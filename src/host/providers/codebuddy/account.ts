/**
 * CodeBuddy's account, quota and browser login.
 *
 * These reads and the login flow all speak HTTP/SDK calls that are unrelated to
 * a conversation: the account card, the persisted credential, the billing
 * endpoint, and the browser round trip. Keeping them out of `session.ts` means
 * the session module describes one turn, not the account behind it.
 *
 * @module dsh-agent-sdk-bridge/codebuddy/account
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { CodeBuddyRegion } from '../../core/brand.ts'
import { inertInput, withTimeout } from '../../core/async.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { withoutCredential } from '../../infra/codebuddy-state.ts'
import { codeBuddyEnvironment, loadCodeBuddySdk } from '../../infra/sdk.ts'
import {
  CODEBUDDY_FETCH_TIMEOUT_MS, cliDirEnv, cliEnv, codeBuddyState,
  forgetToken, rememberBearerToken, tokenFor,
} from './cli.ts'

/** How long a login waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 300_000
/** Bound for clearing stale credentials before a fresh browser login. */
const LOGOUT_TIMEOUT_MS = 20_000
/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
  uid?: string
  userId?: string
  userName?: string
  email?: string
  organization?: string
  subscriptionType?: string
}

/**
 * Whether the CLI answered as the anonymous fallback.
 *
 * With an invalid `CODEBUDDY_AUTH_TOKEN` the CLI still reports an account
 * object whose uid is `anonymous`; treating that as a login would show a
 * signed-in card and try the quota endpoint with a dead credential.
 */
function isUnauthenticatedAccount(account: CodeBuddyAccount): boolean {
  return Object.keys(account).length === 0
    || (account.uid ?? account.userId) === 'anonymous'
}

/** One credit package inside a CodeBuddy quota reading. */
export interface CodeBuddyQuotaPackage {
  name: string
  total: number
  used: number
  /** Epoch milliseconds, when the package expires. */
  end?: number
}

/** Account credits, read from CodeBuddy's billing endpoint. */
export interface CodeBuddyQuota {
  remaining: number
  total: number
  used: number
  /** Earliest still-valid package expiry, in epoch milliseconds. */
  cycleEnd?: number
  packages: CodeBuddyQuotaPackage[]
}

/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
  at: number
  account?: CodeBuddyAccount
  quota?: CodeBuddyQuota
  /** Why the quota lookup failed, when the account itself was readable. */
  quotaError?: string
  error?: string
}

/** The public billing hosts; both regions speak the same quota protocol. */
const CODEBUDDY_ENDPOINTS: Record<CodeBuddyRegion, string> = {
  global: 'https://www.codebuddy.ai',
  cn: 'https://copilot.tencent.com',
}
const QUOTA_PATH = '/v2/billing/meter/get-user-resource'
const QUOTA_RANGE_END = '2099-12-31 23:59:59'
/** Cosmetic fingerprint headers the upstream checks; kept in step with the CLI. */
const CLIENT_VERSION = '2.174.0'

/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
  running: boolean
  region: CodeBuddyRegion
  startedAt?: number
  finishedAt?: number
  /** Browser URL, once the CLI hands one over. */
  url?: string
  user?: { userId: string, userName: string, userNickname: string }
  /** Whether a usable credential is available for this region. */
  signedIn?: boolean
  error?: string
}

