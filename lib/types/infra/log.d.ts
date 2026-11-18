/**
 * The plugin's own event log.
 *
 * DSH's desktop host does not write a log file, so a diagnosis of "the
 * conversation suddenly dropped" had to be reconstructed from file mtimes and
 * the compressed session event stream — and the decisive fact (was the plugin
 * entry rebuilt, or was the config committed in place?) was simply not
 * recorded anywhere.
 *
 * Each line is one JSON object with a boot id and a pid, appended to
 * `~/.dsh/agent-sdk-bridge/bridge.log`. Appends are synchronous: ordering
 * against a subprocess's own log and against the harness event stream is the
 * whole point, and a buffered write would lose the last few lines exactly when
 * a crash matters most. The volume is a handful of lines per turn.
 *
 * Nothing here may ever throw: a diagnostic that breaks a turn is worse than no
 * diagnostic.
 *
 * @module dsh-agent-sdk-bridge/log
 */
/**
 * Identifies this plugin generation in the host process.
 *
 * A reload re-evaluates the module, so a new value means the entry was rebuilt
 * rather than committed in place — which is exactly the question a settings
 * save has to answer.
 */
export declare const BOOT_ID: string;
/** The active log's path: `DSH_BRIDGE_LOG_PATH`, or the profile-side default. */
export declare function traceLogPath(): string;
/**
 * Install the trace gate.
 *
 * @param read - the plugin's `traceEnabled` setting, read per write; omit to
 *   trace unconditionally (the default, and what tests get).
 */
export declare function setTraceGate(read: (() => boolean) | undefined): void;
/**
 * Append one event.
 *
 * @param event - stable event name, e.g. `session/close`; never localized.
 * @param fields - flat, JSON-serializable facts about the event.
 */
export declare function trace(event: string, fields?: Record<string, unknown>): void;
