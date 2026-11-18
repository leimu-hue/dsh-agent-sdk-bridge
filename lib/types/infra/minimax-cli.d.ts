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
/** How to invoke the CLI: an executable plus its leading arguments. */
export interface MinimaxCliSpec {
    command: string;
    args: string[];
    /** The JavaScript entry, when the launcher resolves to one. */
    cliPath?: string;
}
/**
 * Locate `mcode`.
 *
 * `MCODE_CLI_PATH` wins (a cli.js path or an executable); otherwise the PATH
 * shims and the global npm prefixes are checked. The explicit cli.js lookup
 * matters on Windows, where spawning a `.cmd` for ACP would put cmd.exe between
 * the protocol streams.
 */
export declare function resolveMinimaxCli(): MinimaxCliSpec | undefined;
/** The spawn argument list for one CLI invocation. */
export declare function minimaxCliArgs(spec: MinimaxCliSpec, args: readonly string[]): string[];