/** Read the signed-in account once and reuse it until a login or region change. */
export class CodeBuddyAccountReader {
  private readonly cached = new Map<CodeBuddyRegion, CodeBuddyUsageSnapshot>()
  private readonly inflight = new Map<CodeBuddyRegion, Promise<CodeBuddyUsageSnapshot>>()

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly timeoutMs: Live<number> = CODEBUDDY_FETCH_TIMEOUT_MS,
  ) {}

  /**
   * The account for one region.
   *
   * A non-fresh read answers from the persisted snapshot first, so switching
   * the region selector paints immediately; the page follows with `fresh=1`
   * to replace it with a live CLI reading.
   */
  async read(fresh = false, requested?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot> {
    const region = requested ?? readLive(this.region, 'global')
    if (!fresh) {
      // The persisted snapshot is what lets the card paint before a fresh CLI
      // read finishes; it is replaced on the page's `fresh=1` follow-up, not by
      // a wall clock.
      const memory = this.cached.get(region)
      if (memory !== undefined) return memory
      const saved = codeBuddyState.usage(region)
      if (saved !== undefined) {
        this.cached.set(region, saved)
        return saved
      }
    }
    let pending = this.inflight.get(region)
    if (pending === undefined) {
      pending = this.fetch(region).finally(() => { this.inflight.delete(region) })
      this.inflight.set(region, pending)
    }
    const snapshot = await pending
    this.cached.set(region, snapshot)
    return snapshot
  }

  invalidate(region?: CodeBuddyRegion): void {
    if (region === undefined) this.cached.clear()
    else this.cached.delete(region)
  }

  private async fetch(region: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot> {
    const at = Date.now()
    const saved = codeBuddyState.region(region)
    const token = tokenFor(region)
    // Fast path: a remembered identity plus a credential is everything the
    // quota endpoint needs, and that endpoint is a plain HTTP call. Booting the
    // CLI for it was the largest cost of opening the settings page — a fresh
    // 24 MB process whose only contribution was an identity this store already
    // holds. The CLI keeps its recovery role below: a rejected credential, or a
    // region whose identity was never read, still asks it.
    if (saved?.account !== undefined && token !== undefined) {
      try {
        const quota = await fetchCodeBuddyQuota(region, token)
        codeBuddyState.patch(region, { signedIn: true, quota, quotaError: undefined, at })
        return { at, account: saved.account, quota }
      } catch (error) {
        if (!isCredentialRejected(error)) {
          // A 5xx, an unreachable endpoint or an unparseable body says nothing
          // about the login: the identity stays, only the quota is unknown.
          const message = error instanceof Error ? error.message : String(error)
          codeBuddyState.patch(region, { signedIn: true, quota: undefined, quotaError: message, at })
          return { at, account: saved.account, quotaError: message }
        }
        // Rejected: drop it and let the CLI try to recover a usable one below.
        forgetToken(region)
      }
    }
    // Ask the CLI even when this region holds no credential of ours.
    //
    // Refusing here used to be the guard against adopting the *other* region's
    // login: the CLI's default directory is shared, so a probe could answer with
    // whichever account logged in last. Every call now runs inside this region's
    // own directory, so the answer can only be this region's — and the refusal
    // had become pure damage: any accident that dropped the local copy of a
    // working token left the card saying "not signed in" for an account the CLI
    // still had, with no path back short of a fresh browser login.
    try {
      const account = await readAccount(region, readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS))
      // An unauthenticated CLI answers with an empty object or an anonymous
      // account, which must not read as "signed in with no details".
      if (isUnauthenticatedAccount(account)) {
        forgetToken(region)
        codeBuddyState.patch(region, { signedIn: false, account: undefined, quota: undefined, quotaError: undefined, at })
        return { at, error: `${region === 'cn' ? 'CodeBuddy 国内版' : 'CodeBuddy 国际版'}尚未登录，请在页面顶部选择该区域并登录。` }
      }
      codeBuddyState.patch(region, { signedIn: true, account, at })
      try {
        const quota = await readQuotaWithToken(region)
        codeBuddyState.patch(region, { quota, quotaError: undefined, at })
        return { at, account, quota }
      } catch (quotaError) {
        const message = quotaError instanceof Error ? quotaError.message : String(quotaError)
        if (isCredentialRejected(quotaError)) forgetToken(region)
        else codeBuddyState.patch(region, { quota: undefined, quotaError: message })
        return { at, account, quotaError: message }
      }
    } catch (error) {
      return { at, error: authErrorText(region, error) }
    }
  }
}

/**
 * Read the signed-in account through a one-shot query.
 *
 * `createSession` exposes models but not the account, while `query()` exposes
 * `accountInfo()`; the prompt never yields, so no model turn is started.
 */
async function readAccount(region: CodeBuddyRegion, timeoutMs: number): Promise<CodeBuddyAccount> {
  const sdk = await loadCodeBuddySdk()
  const q = sdk.query({
    prompt: inertInput(),
    options: {
      environment: codeBuddyEnvironment(region),
      ...cliEnv(region),
      tools: [],
      settingSources: [],
      maxTurns: 1,
    },
  })
  try {
    await withTimeout(q.connect(), timeoutMs, 'CodeBuddy request')
    // The CLI's answer carries a bearer token beside the identity; it goes on
    // to the settings page through `/usage`, so the credential comes off here.
    return withoutCredential(await withTimeout(q.accountInfo(), timeoutMs, 'CodeBuddy request')) ?? {}
  } finally {
    await q.return().catch(() => undefined)
  }
}

