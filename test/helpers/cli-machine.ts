/**
 * Fake machines for the CLI lookup's tests — fixtures, not tests.
 *
 * The lookup is driven entirely through its injectable {@link CliLookup}, so a
 * case can describe a computer instead of having to be one: an Electron host
 * with no Node on `PATH`, an npm-global install, an installer-managed binary, a
 * stray worker runtime. Everything here is a path on a machine that does not
 * exist; `machine()` answers which of them are present.
 *
 * Kept out of the test files themselves so the layout constants stay in one
 * place and a new case only adds assertions.
 */
import * as path from 'node:path'
import type { CliLookup } from '../../src/host/infra/cli.ts'

/** Suffix a native build carries on this platform. */
export const EXE = process.platform === 'win32' ? '.exe' : ''

/** The root of the invented machine; every other path hangs off it. */
export const BASE = path.resolve('/machine')
const NPM_PREFIX = path.join(BASE, 'npm')
const APPDATA = path.join(BASE, 'appdata')
export const QODER_CLI_HOME = path.join(BASE, 'home')
const DSH_HOME = path.join(BASE, 'dsh')
export const RUNTIMES = path.join(DSH_HOME, 'dsh-runtimes')

/** A Node this process runs as, when it is Node and not Electron. */
export const HOST_NODE = path.join(BASE, 'node', `node${EXE}`)
/** The Node DSH ships, which an install guarantees whatever `PATH` says. */
export const RUNTIME_NODE = path.join(RUNTIMES, 'dsh-primary-runtime', 'dependencies', 'node', 'bin', `node${EXE}`)
/** An Electron binary: present, but not able to run a CLI script. */
export const ELECTRON = path.join(BASE, 'DeepSeek Harness.exe')

const CN_PACKAGE = path.join(NPM_PREFIX, 'node_modules', '@qodercn-ai', 'qoderclicn')
export const CN_BUNDLE = path.join(CN_PACKAGE, 'bundle', 'qoderclicn.js')
export const INTL_BUNDLE = path.join(NPM_PREFIX, 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js')
/** An installer-managed native build at the layout the CLI's installer used. */
export const NATIVE = path.join(QODER_CLI_HOME, '.qoder-cn', 'local', `qoderclicn${EXE}`)
/** The in-process worker runtime the lookup must never answer with. */
export const WORKER = path.join(BASE, 'worker', 'qoderclicn-worker-runtime.mjs')

/** The environment of the invented machine, before a case adds to it. */
export const ENV: NodeJS.ProcessEnv = {
  NPM_CONFIG_PREFIX: NPM_PREFIX,
  APPDATA,
  QODER_CLI_HOME,
  DSH_HOME,
  PATH: '',
}

/** The switch a spawned CLI is handed so its usage frames carry real tokens. */
export const EXPOSED_USAGE: NodeJS.ProcessEnv = {
  QODERCN_EXPOSE_TOKEN_USAGE: '1',
  QODER_EXPOSE_TOKEN_USAGE: '1',
}

/**
 * A machine holding exactly these files, seen through the lookup's own eyes.
 *
 * Nothing else exists: `readdir` answers no entries unless a case overrides it,
 * and the host interpreter is Node rather than Electron.
 */
export function machine(files: readonly string[], overrides: Partial<CliLookup> = {}): CliLookup {
  const present = new Set(files.map(file => path.normalize(file)))
  return {
    env: { ...ENV },
    exists: candidate => present.has(path.normalize(candidate)),
    readdir: () => [],
    execPath: HOST_NODE,
    electron: false,
    ...overrides,
  }
}

/** The same machine, but with the environment variables a case needs set. */
export function withEnv(plus: NodeJS.ProcessEnv, files: readonly string[], overrides: Partial<CliLookup> = {}): CliLookup {
  return machine(files, { ...overrides, env: { ...ENV, ...plus } })
}
