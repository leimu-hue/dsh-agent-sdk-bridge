/**
 * Where one edition's CLI can be on this machine — the layout layer.
 *
 * A layout guess, not a decision: this module answers "which paths are worth
 * probing, and in what order", while `lookup.ts` decides which of them is
 * usable. Every list is built from the same three facts — the brand's package
 * name, the platform suffix, and the directories the machine exposes — so an
 * edition can only ever be offered its own package.
 *
 * @module dsh-agent-sdk-bridge/cli/layout
 */

import { homedir } from 'node:os'
import * as path from 'node:path'
import type { BrandProfile, QoderBrand } from '../../core/brand.ts'
import { brandProfile } from '../../core/brand.ts'
import { cliHome, pathEntries, sdkDir, type Probe } from './machine.ts'

/**
 * Every candidate path for one edition, most explicit first.
 *
 * Order is the contract: an explicit override outranks a global install, which
 * outranks a bundled or installer-managed build, which outranks whatever `PATH`
 * happens to answer. The caller takes the first candidate that exists and can
 * be spawned, so moving a row here changes which build a session actually runs.
 *
 * Each brand only ever sees its own package and state directory — handing the
 * CN SDK the intl CLI (or the other way round) would speak one edition's
 * protocol to the other edition's account.
 */
export function candidates(brand: QoderBrand, probe: Probe): string[] {
  const profile = brandProfile(brand)
  const found: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0 && !found.includes(value)) found.push(value)
  }
  // Brand-specific overrides first, then the shared one only when it does not
  // name the other edition (see {@link isForeignCliPath}).
  push(brand === 'cn' ? probe.env.QODERCN_CLI_PATH : probe.env.QODER_CLI_PATH)
  const shared = probe.env.QODERCLI_PATH
  if (shared !== undefined && !isForeignCliPath(brand, shared)) push(shared)
  for (const root of nodeModulesRoots(probe)) {
    for (const pkg of profile.cliPackages) {
      for (const entry of packageEntries(path.join(root, pkg.scope, pkg.name), pkg.name, probe)) push(entry)
    }
  }
  const sdk = sdkDir(profile.sdkPackage)
  if (sdk !== undefined) {
    for (const pkg of profile.cliPackages) push(path.join(sdk, 'dist', '_bundled', `${pkg.name}${probe.suffix}`))
  }
  // The CLI's own install roots, where its installers put a native build.
  for (const entry of nativeInstalls(profile, probe)) push(entry)
  // Last, whatever a user's shell would resolve: a build on `PATH` that no
  // layout above knows about is still a build this machine can run.
  for (const entry of pathClis(profile, probe)) push(entry)
  return found
}

/**
 * Whether a CLI path belongs to the other edition.
 *
 * `QODERCLI_PATH` predates the international edition and is set globally by
 * some CN installs. Both SDKs read that one variable from the parent process
 * before anything else, so an intl session would otherwise spawn the CN CLI and
 * answer with the CN account. A path that names an edition is therefore never
 * offered to the other one; a neutral custom build is still honoured for both.
 */
export function isForeignCliPath(brand: QoderBrand, candidate: string): boolean {
  const text = candidate.replace(/\\/g, '/').toLowerCase()
  const chinese = text.includes('qoderclicn') || text.includes('@qodercn-ai') || text.includes('/.qoder-cn/')
  const global = !chinese
    && (text.includes('@qoder-ai') || text.includes('/.qoder/') || /(^|[/_-])qodercli(\.exe|\.js|$)/.test(text))
  return brand === 'global' ? chinese : global
}

/** Whether the SDK would run this entry through an interpreter. */
export function isScript(entry: string): boolean {
  return /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry)
}

/**
 * Whether the SDK would answer this entry with its in-process worker runtime,
 * which is the transport this module exists to avoid. Kept in step with the
 * SDK's own recognition rule so a path is never silently routed back in-process.
 */
export function isWorkerRuntime(entry: string): boolean {
  return /^(?:qoder(?:cli|clicn|cn)?-)?worker-runtime(?:\.obf)?\.mjs$/i.test(path.basename(entry))
}

/**
 * Where a Qoder installer puts a native build, most specific first.
 *
 * The desktop installers write `<home>/<state dir>/bin/<cli>/<cli><suffix>`,
 * which is what `where qodercli` answers on a machine that never used npm for
 * it — and that layout used to be invisible here, so a working install was
 * reported as missing. The earlier `<home>/<state dir>/local/<cli><suffix>`
 * stays probed: it is what the CLI's own installer wrote before that.
 */