/** Turn a raw SDK failure into a sentence the settings page can act on. */
export function authErrorText(region: CodeBuddyRegion, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const label = region === 'cn' ? 'CodeBuddy 国内版' : 'CodeBuddy 国际版'
  if (/auth|login|登录|credential|401|unauthor/i.test(detail)) {
    return `${label}尚未登录，请在页面顶部选择该区域并登录。`
  }
  return detail
}

/**
 * The account's credits, read from CodeBuddy's billing endpoint.
 *
 * The SDK exposes no quota call, but the CLI's own account page uses
 * `POST /v2/billing/meter/get-user-resource` on the same host. The response is
 * a list of independently expiring credit packages; `CycleCapacity*Precise`
 * is the live balance, while the top-level `TotalDosage` is a stale
 * period-scoped figure and is deliberately ignored.
 *
 * @param payload - the endpoint's JSON answer.
 */
export function parseCodeBuddyQuota(payload: unknown): CodeBuddyQuota {
  const data = (payload as { data?: unknown } | null)?.data as Record<string, unknown> | undefined
  if (data === null || data === undefined || typeof data !== 'object') throw new Error('额度响应缺少 data')
  const response = data.Response as Record<string, unknown> | undefined
  const error = response?.Error as { Code?: unknown, Message?: unknown } | undefined
  if (error?.Code !== undefined && error.Code !== 0 && error.Code !== '0') {
    throw new Error(`${String(error.Code)}: ${String(error.Message ?? '')}`)
  }
  const source = (response?.Data as Record<string, unknown> | undefined)?.Accounts
    ?? response?.Accounts
    ?? (data.Data as Record<string, unknown> | undefined)?.Accounts
    ?? data.Accounts
  if (!Array.isArray(source)) throw new Error('额度响应缺少 Accounts')

  const now = Date.now()
  let total = 0
  let remaining = 0
  let cycleEnd: number | undefined
  const packages: CodeBuddyQuotaPackage[] = []
  for (const entry of source as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== 'object') continue
    if (Number(entry.Status) !== 0) continue
    const packageTotal = cycleCapacity(entry, 'CycleCapacitySize')
    if (packageTotal <= 0) continue
    const packageRemaining = Math.max(0, cycleCapacity(entry, 'CycleCapacityRemain'))
    total += packageTotal
    remaining += packageRemaining
    const end = parseLocalTime(entry.CycleEndTime)
    if (packageRemaining > 0 || (end !== undefined && end > now)) {
      packages.push({
        name: String(entry.PackageName ?? ''),
        total: packageTotal,
        used: Math.max(0, packageTotal - packageRemaining),
        ...end === undefined ? {} : { end },
      })
    }
    if (end !== undefined && end > now && packageRemaining > 0) {
      cycleEnd = cycleEnd === undefined ? end : Math.min(cycleEnd, end)
    }
  }
  return {
    remaining,
    total,
    used: Math.max(0, total - remaining),
    ...cycleEnd === undefined ? {} : { cycleEnd },
    packages,
  }
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function cycleCapacity(entry: Record<string, unknown>, key: string): number {
  return numeric(entry[`${key}Precise`]) ?? numeric(entry[key]) ?? 0
}

function parseLocalTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value.trim().replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function formatLocalTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * A bearer token for the region, from a recent login or a silent SDK read.
 *
 * The silent read is the documented behaviour of `authenticate` — return the
 * CLI's existing token instead of opening a browser when the region is signed
 * in — but it did not work as measured: on a machine with a live CodeBuddy
 * login it timed out for both regions, each in the shared default directory and
 * in both per-region directories. So treat it as best effort, and never as a
 * place to recover from: the copy this plugin saved is the only credential a
 * session can count on, which is why dropping it used to read as "not signed
 * in" even while the account still worked.
 */
async function readBearerToken(region: CodeBuddyRegion): Promise<string> {
  const cached = tokenFor(region)
  if (cached !== undefined) return cached
  const sdk = await loadCodeBuddySdk()
  const result = await withTimeout(sdk.unstable_v2_authenticate({
    environment: codeBuddyEnvironment(region),
    // Scoped to this region's directory. Left out, the CLI answered from its
    // shared default directory — whichever region had signed in last — and
    // `rememberBearerToken` below then recorded *that* account as this region's.
    env: cliDirEnv(region),
    timeout: 3000,
    onAuthUrl: () => {
      // A quota read must never pop a browser; the page owns login.
    },
  }), 6000, 'CodeBuddy authenticate')
  rememberBearerToken(region, result.userinfo.token, {
    userId: result.userinfo.userId,
    userName: result.userinfo.userName,
    userNickname: result.userinfo.userNickname,
  })
  return result.userinfo.token
}

