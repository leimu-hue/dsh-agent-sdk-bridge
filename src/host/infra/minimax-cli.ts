/**
 * The MiniMax Code CLI (`mcode`): locating it, and how to spawn it.
 *
 * MiniMax ships `@minimax-ai/code` as a global npm package whose `mcode`
 * launcher is a Node shim; its native SQLite dependency comes from the
 * package's own postinstall. The plugin deliberately does NOT install it: the
 * exact npm flags, package version and dependency set belong to MiniMax and
 * change with their releases, so the page only reports whether a CLI is present
 * and leaves installing it to the user. What remains here is the lookup, which
 * is the half that has to be exact.
 *
 * @module dsh-agent-sdk-bridge/minimax-cli
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** How to invoke the CLI: an executable plus its leading arguments. */
export interface MinimaxCliSpec {
  command: string
  args: string[]
  /** The JavaScript entry, when the launcher resolves to one. */
  cliPath?: string
}

/** The npm package the launcher belongs to. */
const PACKAGE = '@minimax-ai/code'

/**
 * The Node interpreter that can load the CLI's native SQLite module.
 *
 * `@minimax-ai/code` is installed globally by npm, so its `better-sqlite3`
 * build matches the Node npm used — the `node` on PATH. DSH's desktop host
 * runs Electron, whose NODE_MODULE_VERSION differs; spawning `process.execPath`
 * there makes `mcode acp` die before the ACP handshake ("ACP connection
 * closed"). Prefer the npm shim's sibling node.exe when present, otherwise
 * resolve `node` from PATH.
 */
function cliNodeCommand(shimDir?: string): string {
  if (process.versions.electron === undefined) return process.execPath
  if (shimDir !== undefined) {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const local = join(shimDir, exe)
    if (existsSync(local)) return local
  }
  return 'node'
}

function fromJsEntry(path: string, nodeCommand: string = cliNodeCommand()): MinimaxCliSpec {
  return { command: nodeCommand, args: [path], cliPath: path }
}

function fromShim(shim: string): MinimaxCliSpec | undefined {
  if (shim.endsWith('.cmd') || shim.endsWith('.bat')) {
    // npm's Windows shim forwards to the package's cli.js. Reading it avoids a
    // cmd.exe layer, which keeps ACP's stdio byte-clean; the shim's own Node
    // interpreter is kept so the native SQLite ABI still matches.
    try {
      const text = readFileSync(shim, 'utf8')
      const match = /["']([^"']*node_modules[\\/]@minimax-ai[\\/]code[\\/]cli\.js)["']/.exec(text)
      if (match !== null && existsSync(match[1])) return fromJsEntry(match[1], cliNodeCommand(dirname(shim)))
    } catch {
      // Fall through to the sibling-package guess below.
    }
    const sibling = join(dirname(shim), 'node_modules', '@minimax-ai', 'code', 'cli.js')
    if (existsSync(sibling)) return fromJsEntry(sibling, cliNodeCommand(dirname(shim)))
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', shim],
    }
  }
  if (shim.endsWith('.js') || shim.endsWith('.mjs')) return fromJsEntry(shim)
  try {
    const real = realpathSync(shim)
    if (real.endsWith('.js') || real.endsWith('.mjs')) return fromJsEntry(real)
  } catch {
    // A path that cannot be resolved is still usable as a command.
  }
  return { command: shim, args: [] }
}

/**
 * Locate `mcode`.
 *
 * `MCODE_CLI_PATH` wins (a cli.js path or an executable); otherwise the PATH
 * shims and the global npm prefixes are checked. The explicit cli.js lookup
 * matters on Windows, where spawning a `.cmd` for ACP would put cmd.exe between
 * the protocol streams.
 */
export function resolveMinimaxCli(): MinimaxCliSpec | undefined {
  const override = process.env.MCODE_CLI_PATH?.trim()
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    return fromShim(override)
  }

  const names = process.platform === 'win32'
    ? ['mcode.cmd', 'mcode.exe', 'mcode']
    : ['mcode']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.trim() === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return fromShim(candidate)
    }
  }

  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', PACKAGE, 'cli.js'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'npm', 'node_modules', PACKAGE, 'cli.js'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', PACKAGE, 'cli.js'),
      ]
    : [
        join(home, '.npm-global', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join('/usr', 'local', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join('/usr', 'lib', 'node_modules', PACKAGE, 'cli.js'),
        join(home, '.local', 'lib', 'node_modules', PACKAGE, 'cli.js'),
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return fromJsEntry(candidate)
  }
  return undefined
}

/** The spawn argument list for one CLI invocation. */
export function minimaxCliArgs(spec: MinimaxCliSpec, args: readonly string[]): string[] {
  return [...spec.args, ...args]
}
