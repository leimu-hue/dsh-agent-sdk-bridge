/**
 * The settings pages' data source, served same-origin.
 *
 * The pages cannot read the model catalog from the config form: the catalog is
 * fetched live from the provider, while the form only carries what the user
 * stored. So the host answers these JSON routes:
 *
 * - `GET <prefix>/models?brand=cn|global|codebuddy` — the account's
 *   models, each with its enabled state and the windows it may use.
 * - `GET <prefix>/usage?brand=...` — the account reading. Qoder returns quota;
 *   CodeBuddy returns the signed-in account (its SDK exposes no quota call).
 * - `GET/POST <prefix>/auth` — CodeBuddy browser login/logout.
 *
 * The handler is deliberately brand-agnostic: it resolves a {@link SettingsSource}
 * and never sees a provider adapter, so adding a route or a brand does not
 * reintroduce a union type and a cast per branch.
 *
 * Config writes deliberately do NOT come through here. The browser half holds
 * a revision-fenced form for this plugin's namespace (`ctx.configForms`), and
 * routing every change through it means one write path and one revision fence.
 *
 * @module dsh-agent-sdk-bridge/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrandId, CodeBuddyRegion } from '../core/brand.ts'
import { isBrandId, isCodeBuddyRegion } from '../core/brand.ts'
import type { SettingsSources } from './settings-source.ts'

/** Route prefix this plugin owns; the client resolves it relative to the page. */
export const API_PREFIX = '/api/llm-qoder-cn'

/** Answer one request with JSON. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 2048

/** Read and parse a small JSON request body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('缺少请求体')
  return JSON.parse(text)
}

/**
 * Whether a write request came from this application.
 *
 * The login routes are reachable from every page on this machine (the host
 * listens on loopback), so a plain cross-site form post could otherwise log the
 * user out or open a login flow. The plugin's own page is same-origin and sends
 * JSON, which a simple cross-site form cannot do without a preflight; requiring
 * both keeps a write for the page that owns it.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const expected = req.headers.host
  return typeof expected !== 'string' || expected.length === 0 || host === expected
}

/** A write is same-origin and in the JSON shape the plugin's own page sends. */
function isSameOriginWrite(req: IncomingMessage): boolean {
  if (!isSameOrigin(req)) return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

/** The brand a query-string or body selected, or undefined when it named none. */
function brandFrom(value: unknown): BrandId | undefined {
  if (value === null || value === undefined || value === '') return 'cn'
  return isBrandId(value) ? value : undefined
}

/** A CodeBuddy region from a query or body, defaulting to the international one. */
function regionFrom(value: unknown): CodeBuddyRegion | undefined {
  if (value === null || value === undefined || value === '') return 'global'
  return isCodeBuddyRegion(value) ? value : undefined
}

/** Handle one request under {@link API_PREFIX}. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  sources: SettingsSources,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    const brand = brandFrom(url.searchParams.get('brand'))

    if (brand === undefined) {
      send(res, 400, { error: 'brand 只接受 cn、global 或 codebuddy' })
      return
    }
    const source = sources[brand]

    // A switched-off edition owns neither a route nor a page. Refusing here
    // keeps the API from cold-starting a CLI that the user disabled.
    if (!source.enabled()) {
      send(res, 404, { error: '该 provider 已在插件选项中关闭' })
      return
    }

    if (method !== 'GET' && method !== 'HEAD' && !isSameOriginWrite(req)) {
      send(res, 403, { error: '跨站写入被拒绝' })
      return
    }

    // A refresh re-reads the account catalog (a CLI cold start for Qoder) and
    // bypasses the cache, so it is not a safe read to let another page trigger.
    const fresh = url.searchParams.get('fresh') === '1'
    if (fresh && !isSameOrigin(req)) {
      send(res, 403, { error: '跨站刷新被拒绝' })
      return
    }

    // A POST selects its provider in the body: the page never puts the brand in
    // the URL for writes, so this is resolved before the URL source is used.
    if (path === '/auth' && method === 'POST') {
      let body: { brand?: unknown, region?: unknown, action?: unknown }
      try {
        body = ((await readJson(req)) ?? {}) as { brand?: unknown, region?: unknown, action?: unknown }
      } catch (error) {
        send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const postBrand = brandFrom(body.brand)
      const target = postBrand === undefined ? undefined : sources[postBrand]
      if (target?.auth === undefined) {
        send(res, 400, { error: '该 provider 没有浏览器登录流程' })
        return
      }
      if (!target.enabled()) {
        send(res, 404, { error: '该 provider 已在插件选项中关闭' })
        return
      }
      const authRegion = regionFrom(body.region)
      if (authRegion === undefined) {
        send(res, 400, { error: 'region 只接受 global 或 cn' })
        return
      }
      if (body.action !== 'login' && body.action !== 'logout') {
        send(res, 400, { error: 'action 只接受 login 或 logout' })
        return
      }
      if (body.action === 'logout') {
        const result = await target.auth.logout(authRegion)
        if (!result.ok) {
          send(res, 500, { error: result.error })
          return
        }
        send(res, 200, { brand: 'codebuddy', ...target.auth.status(authRegion) as Record<string, unknown> })
        return
      }
      const started = target.auth.login(authRegion)
      if (started.started === false) {
        send(res, 409, { error: started.error })
        return
      }
      send(res, 200, { brand: 'codebuddy', ...target.auth.status(authRegion) as Record<string, unknown> })
      return
    }

    const requestedRegion = url.searchParams.get('region')
    const region = source.regionAware && requestedRegion !== null && requestedRegion !== ''
      ? regionFrom(requestedRegion)
      : undefined
    if (source.regionAware && requestedRegion !== null && requestedRegion !== '' && region === undefined) {
      send(res, 400, { error: 'region 只接受 global 或 cn' })
      return
    }

    if (path === '/models' && method === 'GET') {
      const page = await source.models({ fresh, region })
      send(res, 200, {
        brand,
        models: page.rows,
        // Echo the region so the page can refuse a response that belongs to
        // the other login: a harmless extra field for the Qoder brands.
        ...source.regionAware && region !== undefined ? { region } : {},
        ...page.signedIn === undefined ? {} : { signedIn: page.signedIn },
        ...page.notice === undefined ? {} : { notice: page.notice },
      })
      return
    }

    if (path === '/usage' && method === 'GET') {
      const snapshot = await source.usage({ fresh, region })
      send(res, 200, { brand, ...snapshot })
      return
    }

    if (path === '/auth') {
      const auth = source.auth
      if (auth === undefined) {
        send(res, 404, { error: '该 provider 没有浏览器登录流程' })
        return
      }
      if (method === 'GET') {
        const authRegion = regionFrom(url.searchParams.get('region'))
        if (authRegion === undefined) {
          send(res, 400, { error: 'region 只接受 global 或 cn' })
          return
        }
        send(res, 200, { brand, ...auth.status(authRegion) as Record<string, unknown> })
        return
      }
    }

    send(res, method === 'GET' ? 404 : 405, { error: method === 'GET' ? 'not found' : '不支持的写入路径' })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}
