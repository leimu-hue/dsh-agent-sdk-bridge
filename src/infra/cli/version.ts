/**
 * The two CLI versions that have to agree — the version layer.
 *
 * Each SDK release pins one CLI build in its runtime manifest; a build *older*
 * than that pin drops the handshake the SDK speaks and fails every turn with a
 * bare exit code 42. So the page needs both numbers from disk, without spawning
 * anything: the pin from the SDK this plugin depends on, the installed build
 * from whatever `findCli()` answered.
 *
 * @module dsh-agent-sdk-bridge/cli/version
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { QoderBrand } from '../../core/brand.ts'
import { brandProfile } from '../../core/brand.ts'
import { findCli } from './lookup.ts'
import { probeOf, sdkDir, type CliLookup, type FileRead } from './machine.ts'

/**
 * The CLI version the installed SDK expects, read from its runtime manifest.
 *
 * Each SDK release pins one CLI build: the two speak a wire protocol that
 * changes between them, and a mismatch fails every session with a bare exit
 * code. The bundled helper reads the same file, so the page and the helper
 * agree on which build to install.
 *
 * @param brand - which edition's SDK to inspect.
 * @returns the pinned version, or undefined when the manifest is unreadable.
 */
export function requiredCliVersion(brand: QoderBrand): string | undefined {
  try {
    const dir = sdkDir(brandProfile(brand).sdkPackage)
    if (dir === undefined) return undefined
    const manifest = JSON.parse(readFileSync(path.join(dir, 'dist', 'runtime-manifest.json'), 'utf8')) as {
      qoderCliVersion?: unknown
    }
    return typeof manifest.qoderCliVersion === 'string' && manifest.qoderCliVersion.length > 0
      ? manifest.qoderCliVersion
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The version of the installed CLI, read from its own package manifest.
 *
 * Read from disk rather than by running `--version`: a settings-page poll must
 * not spawn a process every second, and the npm package always ships a
 * manifest next to its entry. A native build carries no manifest, so its own
 * installer's `version.txt` answers instead; when neither is there the answer
 * is undefined, which callers treat as "unknown" and never as a mismatch.
 *
 * @param brand - which edition's CLI to inspect.
 * @param lookup - the machine to inspect; defaults to this process's.
 * @returns the installed version, or undefined when it cannot be read.
 */
export function installedCliVersion(brand: QoderBrand, lookup: CliLookup = {}): string | undefined {
  const probe = probeOf(lookup)
  const cli = findCli(brand, probe)
  if (cli === undefined) return undefined
  for (const candidate of [
    path.join(path.dirname(cli.path), 'package.json'),
    path.join(path.dirname(path.dirname(cli.path)), 'package.json'),
  ]) {
    try {
      const manifest = JSON.parse(probe.read(candidate)) as { name?: unknown, version?: unknown }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@')) continue
      if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
    } catch {
      // No manifest at this level: try the parent, then give up.
    }
  }
  return installedNativeVersion(path.dirname(cli.path), probe.read)
}

/**
 * The version a native build's installer recorded beside it.
 *
 * Qoder's installer writes `version.txt` (`1.1.37`) next to the binary it
 * manages. Reading it is what lets the page say *how old* an installer-managed
 * build is: without it the version was always unknown, and a build older than
 * the SDK's handshake stayed silent about the exit-42 failures it causes.
 */
function installedNativeVersion(dir: string, read: FileRead): string | undefined {
  try {
    const text = read(path.join(dir, 'version.txt')).trim()
    return /^\d+(?:\.\d+)+$/.test(text) ? text : undefined
  } catch {
    // No such file: a build that never came from the installer.
    return undefined
  }
}
