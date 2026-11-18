/**
 * CodeBuddy's account, catalog, login and warm sessions.
 *
 * The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
 * own CLI, so unlike the Qoder brands there is no global install and no batch
 * helper: login is an SDK call whose region is `external` (international) or
 * `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
 *
 * One CodeBuddy provider serves both regions; the region is a setting, so the
 * models and account shown always belong to the selected login.
 *
 * @module dsh-agent-sdk-bridge/codebuddy
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason, GenerateOptions, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type {
  CanUseTool, Message, RawLanguageModel, UserMessage,
} from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion } from '../../core/brand.ts'
import { CodeBuddyStateStore, codeBuddyCliDir, withoutCredential } from '../../infra/codebuddy-state.ts'
import type { CodeBuddySavedUser } from '../../infra/codebuddy-state.ts'
import { jsonSchemaToShape } from '../../core/jsonschema.ts'
import type { CloseCause } from '../../core/lifecycle.ts'
import { CloseGate, DEFAULT_DRAIN_MS, closeFinishReason, unrefTimer } from '../../core/lifecycle.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { bareHostToolName, isHostToolName } from '../../core/mcp-naming.ts'
import { inertInput, withTimeout } from '../../core/async.ts'
import { codeBuddyEnvironment, loadCodeBuddySdk } from '../../infra/sdk.ts'
import { trace } from '../../infra/log.ts'

/**
 * Literal characters in a channel payload; images contribute pixels, not text.
 *
 * The per-turn input estimate charges text only, matching how the Qoder path
 * counts a feed, so a picture cannot inflate the reported prompt size.
 */
function contentChars(content: readonly ChannelContent[]): number {
  return content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
}

/**
 * Wrap one turn's content the way the SDK's `send()` expects it.
 *
 * A plain string keeps the historical shape; image turns are wrapped in a
 * `UserMessage`, because a bare `ContentBlock[]` is not accepted and dropping
 * the wrapper silently loses the picture.
 */
function toCodeBuddyUserMessage(
  sessionId: string,
  content: string | ChannelContent[],
): string | UserMessage {
  if (typeof content === 'string') return content
  return {
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content: content as never },
    parent_tool_use_id: null,
  }
}
import { MCP_SERVER_NAME, HostToolRegistry, ToolResultPairing, TurnQueue } from '../../core/host-session.ts'
import type { ChannelContent, ResolvedImages, ToolResultPayload, ToolRegistryHost } from '../../core/host-session.ts'
import { TurnOutputAccounting, estimateTextTokens } from '../../core/tokens.ts'

/** Default context capacity assumed for a CodeBuddy model that declares none. */
export const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200_000
/** Default output cap when the catalog declares none. */
export const CODEBUDDY_DEFAULT_MAX_TOKENS = 32_000
/** How long one CodeBuddy account/catalog read stays fresh. */
export const CODEBUDDY_CACHE_TTL_MS = 300_000
/** Give up on one CodeBuddy control round trip after this long. */
export const CODEBUDDY_FETCH_TIMEOUT_MS = 30_000
/** How long a login waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 300_000
/** Bound for clearing stale credentials before a fresh browser login. */
const LOGOUT_TIMEOUT_MS = 20_000
/**
 * How long an unused control session keeps its CLI process.
 *
 * The process is what makes a catalog read cheap, but an idle one is memory.
 * Ten minutes covers a settings visit, a region switch back and the refresh
 * after a login, and still gives the memory back on its own.
 */
const CONTROL_IDLE_MS = 10 * 60_000

/** The session object the SDK's createSession returns (not a named export). */
type SessionImpl = ReturnType<typeof import('@tencent-ai/agent-sdk').unstable_v2_createSession>

/**
 * The key this plugin's MCP server is registered under, in the CodeBuddy CLI.
 *
 * It is the CLI's own normalised spelling - `dsh_host`, not `dsh-host` - and
 * that choice is the fix for the recurring "tool went missing": the CLI builds
 * its call-time tool map from `mcp__<key>__<tool>` with the key verbatim,
 * while several of its own code paths (`parseMcpToolName`, the plugin tool
 * namer, the wire-format normaliser) rewrite every non-alphanumeric character
 * to `_`. With a hyphenated key the list showed `mcp__dsh-host__read_files`
 * while a model that emitted the normalised `mcp__dsh_host__read_files` - as
 * one did, verbatim, in a failed session - found no entry, and the CLI refused
 * the call with `Tool "..." does not exist in the current tool set.` before it
 * ever reached this server. Registering under the normalised spelling makes
 * list, lookup and normalisation one and the same name, so there is no second
 * spelling to guess.
 */
const CODEBUDDY_MCP_SERVER_KEY = 'dsh_host'

/**
 * Whether a CLI tool name belongs to this plugin's MCP server.
 *
 * Both spellings count: the key above is the normalised one this plugin now
 * registers, while a name already in flight can still carry the hyphenated
 * form the server used to be keyed under. See {@link mcpToolPrefixes}.
 */
export function isHostTool(toolName: string): boolean {
  return isHostToolName(toolName, MCP_SERVER_NAME)
}

/**
 * The host-side tool name, with every MCP namespace layer removed.
 *
 * CodeBuddy qualifies an already-qualified name again, so the handler can be
 * handed `mcp__dsh_host__mcp__dsh_host__edit`. Stripping one layer produced
 * `mcp__dsh_host__edit`, a name the host does not have (its tool is `edit`), and
 * DSH answered `unknown tool "mcp__dsh_host__edit"`; the model retried the
 * doubled spelling next round and the CLI rejected it with `does not exist in
 * the current tool set`. See {@link stripMcpNamespace}.
 */
export function hostToolName(toolName: string): string {
  return bareHostToolName(toolName, MCP_SERVER_NAME)
}

/** One model as the settings page and the adapter see it. */
export interface CodeBuddyModel {
  id: string
  name: string
  description?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  /**
   * Context budgets the provider actually accepts for this model.
   *
   * Empty means the model exposes no selectable window: CodeBuddy validates
   * `set_config.contextWindow` against `contextWindow.supportedLengths` and
   * rejects everything else with `Allowed: <none>`, so the settings page must
   * not offer a choice the CLI will refuse.
   */
  contextWindows: number[]
  /** The window the model actually runs with (its physical input limit). */
  defaultContextWindow: number
  vision: boolean
  reasoningEfforts?: string[]
  defaultEffort?: string
  /** Credit multiplier, parsed from the catalog's `x0.79 credits` string. */
  priceFactor?: number
}

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

