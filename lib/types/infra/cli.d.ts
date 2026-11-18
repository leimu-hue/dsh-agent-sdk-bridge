/**
 * Finding the local Qoder CLI of one edition, and the Node that has to run it.
 *
 * The SDK's default transport runs its worker runtime on a Node worker thread,
 * which is a thread *inside* the DSH process. On Windows that puts the worker's
 * bundled sharp (libvips 8.17) into the same address space as DSH's own sharp
 * (libvips 8.18), and the loader satisfies the worker's `libvips-42.dll` import
 * from the module already registered under that name. The ABI mismatch that
 * follows fails every turn carrying an image, with libvips reporting
 * `colourspace: parameter space not set` and the CLI answering
 * `image_processing_failed`.
 *
 * A child process has its own address space, and is how an installed
 * `qoderclicn` runs by itself anyway, so sessions hand the SDK an entry it can
 * spawn. Naming that entry is all it takes: the SDK picks its process transport
 * for any `pathToQoderCLIExecutable` that is not a worker-runtime module, which
 * is exactly the transport that must not be used here.
 *
 * Nothing is invented. The CLI is looked for where the setup helper installs
 * it and where the SDK bundles it; the Node to run it is the host's own, DSH's
 * shipped runtime, or whatever `PATH` answers. When none of that is present the
 * lookup returns nothing and the SDK keeps its default transport — worse for
 * images, but not this module's place to fail a session over.
 *
 * This file is the public surface only; the work is layered under `cli/`, each
 * layer answering one question for the layer above it:
 *
 * - `cli/machine.ts` — what this computer offers (env, `PATH`, a Node, the SDK
 *   directory), read once into a `Probe`;
 * - `cli/layout.ts` — which paths are worth probing for one edition, and in
 *   what order;
 * - `cli/lookup.ts` — which of them a session may use, and how it is spawned;
 * - `cli/version.ts` — whether the installed build matches the SDK's pin;
 * - `cli/messages.ts` — what the user is told when it does not.
 *
 * @module dsh-agent-sdk-bridge/cli
 */
export type { CliLookup, DirRead, FileExists, FileRead } from './cli/machine.ts';
export type { QoderCli, QoderCliOptions } from './cli/lookup.ts';
export { cliChildEnv, foreignCliOverride, qoderCliOptions, resolveQoderCli } from './cli/lookup.ts';
export { isForeignCliPath } from './cli/layout.ts';
export { installedCliVersion, requiredCliVersion } from './cli/version.ts';
export { cliConflictMessage, cliFailureText } from './cli/messages.ts';
