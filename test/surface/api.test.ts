/**
 * The settings API's brand routing and write guard.
 *
 * Both editions answer through the same routes, so the one thing that must
 * never regress is which settings source a request reaches: the `brand`
 * parameter is the only thing standing between the page and the other account's
 * catalog or quota. These cases drive the real handler with sources built over
 * stubbed adapters and a fake request/response pair.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { API_PREFIX, handleApi } from '../../src/host/surface/api.ts'
import { codeBuddySettings, qoderSettings } from '../../src/host/surface/settings-source.ts'
import type { QoderAdapter } from '../../src/host/providers/qoder/adapter.ts'
import type { CodeBuddyAdapter } from '../../src/host/providers/codebuddy/adapter.ts'

/** One live catalog entry the stubbed adapters report. */
const ENTRY = {
  value: 'model-1',
  displayName: 'Model One',
  description: '',
  isVl: false,
  isEnabled: true,
  maxInputTokens: 200_000,
  defaultContextWindow: 200_000,
  availableContextWindows: [200_000],
}

/** An adapter that answers with its own name, so routing is observable. */
function adapter(label: string): QoderAdapter {
  return {
    describeCatalog: async () => [ENTRY],
    contextWindowFor: () => undefined,
    isModelDisabled: () => false,
    catalogError: () => `${label} catalog failed`,
    usageInfo: async (fresh: boolean) => ({ at: 1, brand: label, fresh }),
    invalidateCatalog: () => {},
    invalidateUsage: () => {},
  } as unknown as QoderAdapter
}

/** CodeBuddy's catalog uses its own row shape, so it gets its own stub. */
function codeBuddyAdapter(): CodeBuddyAdapter {
  return {
    describeCatalog: async (region?: string) => [{
      id: region === 'cn' ? 'cb-cn-model' : 'cb-model',
      name: 'CB Model', contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000, vision: true, reasoningEfforts: ['low', 'high'],
    }],
    contextWindowFor: () => undefined,
    isModelDisabled: () => false,
    isSignedIn: () => true,
    catalogError: () => undefined,
    usageInfo: async () => ({ at: 1, account: { email: 'cb@example.com' } }),
    invalidateCatalog: () => {},
    invalidateUsage: () => {},
    authStatus: (region: string) => ({ running: false, region }),
    startLogin: () => ({ started: true }),
    logout: async () => ({ ok: true }),
  } as unknown as CodeBuddyAdapter
}

const SOURCES = {
  cn: qoderSettings(adapter('cn')),
  global: qoderSettings(adapter('global')),
  codebuddy: codeBuddySettings(codeBuddyAdapter()),
}

/** Default headers for a same-origin write from the plugin's own page. */
const WRITE_HEADERS = {
  host: '127.0.0.1:54091',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const

/** A request the handler can iterate for a POST body. */
function request(
  url: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers: { ...WRITE_HEADERS, ...headers },
    async *[Symbol.asyncIterator]() { yield* chunks },
  } as unknown as IncomingMessage
}

/** A response that records the JSON it was given. */
function response(): { res: ServerResponse, status: () => number, body: () => any } {
  const state = { status: 0, body: undefined as any }
  const res = {
    writeHead: (status: number) => { state.status = status },
    end: (text: string) => { state.body = JSON.parse(text) },
  } as unknown as ServerResponse
  return { res, status: () => state.status, body: () => state.body }
}

