/**
 * What a user reads when a CLI is missing or unusable — the wording layer.
 *
 * Kept apart from the lookup so the reason a message exists never has to travel
 * with the machinery that detected it: the page's job is to name the CLI to
 * install, not to explain the plugin's environment plumbing. The technical
 * detail stays in the layers below.
 *
 * @module dsh-agent-sdk-bridge/cli/messages
 */
import type { QoderBrand } from '../../core/brand.ts';
/**
 * The error text for {@link foreignCliOverride}.
 *
 * Deliberately says nothing about the variable or the path that caused it: the
 * page's job here is to tell the user which CLI to install, not to explain the
 * plugin's environment plumbing. The technical reason stays in the lookup.
 */
export declare function cliConflictMessage(brand: QoderBrand): string;
/**
 * Turn a CLI failure into something a user can act on.
 *
 * The SDK reports an outdated CLI as `Qoder CLI process exited with code 42`,
 * which says nothing about the cause: CLI 1.1.81 removed the worker-session
 * handshake the older SDK spoke, and its own log says so
 * (`sdk_worker_removed: … Upgrade to the latest Qoder SDK version, or roll back
 * the CLI`). The only fix available to a user is reinstalling the pair through
 * the bundled helper, so say that instead of echoing the number.
 *
 * @param detail - the error text as the SDK reported it.
 * @param brand - which edition's helper the message should name.
 * @returns the original detail, prefixed with the actionable explanation.
 */
export declare function cliFailureText(detail: string, brand: QoderBrand): string;