/** Tokens obtained from a successful login or a silent auth read, per region. */
const bearerTokens = new Map<CodeBuddyRegion, string>()

/** Persisted per-region login and account snapshots. */
export const codeBuddyState = new CodeBuddyStateStore()

/** The region's bearer token, falling back to the persisted copy. */
function tokenFor(region: CodeBuddyRegion): string | undefined {
  const cached = bearerTokens.get(region)
  if (cached !== undefined) return cached
  const saved = codeBuddyState.token(region)
  if (saved !== undefined) bearerTokens.set(region, saved)
  return saved
}

/**
 * The child-process environment for one region's CLI.
 *
 * Two things ride here:
 *
 * - `CODEBUDDY_AUTH_TOKEN`, so a saved login works without another browser
 *   round trip.
 * - `CODEBUDDY_CONFIG_DIR`, a directory of this region's own. The CLI stores
 *   its product environment inside that directory and only switches it during
 *   initialize, while its model provider has already chosen a catalog. With a
 *   shared directory, switching regions read the other region's catalog and
 *   cached it, which made the model list — and the enabled/disabled choices
 *   derived from it — belong to the wrong region. One directory per region
 *   pins the environment, so a fresh process always reads the right catalog.
 */
function cliEnv(region: CodeBuddyRegion): { env: Record<string, string> } {
  const env = cliDirEnv(region)
  const token = tokenFor(region)
  if (token !== undefined) env.CODEBUDDY_AUTH_TOKEN = token
  return { env }
}

/**
 * The region's own CLI directory, with no credential attached.
 *
 * The login, logout and silent-token calls need this and nothing else: they
 * must not carry a bearer token (login starts fresh, logout clears), but they
 * absolutely must be scoped to one region. Without it they acted on the CLI's
 * default `~/.codebuddy`, which both regions share — so signing in for one
 * region overwrote the other's login, and `logout` for the region the page was
 * showing left the credential of the other one standing.
 */
function cliDirEnv(region: CodeBuddyRegion): Record<string, string> {
  return { CODEBUDDY_CONFIG_DIR: codeBuddyCliDir(region) }
}

/** Remember a bearer token in memory and on disk. */
function rememberBearerToken(region: CodeBuddyRegion, token: string, user?: CodeBuddySavedUser): void {
  if (token.length === 0) return
  bearerTokens.set(region, token)
  codeBuddyState.patch(region, {
    token,
    signedIn: true,
    ...user === undefined ? {} : { user },
  })
}

/** Stop using a credential without losing the remembered account card. */
function forgetToken(region: CodeBuddyRegion): void {
  bearerTokens.delete(region)
  codeBuddyState.clearToken(region)
}

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

/** Parse the catalog's `x0.79 credits` string into a number. */
function priceFactorOf(model: RawLanguageModel): number | undefined {
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(model.credits ?? '')
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** Turn one raw catalog entry into the model row this plugin uses. */
export function toCodeBuddyModel(model: RawLanguageModel): CodeBuddyModel {
  // Only what the provider declares as selectable is a choice. The physical
  // `maxInputTokens` is the window the model runs with, not a menu entry:
  // folding it into `contextWindows` offered 200K/1M switches that the CLI
  // answered with `Invalid context_window value … Allowed: <none>`.
  const windows = new Set<number>(model.contextWindow?.supportedLengths ?? [])
  const declared = model.contextWindow?.defaultLength
    ?? model.maxInputTokens
    ?? model.maxAllowedSize
    ?? CODEBUDDY_DEFAULT_CONTEXT_WINDOW
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description ?? model.descriptionZh ?? model.descriptionEn) === undefined
      ? {}
      : { description: (model.description ?? model.descriptionZh ?? model.descriptionEn) as string },
    ...model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens },
    ...model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens },
    contextWindows: [...windows].sort((a, b) => a - b),
    defaultContextWindow: declared,
    vision: model.supportsImages === true && model.disabledMultimodal !== true,
    ...model.reasoning?.supportedEfforts === undefined
      ? model.supportsReasoning === true ? { reasoningEfforts: ['low', 'medium', 'high'] } : {}
      : { reasoningEfforts: [...model.reasoning.supportedEfforts] },
    ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
    ...priceFactorOf(model) === undefined ? {} : { priceFactor: priceFactorOf(model) as number },
  }
}

/**
 * Boot one turn-less session for a region, connected and ready to answer.
 *
 * `getAvailableModelsRaw()` is a control request, but the SDK gives CodeBuddy
 * no daemon: every `createSession` is a fresh child process that loads a 24 MB
 * bundle before it answers. {@link CodeBuddyCatalog} keeps the result warm
 * instead of paying that boot per read. A session that fails to connect is
 * closed here, so no caller has to clean up a half-started process.
 */
async function openControlSession(region: CodeBuddyRegion, timeoutMs: number): Promise<SessionImpl> {
  const sdk = await loadCodeBuddySdk()
  const session = sdk.unstable_v2_createSession({
    environment: codeBuddyEnvironment(region),
    sessionId: randomUUID(),
    ...cliEnv(region),
    settingSources: [],
    persistSession: false,
  })
  try {
    await withTimeout(session.connect(), timeoutMs, 'CodeBuddy request')
    return session
  } catch (error) {
    session.close()
    throw error
  }
}

/**
 * The account's model catalog for one region.
 *
 * CodeBuddy only answers this after the CLI has started, so the read costs one
 * process boot. Results are cached per region and fall back to the last good
 * list when a refresh fails.
 *
 * That boot is paid once per region rather than once per refresh: a warm
 * *control* session answers every later read. It never sends a turn, so it
 * holds no conversation, and it is deliberately kept out of
 * `CodeBuddySessionManager` — it is not one of the host's conversations and
 * must never consume a `maxSessions` slot.
 */