describe('settings API brand routing', () => {
  it('serves each edition from its own source', async () => {
    for (const brand of ['cn', 'global'] as const) {
      const r = response()
      await handleApi(request(`${API_PREFIX}/models?brand=${brand}`), r.res, SOURCES)
      expect(r.status(), brand).toBe(200)
      expect(r.body().brand, brand).toBe(brand)
      expect(r.body().models[0].id, brand).toBe('model-1')
      // This stub advertises a single window, so the page must not offer a
      // selector the CLI would refuse.
      expect(r.body().models[0].contextWindowSelectable, brand).toBe(false)
      // Empty-list guidance is per source; a populated list carries none.
      expect(r.body().notice, brand).toBeUndefined()
    }
  })

  it('reads the quota from the requested edition, and honours refresh', async () => {
    const r = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=global&fresh=1`), r.res, SOURCES)
    expect(r.status()).toBe(200)
    // The snapshot is spread into the response, so its own fields (here the
    // stub's `fresh` marker) sit beside the requested brand.
    expect(r.body()).toMatchObject({ brand: 'global', fresh: true })

    const cached = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=cn`), cached.res, SOURCES)
    expect(cached.body()).toMatchObject({ brand: 'cn', fresh: false })
  })

  it('passes a missing CLI through so the page can drop its cached reading', async () => {
    // Without this flag the card kept showing the previous install's account
    // and credits after the CLI had been uninstalled.
    const missing = {
      describeCatalog: async () => [],
      contextWindowFor: () => undefined,
      isModelDisabled: () => false,
      catalogError: () => undefined,
      usageInfo: async () => ({
        at: 1, cliMissing: true,
        error: '未检测到可用的 qoderclicn，请先安装并登录后再使用此版本。',
      }),
      invalidateCatalog: () => {},
      invalidateUsage: () => {},
    } as unknown as QoderAdapter

    const r = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=cn`), r.res, { ...SOURCES, cn: qoderSettings(missing) })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({ brand: 'cn', cliMissing: true })
    expect(r.body().usage).toBeUndefined()
  })

  it('serves the CodeBuddy catalog and account through the same routes', async () => {
    const models = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy`), models.res, SOURCES)
    expect(models.status()).toBe(200)
    expect(models.body().signedIn).toBe(true)
    expect(models.body().models[0]).toMatchObject({
      id: 'cb-model', vision: true, reasoning: true,
      // The provider's own default budget is what the session runs at; the
      // physical limit is not, and reporting it made the host divide by a
      // window the CLI never used.
      contextWindow: 200_000,
      defaultContextWindow: 200_000,
      contextWindows: [200_000, 1_000_000],
      contextWindowSelectable: true,
    })

    const account = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=codebuddy`), account.res, SOURCES)
    expect(account.body()).toMatchObject({ brand: 'codebuddy', account: { email: 'cb@example.com' } })

    const region = response()
    await handleApi(request(`${API_PREFIX}/usage?brand=codebuddy&region=cn`), region.res, SOURCES)
    expect(region.body()).toMatchObject({ brand: 'codebuddy', account: { email: 'cb@example.com' } })
  })

  it('passes the requested region through to the CodeBuddy catalog', async () => {
    const cn = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy&region=cn`), cn.res, SOURCES)
    expect(cn.status()).toBe(200)
    // The page refuses a table whose echoed region is not the one it asked for.
    expect(cn.body().region).toBe('cn')
    expect(cn.body().models[0].id).toBe('cb-cn-model')

    const bad = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy&region=ioa`), bad.res, SOURCES)
    expect(bad.status()).toBe(400)
  })

  it('does not read a CodeBuddy catalog while signed out', async () => {
    const signedOut = { ...(codeBuddyAdapter() as unknown as Record<string, unknown>) }
    signedOut.isSignedIn = () => false
    signedOut.catalogError = () => '请先登录 CodeBuddy'
    let catalogReads = 0
    signedOut.describeCatalog = async () => { catalogReads++; return [] }
    const r = response()
    await handleApi(request(`${API_PREFIX}/models?brand=codebuddy`), r.res, {
      ...SOURCES,
      codebuddy: codeBuddySettings(signedOut as unknown as CodeBuddyAdapter),
    })
    expect(r.status()).toBe(200)
    expect(r.body()).toMatchObject({ brand: 'codebuddy', signedIn: false, models: [] })
    expect(catalogReads).toBe(0)
  })

  it('starts a CodeBuddy login for the requested region and refuses a bad one', async () => {
    const started = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'cn', action: 'login' }), started.res, SOURCES)
    expect(started.status()).toBe(200)
    expect(started.body()).toMatchObject({ brand: 'codebuddy', running: false, region: 'cn' })

    const badRegion = response()
    await handleApi(request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'ioa', action: 'login' }), badRegion.res, SOURCES)
    expect(badRegion.status()).toBe(400)

    const qoderAuth = response()
    await handleApi(request(`${API_PREFIX}/auth?brand=cn`), qoderAuth.res, SOURCES)
    expect(qoderAuth.status()).toBe(404)
  })

  it('refuses a login write that did not come from this page', async () => {
    // Any page on this machine can reach the loopback host; a cross-site form
    // post must not be able to log the user out or open a login flow.
    const crossSite = response()
    await handleApi(
      request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'cn', action: 'logout' }, {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      }),
      crossSite.res,
      SOURCES,
    )
    expect(crossSite.status()).toBe(403)

    // A simple form post can only send text/plain, which is not the shape the
    // plugin's own page uses for a write.
    const plain = response()
    await handleApi(
      request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'cn', action: 'logout' }, {
        'content-type': 'text/plain',
      }),
      plain.res,
      SOURCES,
    )
    expect(plain.status()).toBe(403)
  })

  it('refuses a cross-site cache-bypassing refresh', async () => {
    // `fresh=1` drops the catalog cache and can cold-start a CLI, so another
    // page must not be able to trigger it.
    const r = response()
    await handleApi(
      request(`${API_PREFIX}/models?brand=cn&fresh=1`, 'GET', undefined, { 'sec-fetch-site': 'cross-site' }),
      r.res,
      SOURCES,
    )
    expect(r.status()).toBe(403)
  })
  it('serves nothing for a provider the plugin options switched off', async () => {
    let catalogReads = 0
    const disabled = { ...(adapter('off') as unknown as Record<string, unknown>) }
    disabled.describeCatalog = async () => { catalogReads += 1; return [ENTRY] }
    const r = response()
    await handleApi(request(`${API_PREFIX}/models?brand=cn`), r.res, {
      ...SOURCES,
      cn: qoderSettings(disabled as unknown as QoderAdapter, () => false),
    })
    expect(r.status()).toBe(404)
    // A switched-off edition must not cold-start its CLI just because an old
    // page still asks for its catalog.
    expect(catalogReads).toBe(0)

    const auth = response()
    await handleApi(
      request(`${API_PREFIX}/auth`, 'POST', { brand: 'codebuddy', region: 'cn', action: 'login' }),
      auth.res,
      { ...SOURCES, codebuddy: { ...SOURCES.codebuddy, enabled: () => false } },
    )
    expect(auth.status()).toBe(404)
  })
  it('offers no install route, for any provider', async () => {
    // Installing a vendor CLI is deliberately not this plugin's job: the flags
    // and versions move with each release, so the page only reports what the
    // machine is missing.
    for (const url of [
      `${API_PREFIX}/setup?brand=cn`,
      `${API_PREFIX}/setup?brand=codebuddy`,
    ]) {
      const r = response()
      await handleApi(request(url), r.res, SOURCES)
      expect(r.status(), url).toBe(404)
    }

    const posted = response()
    await handleApi(request(`${API_PREFIX}/setup`, 'POST', { brand: 'cn', mode: 'login' }), posted.res, SOURCES)
    expect(posted.status()).toBe(405)
  })

  it('refuses a brand it does not serve instead of defaulting to CN', async () => {
    for (const url of [
      `${API_PREFIX}/models?brand=qoder`,
      `${API_PREFIX}/usage?brand=CN`,
      `${API_PREFIX}/models?brand=minimax`,
    ]) {
      const r = response()
      await handleApi(request(url), r.res, SOURCES)
      expect(r.status(), url).toBe(400)
    }
  })

  it('defaults an old page without a brand to CN', async () => {
    const r = response()
    await handleApi(request(`${API_PREFIX}/models`), r.res, SOURCES)
    expect(r.body().brand).toBe('cn')
  })
})
