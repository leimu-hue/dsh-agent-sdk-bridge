/**
 * The plugin's configuration surface.
 *
 * DSH's settings service reads a plugin's exported `Config` schema and, when no
 * custom page is registered for that entry, auto-generates a settings page from
 * it (`autoGenerate` defaults to true in `dsh-settings`). That makes this schema
 * the single source of truth for both runtime behaviour and the settings UI —
 * every field documented here appears as a labelled control, and its
 * `description` becomes the help text under it.
 *
 * Field order matters: the generated form renders in declaration order, so the
 * groups below are arranged the way a user reads them (identity → capacity →
 * context → timeouts → models → aliases).
 *
 * @module dsh-agent-sdk-bridge/config
 */
import z from '@deepseek-ai/schemastery';
import type { CodeBuddyRegion } from './brand.ts';
/**
 * The plugin configuration as authored in a profile patch.
 *
 * These are the values a user writes; at runtime every one of them arrives
 * wrapped in a `Volatile<T>` reference (see {@link ConfigSchema}), which
 * {@link resolveConfig} unwraps. Keep this interface as the authoring shape and
 * `ResolvedConfig` as the runtime shape.
 *
 * Every field is optional and defaulted, so an empty config — the profile row
 * DSH inserts by default — runs with the tuned defaults below.
 */