export class CodeBuddyCatalog {
  private readonly snapshots = new Map<CodeBuddyRegion, { at: number, models: readonly CodeBuddyModel[] }>()
  private readonly inflight = new Map<CodeBuddyRegion, Promise<readonly CodeBuddyModel[]>>()
  private readonly failures = new Map<CodeBuddyRegion, string>()
  /** Warm control sessions, one per region, released when they go idle. */
  private readonly controls = new Map<CodeBuddyRegion, { session: SessionImpl, timer: ReturnType<typeof setTimeout> | undefined }>()

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly ttlMs: Live<number> = CODEBUDDY_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = CODEBUDDY_FETCH_TIMEOUT_MS,
    private readonly controlIdleMs: Live<number> = CONTROL_IDLE_MS,
  ) {}

  /**
   * The last catalog read for a region, without fetching.
   *
   * Callers that must answer synchronously (deciding whether a model exposes a
   * context-budget choice) use this instead of awaiting a refresh.
   */
  snapshot(requested?: CodeBuddyRegion): readonly CodeBuddyModel[] | undefined {
    return this.snapshots.get(requested ?? readLive(this.region, 'global'))?.models
  }

  /** Models for one region; a failed refresh keeps the last good list. */
  async models(requested?: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]> {
    const region = requested ?? readLive(this.region, 'global')
    const ttl = readLive(this.ttlMs, CODEBUDDY_CACHE_TTL_MS)
    const cached = this.snapshots.get(region)
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.models
    let pending = this.inflight.get(region)
    if (pending === undefined) {
      pending = this.fetch(region).finally(() => { this.inflight.delete(region) })
      this.inflight.set(region, pending)
    }
    try {
      const models = await pending
      this.snapshots.set(region, { at: Date.now(), models })
      this.failures.delete(region)
      return models
    } catch (error) {
      this.failures.set(region, error instanceof Error ? error.message : String(error))
      return cached?.models ?? []
    }
  }

  /** Why the last refresh failed, or undefined when it succeeded. */
  error(requested?: CodeBuddyRegion): string | undefined {
    return this.failures.get(requested ?? readLive(this.region, 'global'))
  }

  invalidate(region?: CodeBuddyRegion): void {
    if (region === undefined) {
      this.snapshots.clear()
      this.failures.clear()
      return
    }
    this.snapshots.delete(region)
    this.failures.delete(region)
  }

  /**
   * Models from the region's warm control session, booting it when needed.
   *
   * A failure discards the session: the CLI may have exited on its own, and a
   * process that cannot answer one control request must not answer the next.
   * The retry is simply the next read, which starts a fresh one.
   */
  private async fetch(region: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]> {
    const timeout = readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS)
    const session = await this.controlSession(region, timeout)
    try {
      const raw = await withTimeout(session.getAvailableModelsRaw(), timeout, 'CodeBuddy request')
      return raw.map(toCodeBuddyModel)
    } catch (error) {
      this.discardControl(region)
      throw error
    } finally {
      this.armControl(region)
    }
  }

  /** The region's control session, booted on first use. */
  private async controlSession(region: CodeBuddyRegion, timeoutMs: number): Promise<SessionImpl> {
    const existing = this.controls.get(region)
    if (existing !== undefined) return existing.session
    const session = await openControlSession(region, timeoutMs)
    this.controls.set(region, { session, timer: undefined })
    return session
  }

  /** Release the process once the region has gone a whole idle window unused. */
  private armControl(region: CodeBuddyRegion): void {
    const entry = this.controls.get(region)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const idle = readLive(this.controlIdleMs, CONTROL_IDLE_MS)
    if (!(idle > 0)) {
      entry.timer = undefined
      return
    }
    const timer = setTimeout(() => { this.discardControl(region) }, idle)
    unrefTimer(timer)
    entry.timer = timer
  }

  /**
   * Drop the warm control session(s), so the next read boots a new process.
   *
   * Login, logout and a region switch all change what that process would
   * answer — it was started with one account's credential and one region's
   * directory — so callers must discard rather than reuse. Idle release and a
   * failed read arrive here too.
   */
  discardControl(region?: CodeBuddyRegion): void {
    for (const each of region === undefined ? [...this.controls.keys()] : [region]) {
      const entry = this.controls.get(each)
      if (entry === undefined) continue
      this.controls.delete(each)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.session.close()
    }
  }

  /** Release every warm control session (plugin teardown). */
  close(): void {
    this.discardControl()
  }
}