function nativeInstalls(profile: BrandProfile, probe: Probe): string[] {
  const home = cliHome(probe.env)
  const found: string[] = []
  for (const pkg of profile.cliPackages) {
    const name = `${pkg.name}${probe.suffix}`
    found.push(path.join(home, profile.configDirName, 'bin', pkg.name, name))
    found.push(path.join(home, profile.configDirName, 'bin', name))
    found.push(path.join(home, profile.configDirName, 'local', name))
  }
  return found
}

/**
 * CLIs a user's own shell would find, one per `PATH` directory.
 *
 * Only the package's own name is probed, never a command alias: `qoder` on
 * `PATH` is as likely to be a desktop binary as the CLI. npm's `.cmd`/`.ps1`
 * shims are skipped too — they need a shell to run, and the package they wrap
 * is probed directly by the npm roots.
 */
function pathClis(profile: BrandProfile, probe: Probe): string[] {
  const found: string[] = []
  for (const dir of pathEntries(probe.env)) {
    for (const pkg of profile.cliPackages) found.push(path.join(dir, `${pkg.name}${probe.suffix}`))
  }
  return found
}

/**
 * Every path one installed npm package can expose as its CLI.
 *
 * `main`/`bin` are read from the package's own manifest rather than guessed:
 * the entry point has changed between CLI releases, and hard-coding only
 * `bundle/<name>.js` reported an installed package as missing whenever it did
 * not match. Unreadable manifests fall back to the conventional entries.
 */
function packageEntries(dir: string, name: string, probe: Probe): string[] {
  const entries: string[] = [
    path.join(dir, 'bundle', `${name}.js`),
    path.join(dir, `${name}.js`),
    path.join(dir, 'bundle', `${name}${probe.suffix}`),
  ]
  try {
    const manifest = JSON.parse(probe.read(path.join(dir, 'package.json'))) as {
      main?: unknown
      bin?: unknown
    }
    if (typeof manifest.main === 'string') entries.push(path.join(dir, manifest.main))
    const bin = manifest.bin
    if (typeof bin === 'string') entries.push(path.join(dir, bin))
    else if (bin !== null && typeof bin === 'object') {
      for (const value of Object.values(bin)) {
        if (typeof value === 'string') entries.push(path.join(dir, value))
      }
    }
  } catch {
    // No readable manifest (or no package at all): the conventional entries
    // above are everything worth probing.
  }
  return entries
}

/** `node_modules` roots a global install can land in. */
function nodeModulesRoots(probe: Probe): string[] {
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0 && !roots.includes(value)) roots.push(value)
  }
  const env = probe.env
  // npm's own prefix wins over the default one, which on Windows is
  // %APPDATA%\npm; the rest are the unix layouts — a prefix install (nvm,
  // /usr/local) and the per-user prefix nobody sets but plenty of machines have.
  push(env.NPM_CONFIG_PREFIX === undefined ? undefined : path.join(env.NPM_CONFIG_PREFIX, 'node_modules'))
  push(env.APPDATA === undefined ? undefined : path.join(env.APPDATA, 'npm', 'node_modules'))
  push(path.join(homedir(), '.npm-global', 'node_modules'))
  if (probe.node !== undefined) {
    // A Windows install keeps globals directly under its prefix
    // (`<node>\node_modules`); a unix one under `<prefix>/lib/node_modules`.
    // Only the unix shape used to be probed, so a Windows Node outside
    // %APPDATA%\npm — a portable or per-drive install — had a working CLI the
    // lookup could not see, and the page kept asking to install it again.
    const prefix = path.dirname(probe.node)
    push(path.join(prefix, 'node_modules'))
    push(path.join(path.dirname(prefix), 'lib', 'node_modules'))
  }
  // Prefixes of the other Nodes on `PATH`. The host may be running on the Node
  // DSH ships, whose prefix is not the one this machine's `npm install -g`
  // wrote to (nvm4w's `C:\nvm4w\nodejs`), and probing only the resolved
  // interpreter's prefix reported that install as missing.
  for (const prefix of pathPrefixes(probe)) {
    push(path.join(prefix, 'node_modules'))
    push(path.join(path.dirname(prefix), 'lib', 'node_modules'))
  }
  return roots
}

/**
 * Directories on `PATH` that hold this platform's Node interpreter.
 *
 * Probed rather than read from an npm setting: the prefix a global install
 * landed in is the one belonging to whichever Node put `npm` on `PATH`, which
 * need not be the interpreter this lookup runs under.
 */
function pathPrefixes(probe: Probe): string[] {
  return pathEntries(probe.env).filter(dir => probe.exists(path.join(dir, probe.nodeExecutable)))
}
