/**
 * Which of the machine's CLIs a session may use, and how it is spawned — the
 * decision layer.
 *
 * `layout.ts` lists what is worth probing; this module turns that list into one
 * answer: the first spawnable, non-worker entry, plus the environment its child
 * process needs. It never second-guesses a layout — it only rejects entries the
 * SDK would run the wrong way (a script with no interpreter, the worker runtime
 * that would answer in-process).
 *
 * @module dsh-agent-sdk-bridge/cli/lookup
 */

import * as path from 'node:path'
import type { Options } from '@qodercn-ai/qodercn-agent-sdk'
import type { QoderBrand } from '../../core/brand.ts'
import { candidates, isForeignCliPath, isScript, isWorkerRuntime } from './layout.ts'
import { probeOf, type CliLookup, type Probe } from './machine.ts'

/** The query options that move a session onto the CLI's own process. */
export type QoderCliOptions = Pick<Options, 'pathToQoderCLIExecutable' | 'executable' | 'env'>

/**
 * The switch that makes the CLI report its real token metering.
 *
 * The CLI prices every provider request, but before a usage record leaves the
 * process it zeroes `input_tokens`, `output_tokens` and both cache buckets
 * unless this switch is on — its own bundle guards the real values with
 * `if (options?.exposeTokenCounts || tokenUsageRequested())`, and otherwise
 * emits `{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
 * cache_read_input_tokens: 0 }` while keeping `credits` and the context ratio.
 * That is why every counter the harness shows is an estimate here, and why
 * `缓存命中` reads 0% no matter how much of a prompt the cache served.
 *
 * The names are the CLI's own env-catalog entries (`ENV_EXPOSE_TOKEN_USAGE`),
 * brand-prefixed per build — the CN CLI reads `QODERCN_…`, the international
 * one `QODER_…` — and both are set because which build answers is the lookup's
 * decision, not this module's. The value is read as a boolean (`1`/`true`/`yes`).
 */
const EXPOSE_TOKEN_USAGE: NodeJS.ProcessEnv = {
  QODERCN_EXPOSE_TOKEN_USAGE: '1',
  QODER_EXPOSE_TOKEN_USAGE: '1',
}

/** A CLI entry that can be spawned, plus the directory of the Node that runs it. */
export interface QoderCli {
  /** Path to the CLI: a native binary, or a script the Node below runs. */
  path: string
  /** Directory holding the interpreter for a script entry; absent for a binary. */
  nodeDir?: string
}

/**
 * A CLI the SDK can spawn, or nothing when this machine offers none.
 *
 * Thin by design: {@link probeOf} reads the machine and {@link findCli} decides,
 * so a caller that already described the machine (the version reader) does not
 * have to describe it again.
 *
 * @param brand - which edition's CLI to look for.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export function resolveQoderCli(brand: QoderBrand = 'cn', lookup: CliLookup = {}): QoderCli | undefined {
  return findCli(brand, probeOf(lookup))
}

/**
 * The decision itself: the first candidate that exists and can be spawned.
 *
 * A script entry is only answerable when the machine has an interpreter for it,
 * and the worker runtime is never an answer at all — the SDK would run it on a
 * thread inside DSH, which is the transport this whole module exists to avoid.
 *
 * @param brand - which edition's CLI to look for.
 * @param probe - the machine, already read.
 */
export function findCli(brand: QoderBrand, probe: Probe): QoderCli | undefined {
  for (const candidate of candidates(brand, probe)) {
    if (!probe.exists(candidate) || isWorkerRuntime(candidate)) continue
    if (!isScript(candidate)) return { path: candidate }
    if (probe.node !== undefined) return { path: candidate, nodeDir: path.dirname(probe.node) }
  }
  return undefined
}

/**
 * Query options that route a session through the CLI's own process.
 *
 * Empty when no CLI was found: the caller spreads this into its options, so an
 * empty answer leaves the SDK's default transport in place.
 *
 * @param brand - which edition's CLI the session speaks to.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export function qoderCliOptions(brand: QoderBrand = 'cn', lookup: CliLookup = {}): QoderCliOptions {
  const cli = resolveQoderCli(brand, lookup)
  if (cli === undefined) return {}
  // The SDK reads `env` as the child's whole environment rather than a delta, so
  // every branch hands over the environment the CLI would have inherited anyway
  // — handing over `PATH` alone would strip the CLI of the directories it keeps
  // its own state in — plus the switch that unzeroes its token metering.
  //
  // `cliChildEnv` also drops a `QODERCLI_PATH` naming the *other* edition.
  // Both SDKs consult that variable before any option passed here, so leaving
  // it in place is what made an intl session answer with the CN account (and,
  // before that was understood, refuse to start at all on a machine whose CN
  // installer had exported it globally).
  const env = cliChildEnv(brand)
  if (cli.nodeDir === undefined) {
    return { pathToQoderCLIExecutable: cli.path, env }
  }
  return {
    pathToQoderCLIExecutable: cli.path,
    // A bare name, because that is what the SDK's option accepts: the child
    // resolves it against PATH, so the interpreter's own directory is put in
    // front of the inherited PATH instead of being spelled out here.
    executable: 'node',
    env: { ...env, PATH: `${cli.nodeDir}${path.delimiter}${env.PATH ?? ''}` },
  }
}

/**
 * Why this edition has no usable CLI, when `QODERCLI_PATH` explains it.
 *
 * `QODERCLI_PATH` predates the international edition and some installers
 * export it machine-wide. Both SDKs read it from the parent process before any
 * option this plugin can pass, so a value naming the *other* edition would
 * hand this edition's session the other account. The lookup therefore never
 * offers it ({@link isForeignCliPath}), and this reports the case where it is
 * all the machine has, so the page can ask for the right CLI to be installed.
 *
 * This is a diagnosis, not a second rule: an edition that finds its own CLI is
 * unaffected by the variable. That is what keeps one edition's install from
 * blocking the other's sign-in — the earlier code treated any foreign value as
 * fatal, so a machine that had only the intl CLI installed could not sign in
 * to CN even after installing it if the lookup missed the new package.
 *
 * @param brand - the edition the caller is about to start.
 * @param lookup - the machine to inspect; defaults to this process's.
 * @returns the foreign override when this edition has nothing of its own.
 */
export function foreignCliOverride(brand: QoderBrand, lookup: CliLookup = {}): string | undefined {
  const env = lookup.env ?? process.env
  const override = env.QODERCLI_PATH
  if (override === undefined || override.length === 0) return undefined
  if (!isForeignCliPath(brand, override)) return undefined
  // A CLI of our own always wins; the session then ignores the variable
  // entirely because it names the executable explicitly.
  if (resolveQoderCli(brand, lookup) !== undefined) return undefined
  return override
}

/**
 * The environment one session's child process receives.
 *
 * `QODERCLI_PATH` is stripped when it names the other edition: both SDKs read
 * it from the parent before honouring any option, so leaving it in place would
 * hand the intl session the CN CLI (and the CN account). Every other variable
 * is inherited untouched — the CLI keeps its state in `PATH`-relative dirs.
 *
 * @param brand - which edition's child is being started.
 * @param env - the environment to derive from; defaults to this process's.
 */
export function cliChildEnv(brand: QoderBrand, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, ...EXPOSE_TOKEN_USAGE }
  const override = env.QODERCLI_PATH
  if (override !== undefined && override.length > 0 && isForeignCliPath(brand, override)) {
    delete child.QODERCLI_PATH
  }
  return child
}
