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
import type { QoderBrand } from '../../core/brand.ts';
import { type Probe } from './machine.ts';
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
export declare function candidates(brand: QoderBrand, probe: Probe): string[];
/**
 * Whether a CLI path belongs to the other edition.
 *
 * `QODERCLI_PATH` predates the international edition and is set globally by
 * some CN installs. Both SDKs read that one variable from the parent process
 * before anything else, so an intl session would otherwise spawn the CN CLI and
 * answer with the CN account. A path that names an edition is therefore never
 * offered to the other one; a neutral custom build is still honoured for both.
 */
export declare function isForeignCliPath(brand: QoderBrand, candidate: string): boolean;
/** Whether the SDK would run this entry through an interpreter. */
export declare function isScript(entry: string): boolean;
/**
 * Whether the SDK would answer this entry with its in-process worker runtime,
 * which is the transport this module exists to avoid. Kept in step with the
 * SDK's own recognition rule so a path is never silently routed back in-process.
 */
export declare function isWorkerRuntime(entry: string): boolean;
