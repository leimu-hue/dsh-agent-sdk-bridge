/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { QoderBrand } from '../../core/brand.ts';
import type { Live } from '../../core/live.ts';
import type { ChannelContent, McpContent, ResolvedImages } from '../../core/host-session.ts';
/** Warm sessions kept alive when the deployment names no cap. */
export declare const DEFAULT_MAX_SESSIONS = 8;
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
    toolResultTimeoutMs?: Live<number>;
    /** How long the inner process gets to acknowledge an abort. */
    abortGraceMs?: Live<number>;
    /** Which edition's SDK and CLI this session speaks to. */
    brand?: QoderBrand;
}
/** Per-request model policy a warm session runs with. */
export interface SessionModelPolicy {
    reasoningEffort?: string;
    /**
     * The window the route publishes to the harness, and the one the CLI is asked
     * to run with.
     */
    contextWindow?: number;
    /**
     * The window the CLI will *actually* run with, when that differs from the
     * declared one because the model does not advertise it. The CLI measures its
     * context ratio against this, so it is the only honest multiplier for that
     * ratio — see {@link QoderSession.usage}.
     */
    cliContextWindow?: number;
}
/**
 * Structural view of the SDK usage this consumer forwards to the harness.
 *
 * Every field is optional because the CLI zeroes the four token counters unless
 * it was started with the switch in `cli.ts`; `credits` and the context ratio
 * survive either way. {@link meteredUsage} decides what is real.
 */
export interface SdkUsage {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    /** The CLI's own measurement of how full this session's context is. */
    context_usage_ratio?: number | null;
}
/** Structural view of the SDK stream events this consumer cares about. */
interface SdkStreamEvent {
    type: string;
    content_block?: {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
    };
    delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
    };
    usage?: SdkUsage;
    message?: {
        content?: unknown;
        usage?: SdkUsage;
    };
}
/** The frame fields the request-usage sampler reads. */
export interface UsageFrame {
    type: string;
    event?: SdkStreamEvent;
    usage?: SdkUsage;
}
/**
 * Whether a usage record carries real metering rather than the CLI's zero filler.
 *
 * The CLI attaches a usage record to several frames and leaves the four token
 * counters at zero on all but one kind; a real request always consumed a prompt
 * and produced output, so at least one counter being positive is the whole test.
 */
export declare function carriesTokens(usage: SdkUsage): boolean;
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
export declare function requestUsageSample(message: UsageFrame): SdkUsage | undefined;
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
export declare function meteredUsage(real: SdkUsage | undefined, reasoning: (meteredOutput: number) => {
    reasoningTokens?: number;
}): TokenUsage | undefined;
/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip every prefix layer on the
 * way out. See {@link stripMcpNamespace} for why one layer is not enough.
 */
