/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */

import { randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, ToolCallId,
  isContextWindowExceededError, isQuotaExceededError, textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, ToolSchema, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { createSdkMcpServer } from '@qodercn-ai/qodercn-agent-sdk'
import type { CanUseTool, Query } from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from '../../core/brand.ts'
import { cliConflictMessage, cliFailureText, foreignCliOverride, qoderCliOptions, resolveQoderCli } from '../../infra/cli.ts'
import type { CloseCause } from '../../core/lifecycle.ts'
import { CloseGate, DEFAULT_DRAIN_MS, closeFinishReason } from '../../core/lifecycle.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { trace } from '../../infra/log.ts'
import { bareHostToolName } from '../../core/mcp-naming.ts'
import { feedImageRefs, feedTextLength, feedWideCharCount, renderInitialFeed } from '../../core/render.ts'
import { isDaemonConflict, loadSdk, probeDaemon, resetSdk } from '../../infra/sdk.ts'
import { TurnOutputAccounting, estimateTextTokens } from '../../core/tokens.ts'
import {
  HostToolRegistry, MCP_SERVER_NAME, ToolResultPairing, TurnQueue,
} from '../../core/host-session.ts'
import type { ChannelContent, McpContent, ResolvedImages, ToolRegistryHost } from '../../core/host-session.ts'


/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/**
 * How long a handler the CLI never announced waits for a result before failing.
 *
 * Paired handlers are settled by the host request that follows them, not by
 * this deadline: a host tool may legitimately run far longer than two minutes,
 * and a wall clock cannot tell a slow tool from a lost call.
 */
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 120_000
/** How long the inner process gets to acknowledge an abort before the turn is force-ended. */
const DEFAULT_ABORT_GRACE_MS = 5_000

/**
 * One content block as the assistant message actually carries it.
 *
 * The SDK's declared content type names only `text`, but the wire carries the
 * full block shape, including the `tool_use` blocks a tool-heavy turn spends
 * most of its output on. This is the local view used to read them.
 */
interface WireContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

/**
 * Runtime knobs shared by every warm session a manager owns. Populated from the
 * plugin's resolved config, so the settings page is the single place these are
 * decided.
 *
 * Each value may be a {@link Live} thunk and is resolved when a session is
 * created, not when the manager is: a settings edit therefore applies to the
 * sessions opened after it, while a conversation already in flight keeps the
 * knobs it started with.
 */
export interface SessionRuntimeOptions {
  /** How long an unpaired MCP tool handler waits before failing its call. */
  toolResultTimeoutMs?: Live<number>
  /** How long the inner process gets to acknowledge an abort. */
  abortGraceMs?: Live<number>
  /**
   * How long an in-flight turn may keep running after a close was requested.
   *
   * Read per close, so a settings edit applies to the next reload rather than
   * to the process that is already shutting down.
   */
  drainMs?: Live<number>
  /** Which edition's SDK and CLI this session speaks to. */
  brand?: QoderBrand
}

/** Per-request model policy a warm session runs with. */
export interface SessionModelPolicy {
  reasoningEffort?: string
  /**
   * The window the route publishes to the harness, and the one the CLI is asked
   * to run with.
   */
  contextWindow?: number
  /**
   * The window the CLI will *actually* run with, when that differs from the
   * declared one because the model does not advertise it. The CLI measures its
   * context ratio against this, so it is the only honest multiplier for that
   * ratio — see {@link QoderSession.usage}.
   */
  cliContextWindow?: number
}





interface ChannelMessage {
  type: 'user'
  message: { role: 'user', content: ChannelContent[] }
  parent_tool_use_id: null
}

/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel(): AsyncIterable<ChannelMessage> & { push(message: ChannelMessage): void } {
  const queue: ChannelMessage[] = []
  let resolve: ((result: IteratorResult<ChannelMessage>) => void) | null = null
  return {
    push(message: ChannelMessage): void {
      if (resolve !== null) {
        const settle = resolve
        resolve = null
        settle({ value: message, done: false })
      } else {
        queue.push(message)
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ChannelMessage> {
      return {
        next(): Promise<IteratorResult<ChannelMessage>> {
          const message = queue.shift()
          if (message !== undefined) return Promise.resolve({ value: message, done: false })
          return new Promise(settle => { resolve = settle })
        },
      }
    },
  }
}





/** One tool-use block under assembly in the active turn. */
interface ToolUnderAssembly {
  chunkIndex: number
  callId: string
  name: string
  arguments: string
}

/**
 * Structural view of the SDK usage this consumer forwards to the harness.
 *
 * Every field is optional because the CLI zeroes the four token counters unless
 * it was started with the switch in `cli.ts`; `credits` and the context ratio
 * survive either way. {@link meteredUsage} decides what is real.
 */
export interface SdkUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  /** The CLI's own measurement of how full this session's context is. */
  context_usage_ratio?: number | null
}

/** Structural view of the SDK stream events this consumer cares about. */
interface SdkStreamEvent {
  type: string
  content_block?: { type?: string, id?: string, name?: string, input?: unknown }
  delta?: { type?: string, text?: string, thinking?: string, partial_json?: string }
  usage?: SdkUsage
  message?: { content?: unknown, usage?: SdkUsage }
}

/** The frame fields the request-usage sampler reads. */
export interface UsageFrame {
  type: string
  event?: SdkStreamEvent
  usage?: SdkUsage
}

/** Structural view of the SDK messages this consumer cares about. */
export interface SdkMessage extends UsageFrame {
  subtype?: string
  message?: { content?: Array<{ type?: string, text?: string }>, usage?: SdkUsage }
  errors?: unknown
}

/**
 * Whether a usage record carries real metering rather than the CLI's zero filler.
 *
 * The CLI attaches a usage record to several frames and leaves the four token
 * counters at zero on all but one kind; a real request always consumed a prompt
 * and produced output, so at least one counter being positive is the whole test.
 */
export function carriesTokens(usage: SdkUsage): boolean {
  const positive = (value: number | null | undefined): boolean => typeof value === 'number' && value > 0
  return positive(usage.input_tokens) || positive(usage.output_tokens)
    || positive(usage.cache_read_input_tokens) || positive(usage.cache_creation_input_tokens)
}

/**
 * The occupancy sample one arriving frame may contribute, if any.
 *
 * Exactly one carrier may: the `message_delta` emitted when a provider request
 * finishes, whose usage describes that request's prompt — which is precisely
 * what context occupancy means. The other carriers are traps, confirmed against
 * a live CLI with a tool the inner model calls four times in one turn:
 *
 *  - `message_start`, and the assembled `assistant` message, report all four
 *    counters as zero; a request's numbers exist only once it finishes.
 *  - the `result` frame reports the WHOLE inner turn's total, summed over every
 *    provider request that turn made. One host step is one request, but an inner
 *    turn ends only when the model stops calling tools, so a long agentic run
 *    reports a multiple of any real prompt — that four-request turn ended at
 *    `input_tokens` 2 921 where each request had used 608–837. Taking that total
 *    as the session's occupancy pegged the harness context meter at 100%
 *    (9.8M against a 1M window) and latched it there.
 *
 * @param message - one arriving SDK message.
 * @returns the usage to sample, or undefined when this frame may not supply one.
 */
export function requestUsageSample(message: UsageFrame): SdkUsage | undefined {
  if (message.type !== 'stream_event') return undefined
  const usage = message.event?.usage ?? message.event?.message?.usage
  return usage !== undefined && carriesTokens(usage) ? usage : undefined
}

/**
 * One frame's own metering, translated into the harness's token buckets.
 *
 * Three rules, each measured against a live CLI rather than inferred:
 *
 * 1. `input_tokens` IS the whole prompt, cache included. The CLI measures its
 *    `context_usage_ratio` as `input_tokens / window` (a probe: 9 811 input at
 *    a 200 000 window → exactly 0.049055) and subtracts the cached part
 *    afterwards for its own telemetry — so the harness's four buckets, which
 *    are disjoint, have to take both cache halves back out of `inputTokens`.
 * 2. Both cache buckets are always reported, zero included. The harness shows a
 *    turn's usage only when its accounting is complete: a missing cache bucket
 *    with no `totalTokens` to prove the sum makes the whole disclosure
 *    unavailable, so omitting a zero would hide every per-turn usage row.
 * 3. `totalTokens` is the sum of the four buckets, so the harness's
 *    consistency check (`total - output == input + cacheRead + cacheWrite`)
 *    holds by construction.
 *
 * @param real - the CLI's usage frame, or undefined when it reported none.
 * @param reasoning - the local reasoning estimate, clamped inside the provider's
 *   own output total (the harness drops a reading whose reasoning exceeds it).
 * @returns the harness usage, or undefined when the frame carries no metering.
 */
export function meteredUsage(
  real: SdkUsage | undefined,
  reasoning: (meteredOutput: number) => { reasoningTokens?: number },
): TokenUsage | undefined {
  if (real === undefined
    || typeof real.input_tokens !== 'number'
    || typeof real.output_tokens !== 'number'
    || (real.input_tokens <= 0 && real.output_tokens <= 0)) return undefined
  const cacheReadTokens = typeof real.cache_read_input_tokens === 'number' ? real.cache_read_input_tokens : 0
  const cacheWriteTokens = typeof real.cache_creation_input_tokens === 'number' ? real.cache_creation_input_tokens : 0
  const inputTokens = Math.max(0, real.input_tokens - cacheReadTokens - cacheWriteTokens)
  const outputTokens = real.output_tokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    ...reasoning(outputTokens),
  }
}

/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip every prefix layer on the
 * way out. See {@link stripMcpNamespace} for why one layer is not enough.
 */
export function hostToolName(name: string): string {
  return bareHostToolName(name, MCP_SERVER_NAME)
}

/** Deny native tools, allow this adapter's MCP tools. */
export async function gateTools(toolName: string, _input: unknown, options: { toolUseID?: string }): Promise<unknown> {
  const echo = options.toolUseID !== undefined ? { toolUseID: options.toolUseID } : {}
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return { behavior: 'allow', ...echo }
  return {
    behavior: 'deny',
    message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
    ...echo,
  }
}



/** The SDK permission callback shape this adapter implements per session. */
type SessionCanUseTool = (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<unknown>

/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export class QoderSession {
  private readonly channel = createChannel()
  /**
   * Lazy: the MCP SDK refuses tool registration after the transport connects,
   * so the inner process only spawns once {@link ensureTools} has registered
   * the host tools (the adapter does that immediately before each stream).
   */
  private q: Query | null = null
  /**
   * Tool-result pairing state. Owned by the session rather than the turn,
   * because a handler can fire after its turn has ended — see
   * {@link ToolResultPairing} for the measurement that proves it.
   */
  private readonly pairing = new ToolResultPairing()
  private readonly mcp = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: [] })
  /**
   * Reconciles the live host tool list into {@link mcp}.
   *
   * The session outlives the host's tool list: `dsh-ops` publishes a different
   * set per mode and `ops_discover_tools` adds capabilities mid-conversation.
   * Installing only what is new left the server unable to ever replace a
   * changed schema (the MCP SDK refuses a duplicate name), so this owns the
   * add/update/remove bookkeeping instead of a name→hash map.
   */
  private readonly registry = new HostToolRegistry(
    this.mcp.instance as unknown as ToolRegistryHost,
    () => async (_args: unknown): Promise<{ content: McpContent[], isError?: boolean }> => {
      const result = await this.pairing.claim(this.toolResultTimeoutMs)
      return {
        content: result.content,
        ...result.isError ? { isError: true } : {},
      }
    },
    // A tool the SDK refused is invisible to the model, and the model then calls
    // it, gets `Tool "…" does not exist in the current tool set.` from the CLI,
    // and never reaches this pairing. Log it rather than let it pass silently.
    message => console.warn(`[dsh-agent-sdk-bridge] ${message}`),
  )
  private queue: TurnQueue | null = null
  private model: string
  private reasoningEffort: string | undefined
  private callCounter = 0
  /**
   * Per-instance suffix for emitted host call ids. Ids must stay unique across
   * the whole host session log: a history divergence rebuilds this class, LRU
   * eviction recreates it, and the harness keys tool-call blocks by id, so a
   * fresh `qoder-1` would collide with the one its predecessor already stored.
   */
  private readonly callNonce = randomUUID().slice(0, 8)
  private abortPending = false
  private disposed = false
  /**
   * Deferred-close state: why this session was asked to stop, and whether an
   * in-flight turn is being allowed to finish first.
   *
   * The harness consumes this session's chunks, not the subprocess's, so a turn
   * that already started streaming can still deliver its answer after the
   * plugin was unloaded. Killing the CLI at dispose time instead truncated it
   * and reported `STREAM_CLOSED` — a plugin reload shown as a dropped network
   * connection. See {@link CloseGate}.
   */
  private readonly closeGate: CloseGate
  /** Wall clock of the spawn, for the close log's lifetime figure. */
  private spawnedAt: number | undefined
  /**
   * How the active turn ended, so its cleanup can tell a completed turn (whose
   * unclaimed announcements may still belong to a handler about to fire) from an
   * aborted or failed one (where the CLI cancelled that dispatch).
   */
  private turnEndKind: FinishReason['kind'] | undefined = undefined
  /** Previous request's messages for delta feeding. */
  fedMessages: readonly RequestMessage[] | undefined
  fedSystem: string | undefined
  /** This turn's fed characters, reset per turn for per-call token accounting. */
  turnInputChars = 0
  /** Host system prompt captured before spawn for the boot-time systemPrompt. */
  private hostSystem: string | undefined
  /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
  private sessionCwd: string | undefined

  // Active-turn assembly state, touched only by the consumer fiber.
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private openTool: ToolUnderAssembly | undefined
  private toolCalls: ToolUnderAssembly[] = []
  /**
   * This turn's generated output, priced by script.
   *
   * Counts visible text, reasoning, and tool-call names and arguments — see
   * {@link TurnOutputAccounting} for why the last one matters.
   */
  private readonly output = new TurnOutputAccounting()
  /**
   * Metering of the last provider request that finished in the active turn.
   *
   * Never the `result` frame's usage, which totals the whole inner turn across
   * every request it made — see {@link requestUsageSample}.
   */
  private lastUsage: SdkUsage | undefined
  /**
   * The active turn's feed as plain text, when that feed carries image bytes.
   * Kept so a CLI that refuses to decode those bytes can be retried without
   * them instead of failing the turn. Cleared with the turn.
   */
  private feedFallback: string | undefined
  /**
   * Session-level input token estimate for the CURRENT request, priced by
   * script mix over the rendered conversation the inner session actually
   * receives. It is the last-resort tier of {@link usage}: a turn whose frames
   * carry no metering at all would otherwise read ~0% on the context meter and
   * never trigger auto-compaction, and the CLI's own context ratio is preferred
   * over this whenever the turn reported one.
   */
  private estimatedInputTokens: number | undefined
  /**
   * The window this route publishes, i.e. the denominator the harness meter
   * divides by. The CLI's context ratio is turned into tokens against this same
   * number, so the meter and the ratio always describe one window.
   */
  private contextWindow: number | undefined
  /**
   * The window the CLI will actually run with, when that is known to differ
   * from {@link contextWindow} because the model does not advertise the
   * declared one. This is the denominator the CLI itself measures its context
   * ratio against, so it is what the ratio must be multiplied by.
   */
  private cliContextWindow: number | undefined

  /** Per-session runtime knobs, resolved from the plugin config at creation. */
  private readonly toolResultTimeoutMs: number
  private readonly abortGraceMs: number
  /** Which edition's CLI (and SDK) this session runs on. */
  private readonly brand: QoderBrand
  /** How long a close waits for the in-flight turn; read per close. */
  private readonly drainMs: () => number

  constructor(
    readonly sessionId: string,
    initialModel: string,
    runtime: SessionRuntimeOptions = {},
  ) {
    this.model = initialModel
    this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, DEFAULT_TOOL_RESULT_TIMEOUT_MS)
    this.abortGraceMs = readLive(runtime.abortGraceMs, DEFAULT_ABORT_GRACE_MS)
    this.brand = runtime.brand ?? 'cn'
    this.drainMs = () => readLive(runtime.drainMs, DEFAULT_DRAIN_MS)
    this.closeGate = new CloseGate(
      this.drainMs,
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

  /** Spawn the inner process (first stream only) and attach the consumer. */
  private async ensureStarted(): Promise<Query> {
    if (this.q !== null) return this.q
    // The SDK reads QODERCLI_PATH itself before any option we pass, so a
    // foreign value must fail the turn instead of answering with the other
    // account's CLI. See `cli.ts`.
    const conflict = foreignCliOverride(this.brand)
    if (conflict !== undefined) throw new Error(cliConflictMessage(this.brand))
    // No CLI of our own: do not let the SDK initialize its daemon from nothing,
    // or the first query after the CLI is installed conflicts with it (see
    // `sdk.ts`).
    if (resolveQoderCli(this.brand) === undefined) throw new Error(cliConflictMessage(this.brand))
    // A turn that has started streaming cannot be retried, so make the daemon
    // prove it accepts the current configuration first. A failure here is not
    // fatal by itself (the account may simply be signed out); only the
    // configuration conflict matters, and it is answered by dropping the SDK
    // instance so the query below is built on a fresh daemon.
    try {
      await probeDaemon(this.brand)
    } catch (error) {
      if (isDaemonConflict(error)) resetSdk(this.brand)
    }
    // The SDK is brand-specific: the CN module speaks to qoderclicn and the
    // international one to qodercli, each against its own credentials.
    const sdk = await loadSdk(this.brand)
    // Declare the tools capability before this server connects. `query()` below
    // connects it, and the SDK refuses a capability change afterwards — so a
    // session whose first turn published no host tools would connect without a
    // tools capability, and every tool the host offered later could only throw.
    this.registry.prepare()
    const q = sdk.query({
      prompt: this.channel,
      options: {
        // Spawn the CLI instead of running its runtime in a worker thread: in
        // this process that thread's sharp fights the host's own over the
        // libvips DLL every image needs. See `cli.ts`.
        ...qoderCliOptions(this.brand),
        auth: sdk.qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: this.canUseTool as CanUseTool,
        settingSources: [],
        includePartialMessages: true,
        resolveModel: () => ({
          model: this.model,
          // The window travels with the model, because it is a property of the
          // route rather than of one call. It has to be sent here: the CLI
          // measures its `context_usage_ratio` against the window it is actually
          // running with, so a deployment that declares 1M while the CLI still
          // assumes the model's own 200K gets a ratio five times too large, and
          // the meter that multiplies by the declared window inherits that error
          // exactly (see `usage()` in this file).
          ...this.reasoningEffort === undefined && this.contextWindow === undefined
            ? {}
            : {
                parameters: {
                  ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
                  ...this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow },
                },
              },
        }),
        mcpServers: { [MCP_SERVER_NAME]: this.mcp },
        allowedMcpServerNames: [MCP_SERVER_NAME],
        // Host prompt passes through verbatim: no qodercli preset, so its
        // injected workspace/environment fields never reach the model.
        ...this.hostSystem === undefined ? {} : { systemPrompt: this.hostSystem },
        ...this.sessionCwd === undefined ? {} : { cwd: this.sessionCwd },
      },
    })
    // A close can arrive while the CLI is booting (the plugin is unloaded, the
    // pool reclaims the slot). Adopting the process then would leave a
    // subprocess behind that the teardown already ran without.
    if (this.disposed || this.closeGate.closing) {
      void q.close().catch(() => undefined)
      throw new LlmError(`qoder session ${this.sessionId} closed while starting`, 'INVALID_REQUEST')
    }
    this.q = q
    this.spawnedAt = Date.now()
    trace('session/spawn', { session: this.sessionId, brand: this.brand })
    void this.consume(q)
    return q
  }

  /** Point the session at a model and its per-request policy. */
  setModel(model: string, policy?: SessionModelPolicy): void {
    this.model = model
    this.reasoningEffort = policy?.reasoningEffort
    this.contextWindow = policy?.contextWindow
    this.cliContextWindow = policy?.cliContextWindow
  }

  /** Record the host system prompt; effective only before the process spawns. */
  setSystem(system: string | undefined): void {
    this.hostSystem = system
  }

  /**
   * Record the host session workspace; effective only before the process
   * spawns. qodercli inherits the host process cwd otherwise, which would
   * make its preset report the server's launch directory instead of the
   * session's workspace.
   */
  setCwd(cwd: string | undefined): void { this.sessionCwd = cwd }

  /**
   * Permission gate for the inner process. Native tools are denied; MCP host
   * tools are allowed, and each allowed call's qodercli tool-use id is recorded
   * so the matching MCP handler can park under the exact id (qodercli asks once
   * per call, in execution order, before dispatching the MCP message).
   */
  private canUseTool: SessionCanUseTool = (toolName, _input, options) => {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      if (options.toolUseID !== undefined) this.pairing.announce(options.toolUseID)
      return Promise.resolve({ behavior: 'allow', ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID } })
    }
    return Promise.resolve({
      behavior: 'deny',
      message: '本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。',
      ...options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID },
    })
  }

  /**
   * Make this session's MCP tool set match the host's live tool list.
   *
   * The host adds and withdraws tools during a conversation (`dsh-ops` mode
   * switches, `ops_discover_tools`), so this reconciles rather than only adds:
   * a tool that appears mid-session is registered, a changed schema is updated
   * in place, and a withdrawn tool is removed. See {@link HostToolRegistry} for
   * the failure this prevents — the model calling a name the MCP server no
   * longer had, which the CLI answers with `Tool "…" does not exist in the
   * current tool set.` instead of a host result.
   */
  ensureTools(tools: readonly ToolSchema[]): void {
    this.registry.reconcile(tools)
  }

  /**
   * Deliver host tool results to parked or buffered handlers, keyed by call id,
   * and settle the previous round at this request boundary.
   * @param tail - the host messages appended since the previous request.
   * @param images - adapter-resolved request images keyed by attachment id; an
   *   id missing from the map degrades to handle text.
   */
  deliverToolResults(tail: readonly RequestMessage[], images?: ResolvedImages): void {
    let freshUserTurn = false
    const delivered = new Set<string>()
    for (const message of tail) {
      if (message.role === 'user') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'tool') continue
      delivered.add(this.pairing.deliver(String(message.toolCallId), {
        content: renderResultContent(message.content, images),
        isError: message.isError === true,
      }))
    }
    // This request either answers the previous round's calls or supersedes
    // them; either way, the parked handlers must not wait for a timeout that
    // no longer exists. See {@link ToolResultPairing.beginHostRequest}.
    this.pairing.beginHostRequest(delivered, freshUserTurn)
  }

  /**
   * Run one inner turn: feed (if any) then pump consumer chunks until finish.
   * @param options - the host request (signal; tools already registered).
   * @param feed - literal text, resolved content blocks (a vision turn), or
   *   null for a pure tool-result continuation.
   * @param fallback - the same feed rendered as text. Used only if the inner
   *   CLI refuses the turn's image bytes, in which case the turn is resent
   *   without them rather than failing (see {@link retryWithoutImages}).
   */
  async *stream(
    options: GenerateOptions,
    feed: string | readonly ChannelContent[] | null,
    fallback?: string,
  ): AsyncGenerator<StreamChunk> {
    // `INVALID_REQUEST` rather than a bespoke `CONFLICT`: 0.2.2 narrowed
    // `LlmError`'s code from `string` to `BuiltinLlmFailureCode` and dropped
    // `CONFLICT` from the union. This code is the closest non-retryable match
    // (a second turn on a session that already has one is an invalid request),
    // and it is valid on the older `string` signature too.
    if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, 'INVALID_REQUEST')
    // A closing session must not be revived by a retry: the pool has already
    // handed its slot away or the plugin that owned it is gone. `TRANSPORT`
    // would be the wrong code here — it is in `dsh-llm`'s default retryable set,
    // so the harness would re-dispatch this step into a session that can never
    // answer it.
    if (this.disposed || this.closeGate.closing) {
      throw new LlmError(`qoder session ${this.sessionId} is closed (${this.closeGate.cause ?? 'disposed'})`, 'INVALID_REQUEST')
    }
    let q: Query
    try {
      q = await this.ensureStarted()
    } catch (error) {
      // The session was closed while its CLI booted: report that close rather
      // than a start failure, and never adopt the process (see ensureStarted).
      const cause = this.closeGate.cause
      if (cause === undefined) throw error
      yield { type: 'finish', reason: closeFinishReason(cause) }
      return
    }
    this.queue = new TurnQueue()
    this.resetTurnState()
    if (feed !== null) {
      const content: ChannelContent[] = typeof feed === 'string' ? [{ type: 'text', text: feed }] : [...feed]
      this.feedFallback = fallback !== undefined && content.some(block => block.type === 'image') ? fallback : undefined
      this.turnInputChars += contentChars(content)
      this.channel.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
    }
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      // interrupt() rides the same transport a teardown may already have killed
      // (a host abort racing process shutdown); its rejection must not surface
      // as an unhandled promise rejection.
      void q.interrupt().catch(() => undefined)
      // Fallback: end the turn if the inner process does not settle promptly.
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'qoder session aborted by host', code: 'ABORTED' } }), this.abortGraceMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        if (item.usage !== undefined) {
          yield { type: 'usage', usage: this.usage() }
        }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      // An aborted or failed turn is one where qodercli cancels whatever tool
      // dispatch it had not yet made. Announcements it never spent would shift
      // the next turn's handler onto the wrong id, so they are dropped here —
      // see {@link ToolResultPairing.forgetUnclaimed}.
      if (this.turnEndKind === 'aborted' || this.turnEndKind === 'error') this.pairing.forgetUnclaimed()
      this.queue = null
      this.abortPending = false
      this.feedFallback = undefined
      // A close that was waiting for this turn may now finish. This is also the
      // path a host-cancelled turn takes, so a drain never outlives its turn.
      this.closeGate.settled()
    }
  }

  /**
   * Resend the current turn without its images after the CLI refused them.
   *
   * The inner CLI decodes every image before the model sees the turn, and a
   * decode it cannot do fails that whole turn — the host would surface an error
   * for a question whose only problem was the pixels. The failed turn never
   * reached the model, so the same turn goes out again with the images replaced
   * by the harness's own handle text, the same text a text-only route renders,
   * and the user still gets an answer.
   *
   * @param detail - the failed result frame's subtype and errors.
   * @returns whether a retry was started, in which case the turn must not be
   *   ended: the retry's own result frame settles it.
   */
  private retryWithoutImages(detail: string): boolean {
    const fallback = this.feedFallback
    if (fallback === undefined || !isImageAttachFailure(detail)) return false
    // Anything already streamed belongs to a real answer this turn produced:
    // resending would duplicate it instead of replacing it.
    if (this.textBlock !== undefined || this.reasoningBlock !== undefined
      || this.toolCalls.length > 0 || this.output.outputChars > 0) return false
    this.feedFallback = undefined
    this.resetTurnState()
    this.turnInputChars += fallback.length
    this.channel.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: fallback }] },
      parent_tool_use_id: null,
    })
    return true
  }

  /**
   * Ask the session to stop serving.
   *
   * The request is remembered rather than acted on immediately: an in-flight
   * turn is allowed to finish (up to `drainMs`), because its chunks are being
   * consumed by the harness and truncating them turns a plugin reload into a
   * bogus stream failure. {@link teardown} does the actual work.
   *
   * @param cause - why it is closing; decides how an interrupted turn is
   *   reported and how the close is logged.
   */
  close(cause: CloseCause = 'dispose'): void {
    const outcome = this.closeGate.request(cause, this.busy)
    if (outcome === 'draining') trace('session/drain', { session: this.sessionId, brand: this.brand, cause })
  }

  /**
   * End a turn that outlived its drain window, then let the teardown run.
   *
   * The subprocess is about to die, so the turn must not be left waiting for a
   * `result` frame that will never arrive.
   */
  private forceEnd(cause: CloseCause): void {
    this.endTurn(closeFinishReason(cause))
  }

  /** Tear the inner process down; parked calls die with it. Runs once. */
  private teardown(): void {
    if (this.disposed) return
    this.disposed = true
    const q = this.q
    this.q = null
    // Parked handlers die with the process, but their promises must not outlive
    // it: dropping the pairing state releases anything still waiting.
    this.pairing.clear()
    void q?.close().catch(() => undefined)
    trace('session/close', {
      session: this.sessionId,
      brand: this.brand,
      cause: this.closeGate.cause ?? 'dispose',
      aliveMs: this.spawnedAt === undefined ? 0 : Date.now() - this.spawnedAt,
    })
  }

  /**
   * Reset the per-turn assembly state.
   *
   * Pairing state is deliberately NOT touched here. It looks turn-scoped, but a
   * `tools/call` handler can fire only after the turn that announced it has
   * already ended — the host answers a tool call the moment it sees the block,
   * and the CLI dispatches the MCP message some milliseconds later. Clearing
   * announcements at this boundary made that handler claim nothing, park under a
   * fallback key, and wait out the whole tool-result timeout; see
   * {@link ToolResultPairing}. {@link QoderSession.close} drops it with the
   * session, and an aborted turn drops what it can no longer claim.
   */
  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.openTool = undefined
    this.toolCalls = []
    this.turnInputChars = 0
    this.output.reset()
    this.lastUsage = undefined
    this.turnEndKind = undefined
  }

  private emit(chunk: StreamChunk): void { this.queue?.push({ kind: 'chunk', chunk }) }

  /** Count generated text toward this turn's output tokens. */
  private countOutput(text: string): void { this.output.addOutput(text) }

  /**
   * Price this turn's generated text, by script rather than at a flat rate.
   *
   * {@link TurnOutputAccounting} owns the counters and the harness invariant
   * that `reasoningTokens` is a subset of `outputTokens` — the harness discards
   * a whole reading when it is not.
   */
  private outputUsage(): { outputTokens: number, reasoningTokens?: number } {
    return this.output.usage()
  }

  private usage(): TokenUsage {
    // Two tiers, most authoritative first. The CLI's own metering is now
    // available, because the child is started with the switch that keeps it from
    // zeroing the counters on the way out (`cli.ts`) — including the cache
    // buckets, which is the only thing that can make `缓存命中` mean anything.
    const metered = meteredUsage(this.lastUsage, output => this.output.reasoningTokensWithin(output))
    if (metered !== undefined) return metered
    // Below this line the turn carried no usable metering at all: a CLI build
    // that predates the switch, the in-process worker transport that cannot be
    // handed an environment, or a turn that died before its result frame.
    //
    // Such a session still reports how full its context is, and that ratio comes
    // from the inner model's own tokenizer. It is a fraction of the window the
    // CLI is RUNNING with, which is not always the window this plugin declared:
    // the CLI only honours a window the model advertises, and silently keeps its
    // own default otherwise. Multiplying by the declared window in that case
    // inflates every reading by the ratio of the two (5x for a 1M override on a
    // 200K-only model), so prefer the window the CLI actually uses and fall back
    // to the declared one only when the catalog could not tell us.
    const ratioWindow = this.cliContextWindow ?? this.contextWindow
    const ratio = this.lastUsage?.context_usage_ratio
    if (typeof ratio === 'number' && ratio > 0 && typeof ratioWindow === 'number' && ratioWindow > 0) {
      // Measured prompt-only: the ratio does NOT include the reply this turn is
      // still producing, so adding `outputTokens` below cannot double-count.
      return this.estimatedUsage(Math.min(ratioWindow, Math.max(1, Math.ceil(ratio * ratioWindow))))
    }
    // No metering available: price the request ourselves. Without this the
    // context meter would read ~0% and auto-compaction would never fire.
    if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
      return this.estimatedUsage(this.estimatedInputTokens)
    }
    return this.estimatedUsage(Math.max(1, Math.ceil(this.turnInputChars / 4)))
  }

  /**
   * One estimated turn reading, shaped exactly like a metered one.
   *
   * The cache buckets are present and zero rather than omitted: this estimate
   * prices the prompt as a single uncached block, and a missing bucket would
   * make the harness withhold the turn's usage disclosure entirely.
   *
   * @param inputTokens - the estimated prompt size, uncached by definition.
   * @returns the harness usage for the turn.
   */
  private estimatedUsage(inputTokens: number): TokenUsage {
    const output = this.outputUsage()
    return {
      inputTokens,
      ...output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + output.outputTokens,
    }
  }

  /**
   * Record the input-token estimate for the CURRENT request, priced by script
   * mix over the rendered conversation (system + messages) the inner session
   * receives. This is the fallback {@link usage} reaches for only when a turn
   * reported no metering and no context ratio — without it such a turn would
   * read ~0% on the context meter and never trigger auto-compaction.
   * @param system - the host system prompt included in this request.
   * @param messages - the full host message list included in this request.
   */
  recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void {
    const rendered = renderInitialFeed(system, messages)
    const imageTokens = feedImageRefs(rendered)
      .reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0)
    this.estimatedInputTokens = Math.max(
      1,
      Math.ceil(estimateTextTokens(feedTextLength(rendered), feedWideCharCount(rendered))) + imageTokens,
    )
  }

  private endTurn(reason: FinishReason, usage?: TokenUsage): void {
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
    this.queue.push({ kind: 'turn-end', reason, usage: usage ?? this.usage() })
    this.queue.close()
    const code = reason.kind === 'error' || reason.kind === 'aborted' ? reason.failure.code : undefined
    trace('turn/end', {
      session: this.sessionId,
      brand: this.brand,
      kind: reason.kind,
      ...code === undefined ? {} : { code },
      chars: this.output.outputChars,
      ...this.closeGate.cause === undefined ? {} : { cause: this.closeGate.cause },
    })
  }

  private async consume(q: Query): Promise<void> {
    try {
      const iterator = q[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        try {
          this.handle(next.value as SdkMessage)
        } catch (error) {
          this.endTurn({ kind: 'error', failure: { message: `qoder session consumer failed: ${String(error)}`, code: 'BACKEND_ERROR' } })
        }
      }
      // `done` has two meanings, and they must not share an error code. A close
      // this plugin asked for (reload, eviction, account switch) ends the turn
      // as `aborted`, so the UI and the retry policy both see "the host moved
      // this session", not "the provider dropped the connection".
      const cause = this.closeGate.cause
      if (cause !== undefined) {
        this.endTurn(closeFinishReason(cause))
        return
      }
      trace('session/stream-ended', {
        session: this.sessionId,
        brand: this.brand,
        chars: this.output.outputChars,
      })
      this.endTurn({ kind: 'error', failure: { message: 'qoder session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
    } catch (error) {
      // The SDK's daemon refuses a configuration that changed after it started.
      // That poisons the whole module instance, so every later query would fail
      // the same way; dropping it here lets the next turn start a fresh daemon
      // instead of inheriting the broken one.
      if (isDaemonConflict(error)) {
        resetSdk(this.brand)
        this.q = null
        void q.close().catch(() => undefined)
      }
      this.endTurn({ kind: 'error', failure: { message: `qoder session died: ${cliFailureText(String(error), this.brand)}`, code: 'TRANSPORT' } })
    }
  }

  private handle(message: SdkMessage): void {
    if (message.type === 'stream_event') {
      const event = message.event
      if (event === undefined) return
      // Only a finished request may move the occupancy sample; see
      // {@link requestUsageSample} for which frames carry what.
      const sample = requestUsageSample(message)
      if (sample !== undefined) this.lastUsage = sample
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'tool_use') {
            // Only host-visible tool calls may be emitted: blocks that arrive
            // while no host stream is active can never be delivered, and their
            // canUseTool/handler sequence is paired by tool-use id anyway, so
            // skipping them keeps the host transcript consistent.
            if (this.queue === null || this.queue.isClosed) break
            const callId = `qoder-${this.callNonce}-${++this.callCounter}`
            if (typeof block.id === 'string' && block.id.length > 0) {
              this.pairing.mapHostCall(callId, block.id)
            }
            const chunkIndex = this.blockIndex++
            const initialArguments = block.input !== undefined && block.input !== null && Object.keys(block.input as object).length > 0
              ? JSON.stringify(block.input)
              : ''
            this.openTool = {
              chunkIndex,
              callId,
              name: hostToolName(block.name ?? ''),
              arguments: initialArguments,
            }
            // Tool-call arguments are generated output, and on an agentic turn
            // they are most of it — measured at 86% of the characters in a
            // three-call turn. The harness prices a tool-call block as
            // `name + arguments` and derives `tok/s` from the output tokens an
            // adapter reports, so leaving them out under-reports speed several
            // fold on exactly the multi-step turns where speed is worth reading.
            // Streaming turns deliver the body through `input_json_delta` and
            // leave `block.input` empty, so this counts only the non-streaming
            // case; the two can never both carry the same bytes.
            this.countOutput(this.openTool.name)
            this.countOutput(initialArguments)
            this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
            this.emit({
              type: 'tool-call-delta',
              index: chunkIndex,
              id: ToolCallId(callId),
              name: this.openTool.name,
              argumentsDelta: '',
            })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta === undefined) return
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
            this.emit({
              type: 'tool-call-delta',
              index: this.openTool.chunkIndex,
              id: ToolCallId(this.openTool.callId),
              argumentsDelta: delta.partial_json,
            })
          }
          break
        }
        case 'content_block_stop': {
          if (this.openTool !== undefined) {
            this.emit({
              type: 'block-end',
              index: this.openTool.chunkIndex,
              block: {
                type: 'tool-call',
                id: ToolCallId(this.openTool.callId),
                name: this.openTool.name,
                arguments: this.openTool.arguments,
              },
            })
            this.toolCalls.push(this.openTool)
            this.openTool = undefined
          }
          break
        }
        case 'message_stop': {
          if (this.toolCalls.length > 0) this.endTurn({ kind: 'tool-calls' })
          break
        }
        default: break
      }
      return
    }
    if (message.type === 'assistant') {
      // No usage is taken from an assembled message: it reports zeros (see
      // {@link requestUsageSample}), and the request frame already supplied the
      // turn's metering.
      // Fallback for turns that streamed no partial events: price whatever the
      // finished message carries, including any tool-call arguments.
      if (this.textBlock === undefined && this.toolCalls.length === 0) {
        // The declared content type only names `text`, but the wire carries the
        // full block shape; tool_use blocks are what a tool-heavy turn spends
        // its output on, so they are read through a local view of that shape.
        const content = (message.message?.content ?? []) as readonly WireContentBlock[]
        for (const block of content) {
          if (block.type !== 'tool_use') continue
          this.countOutput(block.name ?? '')
          this.countOutput(JSON.stringify(block.input ?? ''))
        }
        const text = content
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join('')
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
      // The result frame's usage is NOT sampled: it totals the whole inner turn
      // across every provider request, which on a long agentic run is many times
      // the live prompt — see {@link requestUsageSample}. This frame still ends
      // the turn; the occupancy sample stays the last finished request's.
      if (this.abortPending) {
        this.endTurn({ kind: 'aborted', failure: { message: 'qoder turn aborted by host', code: 'ABORTED' } })
        return
      }
      if (this.toolCalls.length > 0) {
        this.endTurn({ kind: 'tool-calls' })
        return
      }
      if (message.subtype === 'success' || message.subtype === undefined) {
        if (this.textBlock === undefined && this.reasoningBlock === undefined) {
          this.endTurn({
            kind: 'error',
            failure: { message: 'qoder model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          })
        } else {
          this.endTurn({ kind: 'stop' })
        }
        return
      }
      const detail = `${message.subtype} ${safeErrors(message.errors)}`
      if (this.retryWithoutImages(detail)) return
      this.endTurn({
        kind: 'error',
        failure: { message: `qoder turn failed: ${detail}`, code: classifyTurnError(detail) },
      })
    }
  }
}

/**
 * Render tool-result content blocks into the MCP content the inner model
 * reads: text passes through, an image resolves from {@link images} into the
 * MCP image shape or degrades to the harness's own handle text, and anything
 * else is serialized.
 */
export function renderResultContent(blocks: readonly ContentBlock[], images?: ResolvedImages): McpContent[] {
  const content: McpContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const resolved = images?.get(String(block.attachment.attachmentId))
      if (resolved !== undefined) content.push({ type: 'image', data: resolved.data, mimeType: resolved.mediaType })
      else content.push({ type: 'text', text: textOnlyImageText(block.attachment) })
    } else {
      content.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  return content
}

/**
 * Vision tokens for one image, estimated with the tile formula the
 * Claude-compatible wire shape this backend follows uses (width x height / 750).
 * The inner CLI reports no usage for the pixels it consumed, so this estimate is
 * the only image occupancy the harness context meter and compaction threshold
 * can see. It is an estimate, not a provider metering figure.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  return Math.max(1, Math.ceil((width * height) / 750))
}

/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars(content: readonly ChannelContent[]): number {
  return content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
}

/** Safely stringify the SDK error payload for turn diagnostics. */
export function safeErrors(errors: unknown): string {
  if (errors === undefined) return ''
  if (typeof errors === 'string') return errors
  try { return JSON.stringify(errors) } catch { return String(errors) }
}

/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}

/**
 * Whether a failed turn is the CLI refusing an image it could not decode.
 *
 * qodercli decodes every attached image before the model sees the turn, and
 * reports such a failure with a fixed set of phrasings: the sentence it shows
 * the user, its terminal reason, and the error code underneath. The turn itself
 * is fine — only the pixels are not, which is what makes it safe to resend.
 *
 * @param detail - the failed result frame's subtype and errors.
 */
export function isImageAttachFailure(detail: string): boolean {
  return /image_processing_failed|unable to attach image|invalid or unsupported image data/i.test(detail)
}