/** Read the signed-in account once per TTL. */
export class CodeBuddyAccountReader {
  private readonly cached = new Map<CodeBuddyRegion, CodeBuddyUsageSnapshot>()
  private readonly inflight = new Map<CodeBuddyRegion, Promise<CodeBuddyUsageSnapshot>>()

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly ttlMs: Live<number> = CODEBUDDY_CACHE_TTL_MS,
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
    bearerTokens.delete(region)
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
    bearerTokens.delete(region)
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
        bearerTokens.delete(region)
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
interface PendingTool {
  chunkIndex: number
  callId: string
  name: string
  arguments: string
}

/** Per-turn output accounting shared with the Qoder session. */
type TurnUsage = { input_tokens: number, output_tokens: number, cache_read_input_tokens?: number | null, cache_creation_input_tokens?: number | null }

/** A token count as a non-negative whole number; anything unusable becomes 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0
}

/** Whether one usage frame actually measured a prompt. */
function measuredPrompt(usage: TurnUsage | undefined): usage is TurnUsage {
  return usage !== undefined
    && (countOf(usage.input_tokens) > 0
      || countOf(usage.cache_read_input_tokens) > 0
      || countOf(usage.cache_creation_input_tokens) > 0)
}

/**
 * Fold one `message_delta` usage into the turn's reading.
 *
 * The delta is cumulative for its own message and carries the final output
 * count. Not every transport repeats the prompt fields on it, so the last
 * measured values are kept rather than letting a later frame erase them.
 */
function mergeTurnUsage(previous: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  const output = typeof next.output_tokens === 'number' && Number.isFinite(next.output_tokens)
    ? next.output_tokens
    : previous?.output_tokens ?? 0
  return {
    input_tokens: countOf(next.input_tokens) > 0 ? next.input_tokens : previous?.input_tokens ?? 0,
    output_tokens: output,
    cache_read_input_tokens: next.cache_read_input_tokens ?? previous?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: next.cache_creation_input_tokens ?? previous?.cache_creation_input_tokens ?? 0,
  }
}

/**
 * Per-session runtime knobs a warm CodeBuddy session is created with.
 *
 * Each value may be a {@link Live} thunk and is resolved when a session is
 * created, so a settings edit applies to the sessions opened after it.
 */
export interface CodeBuddySessionRuntime {
  /** How long an unpaired MCP tool handler waits before failing its call. */
  toolResultTimeoutMs?: Live<number>
  /** How long the inner process gets to acknowledge an abort. */
  abortGraceMs?: Live<number>
  /** How long an in-flight turn may keep running after a close was requested. */
  drainMs?: Live<number>
}

/**
 * One warm CodeBuddy session for a host session id.
 *
 * Mirrors the Qoder session's shape: the host's tool calls are exposed through
 * an in-process MCP server; each handler parks until the host delivers that
 * round's results on its next request. The inner CLI keeps the conversation,
 * so a continuation carries only new user text.
 */
export class CodeBuddySession {
  private session: SessionImpl | null = null
  private mcp: ReturnType<typeof import('@tencent-ai/agent-sdk').createSdkMcpServer> | null = null
  private readonly pairing = new ToolResultPairing()
  private toolSchemas: readonly { name: string, description: string, parameters?: unknown }[] = []
  /**
   * Reconciles the live host tool list into {@link mcp}.
   *
   * Created with the MCP server, because that is what it installs into. Owned
   * here rather than inline so a tool that the host adds or withdraws during a
   * conversation is actually added or withdrawn: the MCP SDK refuses a second
   * `registerTool` for a name it already holds, so the previous
   * name→hash replay could never replace a changed schema, and `Tool "…" does
   * not exist in the current tool set.` was what the model got for its trouble.
   */
  private registry: HostToolRegistry | null = null
  private queue: TurnQueue | null = null
  private disposed = false
  /**
   * Deferred-close state: why this session was asked to stop, and whether an
   * in-flight turn is finishing first. Same contract as the Qoder session —
   * a plugin reload used to kill the CLI mid-answer and report the cut stream
   * as a failure. See {@link CloseGate}.
   */
  private readonly closeGate: CloseGate
  /** Wall clock of the spawn, for the close log's lifetime figure. */
  private spawnedAt: number | undefined
  private abortPending = false
  private turnEndKind: string | undefined
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private tools: PendingTool[] = []
  private openTool: PendingTool | undefined
  private callCounter = 0
  private readonly callNonce = randomUUID().slice(0, 8)
  private lastUsage: TurnUsage | undefined
  /**
   * The last prompt-side buckets a request actually measured.
   *
   * Kept across turns: a turn can end without a usable usage frame (aborted
   * before the first delta, or a transport that only sends the cumulative
   * result). Reusing the last real reading keeps the host's context pressure
   * at the provider's actual prompt instead of collapsing it to the CLI's
   * startup overhead.
   */
  private lastPromptUsage: { inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number } | undefined
  /**
   * Ids of assistant messages whose streaming events this session consumed.
   *
   * Kept across turns, not reset with the turn: the echo of a tool round is
   * delivered on the next stream(), so the previous turn's id is exactly the
   * one that has to be recognised. Only the last few ids matter, and bounding
   * the list keeps a long-lived session from growing without limit.
   */
  private readonly streamedMessageIds = new Set<string>()
  private readonly streamedMessageOrder: string[] = []
  private readonly output = new TurnOutputAccounting()
  private inputChars = 0
  private readonly toolResultTimeoutMs: number
  private readonly abortGraceMs: number
  private region: CodeBuddyRegion = 'global'
  private model = ''
  private effort: string | undefined
  private systemPrompt: string | undefined
  private cwd: string | undefined
  /** Context budget the host shows for this session, when a model offers one. */
  private contextWindow: number | undefined
  /** Budget already pushed to the CLI, keyed by model and value. */
  private appliedWindow: string | undefined
  /** Host messages already fed to the inner session, for continuation planning. */
  fedMessages: readonly import('@deepseek-ai/dsh-llm').RequestMessage[] | undefined
  /** Host system prompt last applied; informational for the adapter. */
  fedSystem: string | undefined

  constructor(
    readonly sessionId: string,
    initialModel: string,
    runtime: CodeBuddySessionRuntime = {},
  ) {
    this.model = initialModel
    this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 120_000)
    this.abortGraceMs = readLive(runtime.abortGraceMs, 5_000)
    this.closeGate = new CloseGate(
      () => readLive(runtime.drainMs, DEFAULT_DRAIN_MS),
      () => { this.teardown() },
      cause => { this.forceEnd(cause) },
    )
  }

  /** Whether a turn is in flight; the pool must never evict such a session. */
  get busy(): boolean {
    return this.queue !== null
  }

  /** Whether this session has been asked to stop and accepts no new turn. */
  get closing(): CloseCause | undefined {
    return this.closeGate.cause
  }

  /** Point the session at a region, model and optional system prompt. */
  configure(
    region: CodeBuddyRegion,
    model: string,
    options: { effort?: string, system?: string, cwd?: string, contextWindow?: number } = {},
  ): void {
    this.region = region
    this.model = model
    this.effort = options.effort
    this.systemPrompt = options.system
    if (options.cwd !== undefined) this.cwd = options.cwd
    if (options.contextWindow !== undefined) this.contextWindow = options.contextWindow
  }

  /**
   * Push the host-visible context window into the inner session.
   *
   * The CLI resolves its own budget (`override > model default > physical
   * limit`) and both its compaction trigger and the upstream gateway enforce
   * that budget. A global-catalog model such as `deepseek-v4.1-flash` declares
   * `supportedLengths [300K, 1M]` with a 300K default, so a session left alone
   * compacts (and the gateway rejects) anything past 276K — while the host,
   * told 1M, keeps showing and feeding a larger history. Replaying that history
   * then collapses to a summary. Applying the same number the host divides by
   * keeps the two in step; the adapter therefore sends a window for every model
   * it knows about, not only the ones that advertise a choice — the mainland
   * catalog declares no lengths anywhere and its physical `maxInputTokens` is a
   * provider number the CLI is free to ignore when left to itself.
   *
   * A rejected value keeps the CLI on its own default, which is the one case
   * where the two denominators can still disagree; it is reported nowhere, so
   * the host's figure stays the visible contract.
   */
  private async applyContextWindow(session: SessionImpl): Promise<void> {
    const window = this.contextWindow
    if (window === undefined) return
    const key = `${this.model}:${window}`
    if (this.appliedWindow === key) return
    this.appliedWindow = key
    try {
      await session.setConfig({ contextWindow: window })
    } catch {
      // Nothing selectable here, or the value was refused: the model's own
      // default stands rather than failing the turn over a budget hint.
    }
  }

