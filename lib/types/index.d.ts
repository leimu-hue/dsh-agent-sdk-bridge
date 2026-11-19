/**
 * The plugin entry: what DSH calls to mount the bridge.
 *
 * This module answers one question — how the harness mounts a plugin — and
 * delegates the two substantial answers next to it. {@link createBridge} owns
 * the provider adapters, the routes and picker groups that follow the edition
 * switches, and the warm-session teardown; `surface/api.ts` owns the settings
 * pages' HTTP reads. What remains here is the plugin contract itself: the
 * `name`/`inject`/`Config`/`apply` exports the loader reads, one counter that
 * makes an entry rebuild visible in the trace log, and the two mounts.
 *
 * ## Settings edits apply without a restart, and that shapes the wiring
 *
 * Every config field is volatile, and DSH commits a volatile-only edit into the
 * running plugin's config cells instead of restarting it — `apply()` is not
 * called again. The bridge is therefore handed {@link liveConfig} thunks and
 * reads each value where it uses it; see `src/core/live.ts` for the mechanism.
 *
 * @module dsh-agent-sdk-bridge
 */
import './core/events.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig } from './core/config.ts';
export { QODER_PROVIDER, QODER_INTL_PROVIDER, QoderAdapter } from './providers/qoder/adapter.ts';
export type { QoderAdapterOptions } from './providers/qoder/adapter.ts';
export { CODEBUDDY_PROVIDER, CodeBuddyAdapter, resolveCodeBuddyModelId } from './providers/codebuddy/adapter.ts';
export type { CodeBuddyAdapterOptions } from './providers/codebuddy/adapter.ts';
export type { ImageRequestReader } from './core/adapter-kit.ts';
export type { Live } from './core/live.ts';
export { liveConfig } from './core/config.ts';
export type { ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig };
export { API_PREFIX } from './surface/api.ts';
/**
 * Cordis plugin name; equals the profile row id this bundle inserts.
 *
 * @see SETTINGS_NS
 */
export declare const name = "llm-qoder-cn";
/** The LLM registry must exist before an adapter can be registered on it. */
export declare const inject: string[];
/** The plugin's configuration schema, under the name the loader looks for. */
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    cnEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    intlEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    codebuddyEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    disabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyRegion: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyGlobalDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyCnDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyGlobalModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyCnModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    displayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    maxSessions: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    sessionIdleSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    abortGraceSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    disposeDrainSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    traceEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    coldMaxTurns: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    cnEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    intlEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    codebuddyEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    disabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    modelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    intlModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    intlModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    intlDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyRegion: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyDisplayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    codebuddyGlobalDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyCnDisabledModels: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    codebuddyGlobalModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyCnModelContextWindows: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<number, string>>, "volatile-defined">;
    codebuddyModelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    displayName: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    maxSessions: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    sessionIdleSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelCacheTtlSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    modelAliases: import("@deepseek-ai/schemastery").default<NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, NoInfer<import("@deepseek-ai/cosmokit").Dict<string, string>>, "volatile-defined">;
    defaultReasoningEffort: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
    defaultMaxTokens: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    toolResultTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    catalogFetchTimeoutSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    abortGraceSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    disposeDrainSeconds: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
    traceEnabled: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
    coldMaxTurns: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
}>>, "plain">;
/**
 * Mount the adapters and the settings API for the lifetime of the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - parsed plugin config, whose volatile fields arrive as
 *   references. {@link liveConfig} wraps them as thunks the bridge reads where
 *   it uses them, so an edit applies without this function running again; an
 *   empty object is a valid deployment.
 */
export declare function apply(ctx: Context, config: ParsedConfig): void;