/** Query the billing endpoint once. */
export async function fetchCodeBuddyQuota(
  region: CodeBuddyRegion,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodeBuddyQuota> {
  const endpoint = CODEBUDDY_ENDPOINTS[region]
  const host = new URL(endpoint).host
  const body = {
    PageNumber: 1,
    PageSize: 200,
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatLocalTime(new Date()),
    PackageEndTimeRangeEnd: QUOTA_RANGE_END,
  }
  const response = await fetchImpl(`${endpoint}${QUOTA_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-stainless-arch': process.arch === 'arm64' ? 'arm64' : 'x64',
      'x-stainless-lang': 'js',
      'x-stainless-os': process.platform === 'darwin' ? 'MacOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
      'x-stainless-package-version': '6.25.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      'x-conversation-id': randomUUID(),
      'x-conversation-request-id': randomBytes(16).toString('hex'),
      'x-conversation-message-id': randomUUID().replace(/-/g, ''),
      'x-request-id': randomUUID().replace(/-/g, ''),
      'x-agent-intent': 'craft',
      'x-agent-purpose': 'conversation',
      'x-ide-type': 'CLI',
      'x-ide-name': 'CLI',
      'x-ide-version': CLIENT_VERSION,
      'user-agent': `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`,
      'x-private-data': 'false',
      'x-codebuddy-request': '1',
      'x-product': 'SaaS',
      'x-domain': host,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CredentialRejectedError('CodeBuddy 登录已过期，请重新登录')
    }
    const detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`CodeBuddy 额度接口返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('CodeBuddy 额度接口返回了非 JSON 内容')
  }
  return parseCodeBuddyQuota(payload)
}

/**
 * The credential this region holds was rejected by the endpoint.
 *
 * Thrown where the rejection is *known* — an explicit HTTP 401/403 — rather
 * than inferred from the error text. Inferring it was the bug: the loose
 * matcher below used to treat any failure whose message happened to contain
 * "token", "401" inside a number, or an HTML body mentioning a token, as an
 * expired login. It then dropped a working credential, and because a missing
 * local token reads as "signed out", the page showed an account as not signed
 * in while the CLI still had a usable login.
 */
class CredentialRejectedError extends Error {}

/**
 * Whether a quota failure genuinely means the credential no longer works.
 *
 * The typed error carries the CLI's own expiry sentence, which is also matched
 * here because the message is ours, fixed, and not derived from server text.
 * Everything else — a 5xx, a bad payload, a timeout, an unreachable endpoint —
 * leaves the credential alone.
 *
 * @param error - whatever quota reading threw.
 */
function isCredentialRejected(error: unknown): boolean {
  if (error instanceof CredentialRejectedError) return true
  const message = error instanceof Error ? error.message : String(error)
  return message === 'CodeBuddy 登录已过期，请重新登录'
}

/** Read quota, retrying once with a fresh token after an auth failure. */
async function readQuotaWithToken(region: CodeBuddyRegion): Promise<CodeBuddyQuota> {
  const token = await readBearerToken(region).catch((error: unknown) => {
    throw new Error(authErrorText(region, error))
  })
  try {
    return await fetchCodeBuddyQuota(region, token)
  } catch (error) {
    if (!isCredentialRejected(error)) throw error
    forgetToken(region)
    const renewed = await readBearerToken(region).catch((renewError: unknown) => {
      throw new Error(authErrorText(region, renewError))
    })
    return await fetchCodeBuddyQuota(region, renewed)
  }
}

interface AuthRun {
  status: CodeBuddyAuthStatus
  /**
   * Whether this region held a credential before the click.
   *
   * The SDK's `authenticate` reuses any token the CLI still has on disk and
   * never calls `onAuthUrl`, so a click on a signed-in region has to clear
   * first. A region that never signed in has nothing to clear, and skipping
   * that call saves a whole CLI boot — the bundled CLI has no daemon, so each
   * `unstable_v2_*` call is a fresh 24 MB process, and this one was the larger
   * half of the wait between the click and the browser tab.
   */
  clearFirst: boolean
}

/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export class CodeBuddyAuth {
  private readonly runs = new Map<CodeBuddyRegion, AuthRun>()

  /** Start a login; refuses while the same region is already logging in. */
  start(
    region: CodeBuddyRegion,
    onFinish?: (ok: boolean) => void,
  ): { started: true } | { started: false, error: string } {
    const existing = this.runs.get(region)
    if (existing?.status.running === true) return { started: false, error: '该区域正在登录，请先在浏览器中完成。' }
    // Read before clearing: the decision is whether this region *had* a
    // credential, and the clear below erases that evidence.
    const saved = codeBuddyState.region(region)
    const clearFirst = saved?.token !== undefined
      || saved?.user !== undefined
      || saved?.account !== undefined
      || saved?.signedIn === true
    // A login click always starts a browser flow. The SDK would otherwise
    // silently reuse any token the CLI still has on disk.
    forgetToken(region)
    codeBuddyState.clear(region)
    const run: AuthRun = { status: { running: true, region, startedAt: Date.now(), signedIn: false }, clearFirst }
    this.runs.set(region, run)
    void this.login(run, onFinish)
    return { started: true }
  }

  status(region: CodeBuddyRegion): CodeBuddyAuthStatus {
    const run = this.runs.get(region)
    if (run !== undefined) return run.status
    const saved = codeBuddyState.region(region)
    return {
      running: false,
      region,
      signedIn: saved?.signedIn === true,
      ...saved?.user === undefined ? {} : { user: saved.user },
    }
  }

  /** Clear the cached credential for one region. */
  async logout(region: CodeBuddyRegion): Promise<{ ok: true } | { ok: false, error: string }> {
    let failure: string | undefined
    try {
      const sdk = await loadCodeBuddySdk()
      await withTimeout(
        sdk.unstable_v2_logout({ environment: codeBuddyEnvironment(region), env: cliDirEnv(region) }),
        CODEBUDDY_FETCH_TIMEOUT_MS,
        'CodeBuddy logout',
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    // Local state goes first: even if the CLI refuses, this process must stop
    // presenting the account as signed in.
    this.runs.delete(region)
    forgetToken(region)
    codeBuddyState.clear(region)
    return failure === undefined ? { ok: true } : { ok: false, error: failure }
  }

  /** False once this run was replaced or cancelled by logout. */
  private current(run: AuthRun): boolean {
    return this.runs.get(run.status.region) === run
  }

  private async login(run: AuthRun, onFinish?: (ok: boolean) => void): Promise<void> {
    const { status } = run
    const { region } = status
    try {
      const sdk = await loadCodeBuddySdk()
      // `authenticate()` short-circuits when the CLI still has a token on disk:
      // it returns that token without ever calling `onAuthUrl`, so the click
      // looks dead and an expired credential survives forever. A login click
      // always means "open the browser", so drop the stored credential first —
      // but only when this region held one: booting the CLI just to clear
      // nothing is the cost this skip exists for.
      // Both calls are scoped to this region's directory: the CLI's default
      // directory is shared, so an unscoped logout here signed the *other*
      // region out as a side effect of logging this one in.
      if (run.clearFirst) {
        await withTimeout(
          sdk.unstable_v2_logout({ environment: codeBuddyEnvironment(region), env: cliDirEnv(region) }),
          LOGOUT_TIMEOUT_MS,
          'CodeBuddy logout',
        ).catch(() => undefined)
        if (!this.current(run)) return
        forgetToken(region)
      }
      const result = await sdk.unstable_v2_authenticate({
        environment: codeBuddyEnvironment(region),
        env: cliDirEnv(region),
        timeout: LOGIN_TIMEOUT_MS,
        onAuthUrl: (state) => {
          // The bundled CLI opens the browser itself as part of the login
          // flow. Opening it here too produced two identical tabs, so this
          // only records the URL for the card's manual fallback link.
          status.url = state.authUrl
        },
      })
      if (!this.current(run)) return
      status.running = false
      status.finishedAt = Date.now()
      const user = {
        userId: result.userinfo.userId,
        userName: result.userinfo.userName,
        userNickname: result.userinfo.userNickname,
      }
      status.user = user
      status.signedIn = true
      rememberBearerToken(region, result.userinfo.token, user)
      onFinish?.(true)
    } catch (error) {
      if (!this.current(run)) return
      status.running = false
      status.finishedAt = Date.now()
      status.signedIn = false
      status.error = authErrorText(region, error)
      onFinish?.(false)
    }
  }
}

/** One tool-use block under assembly in the active turn. */
