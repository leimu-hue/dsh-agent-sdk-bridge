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
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import type { CodeBuddyRegion } from '../../core/brand.ts';
import type { Live } from '../../core/live.ts';
/** Default context capacity assumed for a model that declares none. */
export declare const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200000;
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