  /**
   * Remember the host tools and register them with this session's MCP server.
   *
   * Registration must happen before the CLI connects: the MCP SDK refuses a
   * tool added afterwards. The first turn calls this before the session — and
   * therefore its MCP server — exists, so the schemas are kept and replayed by
   * {@link ensureStarted}. Returning early there left the model with no host
   * tools at all, and it fell back to CodeBuddy's built-in `Bash`, which the
   * host could only answer with "unknown tool".
   */
  ensureTools(tools: readonly { name: string, description: string, parameters?: unknown }[]): void {
    this.toolSchemas = tools
    this.registerTools()
  }

  /**
   * Reconcile this session's MCP tool set with the host's live list.
   *
   * Add, update in place, and remove: the host withdraws tools when a mode
   * changes and adds them when `ops_discover_tools` resolves a deferred one, and
   * a tool the model can still name but the server no longer holds is answered
   * with `Tool "…" does not exist in the current tool set.` — the CLI never
   * forwards it to the host, so no tool result ever comes back.
   */
  private registerTools(): void {
    if (this.registry === null) return
    this.registry.reconcile(this.toolSchemas)
  }

  /** Hand the host's tool results to parked or buffered handlers. */
  deliverToolResults(
    tail: readonly { role: string, toolCallId?: unknown, content?: unknown, isError?: boolean }[],
    images?: ResolvedImages,
  ): void {
    let freshUserTurn = false
    const delivered = new Set<string>()
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      delivered.add(this.pairing.deliver(String(message.toolCallId), {
        content: renderCodeBuddyResult(message.content, images),
        isError: message.isError === true,
      }))
    }
    this.pairing.beginHostRequest(delivered, freshUserTurn)
  }

  /** Run one host turn; `feed` is new user content, or null for a tool continuation. */
  async *stream(options: GenerateOptions, feed: string | ChannelContent[] | null): AsyncGenerator<StreamChunk> {
    if (this.queue !== null) throw new Error(`CodeBuddy session ${this.sessionId} already has a turn in flight`)
    // A closing session accepts no new turn: its pool slot is gone or its plugin
    // generation is. Retrying into it would resurrect a subprocess no one owns.
    if (this.disposed || this.closeGate.closing) {
      // `INVALID_REQUEST` is deliberately outside `dsh-llm`'s default retryable
      // set: re-dispatching into a closing session would only spawn a process
      // nothing owns.
      throw new LlmError(`CodeBuddy session ${this.sessionId} is closed (${this.closeGate.cause ?? 'disposed'})`, 'INVALID_REQUEST')
    }
    let session: SessionImpl
    try {
      session = await this.ensureStarted()
    } catch (error) {
      // Closed while the CLI booted: report the close, not a start failure.
      const cause = this.closeGate.cause
      if (cause === undefined) throw error
      yield { type: 'finish', reason: closeFinishReason(cause) }
      return
    }
    this.queue = new TurnQueue()
    this.resetTurnState()
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      void session.interrupt().catch(() => undefined)
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'CodeBuddy session aborted by host', code: 'ABORTED' } }), this.abortGraceMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // A model switch on a warm session is a control request; waiting for it
      // keeps the next prompt on the model the host just resolved. The window
      // follows it: the CLI validates the value against the current model.
      await session.setModel(this.model)
      await this.applyContextWindow(session)
      if (feed !== null && feed.length > 0) {
        const content = typeof feed === 'string'
          ? feed
          : feed.filter(block => block.type !== 'text' || block.text.length > 0)
        if (content.length > 0) {
          this.inputChars += typeof content === 'string' ? content.length : contentChars(content)
          await session.send(toCodeBuddyUserMessage(this.sessionId, content))
        }
      }
      void this.consume(session)
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        if (item.usage !== undefined) yield { type: 'usage', usage: item.usage }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      if (this.turnEndKind === 'aborted' || this.turnEndKind === 'error') this.pairing.forgetUnclaimed()
      this.queue = null
      this.abortPending = false
      // A close that was waiting for this turn may now finish.
      this.closeGate.settled()
    }
  }

  /**
   * Ask the session to stop serving.
   *
   * An in-flight turn is allowed to finish first (up to `drainMs`): its chunks
   * are consumed by the harness, so the answer arrives instead of being
   * truncated into a bogus stream failure. {@link teardown} does the work.
   *
   * @param cause - why it is closing; decides how an interrupted turn reports.
   */
  close(cause: CloseCause = 'dispose'): void {
    const outcome = this.closeGate.request(cause, this.busy)
    if (outcome === 'draining') trace('session/drain', { session: this.sessionId, brand: 'codebuddy', region: this.region, cause })
  }

  /** End a turn that outlived its drain window, before the CLI dies. */
  private forceEnd(cause: CloseCause): void {
    this.endTurn(closeFinishReason(cause))
  }

  /** Tear the inner CLI down; parked handlers settle with a cancellation. */
  private teardown(): void {
    if (this.disposed) return
    this.disposed = true
    this.pairing.clear()
    this.session?.close()
    this.session = null
    trace('session/close', {
      session: this.sessionId,
      brand: 'codebuddy',
      region: this.region,
      cause: this.closeGate.cause ?? 'dispose',
      aliveMs: this.spawnedAt === undefined ? 0 : Date.now() - this.spawnedAt,
    })
  }

  private async ensureStarted(): Promise<SessionImpl> {
    if (this.session !== null) return this.session
    const sdk = await loadCodeBuddySdk()
    this.mcp ??= sdk.createSdkMcpServer({ name: CODEBUDDY_MCP_SERVER_KEY, tools: [] })
    // Host tools must exist in the MCP server before the CLI lists them. The
    // registry is created here, with the server it installs into, and the
    // replay below is what puts the first turn's schemas in place.
    this.registry ??= new HostToolRegistry(
      this.mcp.instance as unknown as ToolRegistryHost,
      () => async () => {
        const result = await this.pairing.claim(this.toolResultTimeoutMs)
        return {
          content: result.content,
          ...result.isError ? { isError: true } : {},
        }
      },
      // A tool the SDK refused is invisible to the model, which then calls it and
      // gets the CLI's `does not exist in the current tool set` instead of a host
      // result. Surface it instead of dropping it.
      message => console.warn(`[dsh-agent-sdk-bridge] ${message}`),
    )
    // Declare the tools capability before createSession connects this server. A
    // first turn that published no host tools would otherwise connect with no
    // tools capability at all, and the MCP SDK then rejects every later
    // registration — the tool silently never reaches `tools/list`.
    this.registry.prepare()
    this.registerTools()
    const session = sdk.unstable_v2_createSession({
      environment: codeBuddyEnvironment(this.region),
      sessionId: randomUUID(),
      model: this.model,
      mcpServers: { [CODEBUDDY_MCP_SERVER_KEY]: this.mcp },
      canUseTool: this.canUseTool as CanUseTool,
      // Only the host's MCP tools may run: the CLI's own Bash/Read/Edit have no
      // host-side counterpart, and the permission gate denies them anyway.
      tools: [],
      ...cliEnv(this.region),
      settingSources: [],
      includePartialMessages: true,
      persistSession: false,
      ...this.effort === undefined ? {} : { effort: this.effort as never },
      ...this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt },
      ...this.cwd === undefined ? {} : { cwd: this.cwd },
    })
    // A close can arrive while the CLI is booting. Adopting the process then
    // would leave a subprocess the teardown already ran without.
    if (this.disposed || this.closeGate.closing) {
      session.close()
      throw new LlmError(`CodeBuddy session ${this.sessionId} closed while starting`, 'INVALID_REQUEST')
    }
    this.session = session
    this.spawnedAt = Date.now()
    trace('session/spawn', { session: this.sessionId, brand: 'codebuddy', region: this.region })
    return session
  }

  private canUseTool = (toolName: string, _input: Record<string, unknown>, options: { toolUseID?: string }) => {
    if (isHostTool(toolName)) {
      if (options.toolUseID !== undefined) this.pairing.announce(options.toolUseID)
      return Promise.resolve({ behavior: 'allow', ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID } })
    }
    return Promise.resolve({
      behavior: 'deny',
      message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
      ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID },
    })
  }

  private async consume(session: SessionImpl): Promise<void> {
    try {
      for await (const message of session.stream()) {
        this.handle(message)
        if (this.queue === null || this.queue.isClosed) return
      }
      // The stream ended without a `result` frame. Two very different things
      // produce that, and they must not share an error code: a close this
      // plugin asked for (reload, reclaim, account switch) ends the turn as
      // `aborted`, while an unexplained end stays `STREAM_CLOSED`.
      const cause = this.closeGate.cause
      if (cause !== undefined) {
        this.endTurn(closeFinishReason(cause))
        return
      }
      trace('session/stream-ended', { session: this.sessionId, brand: 'codebuddy', region: this.region })
      this.endTurn({ kind: 'error', failure: { message: 'CodeBuddy session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
    } catch (error) {
      // A close that races the CLI's own exit surfaces here as a transport
      // error; it is the close, not a provider failure.
      const cause = this.closeGate.cause
      if (cause !== undefined) {
        this.endTurn(closeFinishReason(cause))
        return
      }
      this.endTurn({
        kind: 'error',
        failure: { message: authErrorText(this.region, error), code: 'BACKEND_TURN_ERROR' },
      })
    }
  }

  private handle(message: Message): void {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') {
        const usage = (event.message as { usage?: TurnUsage }).usage
        // CodeBuddy reports all-zero counts here; the real prompt arrives on
        // message_delta. Only a frame that measured something may replace the
        // turn's reading, or an interrupted turn would report a zero prompt.
        if (measuredPrompt(usage)) this.lastUsage = usage
        // Remember which message this stream belongs to. A tool round ends the
        // host turn at `message_stop` (waiting for `result` would deadlock:
        // the CLI only finishes after the host returns the tool result), so
        // the CLI's `assistant` echo of this message is still buffered and is
        // delivered on the NEXT stream() — where it must not be re-emitted.
        this.rememberStreamedMessage((event.message as { id?: unknown }).id)
        return
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block as { type?: string, id?: string, name?: string, input?: unknown }
        if (block?.type === 'tool_use') {
          // A built-in CLI tool (Bash, Read, ToolSearch…) has no host
          // counterpart; forwarding it made the host answer "unknown tool" and
          // stop the turn. `tools: []` stops them being offered at all, and
          // this guard covers anything the CLI still emits. The permission
          // gate denies the call, so the inner model sees the denial and can
          // retry with a host tool.
          if (!isHostTool(block.name ?? '')) return
          const callId = `cb-${this.callNonce}-${++this.callCounter}`
          if (typeof block.id === 'string' && block.id.length > 0) this.pairing.mapHostCall(callId, block.id)
          const chunkIndex = this.blockIndex++
          const initial = block.input !== undefined && block.input !== null && Object.keys(block.input as object).length > 0
            ? JSON.stringify(block.input)
            : ''
          this.openTool = { chunkIndex, callId, name: hostToolName(block.name ?? ''), arguments: initial }
          this.countOutput(this.openTool.name)
          this.countOutput(initial)
          this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
          this.emit({ type: 'tool-call-delta', index: chunkIndex, id: ToolCallId(callId), name: this.openTool.name, argumentsDelta: '' })
        }
        return
      }
      if (event.type === 'content_block_delta') {
        const delta = event.delta as { type?: string, text?: string, thinking?: string, partial_json?: string }
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          if (this.textBlock === undefined) {
            this.textBlock = { index: this.blockIndex++, text: '' }
            this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          }
          this.textBlock.text += delta.text
          this.countOutput(delta.text)
          this.emit({ type: 'text-delta', index: this.textBlock.index, text: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          if (this.reasoningBlock === undefined) {
            this.reasoningBlock = { index: this.blockIndex++, text: '' }
            this.emit({ type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' })
          }
          this.reasoningBlock.text += delta.thinking
          this.output.addReasoning(delta.thinking)
          this.emit({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: delta.thinking })
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && this.openTool !== undefined) {
          this.openTool.arguments += delta.partial_json
          this.countOutput(delta.partial_json)
          this.emit({ type: 'tool-call-delta', index: this.openTool.chunkIndex, id: ToolCallId(this.openTool.callId), argumentsDelta: delta.partial_json })
        }
        return
      }
      if (event.type === 'content_block_stop') {
        if (this.openTool !== undefined) {
          this.emit({
            type: 'block-end',
            index: this.openTool.chunkIndex,
            block: { type: 'tool-call', id: ToolCallId(this.openTool.callId), name: this.openTool.name, arguments: this.openTool.arguments },
          })
          this.tools.push(this.openTool)
          this.openTool = undefined
        }
        return
      }
      if (event.type === 'message_delta') {
        const usage = (event as { usage?: TurnUsage }).usage
        if (usage !== undefined) this.lastUsage = mergeTurnUsage(this.lastUsage, usage)
        return
      }
      if (event.type === 'message_stop') {
        if (this.tools.length > 0) this.endTurn({ kind: 'tool-calls' })
        return
      }
      return
    }
    if (message.type === 'assistant') {
      // The CLI sends the assembled message after its streaming events. When
      // those events already reached the host, this is an echo, not new
      // content; a replayed echo would print the same reply a second time
      // (and count its tokens twice).
      const echoOf = (message.message as { id?: unknown }).id
      if (typeof echoOf === 'string' && this.streamedMessageIds.has(echoOf)) return
      if (this.textBlock === undefined && this.tools.length === 0) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            this.countOutput(block.name)
            this.countOutput(JSON.stringify(block.input ?? ''))
          }
        }
        const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (text.length > 0) {
          this.textBlock = { index: this.blockIndex++, text }
          this.countOutput(text)
          this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
          this.emit({ type: 'text-delta', index: this.textBlock.index, text })
        }
      }
      return
    }
    if (message.type === 'result') {
      // `result.usage` is cumulative for the whole inner session (verified:
      // the inputs of every request so far are summed), so it is never the
      // current prompt. The per-request reading is the last message_delta's.
      if (this.abortPending) {
        this.endTurn({ kind: 'aborted', failure: { message: 'CodeBuddy turn aborted by host', code: 'ABORTED' } })
        return
      }
      if (this.tools.length > 0) {
        this.endTurn({ kind: 'tool-calls' })
        return
      }
      if (message.is_error === true) {
        const errors = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : 'unknown error'
        this.endTurn({ kind: 'error', failure: { message: `CodeBuddy turn failed: ${errors}`, code: 'BACKEND_TURN_ERROR' } })
        return
      }
      if (this.textBlock === undefined && this.reasoningBlock === undefined) {
        this.endTurn({ kind: 'error', failure: { message: 'CodeBuddy returned a completed response with no content', code: EMPTY_RESPONSE_CODE } })
        return
      }
      this.endTurn({ kind: 'stop' })
    }
  }

  /** Record that one assistant message reached the host as streaming events. */
  private rememberStreamedMessage(id: unknown): void {
    if (typeof id !== 'string' || id.length === 0 || this.streamedMessageIds.has(id)) return
    this.streamedMessageIds.add(id)
    this.streamedMessageOrder.push(id)
    if (this.streamedMessageOrder.length > 32) {
      const oldest = this.streamedMessageOrder.shift()
      if (oldest !== undefined) this.streamedMessageIds.delete(oldest)
    }
  }

  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.openTool = undefined
    this.tools = []
    this.inputChars = 0
    this.output.reset()
    this.lastUsage = undefined
    this.turnEndKind = undefined
  }

  private emit(chunk: StreamChunk): void {
    this.queue?.push({ kind: 'chunk', chunk })
  }

  private countOutput(text: string): void {
    this.output.addOutput(text)
  }

  private usage(): TokenUsage {
    const metered = this.lastUsage
    const local = this.output.usage()
    // The provider counts output exactly. The character estimate is only for
    // turns whose stream carried no usage at all (older transports, aborts).
    const measuredOutput = countOf(metered?.output_tokens)
    const outputTokens = measuredOutput > 0 ? measuredOutput : Math.max(1, Math.ceil(local.outputTokens))
    const reasoning = local.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: Math.min(outputTokens, Math.max(1, Math.ceil(local.reasoningTokens))) }

    if (metered !== undefined && countOf(metered.input_tokens) > 0) {
      const cacheRead = countOf(metered.cache_read_input_tokens)
      const cacheWrite = countOf(metered.cache_creation_input_tokens)
      // `input_tokens` includes cache traffic: CodeBuddy's own modelUsage
      // reports inputTokens = input_tokens - cache_read (verified live), so
      // the harness's disjoint buckets are the remainder plus the cache ones.
      const inputTokens = Math.max(0, countOf(metered.input_tokens) - cacheRead - cacheWrite)
      this.lastPromptUsage = { inputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
      return {
        inputTokens,
        outputTokens,
        ...reasoning,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens,
      }
    }

    if (this.lastPromptUsage !== undefined) {
      // No usable usage frame this turn. Reuse the provider's last measured
      // prompt: reporting zero would collapse the context ring, and `result`
      // is session-cumulative, so it can never stand in for one request.
      const prompt = this.lastPromptUsage
      return {
        inputTokens: prompt.inputTokens,
        outputTokens,
        ...reasoning,
        cacheReadTokens: prompt.cacheReadTokens,
        cacheWriteTokens: prompt.cacheWriteTokens,
        totalTokens: prompt.inputTokens + prompt.cacheReadTokens + prompt.cacheWriteTokens + outputTokens,
      }
    }

    const inputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.inputChars, 0)))
    return {
      inputTokens,
      outputTokens,
      ...reasoning,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
    }
  }

  private endTurn(reason: FinishReason): void {
    // A forced close can race the consumer's own end-of-stream report; whichever
    // arrives second must not append a second turn/end to a queue already closed.
    if (this.queue === null || this.queue.isClosed) return
    this.turnEndKind = reason.kind
    if (this.textBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.textBlock.index, block: { type: 'text', text: this.textBlock.text } })
    }
    if (this.reasoningBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.reasoningBlock.index, block: { type: 'reasoning', text: this.reasoningBlock.text } })
    }
    this.queue.push({ kind: 'turn-end', reason, usage: this.usage() })
    this.queue.close()
    const code = reason.kind === 'error' || reason.kind === 'aborted' ? reason.failure.code : undefined
    trace('turn/end', {
      session: this.sessionId,
      brand: 'codebuddy',
      region: this.region,
      kind: reason.kind,
      ...code === undefined ? {} : { code },
      ...this.closeGate.cause === undefined ? {} : { cause: this.closeGate.cause },
    })
  }
}