export declare function hostToolName(name: string): string;
/** Deny native tools, allow this adapter's MCP tools. */
export declare function gateTools(toolName: string, _input: unknown, options: {
    toolUseID?: string;
}): Promise<unknown>;
/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export declare class QoderSession {
    readonly sessionId: string;
    private readonly channel;
    /**
     * Lazy: the MCP SDK refuses tool registration after the transport connects,
     * so the inner process only spawns once {@link ensureTools} has registered
     * the host tools (the adapter does that immediately before each stream).
     */
    private q;
    /**
     * Tool-result pairing state. Owned by the session rather than the turn,
     * because a handler can fire after its turn has ended — see
     * {@link ToolResultPairing} for the measurement that proves it.
     */
    private readonly pairing;
    private readonly mcp;
    /**
     * Reconciles the live host tool list into {@link mcp}.
     *
     * The session outlives the host's tool list: `dsh-ops` publishes a different
     * set per mode and `ops_discover_tools` adds capabilities mid-conversation.
     * Installing only what is new left the server unable to ever replace a
     * changed schema (the MCP SDK refuses a duplicate name), so this owns the
     * add/update/remove bookkeeping instead of a name→hash map.
     */
    private readonly registry;
    private queue;
    private model;
    private reasoningEffort;
    private callCounter;
    /**
     * Per-instance suffix for emitted host call ids. Ids must stay unique across
     * the whole host session log: a history divergence rebuilds this class, LRU
     * eviction recreates it, and the harness keys tool-call blocks by id, so a
     * fresh `qoder-1` would collide with the one its predecessor already stored.
     */
    private readonly callNonce;
    private abortPending;
    private disposed;
    /**
     * How the active turn ended, so its cleanup can tell a completed turn (whose
     * unclaimed announcements may still belong to a handler about to fire) from an
     * aborted or failed one (where the CLI cancelled that dispatch).
     */
    private turnEndKind;
    /** Previous request's messages for delta feeding. */
    fedMessages: readonly RequestMessage[] | undefined;
    fedSystem: string | undefined;
    /** This turn's fed characters, reset per turn for per-call token accounting. */
    turnInputChars: number;
    /** Host system prompt captured before spawn for the boot-time systemPrompt. */
    private hostSystem;
    /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
    private sessionCwd;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private openTool;
    private toolCalls;
    /**
     * This turn's generated output, priced by script.
     *
     * Counts visible text, reasoning, and tool-call names and arguments — see
     * {@link TurnOutputAccounting} for why the last one matters.
     */
    private readonly output;
    /**
     * Metering of the last provider request that finished in the active turn.
     *
     * Never the `result` frame's usage, which totals the whole inner turn across
     * every request it made — see {@link requestUsageSample}.
     */
    private lastUsage;
    /**
     * The active turn's feed as plain text, when that feed carries image bytes.
     * Kept so a CLI that refuses to decode those bytes can be retried without
     * them instead of failing the turn. Cleared with the turn.
     */
    private feedFallback;
    /**
     * Session-level input token estimate for the CURRENT request, priced by
     * script mix over the rendered conversation the inner session actually
     * receives. It is the last-resort tier of {@link usage}: a turn whose frames
     * carry no metering at all would otherwise read ~0% on the context meter and
     * never trigger auto-compaction, and the CLI's own context ratio is preferred
     * over this whenever the turn reported one.
     */
    private estimatedInputTokens;
    /**
     * The window this route publishes, i.e. the denominator the harness meter
     * divides by. The CLI's context ratio is turned into tokens against this same
     * number, so the meter and the ratio always describe one window.
     */
    private contextWindow;
    /**
     * The window the CLI will actually run with, when that is known to differ
     * from {@link contextWindow} because the model does not advertise the
     * declared one. This is the denominator the CLI itself measures its context
     * ratio against, so it is what the ratio must be multiplied by.
     */
    private cliContextWindow;
    /** Per-session runtime knobs, resolved from the plugin config at creation. */
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    /** Which edition's CLI (and SDK) this session runs on. */
    private readonly brand;
    constructor(sessionId: string, initialModel: string, runtime?: SessionRuntimeOptions);
    /** Spawn the inner process (first stream only) and attach the consumer. */
    private ensureStarted;
    /** Point the session at a model and its per-request policy. */
    setModel(model: string, policy?: SessionModelPolicy): void;
    /** Record the host system prompt; effective only before the process spawns. */
    setSystem(system: string | undefined): void;
    /**
     * Record the host session workspace; effective only before the process
     * spawns. qodercli inherits the host process cwd otherwise, which would
     * make its preset report the server's launch directory instead of the
     * session's workspace.
     */
    setCwd(cwd: string | undefined): void;
    /**
     * Permission gate for the inner process. Native tools are denied; MCP host
     * tools are allowed, and each allowed call's qodercli tool-use id is recorded
     * so the matching MCP handler can park under the exact id (qodercli asks once
     * per call, in execution order, before dispatching the MCP message).
     */
    private canUseTool;
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
    ensureTools(tools: readonly ToolSchema[]): void;
    /**
     * Deliver host tool results to parked or buffered handlers, keyed by call id,
     * and settle the previous round at this request boundary.
     * @param tail - the host messages appended since the previous request.
     * @param images - adapter-resolved request images keyed by attachment id; an
     *   id missing from the map degrades to handle text.
     */
    deliverToolResults(tail: readonly RequestMessage[], images?: ResolvedImages): void;
    /**
     * Run one inner turn: feed (if any) then pump consumer chunks until finish.
     * @param options - the host request (signal; tools already registered).
     * @param feed - literal text, resolved content blocks (a vision turn), or
     *   null for a pure tool-result continuation.
     * @param fallback - the same feed rendered as text. Used only if the inner
     *   CLI refuses the turn's image bytes, in which case the turn is resent
     *   without them rather than failing (see {@link retryWithoutImages}).
     */
    stream(options: GenerateOptions, feed: string | readonly ChannelContent[] | null, fallback?: string): AsyncGenerator<StreamChunk>;
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
    private retryWithoutImages;
    /** Tear the inner process down; parked calls die with it. */
    close(): void;
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
    private resetTurnState;
    private emit;
    /** Count generated text toward this turn's output tokens. */
    private countOutput;
    /**
     * Price this turn's generated text, by script rather than at a flat rate.
     *
     * {@link TurnOutputAccounting} owns the counters and the harness invariant
     * that `reasoningTokens` is a subset of `outputTokens` — the harness discards
     * a whole reading when it is not.
     */
    private outputUsage;
    private usage;
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
    private estimatedUsage;
    /**
     * Record the input-token estimate for the CURRENT request, priced by script
     * mix over the rendered conversation (system + messages) the inner session
     * receives. This is the fallback {@link usage} reaches for only when a turn
     * reported no metering and no context ratio — without it such a turn would
     * read ~0% on the context meter and never trigger auto-compaction.
     * @param system - the host system prompt included in this request.
     * @param messages - the full host message list included in this request.
     */
    recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void;
    private endTurn;
    private consume;
    private handle;
}
/**
 * Render tool-result content blocks into the MCP content the inner model
 * reads: text passes through, an image resolves from {@link images} into the
 * MCP image shape or degrades to the harness's own handle text, and anything
 * else is serialized.
 */
