/**
 * The CodeBuddy model catalog and the warm control session that reads it.
 *
 * CodeBuddy only answers `getAvailableModelsRaw()` after a CLI process boots,
 * and the SDK has no daemon, so one warm *control* session per region pays that
 * boot once instead of once per refresh. It never sends a turn, so it holds no
 * conversation and deliberately stays out of `CodeBuddySessionManager` — it must
 * never consume a `maxSessions` slot.
 *
 * Model rows are the settings page's contract, so their mapping from the raw
 * SDK shape lives here too.
 *
 * @module dsh-agent-sdk-bridge/codebuddy/catalog
 */

import { randomUUID } from 'node:crypto'
import type { RawLanguageModel } from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion } from '../../core/brand.ts'
import { unrefTimer } from '../../core/lifecycle.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { withTimeout } from '../../core/async.ts'
import { codeBuddyEnvironment, loadCodeBuddySdk } from '../../infra/sdk.ts'
import type { SessionImpl } from './cli.ts'
import { CODEBUDDY_CACHE_TTL_MS, CODEBUDDY_FETCH_TIMEOUT_MS, cliEnv } from './cli.ts'

/** Default context capacity assumed for a model that declares none. */
export const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * How long an unused control session keeps its CLI process.
 *
 * The process is what makes a catalog read cheap, but an idle one is memory.
 * Ten minutes covers a settings visit, a region switch back and the refresh
 * after a login, and still gives the memory back on its own.
 */
const CONTROL_IDLE_MS = 10 * 60_000

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
  /**
   * The list clients were last told about, per region.
   *
   * A refresh that answers the same ids and names stays quiet; only a real
   * change is worth making every connected GUI reload a whole model catalog.
   * Kept across {@link invalidate} — dropping the cache says "re-read", not
   * "the answer will differ".
   */
  private readonly announced = new Map<CodeBuddyRegion, string>()
  /** Warm control sessions, one per region, released when they go idle. */
  private readonly controls = new Map<CodeBuddyRegion, { session: SessionImpl, timer: ReturnType<typeof setTimeout> | undefined }>()

  constructor(
    private readonly region: Live<CodeBuddyRegion>,
    private readonly ttlMs: Live<number> = CODEBUDDY_CACHE_TTL_MS,
    private readonly timeoutMs: Live<number> = CODEBUDDY_FETCH_TIMEOUT_MS,
    private readonly controlIdleMs: Live<number> = CONTROL_IDLE_MS,
    /**
     * Notified with the advertised ids when a read advertises a different list
     * than the last one for that region. The provider route is shared by both
     * login regions, so the owner relays one notification for the route.
     */
    private readonly onChange?: (ids: readonly string[]) => void,
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
      this.announce(region, models)
      return models
    } catch (error) {
      this.failures.set(region, error instanceof Error ? error.message : String(error))
      return cached?.models ?? []
    }
  }

  /**
   * Tell the owner that one region's advertised list changed, once per change.
   *
   * @param region - the region this read answered for.
   * @param models - the entries it answered with.
   */
  private announce(region: CodeBuddyRegion, models: readonly CodeBuddyModel[]): void {
    if (this.onChange === undefined) return
    const signature = JSON.stringify(models.map(model => [model.id, model.name]))
    if (this.announced.get(region) === signature) return
    this.announced.set(region, signature)
    this.onChange(models.map(model => model.id))
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
