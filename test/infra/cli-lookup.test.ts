/**
 * Which build of the Qoder CLI a session runs, and with which interpreter.
 *
 * Every case describes a machine through the fixture module, so nothing here
 * asserts whatever the test computer happens to have installed. What matters is
 * that a found CLI is spawnable (never a worker-runtime module, which the SDK
 * would answer with the in-process worker the lookup exists to avoid), that a
 * script entry always comes with an interpreter, that an edition never reaches
 * the other edition's build, and that finding nothing leaves the SDK's own
 * defaults alone.
 */
import * as path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { cliChildEnv, foreignCliOverride, qoderCliOptions, resolveQoderCli, type CliLookup } from '../../src/infra/cli.ts'
import {
  BASE, CN_BUNDLE, ELECTRON, ENV, EXE, EXPOSED_USAGE, HOST_NODE, INTL_BUNDLE, NATIVE, QODER_CLI_HOME,
  RUNTIME_NODE, RUNTIMES, WORKER, machine, withEnv,
} from '../helpers/cli-machine.ts'

describe('qoder CLI lookup', () => {
  it('takes an explicit QODERCLI_PATH before anything it could find itself', () => {
    const custom = path.join(BASE, 'custom', 'qoderclicn.js')
    const lookup = withEnv({ QODERCLI_PATH: custom }, [custom, CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)?.path).toBe(custom)
  })

  it('answers a native build with a path and no interpreter', () => {
    expect(resolveQoderCli('cn', machine([NATIVE]))).toEqual({ path: NATIVE })
    // Nothing to prepend to PATH: the binary is its own entry point. The
    // environment still rides along, because the metering switch does.
    expect(qoderCliOptions('cn', machine([NATIVE]))).toEqual({
      pathToQoderCLIExecutable: NATIVE,
      env: { ...process.env, ...EXPOSED_USAGE },
    })
  })

  it('pairs an installed script with the Node that runs it', () => {
    const lookup = machine([CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: path.dirname(HOST_NODE) })

    const options = qoderCliOptions('cn', lookup)
    expect(options.pathToQoderCLIExecutable).toBe(CN_BUNDLE)
    expect(options.executable).toBe('node')
    // The SDK reads `env` as the child's whole environment, not as a delta: the
    // interpreter's directory must be prepended to the environment the CLI
    // inherits, never take its place.
    const prefix = `${path.dirname(HOST_NODE)}${path.delimiter}`
    expect(options.env).toEqual({ ...process.env, PATH: `${prefix}${process.env.PATH ?? ''}`, ...EXPOSED_USAGE })
  })

  it('asks the CLI to report its real token metering', () => {
    // The CLI zeroes input/output and both cache buckets on every usage frame
    // unless this switch is set, which leaves the harness with estimates and a
    // structurally 0% cache hit. Both brand prefixes are set because either
    // package can answer the lookup.
    for (const lookup of [machine([CN_BUNDLE]), machine([NATIVE])]) {
      const options = qoderCliOptions('cn', lookup)
      expect(options.env?.QODERCN_EXPOSE_TOKEN_USAGE).toBe('1')
      expect(options.env?.QODER_EXPOSE_TOKEN_USAGE).toBe('1')
    }
    // A machine with no CLI keeps the SDK's default transport, which this
    // module cannot hand an environment to.
    expect(qoderCliOptions('cn', machine([]))).toEqual({})
  })

  it('keeps each edition on its own CLI and state directory', () => {
    // The intl brand finds its own package and native install root…
    expect(resolveQoderCli('global', machine([INTL_BUNDLE]))?.path).toBe(INTL_BUNDLE)
    const intlNative = path.join(QODER_CLI_HOME, '.qoder', 'local', `qodercli${EXE}`)
    expect(resolveQoderCli('global', machine([intlNative]))).toEqual({ path: intlNative })

    // …and never the other edition's, because that CLI answers with the other
    // account's credentials and protocol build.
    expect(resolveQoderCli('global', machine([CN_BUNDLE, NATIVE]))).toBeUndefined()
    expect(resolveQoderCli('cn', machine([INTL_BUNDLE, intlNative]))).toBeUndefined()
  })

  it('finds a native build where Qoder\'s installer puts it', () => {
    // The desktop installer writes `~/.qoder/bin/qodercli/qodercli.exe` and
    // puts that directory on PATH. That layout used to be invisible — the only
    // native path probed was `~/.qoder/local` — so a machine whose CLI came
    // from the installer alone was told to install one.
    const installed = path.join(QODER_CLI_HOME, '.qoder', 'bin', 'qodercli', `qodercli${EXE}`)
    expect(resolveQoderCli('global', machine([installed]))).toEqual({ path: installed })

    const cnInstalled = path.join(QODER_CLI_HOME, '.qoder-cn', 'bin', 'qoderclicn', `qoderclicn${EXE}`)
    expect(resolveQoderCli('cn', machine([cnInstalled]))).toEqual({ path: cnInstalled })

    // The editions still never see each other's build.
    expect(resolveQoderCli('cn', machine([installed]))).toBeUndefined()
    expect(resolveQoderCli('global', machine([cnInstalled]))).toBeUndefined()
  })

  it('takes a build off PATH, which is how a shell resolves it', () => {
    const bin = path.join(BASE, 'opt', 'qoder')
    const onPath = path.join(bin, `qodercli${EXE}`)
    expect(resolveQoderCli('global', withEnv({ PATH: bin }, [onPath]))).toEqual({ path: onPath })

    // A command alias is not evidence: `qoder` on PATH is as likely to be the
    // desktop binary as the CLI, so only the package's own name is probed.
    const alias = path.join(bin, `qoder${EXE}`)
    expect(resolveQoderCli('global', withEnv({ PATH: bin }, [alias]))).toBeUndefined()
  })

  it('derives the npm prefix from the Node on PATH, not the one it runs under', () => {
    // A Windows global install lands in `<node dir>\node_modules` — nvm4w keeps
    // its prefix there. When the host runs on the Node DSH ships, that prefix
    // is not the resolved interpreter's, so a working install looked missing.
    const prefix = path.join(BASE, 'nvm4w', 'nodejs')
    const entry = path.join(prefix, 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js')
    const lookup = machine([entry, path.join(prefix, `node${EXE}`), RUNTIME_NODE], {
      execPath: ELECTRON,
      electron: true,
      env: { ...ENV, PATH: prefix },
      readdir: dir => (path.normalize(dir) === path.normalize(RUNTIMES) ? ['dsh-primary-runtime'] : []),
    })
    expect(resolveQoderCli('global', lookup)).toEqual({ path: entry, nodeDir: path.dirname(RUNTIME_NODE) })
  })

  it('never lends the CN CLI override to the international route', () => {
    // `QODERCLI_PATH` predates the intl edition and is set globally by some CN
    // installs. Both SDKs read it from the parent process before any option, so
    // the lookup must refuse it for the other brand — and the caller must be
    // able to explain why the brand has no usable CLI.
    const cnOnly = withEnv({ QODERCLI_PATH: CN_BUNDLE }, [CN_BUNDLE])
    expect(resolveQoderCli('global', cnOnly)).toBeUndefined()
    expect(foreignCliOverride('global', cnOnly)).toBe(CN_BUNDLE)
    expect(foreignCliOverride('cn', cnOnly)).toBeUndefined()

    // With an intl build of its own, the foreign override is ignored and the
    // brand's own CLI wins.
    const both = withEnv({ QODERCLI_PATH: CN_BUNDLE }, [CN_BUNDLE, INTL_BUNDLE])
    expect(resolveQoderCli('global', both)?.path).toBe(INTL_BUNDLE)
    expect(foreignCliOverride('global', both)).toBeUndefined()
    // The explicit option wins over the SDK's own QODERCLI_PATH lookup, which
    // would otherwise still resolve to the CN CLI.
    expect(qoderCliOptions('global', both).pathToQoderCLIExecutable).toBe(INTL_BUNDLE)
  })

  it('follows the manifest when the package entry is not the guessed one', () => {
    // A release may move its entry point (npm itself, a bundler, a partial
    // reinstall). Probing only `bundle/<name>.js` then reported an installed
    // package as missing, and the page insisted the CLI had to be installed —
    // which is exactly what made "install, then sign in" loop.
    const root = mkdtempSync(path.join(tmpdir(), 'qoder-cli-'))
    const dir = path.join(root, 'node_modules', '@qodercn-ai', 'qoderclicn')
    const entry = path.join(dir, 'dist', 'main.js')
    mkdirSync(path.dirname(entry), { recursive: true })
    writeFileSync(entry, '// cli\n')
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'qoderclicn', bin: { qoderclicn: 'dist/main.js' } }))

    const lookup: CliLookup = {
      env: { ...ENV, NPM_CONFIG_PREFIX: root, APPDATA: path.join(root, 'appdata'), QODER_CLI_HOME: path.join(root, 'home') },
      exists: candidate => existsSync(candidate),
      readdir: () => [],
      // A real interpreter, so a script entry is answerable at all.
      execPath: process.execPath,
      electron: false,
    }
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: entry, nodeDir: path.dirname(process.execPath) })
    rmSync(root, { recursive: true, force: true })
  })

  it('gives a child no foreign QODERCLI_PATH to inherit', () => {
    // Both SDKs read that variable from the parent before any option, so the
    // child must not carry the other edition's value at all.
    const env = cliChildEnv('global', { ...ENV, QODERCLI_PATH: CN_BUNDLE })
    expect(env.QODERCLI_PATH).toBeUndefined()
    expect(env.QODERCN_EXPOSE_TOKEN_USAGE).toBe('1')
    // A neutral path belongs to neither edition and is kept as it was.
    const neutral = cliChildEnv('global', { ...ENV, QODERCLI_PATH: path.join(BASE, 'custom', 'cli.js') })
    expect(neutral.QODERCLI_PATH).toBe(path.join(BASE, 'custom', 'cli.js'))
  })

  it('honours brand-specific CLI overrides', () => {
    const custom = path.join(BASE, 'custom', 'qodercli.js')
    const lookup = withEnv({ QODER_CLI_PATH: custom }, [custom])
    expect(resolveQoderCli('global', lookup)?.path).toBe(custom)
    expect(resolveQoderCli('cn', lookup)).toBeUndefined()

    const cnCustom = path.join(BASE, 'custom', 'qoderclicn.js')
    const cnLookup = withEnv({ QODERCN_CLI_PATH: cnCustom }, [cnCustom])
    expect(resolveQoderCli('cn', cnLookup)?.path).toBe(cnCustom)
    expect(resolveQoderCli('global', cnLookup)).toBeUndefined()
  })

  it('prefers a real Node over DSH\'s shipped one', () => {
    const lookup = machine([CN_BUNDLE, HOST_NODE, RUNTIME_NODE])
    expect(resolveQoderCli('cn', lookup)?.nodeDir).toBe(path.dirname(HOST_NODE))
  })

  it('falls back to DSH\'s shipped runtime when the host is Electron', () => {
    const lookup = machine([CN_BUNDLE, RUNTIME_NODE], {
      execPath: ELECTRON,
      electron: true,
      readdir: dir => (path.normalize(dir) === path.normalize(RUNTIMES) ? ['dsh-primary-runtime'] : []),
    })
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: path.dirname(RUNTIME_NODE) })
  })

  it('falls back to PATH when neither the host nor DSH offers a Node', () => {
    const bin = path.join(BASE, 'usr', 'bin')
    const lookup = machine([CN_BUNDLE, path.join(bin, `node${EXE}`)], {
      execPath: ELECTRON,
      electron: true,
      env: { ...ENV, PATH: bin },
    })
    expect(resolveQoderCli('cn', lookup)).toEqual({ path: CN_BUNDLE, nodeDir: bin })
  })

  it('skips the worker runtime the SDK would answer in-process', () => {
    // Alone it is unusable: the SDK would run it on a thread inside DSH, which
    // is the transport that fails every image turn.
    expect(resolveQoderCli('cn', withEnv({ QODERCLI_PATH: WORKER }, [WORKER]))).toBeUndefined()

    // Alongside a spawnable build, the build wins.
    const lookup = withEnv({ QODERCLI_PATH: WORKER }, [WORKER, CN_BUNDLE])
    expect(resolveQoderCli('cn', lookup)?.path).toBe(CN_BUNDLE)
    expect(qoderCliOptions('cn', machine([WORKER]))).toEqual({})
  })

  it('drops a script it has no interpreter for rather than only half-answering', () => {
    const lookup = machine([CN_BUNDLE], { execPath: ELECTRON, electron: true })
    expect(resolveQoderCli('cn', lookup)).toBeUndefined()
    expect(qoderCliOptions('cn', lookup)).toEqual({})
  })

  it('finds nothing on a bare machine, leaving the SDK\'s default transport', () => {
    expect(resolveQoderCli('cn', machine([]))).toBeUndefined()
    expect(resolveQoderCli('global', machine([]))).toBeUndefined()
    expect(qoderCliOptions('cn', machine([]))).toEqual({})
    expect(qoderCliOptions('global', machine([]))).toEqual({})
  })
})
