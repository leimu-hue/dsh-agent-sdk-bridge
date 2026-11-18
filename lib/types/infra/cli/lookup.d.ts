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
import type { Options } from '@qodercn-ai/qodercn-agent-sdk';
import type { QoderBrand } from '../../core/brand.ts';
import { type CliLookup, type Probe } from './machine.ts';
/** The query options that move a session onto the CLI's own process. */
export type QoderCliOptions = Pick<Options, 'pathToQoderCLIExecutable' | 'executable' | 'env'>;
/** A CLI entry that can be spawned, plus the directory of the Node that runs it. */
export interface QoderCli {
    /** Path to the CLI: a native binary, or a script the Node below runs. */
    path: string;
    /** Directory holding the interpreter for a script entry; absent for a binary. */
    nodeDir?: string;
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
export declare function resolveQoderCli(brand?: QoderBrand, lookup?: CliLookup): QoderCli | undefined;
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
export declare function findCli(brand: QoderBrand, probe: Probe): QoderCli | undefined;
/**
 * Query options that route a session through the CLI's own process.
 *
 * Empty when no CLI was found: the caller spreads this into its options, so an
 * empty answer leaves the SDK's default transport in place.
 *
 * @param brand - which edition's CLI the session speaks to.
 * @param lookup - the machine to inspect; defaults to this process's.
 */
export declare function qoderCliOptions(brand?: QoderBrand, lookup?: CliLookup): QoderCliOptions;
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
export declare function foreignCliOverride(brand: QoderBrand, lookup?: CliLookup): string | undefined;
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
export declare function cliChildEnv(brand: QoderBrand, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