export interface Config {
    /**
     * Whether the Qoder CN edition is served at all.
     *
     * Off removes its provider route, its model group and its settings page. The
     * per-model choices are kept, so switching it back on restores the previous
     * configuration rather than resetting it.
     */
    cnEnabled?: boolean;
    /** Whether the international edition is served; same semantics as {@link cnEnabled}. */
    intlEnabled?: boolean;
    /** Whether CodeBuddy is served; same semantics as {@link cnEnabled}. */
    codebuddyEnabled?: boolean;
    /**
     * Model ids the user switched OFF in the settings page.
     *
     * Stored as a deny-list rather than an allow-list so a newly published model
     * appears enabled by default: the account's catalog changes upstream, and a
     * stored allow-list would silently hide anything added after it was written.
     *
     * Ids are Qoder SDK values (e.g. `qmodel_38max`).
     */
    disabledModels?: string[];
    /**
     * Per-model context window in tokens, keyed by Qoder model id.
     *
     * A model with no entry uses the window upstream declares for it, which is
     * what its own session actually runs with. A larger value makes the request
     * use that window, but it also raises the harness's auto-compaction
     * threshold, so a conversation can grow past what the provider accepts
     * before compaction fires.
     */
    modelContextWindows?: Record<string, number>;
    /**
     * Extra aliases mapping a harness-side model id onto a Qoder SDK value,
     * merged over the built-in `deepseek-v4-*` ones.
     */
    modelAliases?: Record<string, string>;
    /**
     * Model ids the user switched OFF for the international edition.
     *
     * A separate list from the CN one on purpose: the two plans publish different
     * catalogs, and a shared deny-list would hide a model on one side because the
     * user happened to switch an unrelated id off on the other.
     */
    intlDisabledModels?: string[];
    /**
     * Per-model context window for the international edition, keyed by model id.
     */
    intlModelContextWindows?: Record<string, number>;
    /**
     * Extra model aliases for the international edition.
     */
    intlModelAliases?: Record<string, string>;
    /**
     * Display name of the international provider group in the model picker.
     */
    intlDisplayName?: string;
    /** Which CodeBuddy login region the sessions use. */
    codebuddyRegion?: CodeBuddyRegion;
    /** Display name of the CodeBuddy provider group in the model picker. */
    codebuddyDisplayName?: string;
    /** Model ids the user switched OFF for the international region. */
    codebuddyGlobalDisabledModels?: string[];
    /** Model ids the user switched OFF for the mainland region. */
    codebuddyCnDisabledModels?: string[];
    /** Per-model context window for the international region, keyed by model id. */
    codebuddyGlobalModelContextWindows?: Record<string, number>;
    /** Per-model context window for the mainland region, keyed by model id. */
    codebuddyCnModelContextWindows?: Record<string, number>;
    /** Extra model aliases for CodeBuddy, shared by both regions. */
    codebuddyModelAliases?: Record<string, string>;
    /**
     * Display name of the primary provider group in the model picker.
     */
    displayName?: string;
    /**
     * How many warm inner Qoder CLI sessions to keep alive at once. One warm
     * session exists per DSH session id; beyond this cap the least recently used
     * one is closed. Each warm session is a subprocess.
     */
    maxSessions?: number;
    /**
     * Seconds a warm session may sit unused before it is reclaimed.
     *
     * `0` disables reclamation. Each warm session is a subprocess, so a long
     * conversation left open is memory the user may not need; the pool evicts it
     * on the next sweep and the next turn rebuilds it cold.
     */
    sessionIdleSeconds?: number;
    /**
     * Seconds a fetched CLI model catalog stays fresh before it is re-fetched.
     */
    modelCacheTtlSeconds?: number;
    /**
     * Reasoning effort used when a request names none. Empty uses upstream's own
     * default for the model.
     */
    defaultReasoningEffort?: string;
    /**
     * Output-token cap assumed when a model does not report one.
     */
    defaultMaxTokens?: number;
    /**
     * Fallback seconds for a tool handler that could not be paired with a host
     * call (no announced tool-use id to match a result against).
     *
     * Paired calls are not bounded by this: a host tool may run for minutes, so
     * they wait for the host request that carries their result and are settled at
     * that request boundary when it does not.
     */
    toolResultTimeoutSeconds?: number;
    /**
     * Seconds to wait for the CLI model catalog before using the static fallback.
     */
    catalogFetchTimeoutSeconds?: number;
    /**
     * Seconds to wait for the inner process to acknowledge an abort.
     */
    abortGraceSeconds?: number;
    /**
     * Seconds an in-flight turn may keep running after its session was asked to
     * close (plugin reload, pool reclaim, account switch).
     *
     * The harness consumes the turn's chunks from this plugin, not from the
     * subprocess, so a turn that is already streaming can finish after the plugin
     * is unloaded — the answer is delivered instead of being truncated into a
     * bogus "connection lost". `0` closes immediately (the previous behaviour).
     */
    disposeDrainSeconds?: number;
    /**
     * Whether this plugin writes its own event log to
     * `~/.dsh/agent-sdk-bridge/bridge.log`.
     *
     * DSH's host writes no log file, so this is the only place a session spawn,
     * close, or turn end is recorded with a millisecond timestamp.
     */
    traceEnabled?: boolean;
    /**
     * Maximum inner turns for one side-channel request (title, compaction).
     */
    coldMaxTurns?: number;
}
/**
 * The configuration schema. This is what DSH turns into the settings page, so
 * the defaults and bounds here are user-visible documentation.
 *
 * ## Why every field is `.volatile()`
 *
 * DSH's settings service builds its form from `volatileForm(schema)`, which
 * keeps a field ONLY when the node (or an ancestor) carries `meta.volatile`;
 * an object whose fields are all non-volatile collapses to `undefined` and the
 * whole namespace is dropped from `describe()` before any client sees it. A
 * plugin with a plain schema therefore registers successfully, streams models
 * correctly, and still shows no settings page anywhere — the namespace never
 * reaches the wire.
 *
 * ## What `.volatile()` costs: read every field at use
 *
 * A volatile-only edit does not restart the plugin. The loader writes the new
 * value into the *same* `Volatile` cell the running plugin already holds and
 * skips the rest of the update lifecycle, so `apply()` is never called again
 * (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`). Capturing a
 * field in `apply()` therefore freezes it for the lifetime of the process, and
 * the plugin answers with mount-time values while the settings page and the
 * profile patch on disk show the new ones.
 *
 * That is why the whole plugin consumes its config through {@link liveConfig},
 * which returns a thunk per field: the value is unwrapped from its volatile
 * reference at every read, so an in-place edit is visible immediately. See
 * `src/core/live.ts` for the full mechanism.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    cnEnabled: z<boolean, boolean, "volatile-defined">;
    intlEnabled: z<boolean, boolean, "volatile-defined">;
    codebuddyEnabled: z<boolean, boolean, "volatile-defined">;
    disabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: z<string, string, "volatile-defined">;
    codebuddyRegion: z<string, string, "volatile-defined">;
    codebuddyDisplayName: z<string, string, "volatile-defined">;
    codebuddyGlobalDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyCnDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyGlobalModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyCnModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    maxSessions: z<number, number, "volatile-defined">;
    sessionIdleSeconds: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    modelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    abortGraceSeconds: z<number, number, "volatile-defined">;
    disposeDrainSeconds: z<number, number, "volatile-defined">;
    traceEnabled: z<boolean, boolean, "volatile-defined">;
    coldMaxTurns: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    cnEnabled: z<boolean, boolean, "volatile-defined">;
    intlEnabled: z<boolean, boolean, "volatile-defined">;
    codebuddyEnabled: z<boolean, boolean, "volatile-defined">;
    disabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: z<string, string, "volatile-defined">;
    codebuddyRegion: z<string, string, "volatile-defined">;
    codebuddyDisplayName: z<string, string, "volatile-defined">;
    codebuddyGlobalDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyCnDisabledModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyGlobalModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyCnModelContextWindows: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyModelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    displayName: z<string, string, "volatile-defined">;
    maxSessions: z<number, number, "volatile-defined">;
    sessionIdleSeconds: z<number, number, "volatile-defined">;
    modelCacheTtlSeconds: z<number, number, "volatile-defined">;
    modelAliases: z<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: z<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: z<number, number, "volatile-defined">;
    abortGraceSeconds: z<number, number, "volatile-defined">;
    disposeDrainSeconds: z<number, number, "volatile-defined">;
    traceEnabled: z<boolean, boolean, "volatile-defined">;
    coldMaxTurns: z<number, number, "volatile-defined">;
}>>, "plain">;
/** Fully-resolved options with every default applied. */
export interface ResolvedConfig {
    cnEnabled: boolean;
    intlEnabled: boolean;
    codebuddyEnabled: boolean;
    codebuddyRegion: CodeBuddyRegion;
    displayName: string;
    maxSessions: number;
    sessionIdleMs: number;
    modelCacheTtlMs: number;
    defaultMaxTokens: number;
    toolResultTimeoutMs: number;
    catalogFetchTimeoutMs: number;
    abortGraceMs: number;
    disposeDrainMs: number;
    traceEnabled: boolean;
    coldMaxTurns: number;
    disabledModels: readonly string[];
    modelContextWindows: Readonly<Record<string, number>>;
    modelAliases: Readonly<Record<string, string>>;
    defaultReasoningEffort: string | undefined;
    intlDisplayName: string;
    intlDisabledModels: readonly string[];
    intlModelContextWindows: Readonly<Record<string, number>>;
    intlModelAliases: Readonly<Record<string, string>>;
    codebuddyDisplayName: string;
    codebuddyGlobalDisabledModels: readonly string[];
    codebuddyCnDisabledModels: readonly string[];
    codebuddyGlobalModelContextWindows: Readonly<Record<string, number>>;
    codebuddyCnModelContextWindows: Readonly<Record<string, number>>;
    codebuddyModelAliases: Readonly<Record<string, string>>;
}
/**
 * A parsed config as it arrives at pply(): every field wrapped in the
 * Volatile<T> reference its .volatile() schema produces.
 *
 * Typed structurally rather than with Volatile<T> per field so the module
 * needs no import of the wrapper type, and so a plain (non-volatile) config
 * still satisfies it — which is what tests and direct callers pass.
 */
