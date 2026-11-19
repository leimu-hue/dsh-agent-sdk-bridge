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

import { randomUUID } from 'node:crypto'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason, GenerateOptions, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type {
  CanUseTool, Message, UserMessage,
} from '@tencent-ai/agent-sdk'
import type { CodeBuddyRegion } from '../../core/brand.ts'
import type { SessionImpl } from './cli.ts'
import { cliEnv } from './cli.ts'
import { authErrorText } from './account.ts'
import type { CloseCause, PoolSession } from '../../core/lifecycle.ts'
import { CloseGate, DEFAULT_DRAIN_MS, closeFinishReason } from '../../core/lifecycle.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { SessionPool } from '../../core/session-pool.ts'
import { approximateUsage, textStreamChunks } from '../../core/text-stream.ts'
import { bareHostToolName, isHostToolName } from '../../core/mcp-naming.ts'
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

/** Default output cap when the catalog declares none. */
export const CODEBUDDY_DEFAULT_MAX_TOKENS = 32_000
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

/** One warm session plus the login region it was opened for. */
interface RegionSlot extends PoolSession {
  readonly region: CodeBuddyRegion
  readonly session: CodeBuddySession
}

/** Bind a session to its region so the pool can retire it on a region switch. */
function bindRegion(session: CodeBuddySession, region: CodeBuddyRegion): RegionSlot {
  return {
    sessionId: session.sessionId,
    region,
    session,
    get busy(): boolean { return session.busy },
    close(cause?: CloseCause): void { session.close(cause) },
  }
}

/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export class CodeBuddySessionManager {
  private readonly pool: SessionPool<RegionSlot>

  /**
   * @param maxSessions - warm-session cap; read per eviction so a settings edit
   *   applies to the next session that overflows the pool.
   * @param runtime - per-session knobs, resolved when each session is created.
   * @param create - builds one session; injectable so the pool's rules are
   *   testable without spawning a CLI.
   */
  constructor(
    maxSessions: Live<number>,
    runtime: CodeBuddySessionRuntime = {},
    private readonly create: (sessionId: string, model: string) => CodeBuddySession =
      (sessionId, model) => new CodeBuddySession(sessionId, model, runtime),
    idleMs?: Live<number>,
  ) {
    this.pool = new SessionPool<RegionSlot>({ label: 'CodeBuddy', maxSessions, idleMs })
  }

  forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession {
    // A region switch makes the held process answer for the other login, so it
    // is retired rather than reused. This is the one fact the shared pool cannot
    // infer: it only knows a session is busy or not.
    return this.pool.forSession(
      sessionId,
      id => bindRegion(this.create(id, model), region),
      slot => slot.region === region ? undefined : 'region',
    ).session
  }

  /** Drop one session (history diverged); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    this.pool.dispose(sessionId)
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
    this.pool.closeAll(cause)
  }

  /**
   * Drop every warm session and refuse to create more.
   *
   * Called from the plugin's dispose effect: a step prepared before the unload
   * can still be retried through this adapter, and a session created then would
   * outlive every owner it has.
   */
  seal(cause: CloseCause = 'dispose'): void {
    this.pool.seal(cause)
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
  chunks.push(...textStreamChunks(text, approximateUsage(prompt, text)))
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}