/** Render host tool-result blocks into the MCP content the inner model reads. */
export function renderCodeBuddyResult(blocks: unknown, images?: ResolvedImages): ToolResultPayload['content'] {
  if (!Array.isArray(blocks)) return [{ type: 'text', text: String(blocks ?? '') }]
  const content: ToolResultPayload['content'] = []
  for (const block of blocks as { type?: string, text?: string, attachment?: unknown }[]) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text ?? '' })
    else if (block.type === 'image' && block.attachment !== null && typeof block.attachment === 'object') {
      // A tool can return pixels (`read_image` does). The MCP result shape
      // carries them as an image block; dropping them here was why the inner
      // model could read a path in the result text but never see the picture.
      const attachment = block.attachment as ImageAttachmentRef
      const resolved = images?.get(String(attachment.attachmentId))
      content.push(resolved === undefined
        ? { type: 'text', text: textOnlyImageText(attachment) }
        : { type: 'image', data: resolved.data, mimeType: resolved.mediaType })
    }
    else content.push({ type: 'text', text: JSON.stringify(block) })
  }
  return content
}

/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export class CodeBuddySessionManager {
  private readonly sessions = new Map<string, { session: CodeBuddySession, region: CodeBuddyRegion }>()
  /** Set by {@link seal}: this pool's plugin generation is gone. */
  private sealed = false

  /**
   * @param maxSessions - warm-session cap; read per eviction so a settings edit
   *   applies to the next session that overflows the pool.
   * @param runtime - per-session knobs, resolved when each session is created.
   * @param create - builds one session; injectable so the pool's rules are
   *   testable without spawning a CLI.
   */
  constructor(
    readonly maxSessions: Live<number>,
    private readonly runtime: CodeBuddySessionRuntime = {},
    private readonly create: (sessionId: string, model: string) => CodeBuddySession =
      (sessionId, model) => new CodeBuddySession(sessionId, model, runtime),
  ) {}

  forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession {
    // A sealed pool belonged to a plugin generation that is gone; reviving it
    // would spawn a CLI process nothing owns. See {@link seal}.
    if (this.sealed) throw new LlmError('CodeBuddy 会话池已封存（插件已卸载）', 'INVALID_REQUEST')
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (existing.region !== region) {
        existing.session.close('region')
        this.sessions.delete(sessionId)
      } else {
        this.sessions.delete(sessionId)
        this.sessions.set(sessionId, existing)
        return existing.session
      }
    }
    const session = this.create(sessionId, model)
    this.sessions.set(sessionId, { session, region })
    const cap = readLive(this.maxSessions, 8)
    while (this.sessions.size > cap) {
      // Never evict a session with a turn in flight: killing it reports the
      // turn as a stream failure and discards an answer that was arriving.
      const victim = [...this.sessions.entries()]
        .find(([id, entry]) => id !== sessionId && !entry.session.busy)
      if (victim === undefined) break
      this.sessions.delete(victim[0])
      victim[1].session.close('evicted')
    }
    return session
  }

  dispose(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    entry.session.close('rebuild')
  }

  /**
   * Drop every warm session, keeping the pool usable.
   *
   * A login or logout changes the credentials those processes loaded, so they
   * cannot answer for the new account; the pool itself keeps serving.
   *
   * @param cause - why the sessions go; decides how interrupted turns report.
   */
  closeAll(cause: CloseCause = 'account'): void {
    for (const entry of this.sessions.values()) entry.session.close(cause)
    this.sessions.clear()
  }

  /**
   * Drop every warm session and refuse to create more.
   *
   * Called from the plugin's dispose effect: a step prepared before the unload
   * can still be retried through this adapter, and a session created then would
   * outlive every owner it has.
   */
  seal(cause: CloseCause = 'dispose'): void {
    this.sealed = true
    this.closeAll(cause)
  }
}

