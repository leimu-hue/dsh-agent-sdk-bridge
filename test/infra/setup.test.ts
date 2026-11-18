/**
 * The CLI helper's server half: where the script lives, what the page may ask
 * for, and whether a real run actually produces output.
 *
 * The end-to-end case is Windows-only because the helper is a batch file. It
 * asserts on the *plumbing* — the run settles, its exit code is a number, and
 * the first step printed — rather than on a successful configuration, since the
 * machine running the tests may legitimately have no CLI installed. It also
 * installs the CLI with `npm i -g`, so it is **opt-in**: `DSH_SETUP_E2E=1`.
 * Every other case here is hermetic, matching `test/setup-isolation.ts`.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_NAME, cancelSetup, compareVersions, isSetupMode, readSetupStatus, setupScriptPath, startSetup,
} from '../../src/infra/setup.ts'
import { brandProfile } from '../../src/core/brand.ts'

describe('setup helper', () => {
  it('finds the shipped script from this package layout', () => {
    const script = setupScriptPath('cn')
    expect(script).toBeDefined()
    expect(script!.endsWith(`scripts${process.platform === 'win32' ? '\\' : '/'}${SCRIPT_NAME}`)).toBe(true)
    expect(existsSync(script!)).toBe(true)
  })

  it('ships a helper for each edition', () => {
    for (const id of ['cn', 'global'] as const) {
      const script = setupScriptPath(id)
      // Both Qoder editions ship a batch helper; only the brands whose login is
      // in-process (CodeBuddy, MiniMax) declare none, so `setupScript` is nullable.
      const name = brandProfile(id).setupScript
      expect(name, id).not.toBeNull()
      expect(script, id).toBeDefined()
      expect(existsSync(script!), id).toBe(true)
      expect(script!.endsWith(name!), id).toBe(true)
    }
  })

  it('accepts only the modes it can name a flag for', () => {
    expect(isSetupMode('configure')).toBe(true)
    expect(isSetupMode('login')).toBe(true)
    expect(isSetupMode('logout')).toBe(true)
    expect(isSetupMode('uninstall')).toBe(true)
    for (const value of [undefined, null, '', 'CONFIGURE', '--gui', 'check', '--check', 'install && calc', {}]) {
      expect(isSetupMode(value)).toBe(false)
    }
  })

  it('answers an empty status before anything has run', () => {
    const status = readSetupStatus('cn')
    expect(status.running).toBe(false)
    expect(status.lines).toEqual([])
    expect(status.truncated).toBe(false)
    // Whether the CLI is present is read from the machine, not from a run:
    // the page uses it to decide between "install" and "uninstall".
    expect(typeof status.installed).toBe('boolean')
  })

  it('refuses to cancel a run that is not in flight', () => {
    expect(cancelSetup('cn')).toBe(false)
  })

  it('reports the CLI build this plugin speaks, so a mismatch is visible early', () => {
    // A session against a CLI *older* than the SDK's pin dies with a bare exit
    // code (1.1.81 removed the old worker handshake), so the page warns from
    // this status before the user signs in. A NEWER build is not a mismatch:
    // the CLI updates itself, and following it is the expected behaviour.
    const status = readSetupStatus('cn')
    expect(status.requiredCliVersion).toBeDefined()
    if (status.installed) {
      expect(typeof status.cliVersion === 'string' || status.cliVersion === undefined).toBe(true)
      expect(status.versionMismatch).toBe(
        status.cliVersion === undefined
          ? undefined
          : compareVersions(status.cliVersion, status.requiredCliVersion!) < 0,
      )
    } else {
      expect(status.cliVersion).toBeUndefined()
      expect(status.versionMismatch).toBeUndefined()
    }
  })

  it('compares versions numerically, not as strings', () => {
    // The point of the helper: "1.1.9" ranks BELOW "1.1.10", and a build newer
    // than the pin must never be reported as outdated.
    expect(compareVersions('1.1.9', '1.1.10')).toBe(-1)
    expect(compareVersions('1.1.10', '1.1.9')).toBe(1)
    expect(compareVersions('1.1.84', '1.1.81')).toBe(1)
    expect(compareVersions('1.1.81', '1.1.84')).toBe(-1)
    expect(compareVersions('1.1.81', '1.1.81')).toBe(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
  })

  const windows = process.platform === 'win32'
  const live = process.env.DSH_SETUP_E2E === '1'

  it.skipIf(windows)('refuses to run off Windows', () => {
    expect(startSetup('cn', 'configure')).toMatchObject({ started: false, reason: 'unsupported' })
  })

  it.skipIf(!windows || !live)('runs the batch file and reports its output', async () => {
    const started = startSetup('cn', 'configure')
    expect(started.started).toBe(true)

    // A second request must be refused while the first one is still alive.
    expect(startSetup('cn', 'configure')).toMatchObject({ started: false, reason: 'busy' })

    // The helper installs the CLI over the network, so the budget has to clear a
    // cold registry fetch rather than only the batch file's own work.
    const deadline = Date.now() + 240_000
    while (readSetupStatus('cn').running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const status = readSetupStatus('cn')
    expect(status.running).toBe(false)
    expect(typeof status.code).toBe('number')
    expect(status.lines.join('\n')).toContain('[1/5]')
  }, 300_000)
})
