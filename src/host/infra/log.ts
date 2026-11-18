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

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Identifies this plugin generation in the host process.
 *
 * A reload re-evaluates the module, so a new value means the entry was rebuilt
 * rather than committed in place — which is exactly the question a settings
 * save has to answer.
 */
export const BOOT_ID = randomUUID().slice(0, 8)

/** Size at which the active file is rotated to `<name>.1`. */
const MAX_LOG_BYTES = 4 * 1024 * 1024

/** The active log's path: `DSH_BRIDGE_LOG_PATH`, or the profile-side default. */
export function traceLogPath(): string {
  const override = process.env.DSH_BRIDGE_LOG_PATH
  if (override !== undefined && override.length > 0) return override
  return join(homedir(), '.dsh', 'agent-sdk-bridge', 'bridge.log')
}

/** Live on/off switch, read per write so a settings edit applies immediately. */
let gate: (() => boolean) | undefined

/**
 * Install the trace gate.
 *
 * @param read - the plugin's `traceEnabled` setting, read per write; omit to
 *   trace unconditionally (the default, and what tests get).
 */
export function setTraceGate(read: (() => boolean) | undefined): void {
  gate = read
}

/** Directories already created, so a hot path does not re-stat them. */
const prepared = new Set<string>()

/**
 * Append one event.
 *
 * @param event - stable event name, e.g. `session/close`; never localized.
 * @param fields - flat, JSON-serializable facts about the event.
 */
export function trace(event: string, fields: Record<string, unknown> = {}): void {
  if (gate !== undefined) {
    try {
      if (!gate()) return
    } catch {
      // A broken settings read must not silence the log.
    }
  }
  const line = JSON.stringify({ t: new Date().toISOString(), boot: BOOT_ID, pid: process.pid, event, ...fields })
  try {
    const path = traceLogPath()
    const dir = dirname(path)
    if (!prepared.has(dir)) {
      mkdirSync(dir, { recursive: true })
      prepared.add(dir)
    }
    rotateIfNeeded(path)
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch {
    // Diagnostics are best-effort by contract.
  }
}

/** Rotate the active file once it passes the ceiling, keeping one generation. */
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    // Absent or unrotatable: the append below still carries this line.
  }
}