/** A one-shot turn, used for titles and compaction summaries. */
export async function codeBuddyColdStream(
  region: CodeBuddyRegion,
  prompt: string,
  model: string | undefined,
  options: GenerateOptions,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  let text = ''
  const signal = options.signal
  const sdk = await loadCodeBuddySdk()
  const session = sdk.unstable_v2_createSession({
    environment: codeBuddyEnvironment(region),
    sessionId: randomUUID(),
    ...model === undefined ? {} : { model },
    ...cliEnv(region),
    // Titles and compaction must never run a tool.
    tools: [],
    settingSources: [],
    persistSession: false,
  })
  const onAbort = (): void => { void session.interrupt().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await session.send(prompt)
    for await (const message of session.stream()) {
      if (signal?.aborted === true) break
      if (message.type === 'assistant') {
        text += message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
      }
    }
  } catch (error) {
    if (signal?.aborted !== true) throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    session.close()
  }
  if (signal?.aborted === true) {
    chunks.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } })
    return chunks
  }
  if (text.length === 0) {
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'CodeBuddy side-channel returned no content', code: EMPTY_RESPONSE_CODE } } })
    return chunks
  }
  chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
  for (let i = 0; i < text.length; i += 192) chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + 192) })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  chunks.push({ type: 'usage', usage: { inputTokens: Math.max(1, Math.ceil(prompt.length / 4)), outputTokens: Math.max(1, Math.ceil(text.length / 4)) } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}
