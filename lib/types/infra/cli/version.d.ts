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
import type { QoderBrand } from '../../core/brand.ts';
import { type CliLookup } from './machine.ts';
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
export declare function requiredCliVersion(brand: QoderBrand): string | undefined;
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
export declare function installedCliVersion(brand: QoderBrand, lookup?: CliLookup): string | undefined;