export declare function renderResultContent(blocks: readonly ContentBlock[], images?: ResolvedImages): McpContent[];
/**
 * Vision tokens for one image, estimated with the tile formula the
 * Claude-compatible wire shape this backend follows uses (width x height / 750).
 * The inner CLI reports no usage for the pixels it consumed, so this estimate is
 * the only image occupancy the harness context meter and compaction threshold
 * can see. It is an estimate, not a provider metering figure.
 */
export declare function estimateImageTokens(width: number, height: number): number;
/** Safely stringify the SDK error payload for turn diagnostics. */
export declare function safeErrors(errors: unknown): string;
/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export declare function classifyTurnError(detail: string): string;
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
export declare function isImageAttachFailure(detail: string): boolean;
/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export declare class QoderSessionManager {
    readonly maxSessions: Live<number>;
    private readonly runtime;
    private readonly sessions;
    /**
     * @param maxSessions - warm-session cap; read per eviction so a settings edit
     *   applies to the next session that overflows the pool.
     * @param runtime - per-session knobs, resolved when each session is created.
     */
    constructor(maxSessions?: Live<number>, runtime?: SessionRuntimeOptions & {
        coldMaxTurns?: Live<number>;
    });
    /** Existing or fresh warm session for one host session id. */
    forSession(sessionId: string, model: string): QoderSession;
    /** Drop one session (history diverged); the next request rebuilds it cold. */
    dispose(sessionId: string): void;
    closeAll(): void;
    /** One-shot turn with no warm state: side channels and cold rebuilds. */
    coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk>;
}
export {};
