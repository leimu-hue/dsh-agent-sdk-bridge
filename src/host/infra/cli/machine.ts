/**
 * One machine's facts, as the CLI lookup needs them — the bottom layer.
 *
 * Everything above this module decides *what* to look for; this one answers
 * *where* and *whether*: which platform's layouts apply, whether a Node exists
 * to run a script entry, where `PATH` points, and where the installed SDK
 * landed. It is read once into a {@link Probe}, so the layers above never touch
 * the filesystem themselves and a test can describe a machine instead of having
 * to be one.
 *
 * @module dsh-agent-sdk-bridge/cli/machine
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import * as path from 'node:path'

/** Whether a path is a file on this machine. */
export type FileExists = (candidate: string) => boolean

/** The text of a file on this machine; throws when it cannot be read. */
export type FileRead = (file: string) => string

/** The entries of a directory on this machine; throws when it cannot be read. */
export type DirRead = (dir: string) => readonly string[]

/**
 * What the lookup reads. Injectable so a test can describe a machine instead of
 * having to be one, and so a caller can point the search somewhere else.
 */
export interface CliLookup {
  /** Environment to read; defaults to this process's. */
  env?: NodeJS.ProcessEnv
  /** Platform whose layouts to follow; defaults to this process's. */
  platform?: NodeJS.Platform
  /** File-existence probe; defaults to the real filesystem. */
  exists?: FileExists
  /** File read; defaults to the real filesystem. */
  readFile?: FileRead
  /** Directory listing; defaults to the real filesystem. */
  readdir?: DirRead
  /** The running interpreter; defaults to this process's executable. */
  execPath?: string
  /** Whether that interpreter is Electron rather than Node; defaults to the truth. */
  electron?: boolean
}

/**
 * The facts one lookup is decided on, computed once.
 *
 * Resolved I/O rides along with the environment rather than being re-derived
 * per candidate: a lookup walks a hundred paths, and asking the injected probe
 * — not `node:fs` directly — is what keeps a fake machine honest all the way
 * down. `readdir` is deliberately absent: only {@link resolveNode} lists a
 * directory, so nothing above needs it.
 */
export interface Probe {
  /** Environment the lookup reads its overrides and `PATH` from. */
  env: NodeJS.ProcessEnv
  /** Suffix a native CLI carries on this platform (`.exe` on Windows). */
  suffix: string
  /** The name `PATH` answers for this platform's Node interpreter. */
  nodeExecutable: string
  /** The interpreter a script entry would run under, when the machine has one. */
  node: string | undefined
  /** Whether a candidate is a file on this machine. */
  exists: FileExists
  /** The text of a file on this machine. */
  read: FileRead
}

/** Read one machine's facts, defaulting to the one this process runs on. */
export function probeOf(lookup: CliLookup = {}): Probe {
  const platform = lookup.platform ?? process.platform
  return {
    env: lookup.env ?? process.env,
    suffix: platform === 'win32' ? '.exe' : '',
    nodeExecutable: platform === 'win32' ? 'node.exe' : 'node',
    node: resolveNode(lookup),
    exists: lookup.exists ?? existsSync,
    read: lookup.readFile ?? ((file: string): string => readFileSync(file, 'utf8')),
  }
}

/**
 * The Node that runs a CLI script: this process when it *is* Node, else DSH's
 * shipped runtime, else whatever `PATH` answers.
 *
 * DSH's runtime comes first among the fallbacks because it is the one Node a
 * DSH install guarantees, whatever the user's PATH says — an Electron host
 * launched from a desktop shortcut inherits an environment that need not carry
 * Node at all.
 */
export function resolveNode(lookup: CliLookup): string | undefined {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const execPath = lookup.execPath ?? process.execPath
  const electron = lookup.electron ?? process.versions.electron !== undefined
  if (!electron && path.basename(execPath).toLowerCase() === name) return execPath
  const home = env.DSH_HOME === undefined || env.DSH_HOME.length === 0 ? path.join(homedir(), '.dsh') : env.DSH_HOME
  const runtimes = path.join(home, 'dsh-runtimes')
  for (const runtime of listDir(runtimes, lookup)) {
    const candidate = path.join(runtimes, runtime, 'dependencies', 'node', 'bin', name)
    if (exists(candidate)) return candidate
  }
  for (const dir of pathEntries(env)) {
    const candidate = path.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * The home directory the CLI keeps its state and native builds under.
 *
 * `QODER_CLI_HOME` overrides it, which is how the CLI's own installer and any
 * per-user relocation answer the same question.
 */
export function cliHome(env: NodeJS.ProcessEnv): string {
  return env.QODER_CLI_HOME === undefined || env.QODER_CLI_HOME.length === 0 ? homedir() : env.QODER_CLI_HOME
}

/** The directories `PATH` names, in resolution order. */
export function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(path.delimiter).filter(dir => dir.length > 0)
}

/**
 * Directory of the installed SDK, for the native CLI build it may carry.
 *
 * The international package is optional, so a missing one answers undefined
 * here rather than failing the lookup.
 */
export function sdkDir(packageName: string): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve(packageName)
    // `resolve` answers the package's entry *inside* its dist directory, so
    // climbing one level only lands on `dist`. Callers want the package root:
    // they join `dist/runtime-manifest.json` and `dist/_bundled/<cli>`, and a
    // doubled `dist/dist/…` made both probes miss.
    const dir = path.dirname(entry)
    return path.basename(dir) === 'dist' ? path.dirname(dir) : dir
  } catch {
    return undefined
  }
}

/** Listing that answers nothing rather than throwing on a missing directory. */
export function listDir(dir: string, lookup: CliLookup): readonly string[] {
  const read = lookup.readdir ?? ((target: string): readonly string[] => readdirSync(target))
  try {
    return read(dir)
  } catch {
    return []
  }
}
