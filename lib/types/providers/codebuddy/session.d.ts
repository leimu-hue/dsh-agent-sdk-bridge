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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import type { CodeBuddyRegion } from '../../core/brand.ts';
import { CodeBuddyStateStore } from '../../infra/codebuddy-state.ts';
import type { CloseCause } from '../../core/lifecycle.ts';
import type { Live } from '../../core/live.ts';
import type { ChannelContent, ResolvedImages, ToolResultPayload } from '../../core/host-session.ts';
/** Default context capacity assumed for a CodeBuddy model that declares none. */
export declare const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200000;
/** Default output cap when the catalog declares none. */
export declare const CODEBUDDY_DEFAULT_MAX_TOKENS = 32000;
/** How long one CodeBuddy account/catalog read stays fresh. */
export declare const CODEBUDDY_CACHE_TTL_MS = 300000;
/** Give up on one CodeBuddy control round trip after this long. */
export declare const CODEBUDDY_FETCH_TIMEOUT_MS = 30000;
/**
 * Whether a CLI tool name belongs to this plugin's MCP server.
 *
 * Both spellings count: the key above is the normalised one this plugin now
 * registers, while a name already in flight can still carry the hyphenated
 * form the server used to be keyed under. See {@link mcpToolPrefixes}.
 */
export declare function isHostTool(toolName: string): boolean;
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
export declare function hostToolName(toolName: string): string;
/** One model as the settings page and the adapter see it. */
export interface CodeBuddyModel {
    id: string;
    name: string;
    description?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    /**
     * Context budgets the provider actually accepts for this model.
     *
     * Empty means the model exposes no selectable window: CodeBuddy validates
     * `set_config.contextWindow` against `contextWindow.supportedLengths` and
     * rejects everything else with `Allowed: <none>`, so the settings page must
     * not offer a choice the CLI will refuse.
     */
    contextWindows: number[];
    /** The window the model actually runs with (its physical input limit). */
    defaultContextWindow: number;
    vision: boolean;
    reasoningEfforts?: string[];
    defaultEffort?: string;
    /** Credit multiplier, parsed from the catalog's `x0.79 credits` string. */
    priceFactor?: number;
}
/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
    uid?: string;
    userId?: string;
    userName?: string;
    email?: string;
    organization?: string;
    subscriptionType?: string;
}
/** One credit package inside a CodeBuddy quota reading. */
export interface CodeBuddyQuotaPackage {
    name: string;
    total: number;
    used: number;
    /** Epoch milliseconds, when the package expires. */
    end?: number;
}
/** Account credits, read from CodeBuddy's billing endpoint. */
export interface CodeBuddyQuota {
    remaining: number;
    total: number;
    used: number;
    /** Earliest still-valid package expiry, in epoch milliseconds. */
    cycleEnd?: number;
    packages: CodeBuddyQuotaPackage[];
}
/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
    at: number;
    account?: CodeBuddyAccount;
    quota?: CodeBuddyQuota;
    /** Why the quota lookup failed, when the account itself was readable. */
    quotaError?: string;
    error?: string;
}
/** Persisted per-region login and account snapshots. */
export declare const codeBuddyState: CodeBuddyStateStore;
/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
    running: boolean;
    region: CodeBuddyRegion;
    startedAt?: number;
    finishedAt?: number;
    /** Browser URL, once the CLI hands one over. */
    url?: string;
    user?: {
        userId: string;
        userName: string;
        userNickname: string;
    };
    /** Whether a usable credential is available for this region. */
    signedIn?: boolean;
    error?: string;
}
/** Turn one raw catalog entry into the model row this plugin uses. */
export declare function toCodeBuddyModel(model: RawLanguageModel): CodeBuddyModel;
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
export declare class CodeBuddyCatalog {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly controlIdleMs;
    /**
     * Notified with the advertised ids when a read advertises a different list
     * than the last one for that region. The provider route is shared by both
     * login regions, so the owner relays one notification for the route.
     */
    private readonly onChange?;
    private readonly snapshots;
    private readonly inflight;
    private readonly failures;
    /**
     * The list clients were last told about, per region.
     *
     * A refresh that answers the same ids and names stays quiet; only a real
     * change is worth making every connected GUI reload a whole model catalog.
     * Kept across {@link invalidate} — dropping the cache says "re-read", not
     * "the answer will differ".
     */
    private readonly announced;
    /** Warm control sessions, one per region, released when they go idle. */
    private readonly controls;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>, controlIdleMs?: Live<number>, 
    /**
     * Notified with the advertised ids when a read advertises a different list
     * than the last one for that region. The provider route is shared by both
     * login regions, so the owner relays one notification for the route.
     */
    onChange?: ((ids: readonly string[]) => void) | undefined);
    /**
     * The last catalog read for a region, without fetching.
     *
     * Callers that must answer synchronously (deciding whether a model exposes a
     * context-budget choice) use this instead of awaiting a refresh.
     */
    snapshot(requested?: CodeBuddyRegion): readonly CodeBuddyModel[] | undefined;
    /** Models for one region; a failed refresh keeps the last good list. */
    models(requested?: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]>;
    /**
     * Tell the owner that one region's advertised list changed, once per change.
     *
     * @param region - the region this read answered for.
     * @param models - the entries it answered with.
     */
    private announce;
    /** Why the last refresh failed, or undefined when it succeeded. */
    error(requested?: CodeBuddyRegion): string | undefined;
    invalidate(region?: CodeBuddyRegion): void;
    /**
     * Models from the region's warm control session, booting it when needed.
     *
     * A failure discards the session: the CLI may have exited on its own, and a
     * process that cannot answer one control request must not answer the next.
     * The retry is simply the next read, which starts a fresh one.
     */
    private fetch;
    /** The region's control session, booted on first use. */
    private controlSession;
    /** Release the process once the region has gone a whole idle window unused. */
    private armControl;
    /**
     * Drop the warm control session(s), so the next read boots a new process.
     *
     * Login, logout and a region switch all change what that process would
     * answer — it was started with one account's credential and one region's
     * directory — so callers must discard rather than reuse. Idle release and a
     * failed read arrive here too.
     */
    discardControl(region?: CodeBuddyRegion): void;
    /** Release every warm control session (plugin teardown). */
    close(): void;
}
/** Read the signed-in account once per TTL. */
export declare class CodeBuddyAccountReader {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly cached;
    private readonly inflight;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /**
     * The account for one region.
     *
     * A non-fresh read answers from the persisted snapshot first, so switching
     * the region selector paints immediately; the page follows with `fresh=1`
     * to replace it with a live CLI reading.
     */
    read(fresh?: boolean, requested?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot>;
    invalidate(region?: CodeBuddyRegion): void;
    private fetch;
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
export declare function authErrorText(region: CodeBuddyRegion, error: unknown): string;
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
export declare function parseCodeBuddyQuota(payload: unknown): CodeBuddyQuota;
/** Query the billing endpoint once. */
export declare function fetchCodeBuddyQuota(region: CodeBuddyRegion, token: string, fetchImpl?: typeof fetch): Promise<CodeBuddyQuota>;
/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export declare class CodeBuddyAuth {
    private readonly runs;
    /** Start a login; refuses while the same region is already logging in. */
    start(region: CodeBuddyRegion, onFinish?: (ok: boolean) => void): {
        started: true;
    } | {
        started: false;
        error: string;
    };
    status(region: CodeBuddyRegion): CodeBuddyAuthStatus;
    /** Clear the cached credential for one region. */
    logout(region: CodeBuddyRegion): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    /** False once this run was replaced or cancelled by logout. */
    private current;
    private login;
}
/**
 * Per-session runtime knobs a warm CodeBuddy session is created with.
 *
 * Each value may be a {@link Live} thunk and is resolved when a session is
 * created, so a settings edit applies to the sessions opened after it.
 */
export interface CodeBuddySessionRuntime {
    /** How long an unpaired MCP tool handler waits before failing its call. */
    toolResultTimeoutMs?: Live<number>;
    /** How long the inner process gets to acknowledge an abort. */
    abortGraceMs?: Live<number>;
    /** How long an in-flight turn may keep running after a close was requested. */
    drainMs?: Live<number>;
}
/**
 * One warm CodeBuddy session for a host session id.
 *
 * Mirrors the Qoder session's shape: the host's tool calls are exposed through
 * an in-process MCP server; each handler parks until the host delivers that
 * round's results on its next request. The inner CLI keeps the conversation,
 * so a continuation carries only new user text.
 */
export declare class CodeBuddySession {
    readonly sessionId: string;
    private session;
    private mcp;
    private readonly pairing;
    private toolSchemas;
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
    private registry;
    private queue;
    private disposed;
    /**
     * Deferred-close state: why this session was asked to stop, and whether an
     * in-flight turn is finishing first. Same contract as the Qoder session —
     * a plugin reload used to kill the CLI mid-answer and report the cut stream
     * as a failure. See {@link CloseGate}.
     */
    private readonly closeGate;
    /** Wall clock of the spawn, for the close log's lifetime figure. */
    private spawnedAt;
    private abortPending;
    private turnEndKind;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private tools;
    private openTool;
    private callCounter;
    private readonly callNonce;
    private lastUsage;
    /**
     * The last prompt-side buckets a request actually measured.
     *
     * Kept across turns: a turn can end without a usable usage frame (aborted
     * before the first delta, or a transport that only sends the cumulative
     * result). Reusing the last real reading keeps the host's context pressure
     * at the provider's actual prompt instead of collapsing it to the CLI's
     * startup overhead.
     */
    private lastPromptUsage;
    /**
     * Ids of assistant messages whose streaming events this session consumed.
     *
     * Kept across turns, not reset with the turn: the echo of a tool round is
     * delivered on the next stream(), so the previous turn's id is exactly the
     * one that has to be recognised. Only the last few ids matter, and bounding
     * the list keeps a long-lived session from growing without limit.
     */
    private readonly streamedMessageIds;
    private readonly streamedMessageOrder;
    private readonly output;
    private inputChars;
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    private region;
    private model;
    private effort;
    private systemPrompt;
    private cwd;
    /** Context budget the host shows for this session, when a model offers one. */
    private contextWindow;
    /** Budget already pushed to the CLI, keyed by model and value. */
    private appliedWindow;
    /** Host messages already fed to the inner session, for continuation planning. */
    fedMessages: readonly import('@deepseek-ai/dsh-llm').RequestMessage[] | undefined;
    /** Host system prompt last applied; informational for the adapter. */
    fedSystem: string | undefined;
    constructor(sessionId: string, initialModel: string, runtime?: CodeBuddySessionRuntime);
    /** Whether a turn is in flight; the pool must never evict such a session. */
    get busy(): boolean;
    /** Whether this session has been asked to stop and accepts no new turn. */
    get closing(): CloseCause | undefined;
    /** Point the session at a region, model and optional system prompt. */
    configure(region: CodeBuddyRegion, model: string, options?: {
        effort?: string;
        system?: string;
        cwd?: string;
        contextWindow?: number;
    }): void;
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
    private applyContextWindow;
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
    ensureTools(tools: readonly {
        name: string;
        description: string;
        parameters?: unknown;
    }[]): void;
    /**
     * Reconcile this session's MCP tool set with the host's live list.
     *
     * Add, update in place, and remove: the host withdraws tools when a mode
     * changes and adds them when `ops_discover_tools` resolves a deferred one, and
     * a tool the model can still name but the server no longer holds is answered
     * with `Tool "…" does not exist in the current tool set.` — the CLI never
     * forwards it to the host, so no tool result ever comes back.
     */
    private registerTools;
    /** Hand the host's tool results to parked or buffered handlers. */
    deliverToolResults(tail: readonly {
        role: string;
        toolCallId?: unknown;
        content?: unknown;
        isError?: boolean;
    }[], images?: ResolvedImages): void;
    /** Run one host turn; `feed` is new user content, or null for a tool continuation. */
    stream(options: GenerateOptions, feed: string | ChannelContent[] | null): AsyncGenerator<StreamChunk>;
    /**
     * Ask the session to stop serving.
     *
     * An in-flight turn is allowed to finish first (up to `drainMs`): its chunks
     * are consumed by the harness, so the answer arrives instead of being
     * truncated into a bogus stream failure. {@link teardown} does the work.
     *
     * @param cause - why it is closing; decides how an interrupted turn reports.
     */
    close(cause?: CloseCause): void;
    /** End a turn that outlived its drain window, before the CLI dies. */
    private forceEnd;
    /** Tear the inner CLI down; parked handlers settle with a cancellation. */
    private teardown;
    private ensureStarted;
    private canUseTool;
    private consume;
    private handle;
    /** Record that one assistant message reached the host as streaming events. */
    private rememberStreamedMessage;
    private resetTurnState;
    private emit;
    private countOutput;
    private usage;
    private endTurn;
}
/** Render host tool-result blocks into the MCP content the inner model reads. */
export declare function renderCodeBuddyResult(blocks: unknown, images?: ResolvedImages): ToolResultPayload['content'];
/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export declare class CodeBuddySessionManager {
    readonly maxSessions: Live<number>;
    private readonly runtime;
    private readonly create;
    private readonly sessions;
    /** Set by {@link seal}: this pool's plugin generation is gone. */
    private sealed;
    /**
     * @param maxSessions - warm-session cap; read per eviction so a settings edit
     *   applies to the next session that overflows the pool.
     * @param runtime - per-session knobs, resolved when each session is created.
     * @param create - builds one session; injectable so the pool's rules are
     *   testable without spawning a CLI.
     */
    constructor(maxSessions: Live<number>, runtime?: CodeBuddySessionRuntime, create?: (sessionId: string, model: string) => CodeBuddySession);
    forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession;
    dispose(sessionId: string): void;
    /**
     * Drop every warm session, keeping the pool usable.
     *
     * A login or logout changes the credentials those processes loaded, so they
     * cannot answer for the new account; the pool itself keeps serving.
     *
     * @param cause - why the sessions go; decides how interrupted turns report.
     */
    closeAll(cause?: CloseCause): void;
    /**
     * Drop every warm session and refuse to create more.
     *
     * Called from the plugin's dispose effect: a step prepared before the unload
     * can still be retried through this adapter, and a session created then would
     * outlive every owner it has.
     */
    seal(cause?: CloseCause): void;
}
/** A one-shot turn, used for titles and compaction summaries. */
export declare function codeBuddyColdStream(region: CodeBuddyRegion, prompt: string, model: string | undefined, options: GenerateOptions): Promise<StreamChunk[]>;
