/**
 * The plugin's own log is the only record of a reload.
 *
 * DSH's host writes no log file, so a "the conversation dropped" report could
 * only be reconstructed from file timestamps — and the decisive fact (did the
 * loader rebuild the entry, or commit the settings edit in place?) was recorded
 * nowhere at all. These pin the shape that makes that answerable: one JSON
 * object per line, carrying the module generation and the pid, switchable at
 * runtime, and silent when it fails.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { BOOT_ID, setTraceGate, trace, traceLogPath } from '../../src/host/infra/log.ts'

const root = mkdtempSync(join(tmpdir(), 'bridge-log-'))
process.env.DSH_BRIDGE_LOG_PATH = join(root, 'bridge.log')

afterEach(() => { setTraceGate(undefined) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** Every parsed line the log currently holds. */
function lines(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('event log', () => {
  it('writes one parseable line per event, with a boot id and a pid', () => {
    const path = join(root, 'shape.log')
    process.env.DSH_BRIDGE_LOG_PATH = path
    trace('apply', { n: 2 })
    trace('session/close', { session: 'abc', cause: 'dispose' })

    const entries = lines(path)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ boot: BOOT_ID, pid: process.pid, event: 'apply', n: 2 })
    // Millisecond timestamps matter: the whole point is ordering against the
    // harness event stream, whose own frames carry epoch millis.
    expect(typeof entries[0]?.t).toBe('string')
    expect(entries[1]).toMatchObject({ event: 'session/close', session: 'abc', cause: 'dispose' })
  })

  it('honours the live gate, so the setting can silence it without a restart', () => {
    const path = join(root, 'gated.log')
    process.env.DSH_BRIDGE_LOG_PATH = path
    let enabled = false
    setTraceGate(() => enabled)
    trace('dispose')
    expect(lines(path)).toHaveLength(0)

    enabled = true
    trace('dispose')
    expect(lines(path)).toHaveLength(1)
  })

  it('keeps a broken gate from silencing the log', () => {
    const path = join(root, 'broken-gate.log')
    process.env.DSH_BRIDGE_LOG_PATH = path
    setTraceGate(() => { throw new Error('config cell gone') })
    trace('apply')
    expect(lines(path)).toHaveLength(1)
  })

  it('defaults the path into the profile directory', () => {
    delete process.env.DSH_BRIDGE_LOG_PATH
    expect(traceLogPath()).toMatch(/agent-sdk-bridge[\\/]bridge\.log$/)
    process.env.DSH_BRIDGE_LOG_PATH = join(root, 'bridge.log')
  })
})
