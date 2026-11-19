/**
 * Mounts the three provider adapters and keeps their registrations in step with
 * the plugin's live configuration.
 *
 * The plugin entry (`host/index.ts`) answers one question — how DSH mounts a
 * plugin — and this module answers the next one — which routes, picker groups,
 * attachment readers and warm sessions exist while it is mounted. Separating
 * them matters because the second set of decisions is large and stateful:
 * routes must appear and disappear with the edition switches, the picker
 * directory is republished through a handle rather than re-registered, and the
 * adapters must be closed exactly once when the plugin unloads. A caller does
 * not need any of that to mount the plugin: it calls {@link createBridge} and
 * receives the adapter instances the HTTP surface reads.
 *
 * @module dsh-agent-sdk-bridge/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LiveConfig } from './core/config.ts';
import { CodeBuddyAdapter } from './providers/codebuddy/adapter.ts';
import { QoderAdapter } from './providers/qoder/adapter.ts';
/** The settings namespace: the profile entry id this plugin is mounted under. */
export declare const SETTINGS_NS = "llm-qoder-cn";
/** The adapter instances, typed per route so the settings surface needs no casts. */
export interface BridgeAdapters {
    cn: QoderAdapter;
    global: QoderAdapter;
    codebuddy: CodeBuddyAdapter;
}
/** What the plugin entry keeps from a mounted bridge. */
export interface Bridge {
    readonly adapters: BridgeAdapters;
    /** Close every warm inner process; registrations are disposed with the fiber. */
    close(): void;
}
/**
 * Mount the adapters for the lifetime of the plugin.
 *
 * Every value is read through `live` at the point it is used: a volatile-only
 * edit is committed into the running plugin without re-entering `apply()`, so a
 * value captured here would stay frozen for the process lifetime. The two
 * exceptions are the structural fields above, which own registrations and are
 * re-synced by the loader's volatile-update event.
 *
 * @param ctx - the plugin's cordis context.
 * @param live - the configuration view whose thunks read the live cells.
 * @returns the adapters and the teardown for their subprocesses.
 */
export declare function createBridge(ctx: Context, live: LiveConfig): Bridge;