export type ParsedConfig = {
    readonly [K in keyof Config]?: unknown;
};
/**
 * {@link ResolvedConfig} with every field as a thunk over its live value.
 *
 * Structurally a resolved config, temporally a subscription: each property
 * reads the underlying `Volatile` cell when it is called, so a settings edit
 * that the loader commits in place is visible on the next read.
 */
export type LiveConfig = {
    readonly [K in keyof ResolvedConfig]: () => ResolvedConfig[K];
};
/**
 * Every authoring field and the resolved field it becomes.
 *
 * The `satisfies` clause is the compile-time half of the config contract: a
 * field added to the schema (and therefore to `Config`) but not resolved here
 * is an error, and the reverse check below catches a resolved field that no
 * authoring field produces. It also keeps the unit-bearing renames
 * (`*Seconds` → `*Ms`) in one place instead of scattering them across the
 * mapping function and the docs. Exported for the runtime parity test.
 */
export declare const CONFIG_FIELD_MAP: {
    readonly cnEnabled: "cnEnabled";
    readonly intlEnabled: "intlEnabled";
    readonly codebuddyEnabled: "codebuddyEnabled";
    readonly disabledModels: "disabledModels";
    readonly modelContextWindows: "modelContextWindows";
    readonly modelAliases: "modelAliases";
    readonly intlDisabledModels: "intlDisabledModels";
    readonly intlModelContextWindows: "intlModelContextWindows";
    readonly intlModelAliases: "intlModelAliases";
    readonly intlDisplayName: "intlDisplayName";
    readonly codebuddyRegion: "codebuddyRegion";
    readonly codebuddyDisplayName: "codebuddyDisplayName";
    readonly codebuddyGlobalDisabledModels: "codebuddyGlobalDisabledModels";
    readonly codebuddyCnDisabledModels: "codebuddyCnDisabledModels";
    readonly codebuddyGlobalModelContextWindows: "codebuddyGlobalModelContextWindows";
    readonly codebuddyCnModelContextWindows: "codebuddyCnModelContextWindows";
    readonly codebuddyModelAliases: "codebuddyModelAliases";
    readonly displayName: "displayName";
    readonly maxSessions: "maxSessions";
    readonly sessionIdleSeconds: "sessionIdleMs";
    readonly modelCacheTtlSeconds: "modelCacheTtlMs";
    readonly defaultReasoningEffort: "defaultReasoningEffort";
    readonly defaultMaxTokens: "defaultMaxTokens";
    readonly toolResultTimeoutSeconds: "toolResultTimeoutMs";
    readonly catalogFetchTimeoutSeconds: "catalogFetchTimeoutMs";
    readonly abortGraceSeconds: "abortGraceMs";
    readonly disposeDrainSeconds: "disposeDrainMs";
    readonly traceEnabled: "traceEnabled";
    readonly coldMaxTurns: "coldMaxTurns";
};
/** A type-level assertion that fails compilation when its argument is false. */
type Assert<T extends true> = T;
export type ResolvedConfigCoverage = Assert<Exclude<keyof ResolvedConfig, (typeof CONFIG_FIELD_MAP)[keyof typeof CONFIG_FIELD_MAP]> extends never ? true : false>;
/**
 * Wrap a parsed config as {@link LiveConfig}.
 *
 * Every normalizer below is the single interpretation of a raw field: the
 * running plugin reads its config only through this view, so a value can never
 * be resolved one way at mount and another way later.
 *
 * @param config - the parsed plugin config, possibly partial or absent.
 * @returns one thunk per resolved field, each reading the live cell.
 */
export declare function liveConfig(config: ParsedConfig | undefined): LiveConfig;
export {};
