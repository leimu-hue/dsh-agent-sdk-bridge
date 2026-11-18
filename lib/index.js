import { createRequire } from "node:module";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, ToolCallId, fileHandleText, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, requestImageHandleText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createSdkMcpServer } from "@qodercn-ai/qodercn-agent-sdk";
import { z } from "zod";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z$1 from "@deepseek-ai/schemastery";
//#region src/host/core/brand.ts
/** The CN edition, which the plugin was originally built for. */
const CN_BRAND = {
	id: "cn",
	provider: "qoder-cn",
	defaultDisplayName: "Qoder CN",
	sdkPackage: "@qodercn-ai/qodercn-agent-sdk",
	cliPackages: [{
		scope: "@qodercn-ai",
		name: "qoderclicn"
	}],
	cliCommands: ["qoderclicn", "qodercn"],
	configDirName: ".qoder-cn",
	staticCatalog: true
};
/**
* The international edition.
*
* The static CN catalog is deliberately NOT reused: model ids differ between
* the two plans, and a fallback the account cannot actually run would put
* unusable entries in the picker.
*/
const GLOBAL_BRAND = {
	id: "global",
	provider: "qoder-intl",
	defaultDisplayName: "Qoder 国际版",
	sdkPackage: "@qoder-ai/qoder-agent-sdk",
	cliPackages: [{
		scope: "@qoder-ai",
		name: "qodercli"
	}],
	cliCommands: ["qodercli", "qoder"],
	configDirName: ".qoder",
	staticCatalog: false
};
/**
* CodeBuddy, served through Tencent's Agent SDK.
*
* The SDK bundles its own CLI (`@tencent-ai/codebuddy-code`), so there is no
* global install step and no setup script: login is an SDK call whose region
* is chosen per request (`external` for the international site, `internal`
* for the mainland one). Enterprise/IOA/self-hosted login is out of scope.
*/
const CODEBUDDY_BRAND = {
	id: "codebuddy",
	provider: "codebuddy",
	defaultDisplayName: "CodeBuddy",
	sdkPackage: "@tencent-ai/agent-sdk",
	cliPackages: [{
		scope: "@tencent-ai",
		name: "codebuddy-code"
	}],
	cliCommands: ["codebuddy", "cbc"],
	configDirName: ".codebuddy",
	staticCatalog: false
};
/** Every brand, in the order the settings pages list them. */
const BRANDS = [
	CN_BRAND,
	GLOBAL_BRAND,
	CODEBUDDY_BRAND
];
/** Whether a value names a Qoder edition. */
function isQoderBrand(value) {
	return value === "cn" || value === "global";
}
/** Whether a value names one of the provider brands. */
function isBrandId(value) {
	return isQoderBrand(value) || value === "codebuddy";
}
/** Whether a value names a CodeBuddy login region. */
function isCodeBuddyRegion(value) {
	return value === "global" || value === "cn";
}
/** The profile for one brand. */
function brandProfile(brand) {
	if (brand === "codebuddy") return CODEBUDDY_BRAND;
	return brand === "global" ? GLOBAL_BRAND : CN_BRAND;
}
/** The SDK environment a CodeBuddy region logs into. */
function codeBuddyEnvironment(region) {
	return region === "cn" ? "internal" : "external";
}
//#endregion
//#region src/host/core/catalog.ts
/** Default combined context capacity assumed for Qoder-backed models. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default per-request output cap assumed for Qoder-backed models. */
const DEFAULT_MAX_TOKENS = 32e3;
/** Every model the account exposed at capture time, in SDK display order. */
const QODER_MODELS = [
	{
		id: "auto",
		name: "Auto",
		description: "Qoder 自动路由"
	},
	{
		id: "ultimate",
		name: "Ultimate",
		description: "最强档位路由"
	},
	{
		id: "performance",
		name: "Performance"
	},
	{
		id: "efficient",
		name: "Efficient"
	},
	{
		id: "lite",
		name: "Lite"
	},
	{
		id: "cmodel",
		name: "Cantus"
	},
	{
		id: "qmodel_38max",
		name: "Qwen3.8-Max"
	},
	{
		id: "qmodel_latest",
		name: "Qwen3.7-Max"
	},
	{
		id: "qmodel",
		name: "Qwen3.7-Plus"
	},
	{
		id: "kmodel_latest",
		name: "Kimi-K3"
	},
	{
		id: "kmodel",
		name: "Kimi-K2.7-Code"
	},
	{
		id: "gmodel",
		name: "GLM-5.3"
	},
	{
		id: "gm51model",
		name: "GLM-5.2"
	},
	{
		id: "dmodel",
		name: "DeepSeek-V4-Pro"
	},
	{
		id: "dfmodel",
		name: "DeepSeek-V4-Flash"
	},
	{
		id: "mmodel",
		name: "MiniMax-M3"
	}
];
/**
* Convenience aliases so a dsh deployment can keep using its own DeepSeek
* model names against the Qoder route.
*/
const MODEL_ALIASES = {
	"deepseek-v4-flash": "dfmodel",
	"deepseek-v4-pro": "dmodel"
};
/**
* Map a dsh-side model id onto a Qoder SDK model value.
*
* Aliases are checked first (config-supplied aliases take precedence over the
* built-in ones), then any `qoder-` prefix is stripped, and an empty result
* falls back to `auto`.
*
* @param model - model id from {@link import('@deepseek-ai/dsh-llm').GenerateOptions.model}.
* @param extraAliases - user-configured aliases, merged over {@link MODEL_ALIASES}.
* @returns the Qoder model value; the CLI falls back to `auto` for unknown values.
*/
function resolveQoderModelId(model, extraAliases) {
	const key = model.toLowerCase();
	const configured = extraAliases?.[key] ?? extraAliases?.[model];
	if (configured !== void 0 && configured.length > 0) return configured;
	const aliased = MODEL_ALIASES[key];
	if (aliased !== void 0) return aliased;
	const stripped = model.startsWith("qoder-") ? model.slice(6) : model;
	return stripped.length > 0 ? stripped : "auto";
}
//#endregion
//#region src/host/core/live.ts
/**
* Resolve one {@link Live} option, falling back when it is absent.
*
* @param value - the plain value or thunk, possibly undefined.
* @param fallback - value used when the option is absent or resolves to undefined.
* @returns the option's current value.
*/
function readLive(value, fallback) {
	const current = typeof value === "function" ? value() : value;
	return current === void 0 ? fallback : current;
}
/**
* Resolve one {@link Live} option that may legitimately be undefined.
*
* Separate from {@link readLive} because an option whose "unset" state is
* itself meaningful (`defaultReasoningEffort`: empty means "use the model's
* strongest level") has no fallback to apply.
*
* @param value - the plain value or thunk, possibly undefined.
* @returns the option's current value, or undefined when it is unset.
*/
function readLiveOptional(value) {
	return typeof value === "function" ? value() : value;
}
//#endregion
//#region src/host/infra/cli/machine.ts
/**
* One machine's facts, as the CLI lookup needs them — the bottom layer.
*
* Everything above this module decides *what* to look for; this one answers
* *where* and *whether*: which platform's layouts apply, whether a Node exists
* to run a script entry, where `PATH` points, and where the installed SDK
* landed. It is read once into a {@link Probe}, so the layers above never touch
* the filesystem themselves and a test can describe a machine instead of having
* to be one.
*
* @module dsh-agent-sdk-bridge/cli/machine
*/
/** Read one machine's facts, defaulting to the one this process runs on. */
function probeOf(lookup = {}) {
	const platform = lookup.platform ?? process.platform;
	return {
		env: lookup.env ?? process.env,
		suffix: platform === "win32" ? ".exe" : "",
		nodeExecutable: platform === "win32" ? "node.exe" : "node",
		node: resolveNode(lookup),
		exists: lookup.exists ?? existsSync,
		read: lookup.readFile ?? ((file) => readFileSync(file, "utf8"))
	};
}
/**
* The Node that runs a CLI script: this process when it *is* Node, else DSH's
* shipped runtime, else whatever `PATH` answers.
*
* DSH's runtime comes first among the fallbacks because it is the one Node a
* DSH install guarantees, whatever the user's PATH says — an Electron host
* launched from a desktop shortcut inherits an environment that need not carry
* Node at all.
*/
function resolveNode(lookup) {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const exists = lookup.exists ?? existsSync;
	const name = platform === "win32" ? "node.exe" : "node";
	const execPath = lookup.execPath ?? process.execPath;
	if (!(lookup.electron ?? process.versions.electron !== void 0) && path.basename(execPath).toLowerCase() === name) return execPath;
	const home = env.DSH_HOME === void 0 || env.DSH_HOME.length === 0 ? path.join(homedir(), ".dsh") : env.DSH_HOME;
	const runtimes = path.join(home, "dsh-runtimes");
	for (const runtime of listDir(runtimes, lookup)) {
		const candidate = path.join(runtimes, runtime, "dependencies", "node", "bin", name);
		if (exists(candidate)) return candidate;
	}
	for (const dir of pathEntries(env)) {
		const candidate = path.join(dir, name);
		if (exists(candidate)) return candidate;
	}
}
/**
* The home directory the CLI keeps its state and native builds under.
*
* `QODER_CLI_HOME` overrides it, which is how the CLI's own installer and any
* per-user relocation answer the same question.
*/
function cliHome(env) {
	return env.QODER_CLI_HOME === void 0 || env.QODER_CLI_HOME.length === 0 ? homedir() : env.QODER_CLI_HOME;
}
/** The directories `PATH` names, in resolution order. */
function pathEntries(env) {
	return (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
}
/**
* Directory of the installed SDK, for the native CLI build it may carry.
*
* The international package is optional, so a missing one answers undefined
* here rather than failing the lookup.
*/
function sdkDir(packageName) {
	try {
		const entry = createRequire(import.meta.url).resolve(packageName);
		const dir = path.dirname(entry);
		return path.basename(dir) === "dist" ? path.dirname(dir) : dir;
	} catch {
		return;
	}
}
/** Listing that answers nothing rather than throwing on a missing directory. */
function listDir(dir, lookup) {
	const read = lookup.readdir ?? ((target) => readdirSync(target));
	try {
		return read(dir);
	} catch {
		return [];
	}
}
//#endregion
//#region src/host/infra/cli/layout.ts
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
function candidates(brand, probe) {
	const profile = brandProfile(brand);
	const found = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !found.includes(value)) found.push(value);
	};
	push(brand === "cn" ? probe.env.QODERCN_CLI_PATH : probe.env.QODER_CLI_PATH);
	const shared = probe.env.QODERCLI_PATH;
	if (shared !== void 0 && !isForeignCliPath(brand, shared)) push(shared);
	for (const root of nodeModulesRoots(probe)) for (const pkg of profile.cliPackages) for (const entry of packageEntries(path.join(root, pkg.scope, pkg.name), pkg.name, probe)) push(entry);
	const sdk = sdkDir(profile.sdkPackage);
	if (sdk !== void 0) for (const pkg of profile.cliPackages) push(path.join(sdk, "dist", "_bundled", `${pkg.name}${probe.suffix}`));
	for (const entry of nativeInstalls(profile, probe)) push(entry);
	for (const entry of pathClis(profile, probe)) push(entry);
	return found;
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
function isForeignCliPath(brand, candidate) {
	const text = candidate.replace(/\\/g, "/").toLowerCase();
	const chinese = text.includes("qoderclicn") || text.includes("@qodercn-ai") || text.includes("/.qoder-cn/");
	const global = !chinese && (text.includes("@qoder-ai") || text.includes("/.qoder/") || /(^|[/_-])qodercli(\.exe|\.js|$)/.test(text));
	return brand === "global" ? chinese : global;
}
/** Whether the SDK would run this entry through an interpreter. */
function isScript(entry) {
	return /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry);
}
/**
* Whether the SDK would answer this entry with its in-process worker runtime,
* which is the transport this module exists to avoid. Kept in step with the
* SDK's own recognition rule so a path is never silently routed back in-process.
*/
function isWorkerRuntime(entry) {
	return /^(?:qoder(?:cli|clicn|cn)?-)?worker-runtime(?:\.obf)?\.mjs$/i.test(path.basename(entry));
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
function nativeInstalls(profile, probe) {
	const home = cliHome(probe.env);
	const found = [];
	for (const pkg of profile.cliPackages) {
		const name = `${pkg.name}${probe.suffix}`;
		found.push(path.join(home, profile.configDirName, "bin", pkg.name, name));
		found.push(path.join(home, profile.configDirName, "bin", name));
		found.push(path.join(home, profile.configDirName, "local", name));
	}
	return found;
}
/**
* CLIs a user's own shell would find, one per `PATH` directory.
*
* Only the package's own name is probed, never a command alias: `qoder` on
* `PATH` is as likely to be a desktop binary as the CLI. npm's `.cmd`/`.ps1`
* shims are skipped too — they need a shell to run, and the package they wrap
* is probed directly by the npm roots.
*/
function pathClis(profile, probe) {
	const found = [];
	for (const dir of pathEntries(probe.env)) for (const pkg of profile.cliPackages) found.push(path.join(dir, `${pkg.name}${probe.suffix}`));
	return found;
}
/**
* Every path one installed npm package can expose as its CLI.
*
* `main`/`bin` are read from the package's own manifest rather than guessed:
* the entry point has changed between CLI releases, and hard-coding only
* `bundle/<name>.js` reported an installed package as missing whenever it did
* not match. Unreadable manifests fall back to the conventional entries.
*/
function packageEntries(dir, name, probe) {
	const entries = [
		path.join(dir, "bundle", `${name}.js`),
		path.join(dir, `${name}.js`),
		path.join(dir, "bundle", `${name}${probe.suffix}`)
	];
	try {
		const manifest = JSON.parse(probe.read(path.join(dir, "package.json")));
		if (typeof manifest.main === "string") entries.push(path.join(dir, manifest.main));
		const bin = manifest.bin;
		if (typeof bin === "string") entries.push(path.join(dir, bin));
		else if (bin !== null && typeof bin === "object") {
			for (const value of Object.values(bin)) if (typeof value === "string") entries.push(path.join(dir, value));
		}
	} catch {}
	return entries;
}
/** `node_modules` roots a global install can land in. */
function nodeModulesRoots(probe) {
	const roots = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !roots.includes(value)) roots.push(value);
	};
	const env = probe.env;
	push(env.NPM_CONFIG_PREFIX === void 0 ? void 0 : path.join(env.NPM_CONFIG_PREFIX, "node_modules"));
	push(env.APPDATA === void 0 ? void 0 : path.join(env.APPDATA, "npm", "node_modules"));
	push(path.join(homedir(), ".npm-global", "node_modules"));
	if (probe.node !== void 0) {
		const prefix = path.dirname(probe.node);
		push(path.join(prefix, "node_modules"));
		push(path.join(path.dirname(prefix), "lib", "node_modules"));
	}
	for (const prefix of pathPrefixes(probe)) {
		push(path.join(prefix, "node_modules"));
		push(path.join(path.dirname(prefix), "lib", "node_modules"));
	}
	return roots;
}
/**
* Directories on `PATH` that hold this platform's Node interpreter.
*
* Probed rather than read from an npm setting: the prefix a global install
* landed in is the one belonging to whichever Node put `npm` on `PATH`, which
* need not be the interpreter this lookup runs under.
*/
function pathPrefixes(probe) {
	return pathEntries(probe.env).filter((dir) => probe.exists(path.join(dir, probe.nodeExecutable)));
}
//#endregion
//#region src/host/infra/cli/lookup.ts
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
const EXPOSE_TOKEN_USAGE = {
	QODERCN_EXPOSE_TOKEN_USAGE: "1",
	QODER_EXPOSE_TOKEN_USAGE: "1"
};
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
function resolveQoderCli(brand = "cn", lookup = {}) {
	return findCli(brand, probeOf(lookup));
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
function findCli(brand, probe) {
	for (const candidate of candidates(brand, probe)) {
		if (!probe.exists(candidate) || isWorkerRuntime(candidate)) continue;
		if (!isScript(candidate)) return { path: candidate };
		if (probe.node !== void 0) return {
			path: candidate,
			nodeDir: path.dirname(probe.node)
		};
	}
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
function qoderCliOptions(brand = "cn", lookup = {}) {
	const cli = resolveQoderCli(brand, lookup);
	if (cli === void 0) return {};
	const env = cliChildEnv(brand);
	if (cli.nodeDir === void 0) return {
		pathToQoderCLIExecutable: cli.path,
		env
	};
	return {
		pathToQoderCLIExecutable: cli.path,
		executable: "node",
		env: {
			...env,
			PATH: `${cli.nodeDir}${path.delimiter}${env.PATH ?? ""}`
		}
	};
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
function foreignCliOverride(brand, lookup = {}) {
	const override = (lookup.env ?? process.env).QODERCLI_PATH;
	if (override === void 0 || override.length === 0) return void 0;
	if (!isForeignCliPath(brand, override)) return void 0;
	if (resolveQoderCli(brand, lookup) !== void 0) return void 0;
	return override;
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
function cliChildEnv(brand, env = process.env) {
	const child = {
		...env,
		...EXPOSE_TOKEN_USAGE
	};
	const override = env.QODERCLI_PATH;
	if (override !== void 0 && override.length > 0 && isForeignCliPath(brand, override)) delete child.QODERCLI_PATH;
	return child;
}
//#endregion
//#region src/host/infra/cli/version.ts
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
function requiredCliVersion(brand) {
	try {
		const dir = sdkDir(brandProfile(brand).sdkPackage);
		if (dir === void 0) return void 0;
		const manifest = JSON.parse(readFileSync(path.join(dir, "dist", "runtime-manifest.json"), "utf8"));
		return typeof manifest.qoderCliVersion === "string" && manifest.qoderCliVersion.length > 0 ? manifest.qoderCliVersion : void 0;
	} catch {
		return;
	}
}
//#endregion
//#region src/host/infra/cli/messages.ts
/**
* The error text for {@link foreignCliOverride}.
*
* Deliberately says nothing about the variable or the path that caused it: the
* page's job here is to tell the user which CLI to install, not to explain the
* plugin's environment plumbing. The technical reason stays in the lookup.
*/
function cliConflictMessage(brand) {
	return `未检测到可用的 ${brandProfile(brand).cliCommands[0]}，请先安装并登录后再使用此版本。`;
}
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
function cliFailureText(detail, brand) {
	if (/DaemonConfigurationConflict|Global daemon is already initialized with different options/i.test(detail)) return `本机 ${brandProfile(brand).cliCommands[0]} 的运行配置在本次会话期间发生了变化，SDK 的本地守护进程仍按旧配置运行。插件已重置这部分运行时，请重试一次；若仍失败，重启 DSH Web。原始信息：${detail}`;
	if (!/exit(?:ed)?(?: with)? code 42|sdk_worker_removed/i.test(detail)) return detail;
	const profile = brandProfile(brand);
	const pkg = profile.cliPackages[0];
	const spec = pkg === void 0 ? profile.cliCommands[0] : `${pkg.scope}/${pkg.name}`;
	const required = requiredCliVersion(brand);
	const target = required === void 0 ? spec : `${spec}@${required}`;
	return `本机 ${profile.cliCommands[0]} 与插件使用的 SDK 版本不匹配（CLI 已移除旧版握手，退出码 42）。请在设置页点「一键配置」重新安装配套版本，或手动执行 npm install -g ${target} 后重试。原始信息：${detail}`;
}
//#endregion
//#region src/host/core/async.ts
/**
* The two async primitives every backend needs: a prompt that never yields, and
* a deadline on one control round trip.
*
* Both are shape-of-the-wire concerns rather than provider ones. A "closed"
* prompt is how a query is opened just to run a control request — reading the
* account, the catalog or the quota — without letting a model turn start, and
* every SDK here accepts a streaming prompt instead of a string, so the closed
* generator is the only thing that keeps such a query from answering. The
* deadline is the same idea in the other direction: a control request that never
* settles must not strand a settings read or a session start.
*
* They live in `core` because all three backends use them verbatim; the copies
* they replace had already drifted apart in wording while behaving identically.
*
* @module dsh-agent-sdk-bridge/core/async
*/
/**
* A prompt that produces nothing and never ends.
*
* The SDKs read a stream of input turns; handing them this one keeps the query
* alive and idle, so a control request (`getUsageInfo`, `getAvailableModels`,
* `accountInfo`) can be answered without any turn ever being requested.
*/
async function* inertInput() {
	await new Promise(() => {});
}
/**
* Settle with `promise`, or reject once `ms` elapse.
*
* @param promise - the round trip to bound.
* @param ms - how long it may take.
* @param label - what the caller was doing, for the timeout message.
*/
function withTimeout(promise, ms, label = "request") {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
//#endregion
//#region src/host/infra/sdk.ts
/**
* The SDK package behind each brand.
*
* The Qoder editions publish the same API under different scopes, so the rest
* of the plugin imports this module instead of a package name. The CN SDK is a
* real dependency and is loaded eagerly; the international one is optional at
* runtime — a deployment that only has a CN account may not have it installed —
* so it is imported on demand and its absence is reported to the settings page
* as a plain error instead of failing the plugin's mount.
*
* CodeBuddy has its own, unrelated API and is loaded dynamically for the same
* reason: an account may never use it, and its package carries a large CLI.
*
* ## Why modules are reloaded
*
* Every Qoder SDK routes all queries through one **process-wide daemon** that
* is initialized with the first query's launch configuration (CLI path,
* interpreter, environment, proxy) and then refuses any different one for the
* life of the process:
*
*     DaemonConfigurationConflictError:
*       Global daemon is already initialized with different options
*
* The host is long-lived, so its configuration is not: a CLI can be
* reinstalled, an edition can appear, an installer can change the machine
* environment. When that happens the ready daemon no longer matches and every
* later query fails until the process restarts — a state the settings page
* cannot recover from on its own.
*
* So the module tracks the configuration signature it loaded under and takes a
* fresh instance whenever the signature changes; {@link resetSdk} does the same
* after a conflict is observed. A new instance has an empty daemon registry, so
* it initializes against the current configuration instead of arguing with the
* old one.
*
* @module dsh-agent-sdk-bridge/sdk
*/
const generations = /* @__PURE__ */ new Map();
/** Brands whose next load must take a fresh instance even if the signature matches. */
const forced = /* @__PURE__ */ new Set();
let counter = 0;
let codeBuddySdk;
const require = createRequire(import.meta.url);
/**
* The launch configuration a Qoder query would use, as a comparable string.
*
* Mirrors the fields the SDK's own daemon compares before reusing itself. The
* environment is included because the SDK hands it to the CLI verbatim, and a
* difference there is enough to make the daemon reject a query.
*
* @param brand - which edition's configuration to describe.
* @returns a stable string that changes exactly when the configuration does.
*/
function configurationSignature(brand) {
	const options = qoderCliOptions(brand);
	const env = Object.entries(options.env ?? {}).filter(([, value]) => value !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	return JSON.stringify({
		path: options.pathToQoderCLIExecutable ?? null,
		executable: options.executable ?? null,
		env
	});
}
/**
* Import one edition's SDK.
*
* A fresh instance is the same file imported under a unique URL: the module's
* top-level daemon state is per instance, while the implementation is shared by
* the module loader as usual.
*
* @param brand - which edition to load.
* @param fresh - ignore the already-loaded instance and take a new one.
*/
async function importSdk(brand, fresh) {
	const specifier = brandProfile(brand).sdkPackage;
	try {
		if (!fresh) return await import(
			/* @vite-ignore */
			specifier
);
		const entry = pathToFileURL(require.resolve(specifier)).href;
		counter += 1;
		return await import(
			/* @vite-ignore */
			`${entry}?generation=${counter}`
);
	} catch (error) {
		generations.delete(brand);
		forced.delete(brand);
		if (brand === "cn") throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`未安装国际版 SDK（${specifier}）：${detail}`);
	}
}
/**
* Load the SDK for one Qoder edition, under its current configuration.
*
* @param brand - which edition's SDK to load.
* @returns the SDK module.
*/
function loadSdk(brand) {
	const signature = configurationSignature(brand);
	const current = generations.get(brand);
	if (current !== void 0 && current.signature === signature && !forced.has(brand)) return current.module;
	const module = importSdk(brand, current !== void 0 || forced.delete(brand));
	const generation = {
		signature,
		module
	};
	generations.set(brand, generation);
	module.catch(() => {
		if (generations.get(brand) === generation) generations.delete(brand);
	});
	return module;
}
/**
* Drop the loaded instance so the next {@link loadSdk} starts a new daemon.
*
* @param brand - which edition to reset.
*/
function resetSdk(brand) {
	generations.delete(brand);
	forced.add(brand);
}
/**
* Drop the loaded generation and stop the daemon it started.
*
* A daemon loads the CLI's credentials when it initializes, and those
* credentials are not part of the configuration signature: signing in as
* another account leaves the daemon answering as the account it started with.
* Shutting it down and forcing a new instance makes the next query read the
* credentials that are on disk now.
*
* The generation is dropped synchronously, so a read that starts as soon as the
* sign-in helper exits already gets the new instance; the old daemon is stopped
* in the background because no caller can wait on the shutdown.
*
* @param brand - which edition's daemon to replace.
*/
function discardSdk(brand) {
	const generation = generations.get(brand);
	generations.delete(brand);
	forced.add(brand);
	if (generation === void 0) return;
	generation.module.then((sdk) => sdk.shutdownDaemon()).catch(() => void 0);
}
/**
* Whether an error is the SDK's daemon refusing a different configuration.
*
* @param error - whatever a query threw.
*/
function isDaemonConflict(error) {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.includes("DaemonConfigurationConflictError") || text.includes("Global daemon is already initialized with different options");
}
/**
* Run one idempotent SDK operation, recovering from a daemon conflict once.
*
* A conflict means the daemon was initialized under a configuration that no
* longer applies. A fresh module instance starts an empty daemon with the
* current one, so the retry succeeds without a restart. Only use this for
* operations that can be repeated without side effects (reads), never for a
* turn that may already have emitted output.
*
* @param brand - which edition to query.
* @param run - the operation, given the module to use.
*/
async function withSdk(brand, run) {
	try {
		return await run(await loadSdk(brand));
	} catch (error) {
		if (!isDaemonConflict(error)) throw error;
		resetSdk(brand);
		return await run(await loadSdk(brand));
	}
}
/**
* Open one cheap control query so a stale daemon is discovered before a turn
* starts streaming.
*
* A turn cannot be retried once it has emitted output, so the session path has
* to find out about a configuration conflict first. `getUsageInfo` is a
* control request: it initializes the daemon and reads the account without
* running a model turn.
*
* @param brand - which edition to probe.
*/
async function probeDaemon(brand) {
	const sdk = await loadSdk(brand);
	const q = sdk.query({
		prompt: inertInput(),
		options: {
			...qoderCliOptions(brand),
			auth: sdk.qodercliAuth(),
			tools: [],
			allowedTools: [],
			settingSources: [],
			maxTurns: 1
		}
	});
	try {
		await q.getUsageInfo();
	} finally {
		await q.close().catch(() => void 0);
	}
}
/**
* Load the CodeBuddy Agent SDK.
*
* Kept lazy because the package ships its own ~200 MB CLI and is useless to a
* deployment that never enables CodeBuddy.
*/
function loadCodeBuddySdk() {
	codeBuddySdk ??= importCodeBuddySdk();
	return codeBuddySdk;
}
async function importCodeBuddySdk() {
	const specifier = brandProfile("codebuddy").sdkPackage;
	try {
		return await import(
			/* @vite-ignore */
			specifier
);
	} catch (error) {
		codeBuddySdk = void 0;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`CodeBuddy SDK 不可用（${specifier}）：${detail}`);
	}
}
//#endregion
//#region src/host/providers/qoder/models.ts
/** How long a fetched catalog stays fresh by default. */
const DEFAULT_MODEL_CACHE_TTL_MS = 3e5;
/** Give up on one CLI catalog fetch after this long by default. */
const DEFAULT_FETCH_TIMEOUT_MS = 2e4;
/**
* Last successful catalog per brand, shared by every {@link QoderModelCatalog}
* in this process.
*
* A settings write does NOT restart this plugin — a volatile edit is committed
* into the running cells (see `live.ts`) — so the cache now only has to survive
* a real remount: enabling the plugin, a profile reload, or a DSH restart. It
* matters in exactly those cases, because the first settings read after the
* remount would otherwise cold-start the Qoder CLI and stall the page for
* seconds.
*
* The entry carries its own timestamp and is only used while it is still within
* the requesting catalog's TTL, so normal freshness is unchanged.
*/
const sharedSnapshots = /* @__PURE__ */ new Map();
/**
* Brands whose CLI has answered a catalogue read successfully at least once.
*
* An empty answer is the account speaking — signed out, or a plan with no
* official models — and it must not be confused with a read that never
* happened. Deliberately NOT cleared by {@link QoderModelCatalog.invalidate}:
* a sign-out drops the catalogue, and the next read may fail outright (the CLI
* was just re-authenticated, the network hiccuped), which would otherwise look
* like "never reachable" and republish the static plan to an account with
* nothing. Any successful read counts, including one whose models are all
* switched off upstream: the plan only ever stands in for silence.
*/
const answeredCatalogs = /* @__PURE__ */ new Set();
/** Cached live CLI catalog with a static fallback. */
var QoderModelCatalog = class {
	brand;
	ttlMs;
	fetchTimeoutMs;
	cached;
	inflight;
	/** Why the last refresh failed, for the settings page's guidance. */
	failure;
	/**
	* Bumped by {@link invalidate}. A fetch that started before a sign-in carries
	* the previous account's entries, so it must not republish them after the
	* cache was dropped for that account change.
	*/
	epoch = 0;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
	*   Read per use, so a settings edit takes effect on the next read.
	* @param fetchTimeoutMs - how long one CLI catalog fetch may take before the
	*   static fallback takes over.
	*/
	constructor(brand, ttlMs, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.fetchTimeoutMs = fetchTimeoutMs;
	}
	/**
	* Raw live entries; the stale snapshot when a refresh fails, else nothing.
	*
	* Filtered to the subscription's official models here, so the picker and the
	* settings page cannot disagree about what the account has.
	*/
	async liveModels() {
		const ttlMs = readLive(this.ttlMs, DEFAULT_MODEL_CACHE_TTL_MS);
		const epoch = this.epoch;
		const fresh = (snapshot) => snapshot !== void 0 && Date.now() - snapshot.at < ttlMs;
		const cached = this.cached ?? sharedSnapshots.get(this.brand);
		if (fresh(cached) && cached !== void 0) {
			this.cached = cached;
			return officialOnly(cached.models);
		}
		let entry = this.inflight;
		if (entry === void 0 || entry.epoch !== epoch) {
			const promise = this.fetch();
			entry = {
				epoch,
				promise
			};
			this.inflight = entry;
			const settled = entry;
			const clear = () => {
				if (this.inflight === settled) this.inflight = void 0;
			};
			promise.then(clear, clear);
		}
		try {
			const models = await entry.promise;
			if (epoch !== this.epoch) return officialOnly(models);
			const snapshot = {
				at: Date.now(),
				models
			};
			this.cached = snapshot;
			sharedSnapshots.set(this.brand, snapshot);
			this.failure = void 0;
			answeredCatalogs.add(this.brand);
			return officialOnly(models);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (epoch === this.epoch) this.failure = cliFailureText(detail, this.brand);
			return officialOnly((this.cached ?? sharedSnapshots.get(this.brand))?.models ?? []);
		}
	}
	/**
	* The last successful live list, without fetching.
	*
	* The model picker resolves a route on every switch, and a switch must not
	* wait on a CLI cold start (up to the fetch timeout). Callers that need an
	* immediate answer read this and let {@link liveModels} refresh behind them;
	* `undefined` means nothing has been read yet, which only the first switch
	* has to wait for.
	*/
	snapshot() {
		const cached = this.cached ?? sharedSnapshots.get(this.brand);
		return cached === void 0 ? void 0 : officialOnly(cached.models);
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	get error() {
		return this.failure;
	}
	/**
	* Drop the cached catalog so the next read goes back to the CLI.
	*
	* What the CLI answers depends on state this plugin does not own — whether it
	* is installed at all, and which account is signed in — and an empty answer is
	* cached like any other. So after the setup helper has run, the page's next
	* read must not be served from a snapshot taken before that login existed.
	*
	* The remembered empty answer is deliberately kept: it says the account has
	* nothing, which a later failed read must not turn back into the static plan.
	*/
	invalidate() {
		this.cached = void 0;
		sharedSnapshots.delete(this.brand);
		this.failure = void 0;
		this.epoch += 1;
		this.inflight = void 0;
	}
	/** dsh catalog entries: the enabled live list, or the fallback {@link emptyCatalogFallback} allows. */
	async models() {
		const live = (await this.liveModels()).filter((model) => model.isEnabled !== false);
		if (live.length === 0) return emptyCatalogFallback(this.brand, {
			cliInstalled: resolveQoderCli(this.brand) !== void 0,
			answered: answeredCatalogs.has(this.brand)
		});
		return live.map((model) => ({
			id: model.value,
			name: model.displayName.length > 0 ? model.displayName : model.value,
			...model.description.length > 0 ? { description: model.description } : {},
			...model.isVl === true ? { isVl: true } : {}
		}));
	}
	async fetch() {
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		if (resolveQoderCli(this.brand) === void 0) throw new Error(cliConflictMessage(this.brand));
		return withSdk(this.brand, (sdk) => this.read(sdk));
	}
	async read(sdk) {
		const q = sdk.query({
			prompt: inertInput(),
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				settingSources: [],
				maxTurns: 1
			}
		});
		try {
			const timeout = readLive(this.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
			const uid = (await withTimeout(q.accountInfo(), timeout, "qoder request").catch(() => void 0))?.userId;
			const models = await withTimeout(q.getAvailableModels(uid === void 0 ? {} : { uid }), timeout, "qoder request");
			if (models.length > 0) return models;
			for (const strategy of ["cache", "live"]) {
				const fallback = await withTimeout(q.getAvailableModels({
					...uid === void 0 ? {} : { uid },
					fetchStrategy: strategy
				}), timeout, "qoder request").catch(() => []);
				if (fallback.length > 0) return fallback;
			}
			return [];
		} finally {
			await q.close().catch(() => void 0);
		}
	}
};
/**
* What the picker may show when the live catalogue came back empty.
*
* The captured CN plan is a stand-in for exactly one situation: this edition's
* CLI is installed, and the catalogue could not be read because the CLI or the
* network was unavailable. Two cases must stay empty:
*
* - The CLI answered. That is the account speaking — signed out, or a plan
*   with no official models — and publishing the plan here is what put every
*   Qoder CN model back into the picker after a sign-out, where selecting one
*   could only fail. `getAvailableModels()` answers a *successful* empty list
*   while signed out (its `cache` and `live` strategies included, even with a
*   populated `~/.qoder-cn/.models`), so this is the ordinary sign-out path,
*   not an edge case.
* - The CLI is not installed at all, so none of those models could run.
*
* @param brand - which edition's catalogue is empty.
* @param state - whether that edition's CLI is on the machine, and whether a
*   successful read has ever produced an answer.
*/
function emptyCatalogFallback(brand, state) {
	if (!state.cliInstalled || state.answered) return [];
	return brandProfile(brand).staticCatalog ? QODER_MODELS : [];
}
/**
* Keep only the subscription's official models.
*
* The CLI also returns models the account added itself (`source` is `user` or
* `custom`): bring-your-own-key routes, which upstream serves on a separate
* provider. DSH runs on the subscription catalog and has no use for those, so
* they are dropped at this single layer — the picker, the settings page and
* the request path all read from here and cannot diverge.
*
* @param models - entries as the CLI reported them.
* @returns the same list without account-added entries.
*/
function officialOnly(models) {
	return models.filter((model) => model.source !== "user" && model.source !== "custom");
}
/**
* The credit multiplier upstream quotes for one model.
*
* Present on every live entry as `priceFactor`; `0` means the model is free.
* Returned as a number rather than a formatted string so callers decide how to
* render it.
*
* @param entry - one live catalog entry.
* @returns the multiplier, or undefined when upstream did not quote one.
*/
function priceFactorOf(entry) {
	const value = entry.priceFactor;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
//#endregion
//#region src/host/core/model-cache.ts
/**
* Cache-first catalogue reads for the model picker.
*
* The harness resolves a route every time the user switches model or reasoning
* level, and each provider answers that resolution from a catalogue whose
* fetch is expensive: Qoder cold-starts its CLI (up to the fetch timeout),
* CodeBuddy boots a process. Awaiting that fetch inside a resolution made the
* picker freeze for seconds whenever the cache had just expired.
*
* So a resolution reads the last successful snapshot when there is one and lets
* the catalogue refresh behind it; only the very first resolution, where there
* is nothing to show, waits. A snapshot that is merely stale still describes
* the same account's models, so answering from it is no less correct than the
* previous behaviour of answering from a failed fetch's fallback.
*
* @module dsh-agent-sdk-bridge/model-cache
*/
/**
* The cached list when one exists, otherwise the awaited fetch.
*
* @param snapshot - last successful catalogue, or undefined before the first.
* @param fetch - the catalogue's normal (TTL-aware, in-flight-sharing) read.
* @returns the entries to resolve against, never empty-by-surprise when a
*   snapshot exists.
*/
async function cachedModels(snapshot, fetch) {
	if (snapshot !== void 0 && snapshot.length > 0) {
		fetch().catch(() => void 0);
		return snapshot;
	}
	return fetch();
}
//#endregion
//#region src/host/core/tokens.ts
/**
* Script-aware text pricing, shared by the input and output estimators.
*
* The harness prices text at a flat 4 chars/token (dsh-token-meter's
* `CHARS_PER_TOKEN`). That is close for Latin text but under-prices Chinese by
* about 2.3x, which matters twice over in this plugin: it reports the tokens for
* a turn, and the harness derives `tok/s` from the output half of that report.
* A flat rate therefore made Chinese replies look roughly half as fast as they
* really are.
*
* The rates below were measured against this backend's own tokenizer, by
* least-squares fit over four content sizes per script, each read against the
* CLI's `context_usage_ratio` with a window the CLI had confirmed it honoured:
*
* | script | chars/token | tokens/char |
* |--------|-------------|-------------|
* | CJK    | 1.77        | 0.565       |
* | ASCII  | 5.20        | 0.192       |
*
* A constant offset in that fit (qodercli's own prompt, skills and tool
* definitions, ~127 tokens) is deliberately not modelled here: it belongs to the
* CLI's session, not to the text being priced.
* @module dsh-agent-sdk-bridge/tokens
*/
/** Characters per token for wide (CJK) text, measured. */
const WIDE_CHARS_PER_TOKEN = 1.77;
/** Characters per token for narrow (Latin, digits, punctuation) text, measured. */
const NARROW_CHARS_PER_TOKEN = 5.2;
/**
* Whether this tokenizer prices a character as wide (CJK) text.
*
* Ranges follow the Unicode blocks that CJK tokenizers treat as one-or-more
* tokens per character, including the fullwidth forms that Chinese punctuation
* uses. Everything else is priced as narrow text.
*/
function isWideChar(character) {
	const code = character.codePointAt(0) ?? 0;
	return code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12353 && code <= 13311 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 40960 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 262141;
}
/** How many of a text's characters are wide (CJK) text. */
function countWideChars(text) {
	let wide = 0;
	for (const character of text) if (isWideChar(character)) wide += 1;
	return wide;
}
/**
* Price text by its script mix, rather than at a flat 4 chars/token.
*
* @param chars - total character count.
* @param wideChars - how many of those characters are wide (CJK) text.
* @returns the estimated token count.
*/
function estimateTextTokens(chars, wideChars) {
	const wide = Math.max(0, Math.min(chars, wideChars));
	return wide / WIDE_CHARS_PER_TOKEN + (chars - wide) / NARROW_CHARS_PER_TOKEN;
}
/**
* The output tokens one turn generated, priced by script.
*
* Everything the model produced belongs here, whatever block carried it: visible
* text, reasoning, and tool-call names and arguments. That last one is easy to
* miss and usually the largest — measured at 86% of the characters in a
* three-call turn — and because the harness derives `tok/s` from the output
* tokens an adapter reports, omitting it under-reports speed several fold on
* exactly the multi-step agentic work where the figure is worth reading.
*
* Reasoning is a SUBSET of the output total, not a separate bucket: the harness
* discards an entire reading whose `reasoningTokens` exceeds its `outputTokens`,
* so {@link usage} clamps it rather than trusting the caller to.
*/
var TurnOutputAccounting = class {
	chars = 0;
	wideChars = 0;
	reasoningChars = 0;
	reasoningWideChars = 0;
	/** Count generated text: visible output, or a tool-call name or arguments. */
	addOutput(text) {
		if (text.length === 0) return;
		this.chars += text.length;
		this.wideChars += countWideChars(text);
	}
	/** Count generated reasoning, which is also part of the output total. */
	addReasoning(text) {
		if (text.length === 0) return;
		this.addOutput(text);
		this.reasoningChars += text.length;
		this.reasoningWideChars += countWideChars(text);
	}
	/** Total generated characters, for diagnostics. */
	get outputChars() {
		return this.chars;
	}
	/** Generated reasoning characters, a subset of {@link outputChars}. */
	get reasoningCharsTotal() {
		return this.reasoningChars;
	}
	/** Discard the turn's counts; called when a turn ends or is retried. */
	reset() {
		this.chars = 0;
		this.wideChars = 0;
		this.reasoningChars = 0;
		this.reasoningWideChars = 0;
	}
	/**
	* The turn's `outputTokens` and, when it reasoned, its `reasoningTokens`.
	*
	* Both are at least 1 so a turn that produced only a tool call still reports a
	* positive count, and reasoning never exceeds output.
	*/
	usage() {
		const outputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.chars, this.wideChars)));
		if (this.reasoningChars === 0) return { outputTokens };
		const reasoningTokens = Math.max(1, Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars)));
		return {
			outputTokens,
			reasoningTokens: Math.min(reasoningTokens, outputTokens)
		};
	}
	/**
	* This turn's reasoning tokens, clamped inside a real metered output total.
	*
	* Used when the CLI reports genuine `output_tokens`: the reasoning figure is
	* still the local estimate, but it must stay a subset of what the provider
	* counted or the harness discards the reading.
	*
	* @param meteredOutput - the provider's own output token count.
	* @returns a spreadable `reasoningTokens` field, or nothing when unmeasured.
	*/
	reasoningTokensWithin(meteredOutput) {
		if (this.reasoningChars === 0) return {};
		const reasoningTokens = Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars));
		return { reasoningTokens: Math.max(0, Math.min(meteredOutput, reasoningTokens)) };
	}
};
//#endregion
//#region src/host/core/render.ts
/**
* Render harness messages into the turns fed to the inner Qoder session.
* Tool calls and results need no protocol here — they travel through the
* in-process MCP server — so this layer handles conversational context: the
* host system prompt, user turns, and (for full rebuilds) prior history as
* compact text.
*
* A feed is plain text unless the *current* turn carries image occurrences,
* in which case it is a part list so those bytes can ride along. Historical
* images stay text: the harness has already replaced them with its own
* placeholder for text-only routes, and re-sending archived pixels on every
* rebuild would price a screenshot into every later request.
* @module dsh-llm-qoder/render
*/
/**
* Model-facing handle for one image.
*
* The host's native adapters use the same text: it names the attachment, its
* pixel size and media type, and the read-only normalized copy on disk, and it
* tells the model to copy that file to a writable path before editing. Pixels
* alone let a model describe an image but not process it — without this path
* the model goes looking through the workspace for a file that was never there.
*/
function imageRefText(ref, path) {
	if (path === void 0) return `[图片附件 ${String(ref.attachmentId)}（${ref.width}×${ref.height}px，${ref.mediaType}）]`;
	return requestImageHandleText(ref, {
		width: ref.width,
		height: ref.height
	}, { readonlyPath: path });
}
/**
* Image references in block order, skipping occurrences the surface already
* offloaded: an offload is a durable fact the harness renders as path-bearing
* placeholder text on every route, so re-sending those pixels would undo it.
*/
function imageRefs(blocks) {
	const refs = [];
	for (const block of blocks) if (block.type === "image" && block.offloaded !== true) refs.push(block.attachment);
	return refs;
}
/** Render one content-block list as plain text; non-text blocks get handles. */
function renderBlocks(blocks, imagePath) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			parts.push(block.text);
			break;
		case "reasoning": break;
		case "image":
			parts.push(block.offloaded === true ? offloadedImageText(block.attachment) : imageRefText(block.attachment, imagePath?.(block.attachment)));
			break;
		case "file":
			parts.push(fileHandleText(block.attachment, void 0));
			break;
		case "tool-call":
			parts.push(`[调用了工具 ${block.name}(${block.arguments})]`);
			break;
		case "tool-addition":
			parts.push(`[工具启用 ${block.toolName}]`);
			break;
		case "tool-removal":
			parts.push(`[工具停用 ${block.toolName}]`);
			break;
		default: parts.push(JSON.stringify(block));
	}
	return parts.join("\n");
}
/** Role tag {@link renderMessage} uses, without the rendered content. */
function roleTag(message) {
	switch (message.role) {
		case "system": return "系统提示";
		case "developer": return "开发者";
		case "user": return "用户";
		case "assistant": return "助手";
		case "tool": return "工具结果";
	}
}
/**
* Render one request message with its role tag. A request-only user input has
* no durable identity or source, so it reads exactly like a user message.
*/
function renderMessage(message, imagePath) {
	return `[${roleTag(message)}] ${renderBlocks(message.content, imagePath)}`;
}
/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
	"你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出\"下一条助手回复\"本身。",
	"宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。",
	"不要复述对话，不要解释你的角色。"
].join("\n");
/**
* Preamble for a side-channel call whose last user message *is* the task.
*
* Compaction and session titles are not "what would the assistant say next":
* DSH appends an instruction as the final user message — compaction sends
* `Condense the conversation ABOVE into a structured checkpoint…` — and
* expects exactly that to be carried out. Rendering such a request with
* {@link BACKEND_ROLE} buried the instruction inside "background" and then
* closed with "output the next assistant reply", so a compaction run dutifully
* reproduced the previous assistant message instead of summarising. The
* transcript then showed the last reply restated where the checkpoint belonged.
*/
const SIDE_CHANNEL_ROLE = [
	"你在为一个编码 agent（宿主）充当 LLM API 后端。",
	"这一次不是继续对话：最后一条用户消息就是你要执行的任务，请直接完成它。",
	"不要把最后一条消息当成新的聊天内容来回应，也不要复述对话或解释你的角色。"
].join("\n");
/**
* Join feed sections into one feed. While no section carries an image the
* result is the historical text shape, sections separated by a blank line;
* the first image turns the whole feed into parts, with the text around it
* merged into the parts before and after.
*/
function joinFeeds(sections) {
	const parts = [];
	const push = (part) => {
		if (part.type === "text" && part.text.length === 0) return;
		const previous = parts.at(-1);
		if (previous !== void 0 && previous.type === "text" && part.type === "text") {
			previous.text = `${previous.text}\n\n${part.text}`;
			return;
		}
		parts.push(part.type === "text" ? {
			type: "text",
			text: part.text
		} : {
			type: "image",
			attachment: part.attachment
		});
	};
	for (const section of sections) if (typeof section === "string") push({
		type: "text",
		text: section
	});
	else for (const part of section) push(part);
	if (parts.filter((part) => part.type === "image").length > 0) return parts;
	return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
}
/** Render a block list as parts, keeping image occurrences as their references. */
function blockParts(blocks) {
	const parts = [];
	let pending = [];
	const flush = () => {
		if (pending.length === 0) return;
		parts.push({
			type: "text",
			text: pending.join("\n")
		});
		pending = [];
	};
	for (const block of blocks) {
		if (block.type === "image" && block.offloaded !== true) {
			flush();
			parts.push({
				type: "image",
				attachment: block.attachment
			});
			continue;
		}
		const text = renderBlocks([block]);
		if (text.length > 0) pending.push(text);
	}
	flush();
	return parts;
}
/** Prefix a label onto a feed, folding it into the leading text when there is any. */
function label(labelText, feed) {
	if (typeof feed === "string") return labelText + feed;
	const first = feed[0];
	if (first === void 0) return [{
		type: "text",
		text: labelText
	}];
	if (first.type === "text") return [{
		type: "text",
		text: `${labelText}${first.text}`
	}, ...feed.slice(1)];
	return [{
		type: "text",
		text: labelText
	}, ...feed];
}
/**
* Index where the message list's current turn starts: everything after the
* last assistant reply is new content the inner session has not seen, so its
* images are worth forwarding as bytes.
*/
function currentTurnStart(messages) {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i + 1;
	return 0;
}
/** Image references carried by a feed, in order. */
function feedImageRefs(feed) {
	if (typeof feed === "string") return [];
	return feed.filter((part) => part.type === "image").map((part) => part.attachment);
}
/** Flatten a feed back to text, replacing images with the harness handle text. */
function feedToText(feed, imagePath) {
	if (typeof feed === "string") return feed;
	return feed.map((part) => {
		if (part.type === "text") return part.text;
		const path = imagePath?.(part.attachment);
		return path === void 0 ? textOnlyImageText(part.attachment) : imageRefText(part.attachment, path);
	}).filter((text) => text.length > 0).join("\n\n");
}
/**
* Split a feed into text and resolved images for providers with a vision API.
*
* The non-Qoder adapter (CodeBuddy) speaks its own content-block
* shape, so this returns a neutral list rather than a provider shape: text
* parts pass through, an image uses its bytes when the host could read them,
* and an unreadable image keeps a note naming what was dropped instead of
* silently disappearing from the prompt.
*/
function resolvedFeedParts(feed, images) {
	const parts = [];
	if (typeof feed === "string") {
		if (feed.length > 0) parts.push({
			type: "text",
			text: feed
		});
		return parts;
	}
	for (const part of feed) {
		if (part.type === "text") {
			if (part.text.length > 0) parts.push({
				type: "text",
				text: part.text
			});
			continue;
		}
		const resolved = images.get(String(part.attachment.attachmentId));
		parts.push(resolved === void 0 ? {
			type: "image-unreadable",
			attachment: part.attachment
		} : {
			type: "image",
			attachment: part.attachment,
			data: resolved.data,
			mediaType: resolved.mediaType
		});
	}
	return parts;
}
/** Literal characters in a feed; images contribute their pixels, not text. */
function feedTextLength(feed) {
	if (typeof feed === "string") return feed.length;
	return feed.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0);
}
/**
* How many of a feed's literal characters are wide (CJK) text.
*
* The token estimate prices wide and narrow text at different rates, so a bare
* character count is not enough to price a feed that mixes Chinese and code.
*/
function feedWideCharCount(feed) {
	if (typeof feed === "string") return countWideChars(feed);
	return feed.reduce((total, part) => total + (part.type === "text" ? countWideChars(part.text) : 0), 0);
}
/**
* Compose the feed for a one-shot side-channel request (compaction, a session
* title): its last user message is the instruction to carry out, not a turn to
* continue.
*
* The history is still rendered, because compaction must see the conversation
* it is condensing, but the role preamble and the closing line both name the
* trailing instruction as the task. See {@link SIDE_CHANNEL_ROLE} for the
* misread this replaces.
*/
function renderSideChannelFeed(system, messages, imagePath) {
	const history = [];
	for (const message of messages) {
		const entry = renderMessage(message, imagePath);
		if (feedToText(entry, imagePath).length > 0) history.push(entry);
	}
	const sections = [SIDE_CHANNEL_ROLE];
	if (system !== void 0 && system.length > 0) sections.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
	const first = history[0];
	if (first !== void 0) {
		sections.push(label("---- 宿主对话记录 ----\n", first));
		sections.push(...history.slice(1));
	}
	sections.push("---- 以上是背景。请执行最后一条用户消息给出的任务。 ----");
	return joinFeeds(sections);
}
/**
* Compose the first feed for a fresh session: backend role, the host system
* prompt, and the existing conversation as compact context. Messages of the
* current turn keep their image references; earlier ones are handles.
*/
function renderInitialFeed(system, messages, imagePath) {
	const from = currentTurnStart(messages);
	const history = [];
	for (const [index, message] of messages.entries()) {
		const entry = index >= from && imageRefs(message.content).length > 0 ? label(`[${roleTag(message)}] `, blockParts(message.content)) : renderMessage(message, imagePath);
		if (feedToText(entry, imagePath).length > 0) history.push(entry);
	}
	const sections = [BACKEND_ROLE];
	if (system !== void 0 && system.length > 0) sections.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
	const first = history[0];
	if (first !== void 0) {
		sections.push(label("---- 宿主对话记录 ----\n", first));
		sections.push(...history.slice(1));
	}
	sections.push("---- 以上是背景。输出下一条助手回复。 ----");
	return joinFeeds(sections);
}
/** Render a brand-new host user turn; images stay references, text-only stays a string. */
function renderUserTurn(blocks) {
	if (imageRefs(blocks).length === 0) return `[用户] ${renderBlocks(blocks)}`;
	return label("[用户] ", blockParts(blocks));
}
/** Render an in-place-updated message (runtime-context snapshots and the like). */
function renderRefreshed(message) {
	return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`;
}
//#endregion
//#region src/host/core/lifecycle.ts
/**
* How long an in-flight turn may keep running after its session was asked to
* close.
*
* A turn is normally one model response, but an agentic turn can run for
* minutes and its chunks are still being consumed by the harness: killing the
* subprocess truncates an answer that only needed to finish. Draining is
* therefore the default, bounded so an unloaded plugin cannot leave a
* subprocess behind forever.
*/
const DEFAULT_DRAIN_MS = 12e4;
/** How long a warm session may sit unused before the pool reclaims it. */
const DEFAULT_SESSION_IDLE_MS = 6e5;
/**
* The message one close cause shows for the turn it interrupted.
*
* Written from the user's point of view: every one of these interruptions is
* recoverable by sending again, and none of them is a network fault.
*/
const CLOSE_TEXT = {
	dispose: "DSH 已重新加载或停用本插件，本轮被中断；再次发送时会话会重建",
	evicted: "本会话被回收（同时保持的会话数超过上限），本轮被中断；再次发送即可继续",
	idle: "本会话长时间空闲已被回收，本轮被中断；再次发送即可继续",
	account: "登录账号已变更，本轮被中断；再次发送即可继续",
	region: "CodeBuddy 登录区域已切换，本轮被中断；再次发送即可继续",
	rebuild: "会话历史已分叉，本轮被中断；再次发送即可继续"
};
/**
* The finish reason for a turn interrupted by a session close.
*
* `aborted` rather than `error`: the provider did not fail, the host moved the
* session out from under the turn. `ABORTED` is the code `dsh-llm` itself maps
* to that kind, and it is outside the framework's default retryable set.
*
* @param cause - why the session closed.
* @returns the terminal reason the interrupted turn ends with.
*/
function closeFinishReason(cause) {
	return {
		kind: "aborted",
		failure: {
			message: CLOSE_TEXT[cause],
			code: "ABORTED"
		}
	};
}
/**
* Deferred-close state machine for one session.
*
* Two decisions live here rather than in each provider's session class: whether
* a close can wait for the in-flight turn, and when it must stop waiting. Both
* backends need exactly the same rules, and this is the only part of the
* teardown that is worth testing on its own.
*
* Contract: {@link request} is idempotent; {@link settled} is how the session
* reports that its turn finished and the deferred teardown may run; and once
* {@link cause} is set the session accepts no new turn.
*/
var CloseGate = class {
	drainMs;
	onTeardown;
	onForce;
	requested;
	timer;
	/** Whether a turn is being allowed to finish before the teardown runs. */
	draining = false;
	torn = false;
	/**
	* @param drainMs - read per close, so a settings edit applies to the next one.
	* @param onTeardown - tears the subprocess down; must be safe to call once.
	* @param onForce - called when the drain window expired with the turn still
	*   running, so the session can end that turn before the subprocess dies.
	*/
	constructor(drainMs, onTeardown, onForce) {
		this.drainMs = drainMs;
		this.onTeardown = onTeardown;
		this.onForce = onForce;
	}
	/** The cause, once a close has been requested; undefined while serving. */
	get cause() {
		return this.requested;
	}
	/** Whether this session has been asked to stop (new turns must be refused). */
	get closing() {
		return this.requested !== void 0;
	}
	/**
	* Ask this session to stop.
	*
	* @param cause - why it is closing, remembered for the turn's finish reason.
	* @param busy - whether a turn is in flight right now.
	* @returns `'closed'` when teardown already ran, `'draining'` when it waits.
	*/
	request(cause, busy) {
		if (this.requested !== void 0) return this.draining ? "draining" : "closed";
		this.requested = cause;
		const drainMs = this.drainMs();
		if (!busy || !(drainMs > 0)) {
			this.teardown();
			return "closed";
		}
		this.draining = true;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			if (!this.draining) return;
			this.draining = false;
			try {
				this.onForce?.(cause);
			} catch {}
			this.teardown();
		}, drainMs);
		unrefTimer(this.timer);
		return "draining";
	}
	/**
	* Report that the in-flight turn settled.
	*
	* Called from the turn's own `finally`, which is also reached when the host
	* cancels its stream, so a drain never outlives its turn.
	*/
	settled() {
		if (this.requested === void 0 || !this.draining) return;
		this.draining = false;
		this.teardown();
	}
	teardown() {
		if (this.torn) return;
		this.torn = true;
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		this.onTeardown();
	}
};
/** Node timers hold the process open unless they are unref'd. */
function unrefTimer(timer) {
	timer.unref?.();
}
//#endregion
//#region src/host/infra/log.ts
/**
* The plugin's own event log.
*
* DSH's desktop host does not write a log file, so a diagnosis of "the
* conversation suddenly dropped" had to be reconstructed from file mtimes and
* the compressed session event stream — and the decisive fact (was the plugin
* entry rebuilt, or was the config committed in place?) was simply not
* recorded anywhere.
*
* Each line is one JSON object with a boot id and a pid, appended to
* `~/.dsh/agent-sdk-bridge/bridge.log`. Appends are synchronous: ordering
* against a subprocess's own log and against the harness event stream is the
* whole point, and a buffered write would lose the last few lines exactly when
* a crash matters most. The volume is a handful of lines per turn.
*
* Nothing here may ever throw: a diagnostic that breaks a turn is worse than no
* diagnostic.
*
* @module dsh-agent-sdk-bridge/log
*/
/**
* Identifies this plugin generation in the host process.
*
* A reload re-evaluates the module, so a new value means the entry was rebuilt
* rather than committed in place — which is exactly the question a settings
* save has to answer.
*/
const BOOT_ID = randomUUID().slice(0, 8);
/** Size at which the active file is rotated to `<name>.1`. */
const MAX_LOG_BYTES = 4194304;
/** The active log's path: `DSH_BRIDGE_LOG_PATH`, or the profile-side default. */
function traceLogPath() {
	const override = process.env.DSH_BRIDGE_LOG_PATH;
	if (override !== void 0 && override.length > 0) return override;
	return join(homedir(), ".dsh", "agent-sdk-bridge", "bridge.log");
}
/** Live on/off switch, read per write so a settings edit applies immediately. */
let gate;
/**
* Install the trace gate.
*
* @param read - the plugin's `traceEnabled` setting, read per write; omit to
*   trace unconditionally (the default, and what tests get).
*/
function setTraceGate(read) {
	gate = read;
}
/** Directories already created, so a hot path does not re-stat them. */
const prepared = /* @__PURE__ */ new Set();
/**
* Append one event.
*
* @param event - stable event name, e.g. `session/close`; never localized.
* @param fields - flat, JSON-serializable facts about the event.
*/
function trace(event, fields = {}) {
	if (gate !== void 0) try {
		if (!gate()) return;
	} catch {}
	const line = JSON.stringify({
		t: (/* @__PURE__ */ new Date()).toISOString(),
		boot: BOOT_ID,
		pid: process.pid,
		event,
		...fields
	});
	try {
		const path = traceLogPath();
		const dir = dirname(path);
		if (!prepared.has(dir)) {
			mkdirSync(dir, { recursive: true });
			prepared.add(dir);
		}
		rotateIfNeeded(path);
		appendFileSync(path, `${line}\n`, "utf8");
	} catch {}
}
/** Rotate the active file once it passes the ceiling, keeping one generation. */
function rotateIfNeeded(path) {
	try {
		if (statSync(path).size < MAX_LOG_BYTES) return;
		renameSync(path, `${path}.1`);
	} catch {}
}
//#endregion
//#region src/host/core/mcp-naming.ts
/**
* MCP tool-name namespacing, shared by every CLI backend this bridge drives.
*
* Each backend reaches the host's tools over an in-process MCP server, so the
* name a model emits is namespaced (`mcp__dsh-host__ops_bash`) while the host
* dispatches on the bare name (`ops_bash`). Two things make that translation
* less trivial than it looks, and both are the same bug in different clothes:
*
* - **Spelling.** CodeBuddy rewrites a server name's non-alphanumeric characters
*   to `_`, so `dsh-host` is exposed as `mcp__dsh_host__…`; the Qoder CLI keeps
*   the hyphen. A handler must accept both.
* - **Depth.** A model occasionally emits an already-qualified name, and the CLI
*   then qualifies it again. Peeling exactly one layer handed the host
*   `mcp__dsh_host__edit` — a name it does not have — so DSH answered
*   `unknown tool "mcp__dsh_host__edit"`; the model then retried the doubled
*   spelling and the CLI refused it with its own
*   `does not exist in the current tool set.` Two error messages, one cause:
*   a prefix peeled once instead of exhaustively.
*
* This module exists so all three backends peel the same way, rather than each
* carrying its own one-layer `slice`.
*
* @module dsh-agent-sdk-bridge/mcp-naming
*/
/** How many prefix layers a single name may carry before the walk gives up. */
const MAX_NAMESPACE_LAYERS = 8;
/**
* Peel every matching namespace layer off a tool name.
*
* @param name - the tool name as the CLI's `tool_use` block carried it.
* @param prefixes - the namespaced spellings that belong to one server, in
*   either spelling the backends produce. Longest first is not required; the
*   walk re-checks the whole list after each peel.
* @returns the bare host tool name, or null when no prefix matched at all (or
*   the name was nothing but namespaces).
*/
function stripMcpNamespace(name, prefixes) {
	const usable = prefixes.filter((prefix) => prefix.length > 0);
	let current = name;
	let stripped = false;
	for (let layer = 0; layer < MAX_NAMESPACE_LAYERS; layer++) {
		const found = usable.find((prefix) => current.startsWith(prefix));
		if (found === void 0) return stripped && current.length > 0 ? current : null;
		current = current.slice(found.length);
		stripped = true;
	}
	return usable.some((prefix) => current.startsWith(prefix)) || current.length === 0 ? null : stripped ? current : null;
}
/**
* The two spellings one MCP server name is exposed under by the backends.
*
* @param serverName - the name the server was registered with, e.g. `dsh-host`.
* @returns the registered spelling followed by the CLI-sanitised one; the two
*   collapse to a single entry when the name is already alphanumeric.
*/
function mcpToolPrefixes(serverName) {
	const registered = `mcp__${serverName}__`;
	const sanitized = `mcp__${serverName.replace(/[^a-zA-Z0-9]/g, "_")}__`;
	return sanitized === registered ? [registered] : [registered, sanitized];
}
/**
* Whether a CLI tool name belongs to one host MCP server, in any spelling.
*
* @param name - the tool name as the CLI's `tool_use` block carried it.
* @param serverName - the name the server was registered with.
* @returns whether a namespace layer, and a tool name, are both there.
*/
function isHostToolName(name, serverName) {
	return stripMcpNamespace(name, mcpToolPrefixes(serverName)) !== null;
}
/**
* The bare host tool name, or the input unchanged when no layer matched.
*
* @param name - the tool name as the CLI's `tool_use` block carried it.
* @param serverName - the name the server was registered with.
* @returns the name the host dispatches on.
*/
function bareHostToolName(name, serverName) {
	return stripMcpNamespace(name, mcpToolPrefixes(serverName)) ?? name;
}
//#endregion
//#region src/host/core/jsonschema.ts
/**
* Convert dsh `ToolSchema.parameters` (a JSON Schema object) into a zod raw
* shape for the SDK's in-process MCP `tool()` registration. Fidelity is
* one-directional on purpose: anything the converter does not recognize maps
* to `z.unknown()`, and objects stay loose (zod strips unknown keys instead
* of rejecting them), so a converted tool never rejects arguments the host
* tool would have accepted. Unmapped PROPERTY NAMES still appear in the shape
* (as `z.unknown()`), so nothing the model sends is silently stripped.
* @module dsh-llm-qoder/jsonschema
*/
/**
* Convert one JSON Schema node into one zod schema.
* @param schema - a JSON Schema node (object form expected).
* @param depth - recursion guard; past the cap every node becomes `z.unknown()`.
* @returns a zod schema covering the recognized constructs.
*/
function jsonSchemaToZod(schema, depth = 0) {
	if (schema === void 0 || depth > 6) return z.unknown();
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((v) => typeof v === "string");
		if (values.length === schema.enum.length && values.length > 0) return z.enum(values);
		return z.unknown();
	}
	const type = schema.type;
	const description = typeof schema.description === "string" ? schema.description : void 0;
	let base;
	switch (type) {
		case "string":
			base = z.string();
			break;
		case "number":
			base = z.number();
			break;
		case "integer":
			base = z.number().int();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "array": {
			const items = schema.items;
			base = z.array(jsonSchemaToZod(typeof items === "object" && items !== null && !Array.isArray(items) ? items : void 0, depth + 1));
			break;
		}
		case "object": {
			const properties = schema.properties;
			const required = Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === "string") : [];
			const shape = {};
			if (typeof properties === "object" && properties !== null) for (const [key, node] of Object.entries(properties)) {
				const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
				shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, depth + 1) : jsonSchemaToZod(nodeSchema, depth + 1).optional();
			}
			base = z.object(shape);
			break;
		}
		default: base = z.unknown();
	}
	return description === void 0 ? base : base.describe(description);
}
/**
* Convert a tool's `parameters` JSON Schema into a zod raw shape for `tool()`.
* A non-object schema yields a single catch-all shape so registration stays valid.
* @param parameters - the JSON Schema object from a dsh `ToolSchema`.
* @returns the zod raw shape handed to the SDK MCP `tool()`.
*/
function jsonSchemaToShape(parameters) {
	const properties = parameters.properties;
	if (typeof properties !== "object" || properties === null) return {};
	const shape = {};
	const required = Array.isArray(parameters.required) ? parameters.required.filter((v) => typeof v === "string") : [];
	for (const [key, node] of Object.entries(properties)) {
		const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
		shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, 1) : jsonSchemaToZod(nodeSchema, 1).optional();
	}
	return shape;
}
//#endregion
//#region src/host/core/host-session.ts
/** MCP server name every adapter exposes host tools under. */
const MCP_SERVER_NAME = "dsh-host";
/**
* Keeps one in-process MCP server's tool set equal to the host's live set.
*
* The host's tool list is not fixed for a session's lifetime: `dsh-ops` adds
* and withdraws tools as a session's mode changes and as `ops_discover_tools`
* pulls a deferred capability in, and DSH republishes that change to the model
* as `tool-addition` / `tool-removal` blocks. The MCP SDK, however, refuses a
* second `registerTool` for a name it already holds ("Tool X is already
* registered") and offers no unregister of its own, so a naive replay leaves a
* changed schema at its old definition and can never take a withdrawn tool back
* out. The model then calls a name the server does not have, and CodeBuddy
* answers it with `Tool "…" does not exist in the current tool set.` instead of
* a host result — the "tool went missing mid-conversation" symptom.
*
* This wrapper therefore reconciles by name: register what is new, `update()`
* what changed, and `remove()` what the host withdrew. The call handler is built
* per registered tool and answers through the session's tool-result pairing, so
* a tool re-registered after a mode change still collects its own result.
*/
var HostToolRegistry = class {
	host;
	handlerFor;
	onProblem;
	/** What this registry has actually installed, by tool name, with its schema hash. */
	installed = /* @__PURE__ */ new Map();
	constructor(host, handlerFor, onProblem = () => {}) {
		this.host = host;
		this.handlerFor = handlerFor;
		this.onProblem = onProblem;
	}
	/**
	* Declare the tools capability before the transport connects.
	*
	* Must run before `connect()`, because the SDK refuses a capability change
	* afterwards. Without it a session whose first turn published no host tools
	* connects with no tools capability, and every tool the host offers later can
	* only throw — see {@link ToolRegistryHost.setToolRequestHandlers}.
	*/
	prepare() {
		try {
			this.host.setToolRequestHandlers?.();
		} catch (error) {
			this.onProblem(`MCP tools 能力未能在连接前声明：${errorText(error)}`);
		}
	}
	/**
	* Make the installed tool set match `tools` exactly.
	*
	* @param tools - the host's live tool schemas, in the order the host published them.
	* @returns whether anything was added, changed or removed.
	*/
	reconcile(tools) {
		const wanted = /* @__PURE__ */ new Map();
		for (const schema of tools) {
			const hash = JSON.stringify([schema.description, schema.parameters ?? {}]);
			wanted.set(schema.name, {
				hash,
				schema
			});
		}
		let changed = false;
		for (const [name, entry] of [...this.installed.entries()]) {
			if (wanted.has(name)) continue;
			try {
				entry.handle.remove();
			} catch (error) {
				this.onProblem(`工具 ${name} 无法从 MCP 注销：${errorText(error)}`);
			}
			this.installed.delete(name);
			changed = true;
		}
		for (const [name, { hash, schema }] of wanted) {
			const existing = this.installed.get(name);
			if (existing !== void 0 && existing.hash === hash) continue;
			const description = schema.description.length > 0 ? schema.description : name;
			const inputSchema = jsonSchemaToShape(schema.parameters ?? {});
			if (existing !== void 0) try {
				existing.handle.update({
					description,
					paramsSchema: inputSchema
				});
				this.installed.set(name, {
					hash,
					handle: existing.handle
				});
				changed = true;
				continue;
			} catch (error) {
				this.onProblem(`工具 ${name} 的 schema 更新失败，改为重新注册：${errorText(error)}`);
				try {
					existing.handle.remove();
				} catch {}
				this.installed.delete(name);
			}
			try {
				const handle = this.host.registerTool(name, {
					description,
					inputSchema
				}, this.handlerFor(name));
				this.installed.set(name, {
					hash,
					handle
				});
				changed = true;
			} catch (error) {
				this.onProblem(`宿主工具 ${name} 未能注册进 MCP server：${errorText(error)}`);
			}
		}
		if (changed) try {
			this.host.sendToolListChanged?.();
		} catch {}
		return changed;
	}
	/** Names currently installed, for diagnostics and tests. */
	names() {
		return [...this.installed.keys()];
	}
};
/** One error's message, for the diagnostics above. */
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Unbounded FIFO the consumer pushes into and the active turn pumps out.
*
* Both backends drain it as an `AsyncIterable` (Qoder and CodeBuddy pump it with
* `for await`). Closing it releases a parked reader, so a session that is torn
* down mid-turn never leaves one waiting.
*/
var TurnQueue = class {
	items = [];
	resolve = null;
	closed = false;
	push(item) {
		if (this.closed) return;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: item,
				done: false
			});
		} else this.items.push(item);
	}
	close() {
		this.closed = true;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: void 0,
				done: true
			});
		}
	}
	[Symbol.asyncIterator]() {
		return { next: () => this.pump() };
	}
	/** Whether the turn already ended; late pushes are dropped. */
	get isClosed() {
		return this.closed;
	}
	pump() {
		const item = this.items.shift();
		if (item !== void 0) return Promise.resolve({
			value: item,
			done: false
		});
		if (this.closed) return Promise.resolve({
			value: void 0,
			done: true
		});
		return new Promise((settle) => {
			this.resolve = settle;
		});
	}
};
/** Message the inner model reads when a host turn superseded a parked call. */
const SUPERSEDED_CALL_TEXT = "[宿主取消了这次工具执行]";
/** Payload for a call the host request that followed it did not answer. */
function unansweredCall(toolUseId) {
	return {
		content: [{
			type: "text",
			text: `宿主未返回这次工具调用的结果（toolUseId=${toolUseId}），本次工具调用已取消`
		}],
		isError: true
	};
}
/**
* The tool-result bridge between an inner CLI and the host.
*
* The CLI announces a tool call twice, under two different identities:
* `canUseTool` receives the CLI's own tool-use id *before* the call runs, while
* the MCP `tools/call` handler that actually needs the host's result receives no
* id at all. The two arrive in the same order, so a FIFO pairs them — and the
* handler then parks under the exact id the host's result was filed under.
*
* ## Why that FIFO belongs to the session, not to a turn
*
* Measured against a live CLI, the handler can fire *after* the turn it belongs
* to has already ended. The host answers a tool call as soon as it sees the
* block, so the adapter's `deliverToolResults` files the result while nothing is
* parked yet, and only then does the CLI get around to dispatching the MCP call:
*
* ```
* 6198ms  [endTurn] kind=tool-calls
* 6198ms  [host] no parked handler -> BUFFERED under key=call_80d292a7…
* 6217ms  [mcp handler] ENTER | shifted toolUseId=undefined
* 6217ms  [mcp handler] PARKING under key=anonymous-1
* 14226ms [mcp handler] TIMED OUT after 8009ms
* ```
*
* Clearing the announcements at the turn boundary therefore threw away the very
* id the handler was about to claim. The handler fell through to a fallback key
* nothing could resolve, parked for the whole tool-result timeout, and the turn
* stalled — 120 s by default, which the user reads as "the model stopped
* answering" and works around by stopping the conversation and resending. The
* stall is probabilistic because a *slow* host tool (a shell command) parks its
* handler before the turn ends and takes the other path, while a fast one
* (`read`, `ask_user_question`) loses the race.
*
* ## Why a parked call must not have a wall-clock deadline
*
* A host result can only arrive on the next host request: the host runs every
* tool of the round first, then sends one request carrying all their results.
* A host tool is allowed to run for minutes (a build, a directory scan, a long
* shell command), and one slow tool delays the results of its whole batch. A
* fixed 120 s deadline therefore cancels calls whose real result is still on
* its way:
*
* ```
* 10:07:53  [mcp handler] PARK call_00_QFqbaum… (write — result ready at once)
* 10:07:53  [host]         pwsh starts (its own timeout: 300 s)
* 10:09:53  [mcp handler] TIMED OUT after 120s   <- write cancelled for nothing
* 10:10:38  [host]         first request arrives with all three results
* ```
*
* The request boundary is the real signal: the request that continues a tool
* round carries a result for every call the host answered; a call it did not
* answer in that request will never be answered. {@link beginHostRequest}
* settles those, so a slow host never loses a result it was about to send.
* Only a handler with no announced id — where no result can be matched at all
* — keeps a bounded park as the last-resort recovery.
*
* ## Why the boundary alone is not enough
*
* The boundary settles what is *already* parked when it runs, and an
* announcement that arrives after it is not touched by it. That leaves one
* shape a wall clock used to break and nothing else could: the CLI dispatches
* an MCP call whose tool-use block never reached the host. No result can be
* filed for that id, and the boundary that would settle it needs the next host
* request — which needs this turn to end first, and this turn is blocked on the
* handler. The turn hangs until the user stops it. {@link claim} therefore
* checks {@link ToolResultPairing.hostVisible} before parking: a call the host
* was never shown fails at once, exactly as the boundary would have failed it.
*
* Announcements are dropped only where the CLI provably cancels its pending
* dispatch — {@link forgetUnclaimed} on an aborted or failed turn, and
* {@link clear} when the session dies.
*/
var ToolResultPairing = class {
	/** Handlers parked under the tool-use id their host result will arrive as. */
	parked = /* @__PURE__ */ new Map();
	/** Results that arrived before their handler did, by tool-use id. */
	buffered = /* @__PURE__ */ new Map();
	/** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
	announced = [];
	/**
	* Announcements a host request has moved past without answering.
	*
	* A handler for one of these can still fire (the CLI decides when to dispatch
	* the MCP call), but no result will ever arrive for it; {@link claim} settles
	* it immediately instead of parking it for the fallback timeout.
	*/
	abandoned = [];
	/**
	* Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
	*
	* Keyed by a per-session nonce, so a stale entry can never be reached by a
	* later call and is safe to keep across turns; it is dropped with the session.
	*/
	hostCallIds = /* @__PURE__ */ new Map();
	/**
	* Tool-use ids the host was actually shown, and has not answered yet.
	*
	* A host result is filed under a tool-use id only because the adapter emitted
	* that call's block to the host, so these — and only these — are calls the
	* host can still answer. {@link claim} refuses to park on any other id; see
	* the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
	* and is cleared everywhere that map is.
	*/
	hostVisible = /* @__PURE__ */ new Set();
	/** Suffix for a handler that claimed no announcement, so keys stay distinct. */
	anonymous = 0;
	/** Record the tool-use id `canUseTool` allowed, in execution order. */
	announce(toolUseId) {
		this.announced.push(toolUseId);
	}
	/** Record which tool-use id a model-emitted tool-call block belongs to. */
	mapHostCall(hostCallId, toolUseId) {
		this.hostCallIds.set(hostCallId, toolUseId);
		this.hostVisible.add(toolUseId);
	}
	/**
	* Hand one MCP handler the result the host already delivered, or park it until
	* the host delivers one.
	*
	* A paired call is NOT timed out. The host can only answer on its next
	* request, and a host tool may legitimately run for minutes; the next request
	* settles it instead — see {@link beginHostRequest}. `timeoutMs` is therefore
	* reached only by a handler the CLI never announced, where no id exists to
	* match a result against and a bounded park remains the last resort.
	*
	* Parking forever is safe only for a call the host was shown; an announced id
	* the host never received fails at once rather than hanging the turn. See the
	* measurement in the body.
	*
	* @param timeoutMs - how long an *unpaired* handler waits before failing.
	* @returns the host's result, a cancellation, or a timeout payload.
	*/
	async claim(timeoutMs) {
		const toolUseId = this.announced.shift();
		if (toolUseId !== void 0) {
			const ready = this.buffered.get(toolUseId);
			if (ready !== void 0) {
				this.buffered.delete(toolUseId);
				return ready;
			}
			if (!this.hostVisible.has(toolUseId)) return unansweredCall(toolUseId);
			return await this.park(toolUseId);
		}
		const abandoned = this.abandoned.shift();
		if (abandoned !== void 0) return unansweredCall(abandoned);
		if (this.parked.size === 0 && this.buffered.size === 1) {
			const only = this.buffered.entries().next();
			if (only.done !== true) {
				this.buffered.delete(only.value[0]);
				return only.value[1];
			}
		}
		return await this.park(`anonymous-${++this.anonymous}`, timeoutMs);
	}
	/**
	* Park one handler under `key` until the host answers, the request boundary
	* settles it, or — for an unpaired key only — the fallback timeout expires.
	*/
	async park(key, timeoutMs) {
		return await new Promise((resolve) => {
			let timer;
			if (timeoutMs !== void 0) timer = setTimeout(() => {
				this.parked.delete(key);
				resolve({
					content: [{
						type: "text",
						text: `宿主在 ${timeoutMs / 1e3}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`
					}],
					isError: true
				});
			}, timeoutMs);
			this.parked.set(key, (payload) => {
				if (timer !== void 0) clearTimeout(timer);
				resolve(payload);
			});
		});
	}
	/**
	* File one host tool result against the call it answers.
	*
	* Resolves the handler already parked under that tool-use id, or buffers the
	* result for the handler that has not fired yet — which is the ordinary case
	* for a host tool that returns quickly.
	*
	* @param hostCallId - the host-facing call id from the tool-result message.
	* @param payload - the rendered result.
	* @returns the tool-use id the result was filed under, for the request
	*   boundary that settles the rest of the round.
	*/
	deliver(hostCallId, payload) {
		const key = this.hostCallIds.get(hostCallId) ?? hostCallId;
		this.hostCallIds.delete(hostCallId);
		this.hostVisible.delete(key);
		const resolve = this.parked.get(key);
		if (resolve !== void 0) {
			this.parked.delete(key);
			resolve(payload);
			return key;
		}
		this.buffered.set(key, payload);
		return key;
	}
	/**
	* Settle the pairing against one arriving host request.
	*
	* The host runs every tool of a round before it sends the request that
	* continues the conversation, and that request carries a result for every
	* call it answered. A call it did not answer there will never be answered,
	* so this boundary — not a wall clock — decides that a handler is stranded:
	*
	*  - a handler parked under an unanswered id is released now;
	*  - an announcement whose handler has not fired yet is marked abandoned, so
	*    that handler settles as soon as it does arrive;
	*  - a buffered result from an earlier round whose handler never arrived is
	*    dropped, because no later request can produce that handler.
	*
	* A fresh user turn is handled by the same rules: the results the request
	* still carries are delivered, and the calls it left unanswered are
	* superseded. It differs only in the cancellation text the model reads.
	*
	* `delivered` is what protects the fast-handler race: a result can arrive
	* before the CLI dispatches the MCP handler, and a runtime-context snapshot
	* can make the same request look like a new user turn. Keeping everything
	* this request answered, in both cases, is what lets that handler collect
	* the real result instead of a cancellation.
	*
	* @param delivered - tool-use ids the host just delivered a result for.
	* @param freshUserTurn - whether the request carries a new user message.
	*/
	beginHostRequest(delivered, freshUserTurn) {
		if (this.announced.length === 0 && this.parked.size === 0) this.abandoned.length = 0;
		for (const [key, resolve] of [...this.parked.entries()]) {
			if (delivered.has(key)) continue;
			this.parked.delete(key);
			resolve(freshUserTurn ? {
				content: [{
					type: "text",
					text: SUPERSEDED_CALL_TEXT
				}],
				isError: true
			} : unansweredCall(key));
		}
		const kept = this.announced.filter((id) => delivered.has(id));
		for (const id of this.announced) if (!delivered.has(id)) this.abandoned.push(id);
		this.announced.length = 0;
		this.announced.push(...kept);
		for (const key of [...this.buffered.keys()]) if (!delivered.has(key)) this.buffered.delete(key);
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/**
	* Release every parked handler: the host started a fresh user turn while their
	* calls were still outstanding, so those calls can never be answered.
	*/
	cancelParked() {
		const stale = [...this.parked.entries()];
		this.parked.clear();
		for (const [, resolve] of stale) resolve({
			content: [{
				type: "text",
				text: SUPERSEDED_CALL_TEXT
			}],
			isError: true
		});
	}
	/**
	* Drop announcements no handler can still claim, and release parked handlers.
	*
	* An aborted or failed turn is one where the CLI cancels its pending tool
	* dispatch, so an id it announced but never dispatched would otherwise shift
	* the pairing of the NEXT turn's handler by one slot and park it under a key
	* nothing resolves — reintroducing the very stall this class exists to fix.
	* A handler that was already dispatched still needs an answer, so parked
	* handlers settle here, and announcements move to the abandoned queue in case
	* their dispatch was already in flight when the turn died.
	*/
	forgetUnclaimed() {
		this.abandoned.push(...this.announced);
		this.announced.length = 0;
		this.cancelParked();
		this.buffered.clear();
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/** Drop all pairing state; the session is being torn down. */
	clear() {
		this.cancelParked();
		this.announced.length = 0;
		this.abandoned.length = 0;
		this.hostCallIds.clear();
		this.hostVisible.clear();
		this.buffered.clear();
	}
	/** How many handlers are waiting for a host result. */
	get parkedCount() {
		return this.parked.size;
	}
};
//#endregion
//#region src/host/providers/qoder/session.ts
/**
* One long-lived inner Qoder CLI session per host session id: a channel-fed
* `query()` subprocess whose model continuation streams out as harness
* `StreamChunk`s. Host tool calls travel through an in-process MCP server:
* the handler parks on a promise, the adapter finishes the turn with
* `tool-calls`, and the next host request (carrying tool results) resolves
* the parked promise so the inner model continues with the result in place.
* @module dsh-llm-qoder/session
*/
/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/**
* How long a handler the CLI never announced waits for a result before failing.
*
* Paired handlers are settled by the host request that follows them, not by
* this deadline: a host tool may legitimately run far longer than two minutes,
* and a wall clock cannot tell a slow tool from a lost call.
*/
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 12e4;
/** How long the inner process gets to acknowledge an abort before the turn is force-ended. */
const DEFAULT_ABORT_GRACE_MS = 5e3;
/** Inner turns allowed for one side-channel (title, compaction) request. */
const DEFAULT_COLD_MAX_TURNS = 4;
/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel() {
	const queue = [];
	let resolve = null;
	return {
		push(message) {
			if (resolve !== null) {
				const settle = resolve;
				resolve = null;
				settle({
					value: message,
					done: false
				});
			} else queue.push(message);
		},
		[Symbol.asyncIterator]() {
			return { next() {
				const message = queue.shift();
				if (message !== void 0) return Promise.resolve({
					value: message,
					done: false
				});
				return new Promise((settle) => {
					resolve = settle;
				});
			} };
		}
	};
}
/**
* Whether a usage record carries real metering rather than the CLI's zero filler.
*
* The CLI attaches a usage record to several frames and leaves the four token
* counters at zero on all but one kind; a real request always consumed a prompt
* and produced output, so at least one counter being positive is the whole test.
*/
function carriesTokens(usage) {
	const positive = (value) => typeof value === "number" && value > 0;
	return positive(usage.input_tokens) || positive(usage.output_tokens) || positive(usage.cache_read_input_tokens) || positive(usage.cache_creation_input_tokens);
}
/**
* The occupancy sample one arriving frame may contribute, if any.
*
* Exactly one carrier may: the `message_delta` emitted when a provider request
* finishes, whose usage describes that request's prompt — which is precisely
* what context occupancy means. The other carriers are traps, confirmed against
* a live CLI with a tool the inner model calls four times in one turn:
*
*  - `message_start`, and the assembled `assistant` message, report all four
*    counters as zero; a request's numbers exist only once it finishes.
*  - the `result` frame reports the WHOLE inner turn's total, summed over every
*    provider request that turn made. One host step is one request, but an inner
*    turn ends only when the model stops calling tools, so a long agentic run
*    reports a multiple of any real prompt — that four-request turn ended at
*    `input_tokens` 2 921 where each request had used 608–837. Taking that total
*    as the session's occupancy pegged the harness context meter at 100%
*    (9.8M against a 1M window) and latched it there.
*
* @param message - one arriving SDK message.
* @returns the usage to sample, or undefined when this frame may not supply one.
*/
function requestUsageSample(message) {
	if (message.type !== "stream_event") return void 0;
	const usage = message.event?.usage ?? message.event?.message?.usage;
	return usage !== void 0 && carriesTokens(usage) ? usage : void 0;
}
/**
* One frame's own metering, translated into the harness's token buckets.
*
* Three rules, each measured against a live CLI rather than inferred:
*
* 1. `input_tokens` IS the whole prompt, cache included. The CLI measures its
*    `context_usage_ratio` as `input_tokens / window` (a probe: 9 811 input at
*    a 200 000 window → exactly 0.049055) and subtracts the cached part
*    afterwards for its own telemetry — so the harness's four buckets, which
*    are disjoint, have to take both cache halves back out of `inputTokens`.
* 2. Both cache buckets are always reported, zero included. The harness shows a
*    turn's usage only when its accounting is complete: a missing cache bucket
*    with no `totalTokens` to prove the sum makes the whole disclosure
*    unavailable, so omitting a zero would hide every per-turn usage row.
* 3. `totalTokens` is the sum of the four buckets, so the harness's
*    consistency check (`total - output == input + cacheRead + cacheWrite`)
*    holds by construction.
*
* @param real - the CLI's usage frame, or undefined when it reported none.
* @param reasoning - the local reasoning estimate, clamped inside the provider's
*   own output total (the harness drops a reading whose reasoning exceeds it).
* @returns the harness usage, or undefined when the frame carries no metering.
*/
function meteredUsage(real, reasoning) {
	if (real === void 0 || typeof real.input_tokens !== "number" || typeof real.output_tokens !== "number" || real.input_tokens <= 0 && real.output_tokens <= 0) return void 0;
	const cacheReadTokens = typeof real.cache_read_input_tokens === "number" ? real.cache_read_input_tokens : 0;
	const cacheWriteTokens = typeof real.cache_creation_input_tokens === "number" ? real.cache_creation_input_tokens : 0;
	const inputTokens = Math.max(0, real.input_tokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = real.output_tokens;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
		...reasoning(outputTokens)
	};
}
/**
* The host tool runtime dispatches by the bare host name; the inner model
* only ever sees the namespaced MCP form, so strip every prefix layer on the
* way out. See {@link stripMcpNamespace} for why one layer is not enough.
*/
function hostToolName$1(name) {
	return bareHostToolName(name, MCP_SERVER_NAME);
}
/** Deny native tools, allow this adapter's MCP tools. */
async function gateTools(toolName, _input, options) {
	const echo = options.toolUseID !== void 0 ? { toolUseID: options.toolUseID } : {};
	if (toolName.startsWith(MCP_TOOL_PREFIX)) return {
		behavior: "allow",
		...echo
	};
	return {
		behavior: "deny",
		message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
		...echo
	};
}
/**
* One warm inner session. All mutation happens on the consumer fiber except
* the documented turn lifecycle driven by {@link stream}.
*/
var QoderSession = class {
	sessionId;
	channel = createChannel();
	/**
	* Lazy: the MCP SDK refuses tool registration after the transport connects,
	* so the inner process only spawns once {@link ensureTools} has registered
	* the host tools (the adapter does that immediately before each stream).
	*/
	q = null;
	/**
	* Tool-result pairing state. Owned by the session rather than the turn,
	* because a handler can fire after its turn has ended — see
	* {@link ToolResultPairing} for the measurement that proves it.
	*/
	pairing = new ToolResultPairing();
	mcp = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		tools: []
	});
	/**
	* Reconciles the live host tool list into {@link mcp}.
	*
	* The session outlives the host's tool list: `dsh-ops` publishes a different
	* set per mode and `ops_discover_tools` adds capabilities mid-conversation.
	* Installing only what is new left the server unable to ever replace a
	* changed schema (the MCP SDK refuses a duplicate name), so this owns the
	* add/update/remove bookkeeping instead of a name→hash map.
	*/
	registry = new HostToolRegistry(this.mcp.instance, () => async (_args) => {
		const result = await this.pairing.claim(this.toolResultTimeoutMs);
		return {
			content: result.content,
			...result.isError ? { isError: true } : {}
		};
	}, (message) => console.warn(`[dsh-agent-sdk-bridge] ${message}`));
	queue = null;
	model;
	reasoningEffort;
	callCounter = 0;
	/**
	* Per-instance suffix for emitted host call ids. Ids must stay unique across
	* the whole host session log: a history divergence rebuilds this class, LRU
	* eviction recreates it, and the harness keys tool-call blocks by id, so a
	* fresh `qoder-1` would collide with the one its predecessor already stored.
	*/
	callNonce = randomUUID().slice(0, 8);
	abortPending = false;
	disposed = false;
	/**
	* Deferred-close state: why this session was asked to stop, and whether an
	* in-flight turn is being allowed to finish first.
	*
	* The harness consumes this session's chunks, not the subprocess's, so a turn
	* that already started streaming can still deliver its answer after the
	* plugin was unloaded. Killing the CLI at dispose time instead truncated it
	* and reported `STREAM_CLOSED` — a plugin reload shown as a dropped network
	* connection. See {@link CloseGate}.
	*/
	closeGate;
	/** Wall clock of the spawn, for the close log's lifetime figure. */
	spawnedAt;
	/**
	* How the active turn ended, so its cleanup can tell a completed turn (whose
	* unclaimed announcements may still belong to a handler about to fire) from an
	* aborted or failed one (where the CLI cancelled that dispatch).
	*/
	turnEndKind = void 0;
	/** Previous request's messages for delta feeding. */
	fedMessages;
	fedSystem;
	/** This turn's fed characters, reset per turn for per-call token accounting. */
	turnInputChars = 0;
	/** Host system prompt captured before spawn for the boot-time systemPrompt. */
	hostSystem;
	/** Host session workspace; qodercli runs there so its preset reports the session cwd. */
	sessionCwd;
	blockIndex = 0;
	textBlock;
	reasoningBlock;
	openTool;
	toolCalls = [];
	/**
	* This turn's generated output, priced by script.
	*
	* Counts visible text, reasoning, and tool-call names and arguments — see
	* {@link TurnOutputAccounting} for why the last one matters.
	*/
	output = new TurnOutputAccounting();
	/**
	* Metering of the last provider request that finished in the active turn.
	*
	* Never the `result` frame's usage, which totals the whole inner turn across
	* every request it made — see {@link requestUsageSample}.
	*/
	lastUsage;
	/**
	* The active turn's feed as plain text, when that feed carries image bytes.
	* Kept so a CLI that refuses to decode those bytes can be retried without
	* them instead of failing the turn. Cleared with the turn.
	*/
	feedFallback;
	/**
	* Session-level input token estimate for the CURRENT request, priced by
	* script mix over the rendered conversation the inner session actually
	* receives. It is the last-resort tier of {@link usage}: a turn whose frames
	* carry no metering at all would otherwise read ~0% on the context meter and
	* never trigger auto-compaction, and the CLI's own context ratio is preferred
	* over this whenever the turn reported one.
	*/
	estimatedInputTokens;
	/**
	* The window this route publishes, i.e. the denominator the harness meter
	* divides by. The CLI's context ratio is turned into tokens against this same
	* number, so the meter and the ratio always describe one window.
	*/
	contextWindow;
	/**
	* The window the CLI will actually run with, when that is known to differ
	* from {@link contextWindow} because the model does not advertise the
	* declared one. This is the denominator the CLI itself measures its context
	* ratio against, so it is what the ratio must be multiplied by.
	*/
	cliContextWindow;
	/** Per-session runtime knobs, resolved from the plugin config at creation. */
	toolResultTimeoutMs;
	abortGraceMs;
	/** Which edition's CLI (and SDK) this session runs on. */
	brand;
	/** How long a close waits for the in-flight turn; read per close. */
	drainMs;
	constructor(sessionId, initialModel, runtime = {}) {
		this.sessionId = sessionId;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, DEFAULT_TOOL_RESULT_TIMEOUT_MS);
		this.abortGraceMs = readLive(runtime.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
		this.brand = runtime.brand ?? "cn";
		this.drainMs = () => readLive(runtime.drainMs, DEFAULT_DRAIN_MS);
		this.closeGate = new CloseGate(this.drainMs, () => {
			this.teardown();
		}, (cause) => {
			this.forceEnd(cause);
		});
	}
	/** Whether a turn is in flight; the pool must never evict such a session. */
	get busy() {
		return this.queue !== null;
	}
	/** Whether this session has been asked to stop and accepts no new turn. */
	get closing() {
		return this.closeGate.cause;
	}
	/** Spawn the inner process (first stream only) and attach the consumer. */
	async ensureStarted() {
		if (this.q !== null) return this.q;
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		if (resolveQoderCli(this.brand) === void 0) throw new Error(cliConflictMessage(this.brand));
		try {
			await probeDaemon(this.brand);
		} catch (error) {
			if (isDaemonConflict(error)) resetSdk(this.brand);
		}
		const sdk = await loadSdk(this.brand);
		this.registry.prepare();
		const q = sdk.query({
			prompt: this.channel,
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: this.canUseTool,
				settingSources: [],
				includePartialMessages: true,
				resolveModel: () => ({
					model: this.model,
					...this.reasoningEffort === void 0 && this.contextWindow === void 0 ? {} : { parameters: {
						...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
						...this.contextWindow === void 0 ? {} : { contextWindow: this.contextWindow }
					} }
				}),
				mcpServers: { [MCP_SERVER_NAME]: this.mcp },
				allowedMcpServerNames: [MCP_SERVER_NAME],
				...this.hostSystem === void 0 ? {} : { systemPrompt: this.hostSystem },
				...this.sessionCwd === void 0 ? {} : { cwd: this.sessionCwd }
			}
		});
		if (this.disposed || this.closeGate.closing) {
			q.close().catch(() => void 0);
			throw new LlmError(`qoder session ${this.sessionId} closed while starting`, "INVALID_REQUEST");
		}
		this.q = q;
		this.spawnedAt = Date.now();
		trace("session/spawn", {
			session: this.sessionId,
			brand: this.brand
		});
		this.consume(q);
		return q;
	}
	/** Point the session at a model and its per-request policy. */
	setModel(model, policy) {
		this.model = model;
		this.reasoningEffort = policy?.reasoningEffort;
		this.contextWindow = policy?.contextWindow;
		this.cliContextWindow = policy?.cliContextWindow;
	}
	/** Record the host system prompt; effective only before the process spawns. */
	setSystem(system) {
		this.hostSystem = system;
	}
	/**
	* Record the host session workspace; effective only before the process
	* spawns. qodercli inherits the host process cwd otherwise, which would
	* make its preset report the server's launch directory instead of the
	* session's workspace.
	*/
	setCwd(cwd) {
		this.sessionCwd = cwd;
	}
	/**
	* Permission gate for the inner process. Native tools are denied; MCP host
	* tools are allowed, and each allowed call's qodercli tool-use id is recorded
	* so the matching MCP handler can park under the exact id (qodercli asks once
	* per call, in execution order, before dispatching the MCP message).
	*/
	canUseTool = (toolName, _input, options) => {
		if (toolName.startsWith(MCP_TOOL_PREFIX)) {
			if (options.toolUseID !== void 0) this.pairing.announce(options.toolUseID);
			return Promise.resolve({
				behavior: "allow",
				...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
			});
		}
		return Promise.resolve({
			behavior: "deny",
			message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
			...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
		});
	};
	/**
	* Make this session's MCP tool set match the host's live tool list.
	*
	* The host adds and withdraws tools during a conversation (`dsh-ops` mode
	* switches, `ops_discover_tools`), so this reconciles rather than only adds:
	* a tool that appears mid-session is registered, a changed schema is updated
	* in place, and a withdrawn tool is removed. See {@link HostToolRegistry} for
	* the failure this prevents — the model calling a name the MCP server no
	* longer had, which the CLI answers with `Tool "…" does not exist in the
	* current tool set.` instead of a host result.
	*/
	ensureTools(tools) {
		this.registry.reconcile(tools);
	}
	/**
	* Deliver host tool results to parked or buffered handlers, keyed by call id,
	* and settle the previous round at this request boundary.
	* @param tail - the host messages appended since the previous request.
	* @param images - adapter-resolved request images keyed by attachment id; an
	*   id missing from the map degrades to handle text.
	*/
	deliverToolResults(tail, images) {
		let freshUserTurn = false;
		const delivered = /* @__PURE__ */ new Set();
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			delivered.add(this.pairing.deliver(String(message.toolCallId), {
				content: renderResultContent(message.content, images),
				isError: message.isError === true
			}));
		}
		this.pairing.beginHostRequest(delivered, freshUserTurn);
	}
	/**
	* Run one inner turn: feed (if any) then pump consumer chunks until finish.
	* @param options - the host request (signal; tools already registered).
	* @param feed - literal text, resolved content blocks (a vision turn), or
	*   null for a pure tool-result continuation.
	* @param fallback - the same feed rendered as text. Used only if the inner
	*   CLI refuses the turn's image bytes, in which case the turn is resent
	*   without them rather than failing (see {@link retryWithoutImages}).
	*/
	async *stream(options, feed, fallback) {
		if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, "INVALID_REQUEST");
		if (this.disposed || this.closeGate.closing) throw new LlmError(`qoder session ${this.sessionId} is closed (${this.closeGate.cause ?? "disposed"})`, "INVALID_REQUEST");
		let q;
		try {
			q = await this.ensureStarted();
		} catch (error) {
			const cause = this.closeGate.cause;
			if (cause === void 0) throw error;
			yield {
				type: "finish",
				reason: closeFinishReason(cause)
			};
			return;
		}
		this.queue = new TurnQueue();
		this.resetTurnState();
		if (feed !== null) {
			const content = typeof feed === "string" ? [{
				type: "text",
				text: feed
			}] : [...feed];
			this.feedFallback = fallback !== void 0 && content.some((block) => block.type === "image") ? fallback : void 0;
			this.turnInputChars += contentChars$1(content);
			this.channel.push({
				type: "user",
				message: {
					role: "user",
					content
				},
				parent_tool_use_id: null
			});
		}
		const signal = options.signal;
		let abortTimer;
		const onAbort = () => {
			this.abortPending = true;
			q.interrupt().catch(() => void 0);
			abortTimer = setTimeout(() => this.endTurn({
				kind: "aborted",
				failure: {
					message: "qoder session aborted by host",
					code: "ABORTED"
				}
			}), this.abortGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for await (const item of this.queue) {
				if (item.kind === "chunk") {
					yield item.chunk;
					continue;
				}
				if (item.usage !== void 0) yield {
					type: "usage",
					usage: this.usage()
				};
				yield {
					type: "finish",
					reason: item.reason
				};
				return;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			if (this.turnEndKind === "aborted" || this.turnEndKind === "error") this.pairing.forgetUnclaimed();
			this.queue = null;
			this.abortPending = false;
			this.feedFallback = void 0;
			this.closeGate.settled();
		}
	}
	/**
	* Resend the current turn without its images after the CLI refused them.
	*
	* The inner CLI decodes every image before the model sees the turn, and a
	* decode it cannot do fails that whole turn — the host would surface an error
	* for a question whose only problem was the pixels. The failed turn never
	* reached the model, so the same turn goes out again with the images replaced
	* by the harness's own handle text, the same text a text-only route renders,
	* and the user still gets an answer.
	*
	* @param detail - the failed result frame's subtype and errors.
	* @returns whether a retry was started, in which case the turn must not be
	*   ended: the retry's own result frame settles it.
	*/
	retryWithoutImages(detail) {
		const fallback = this.feedFallback;
		if (fallback === void 0 || !isImageAttachFailure(detail)) return false;
		if (this.textBlock !== void 0 || this.reasoningBlock !== void 0 || this.toolCalls.length > 0 || this.output.outputChars > 0) return false;
		this.feedFallback = void 0;
		this.resetTurnState();
		this.turnInputChars += fallback.length;
		this.channel.push({
			type: "user",
			message: {
				role: "user",
				content: [{
					type: "text",
					text: fallback
				}]
			},
			parent_tool_use_id: null
		});
		return true;
	}
	/**
	* Ask the session to stop serving.
	*
	* The request is remembered rather than acted on immediately: an in-flight
	* turn is allowed to finish (up to `drainMs`), because its chunks are being
	* consumed by the harness and truncating them turns a plugin reload into a
	* bogus stream failure. {@link teardown} does the actual work.
	*
	* @param cause - why it is closing; decides how an interrupted turn is
	*   reported and how the close is logged.
	*/
	close(cause = "dispose") {
		if (this.closeGate.request(cause, this.busy) === "draining") trace("session/drain", {
			session: this.sessionId,
			brand: this.brand,
			cause
		});
	}
	/**
	* End a turn that outlived its drain window, then let the teardown run.
	*
	* The subprocess is about to die, so the turn must not be left waiting for a
	* `result` frame that will never arrive.
	*/
	forceEnd(cause) {
		this.endTurn(closeFinishReason(cause));
	}
	/** Tear the inner process down; parked calls die with it. Runs once. */
	teardown() {
		if (this.disposed) return;
		this.disposed = true;
		const q = this.q;
		this.q = null;
		this.pairing.clear();
		q?.close().catch(() => void 0);
		trace("session/close", {
			session: this.sessionId,
			brand: this.brand,
			cause: this.closeGate.cause ?? "dispose",
			aliveMs: this.spawnedAt === void 0 ? 0 : Date.now() - this.spawnedAt
		});
	}
	/**
	* Reset the per-turn assembly state.
	*
	* Pairing state is deliberately NOT touched here. It looks turn-scoped, but a
	* `tools/call` handler can fire only after the turn that announced it has
	* already ended — the host answers a tool call the moment it sees the block,
	* and the CLI dispatches the MCP message some milliseconds later. Clearing
	* announcements at this boundary made that handler claim nothing, park under a
	* fallback key, and wait out the whole tool-result timeout; see
	* {@link ToolResultPairing}. {@link QoderSession.close} drops it with the
	* session, and an aborted turn drops what it can no longer claim.
	*/
	resetTurnState() {
		this.blockIndex = 0;
		this.textBlock = void 0;
		this.reasoningBlock = void 0;
		this.openTool = void 0;
		this.toolCalls = [];
		this.turnInputChars = 0;
		this.output.reset();
		this.lastUsage = void 0;
		this.turnEndKind = void 0;
	}
	emit(chunk) {
		this.queue?.push({
			kind: "chunk",
			chunk
		});
	}
	/** Count generated text toward this turn's output tokens. */
	countOutput(text) {
		this.output.addOutput(text);
	}
	/**
	* Price this turn's generated text, by script rather than at a flat rate.
	*
	* {@link TurnOutputAccounting} owns the counters and the harness invariant
	* that `reasoningTokens` is a subset of `outputTokens` — the harness discards
	* a whole reading when it is not.
	*/
	outputUsage() {
		return this.output.usage();
	}
	usage() {
		const metered = meteredUsage(this.lastUsage, (output) => this.output.reasoningTokensWithin(output));
		if (metered !== void 0) return metered;
		const ratioWindow = this.cliContextWindow ?? this.contextWindow;
		const ratio = this.lastUsage?.context_usage_ratio;
		if (typeof ratio === "number" && ratio > 0 && typeof ratioWindow === "number" && ratioWindow > 0) return this.estimatedUsage(Math.min(ratioWindow, Math.max(1, Math.ceil(ratio * ratioWindow))));
		if (this.estimatedInputTokens !== void 0 && this.estimatedInputTokens > 0) return this.estimatedUsage(this.estimatedInputTokens);
		return this.estimatedUsage(Math.max(1, Math.ceil(this.turnInputChars / 4)));
	}
	/**
	* One estimated turn reading, shaped exactly like a metered one.
	*
	* The cache buckets are present and zero rather than omitted: this estimate
	* prices the prompt as a single uncached block, and a missing bucket would
	* make the harness withhold the turn's usage disclosure entirely.
	*
	* @param inputTokens - the estimated prompt size, uncached by definition.
	* @returns the harness usage for the turn.
	*/
	estimatedUsage(inputTokens) {
		const output = this.outputUsage();
		return {
			inputTokens,
			...output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: inputTokens + output.outputTokens
		};
	}
	/**
	* Record the input-token estimate for the CURRENT request, priced by script
	* mix over the rendered conversation (system + messages) the inner session
	* receives. This is the fallback {@link usage} reaches for only when a turn
	* reported no metering and no context ratio — without it such a turn would
	* read ~0% on the context meter and never trigger auto-compaction.
	* @param system - the host system prompt included in this request.
	* @param messages - the full host message list included in this request.
	*/
	recordRequestInput(system, messages) {
		const rendered = renderInitialFeed(system, messages);
		const imageTokens = feedImageRefs(rendered).reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0);
		this.estimatedInputTokens = Math.max(1, Math.ceil(estimateTextTokens(feedTextLength(rendered), feedWideCharCount(rendered))) + imageTokens);
	}
	endTurn(reason, usage) {
		if (this.queue === null || this.queue.isClosed) return;
		this.turnEndKind = reason.kind;
		if (this.textBlock !== void 0) this.emit({
			type: "block-end",
			index: this.textBlock.index,
			block: {
				type: "text",
				text: this.textBlock.text
			}
		});
		if (this.reasoningBlock !== void 0) this.emit({
			type: "block-end",
			index: this.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: this.reasoningBlock.text
			}
		});
		this.queue.push({
			kind: "turn-end",
			reason,
			usage: usage ?? this.usage()
		});
		this.queue.close();
		const code = reason.kind === "error" || reason.kind === "aborted" ? reason.failure.code : void 0;
		trace("turn/end", {
			session: this.sessionId,
			brand: this.brand,
			kind: reason.kind,
			...code === void 0 ? {} : { code },
			chars: this.output.outputChars,
			...this.closeGate.cause === void 0 ? {} : { cause: this.closeGate.cause }
		});
	}
	async consume(q) {
		try {
			const iterator = q[Symbol.asyncIterator]();
			while (true) {
				const next = await iterator.next();
				if (next.done) break;
				try {
					this.handle(next.value);
				} catch (error) {
					this.endTurn({
						kind: "error",
						failure: {
							message: `qoder session consumer failed: ${String(error)}`,
							code: "BACKEND_ERROR"
						}
					});
				}
			}
			const cause = this.closeGate.cause;
			if (cause !== void 0) {
				this.endTurn(closeFinishReason(cause));
				return;
			}
			trace("session/stream-ended", {
				session: this.sessionId,
				brand: this.brand,
				chars: this.output.outputChars
			});
			this.endTurn({
				kind: "error",
				failure: {
					message: "qoder session stream ended unexpectedly",
					code: "STREAM_CLOSED"
				}
			});
		} catch (error) {
			if (isDaemonConflict(error)) {
				resetSdk(this.brand);
				this.q = null;
				q.close().catch(() => void 0);
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder session died: ${cliFailureText(String(error), this.brand)}`,
					code: "TRANSPORT"
				}
			});
		}
	}
	handle(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event === void 0) return;
			const sample = requestUsageSample(message);
			if (sample !== void 0) this.lastUsage = sample;
			switch (event.type) {
				case "content_block_start": {
					const block = event.content_block;
					if (block?.type === "tool_use") {
						if (this.queue === null || this.queue.isClosed) break;
						const callId = `qoder-${this.callNonce}-${++this.callCounter}`;
						if (typeof block.id === "string" && block.id.length > 0) this.pairing.mapHostCall(callId, block.id);
						const chunkIndex = this.blockIndex++;
						const initialArguments = block.input !== void 0 && block.input !== null && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
						this.openTool = {
							chunkIndex,
							callId,
							name: hostToolName$1(block.name ?? ""),
							arguments: initialArguments
						};
						this.countOutput(this.openTool.name);
						this.countOutput(initialArguments);
						this.emit({
							type: "block-start",
							index: chunkIndex,
							blockType: "tool-call"
						});
						this.emit({
							type: "tool-call-delta",
							index: chunkIndex,
							id: ToolCallId(callId),
							name: this.openTool.name,
							argumentsDelta: ""
						});
					}
					break;
				}
				case "content_block_delta": {
					const delta = event.delta;
					if (delta === void 0) return;
					if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
						if (this.textBlock === void 0) {
							this.textBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.textBlock.index,
								blockType: "text"
							});
						}
						this.textBlock.text += delta.text;
						this.countOutput(delta.text);
						this.emit({
							type: "text-delta",
							index: this.textBlock.index,
							text: delta.text
						});
					} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
						if (this.reasoningBlock === void 0) {
							this.reasoningBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.reasoningBlock.index,
								blockType: "reasoning"
							});
						}
						this.reasoningBlock.text += delta.thinking;
						this.output.addReasoning(delta.thinking);
						this.emit({
							type: "reasoning-delta",
							index: this.reasoningBlock.index,
							text: delta.thinking
						});
					} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.openTool !== void 0) {
						this.openTool.arguments += delta.partial_json;
						this.countOutput(delta.partial_json);
						this.emit({
							type: "tool-call-delta",
							index: this.openTool.chunkIndex,
							id: ToolCallId(this.openTool.callId),
							argumentsDelta: delta.partial_json
						});
					}
					break;
				}
				case "content_block_stop":
					if (this.openTool !== void 0) {
						this.emit({
							type: "block-end",
							index: this.openTool.chunkIndex,
							block: {
								type: "tool-call",
								id: ToolCallId(this.openTool.callId),
								name: this.openTool.name,
								arguments: this.openTool.arguments
							}
						});
						this.toolCalls.push(this.openTool);
						this.openTool = void 0;
					}
					break;
				case "message_stop": if (this.toolCalls.length > 0) this.endTurn({ kind: "tool-calls" });
			}
			return;
		}
		if (message.type === "assistant") {
			if (this.textBlock === void 0 && this.toolCalls.length === 0) {
				const content = message.message?.content ?? [];
				for (const block of content) {
					if (block.type !== "tool_use") continue;
					this.countOutput(block.name ?? "");
					this.countOutput(JSON.stringify(block.input ?? ""));
				}
				const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
				if (text.length > 0) {
					this.textBlock = {
						index: this.blockIndex++,
						text
					};
					this.countOutput(text);
					this.emit({
						type: "block-start",
						index: this.textBlock.index,
						blockType: "text"
					});
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text
					});
				}
			}
			return;
		}
		if (message.type === "result") {
			if (this.abortPending) {
				this.endTurn({
					kind: "aborted",
					failure: {
						message: "qoder turn aborted by host",
						code: "ABORTED"
					}
				});
				return;
			}
			if (this.toolCalls.length > 0) {
				this.endTurn({ kind: "tool-calls" });
				return;
			}
			if (message.subtype === "success" || message.subtype === void 0) {
				if (this.textBlock === void 0 && this.reasoningBlock === void 0) this.endTurn({
					kind: "error",
					failure: {
						message: "qoder model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				});
				else this.endTurn({ kind: "stop" });
				return;
			}
			const detail = `${message.subtype} ${safeErrors(message.errors)}`;
			if (this.retryWithoutImages(detail)) return;
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder turn failed: ${detail}`,
					code: classifyTurnError(detail)
				}
			});
		}
	}
};
/**
* Render tool-result content blocks into the MCP content the inner model
* reads: text passes through, an image resolves from {@link images} into the
* MCP image shape or degrades to the harness's own handle text, and anything
* else is serialized.
*/
function renderResultContent(blocks, images) {
	const content = [];
	for (const block of blocks) if (block.type === "text") content.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") {
		const resolved = images?.get(String(block.attachment.attachmentId));
		if (resolved !== void 0) content.push({
			type: "image",
			data: resolved.data,
			mimeType: resolved.mediaType
		});
		else content.push({
			type: "text",
			text: textOnlyImageText(block.attachment)
		});
	} else content.push({
		type: "text",
		text: JSON.stringify(block)
	});
	return content;
}
/**
* Vision tokens for one image, estimated with the tile formula the
* Claude-compatible wire shape this backend follows uses (width x height / 750).
* The inner CLI reports no usage for the pixels it consumed, so this estimate is
* the only image occupancy the harness context meter and compaction threshold
* can see. It is an estimate, not a provider metering figure.
*/
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	return Math.max(1, Math.ceil(width * height / 750));
}
/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars$1(content) {
	return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/** Safely stringify the SDK error payload for turn diagnostics. */
function safeErrors(errors) {
	if (errors === void 0) return "";
	if (typeof errors === "string") return errors;
	try {
		return JSON.stringify(errors);
	} catch {
		return String(errors);
	}
}
/**
* Classify an inner result-frame failure into a harness-routable code. The
* qoder backend reports context-window and quota rejections as generic
* per-turn errors, so their message text must be recognized through the shared
* dsh-llm classifiers; only then does the harness overflow recovery (or quota
* surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
*/
function classifyTurnError(detail) {
	if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	return "BACKEND_TURN_ERROR";
}
/**
* Whether a failed turn is the CLI refusing an image it could not decode.
*
* qodercli decodes every attached image before the model sees the turn, and
* reports such a failure with a fixed set of phrasings: the sentence it shows
* the user, its terminal reason, and the error code underneath. The turn itself
* is fine — only the pixels are not, which is what makes it safe to resend.
*
* @param detail - the failed result frame's subtype and errors.
*/
function isImageAttachFailure(detail) {
	return /image_processing_failed|unable to attach image|invalid or unsupported image data/i.test(detail);
}
/**
* Warm-session registry with insertion-order LRU eviction, plus the cold
* one-shot path for side-channel requests (titles, compaction).
*/
var QoderSessionManager = class {
	maxSessions;
	runtime;
	create;
	sessions = /* @__PURE__ */ new Map();
	/** Set by {@link seal}: this pool's plugin generation is gone. */
	sealed = false;
	/**
	* @param maxSessions - warm-session cap; read per eviction so a settings edit
	*   applies to the next session that overflows the pool.
	* @param runtime - per-session knobs, resolved when each session is created.
	* @param create - builds one session; injectable so the pool's eviction and
	*   sealing rules are testable without spawning a CLI.
	*/
	constructor(maxSessions = 8, runtime = {}, create = (sessionId, model) => new QoderSession(sessionId, model, runtime)) {
		this.maxSessions = maxSessions;
		this.runtime = runtime;
		this.create = create;
	}
	/** Existing or fresh warm session for one host session id. */
	forSession(sessionId, model) {
		if (this.sealed) throw new LlmError("qoder 会话池已封存（插件已卸载）", "INVALID_REQUEST");
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			this.sessions.delete(sessionId);
			this.sessions.set(sessionId, existing);
			return existing;
		}
		const session = this.create(sessionId, model);
		this.sessions.set(sessionId, session);
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const victim = [...this.sessions.entries()].find(([id, candidate]) => id !== sessionId && !candidate.busy);
			if (victim === void 0) break;
			this.sessions.delete(victim[0]);
			victim[1].close("evicted");
		}
		return session;
	}
	/** Drop one session (history diverged); the next request rebuilds it cold. */
	dispose(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		this.sessions.delete(sessionId);
		session.close("rebuild");
	}
	/**
	* Drop every warm session, keeping the pool usable.
	*
	* For a credential change: the processes loaded the old account, and the
	* conversations are over, but the adapter keeps serving new ones.
	*
	* @param cause - why the sessions go; decides how interrupted turns report.
	*/
	closeAll(cause = "account") {
		for (const session of this.sessions.values()) session.close(cause);
		this.sessions.clear();
	}
	/**
	* Drop every warm session and refuse to create more.
	*
	* Called from the plugin's dispose effect. `closeAll` alone was not enough:
	* a retry of a step prepared before the unload would reach this manager and
	* spawn a fresh subprocess that nothing owns afterwards.
	*/
	seal(cause = "dispose") {
		this.sealed = true;
		this.closeAll(cause);
	}
	/** One-shot turn with no warm state: side channels and cold rebuilds. */
	async *coldStream(options, prompt, model) {
		const systemPrompt = options.system;
		const brand = this.runtime.brand ?? "cn";
		if (foreignCliOverride(brand) !== void 0) throw new Error(cliConflictMessage(brand));
		if (resolveQoderCli(brand) === void 0) throw new Error(cliConflictMessage(brand));
		const sdk = await loadSdk(brand);
		const q = sdk.query({
			prompt,
			options: {
				...qoderCliOptions(brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: gateTools,
				settingSources: [],
				maxTurns: readLive(this.runtime.coldMaxTurns, DEFAULT_COLD_MAX_TURNS),
				...systemPrompt === void 0 ? {} : { systemPrompt },
				...model === void 0 ? {} : { model }
			}
		});
		const signal = options.signal;
		const onAbort = () => {
			q.interrupt().catch(() => void 0);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let text = "";
			let failure;
			try {
				for await (const message of q) {
					const msg = message;
					if (msg.type === "assistant") {
						const chunk = (msg.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
						if (chunk.length > 0) text += chunk;
					} else if (msg.type === "result" && msg.subtype !== "success" && msg.subtype !== void 0) {
						const detail = `${msg.subtype} ${safeErrors(msg.errors)}`;
						failure = {
							message: `qoder side-channel turn failed: ${detail}`,
							code: classifyTurnError(detail)
						};
					}
				}
			} catch (error) {
				if (signal?.aborted !== true) {
					if (isDaemonConflict(error)) resetSdk(brand);
					throw error;
				}
			}
			if (signal?.aborted === true) {
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							message: "aborted by host",
							code: "ABORTED"
						}
					}
				};
				return;
			}
			if (failure !== void 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure
					}
				};
				return;
			}
			if (text.length === 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "qoder side-channel returned no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				};
				return;
			}
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			for (let i = 0; i < text.length; i += 192) yield {
				type: "text-delta",
				index: 0,
				text: text.slice(i, i + 192)
			};
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text
				}
			};
			yield {
				type: "usage",
				usage: {
					inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
					outputTokens: Math.max(1, Math.ceil(text.length / 4))
				}
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			await q.close().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/host/core/adapter-kit.ts
/**
* The adapter-side primitives every provider shares: how an image occurrence is
* read into request bytes, which reasoning levels a route advertises, and how a
* continuation request is turned into inner-session feed (or a rebuild).
*
* Each backend answers these the same way, so they live in `core` rather than
* in the provider that happened to define them first.
*
* @module dsh-agent-sdk-bridge/core/adapter-kit
*/
/** Empty values, so an unset option allocates nothing per read. */
const NO_MODELS$1 = [];
const NO_ALIASES$1 = {};
/**
* Map a harness-side model id onto a provider's own model value.
*
* A configured alias always wins, under either spelling of the id; then the
* provider's own `prefix-` form is unwrapped. `fallback` answers an id that
* unwraps to nothing at all.
*
* @param model - the id the harness addressed the route with.
* @param aliases - user-configured aliases for this provider.
* @param prefix - the provider's own id prefix, with its trailing dash.
* @param fallback - the value an empty remainder maps to.
*/
function resolveAliasedModelId(model, aliases, prefix, fallback = "") {
	const configured = aliases[model] ?? aliases[model.toLowerCase()];
	if (configured !== void 0 && configured.length > 0) return configured;
	const stripped = model.startsWith(prefix) ? model.slice(prefix.length) : model;
	return stripped.length > 0 ? stripped : fallback;
}
/**
* A deny-list as the set a per-model lookup needs, memoized per scope.
*
* The live config hands out a fresh array on every read, so the memo compares
* by content: rebuilding the set per lookup would turn each model toggle into
* a linear scan of the list. The scope is a login region for the providers
* whose deny-list differs per region.
*/
var DenyList = class {
	perScope = /* @__PURE__ */ new Map();
	/** The current membership of `scope`'s list, rebuilt only when it changed. */
	of(scope, source) {
		const key = source.join("\0");
		const held = this.perScope.get(scope);
		if (held !== void 0 && held.key === key) return held.set;
		const set = new Set(source);
		this.perScope.set(scope, {
			key,
			set
		});
		return set;
	}
};
/**
* One picker row. The three providers differ only in which field carries the
* image capability (`vision`, `isVl`), so callers normalize that first.
*/
function modelInfo$1(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.vision === true ? ["text", "image"] : ["text"]
	};
}
/**
* Resolve image references into base64 request bytes.
*
* Only references the host can actually read become pixels; the rest keep their
* handle text, so one unreadable attachment degrades that part of the prompt
* instead of failing the whole turn.
*
* @param refs - the occurrences to read, in block order.
* @param vision - whether the resolved model accepts images at all.
* @param readImage - the host's reader; absent when no attachment store exists.
* @param signal - the turn's abort signal.
*/
async function resolveImages(refs, vision, readImage, signal) {
	const map = /* @__PURE__ */ new Map();
	if (!vision || readImage === void 0 || refs.length === 0) return map;
	for (const ref of refs) {
		const key = String(ref.attachmentId);
		if (map.has(key)) continue;
		try {
			const image = await readImage(ref, signal);
			if (image !== void 0) map.set(key, {
				data: Buffer.from(image.bytes).toString("base64"),
				mediaType: image.mediaType
			});
		} catch {}
	}
	return map;
}
/**
* Images carried by the messages the inner session has not seen yet.
*
* Tool results are included: `read_image` hands its pixels back through the MCP
* tool result, not through the prompt text, so this tail is the only place the
* bytes can come from.
*/
async function resolveTurnImages(tail, vision, readImage, signal) {
	return await resolveImages(tail.flatMap((message) => message.role === "assistant" ? [] : imageRefs(message.content)), vision, readImage, signal);
}
/**
* Turn a feed into what one CLI turn receives, in a provider's block shape.
*
* A text-only feed stays a plain string (the historical shape). A feed with
* readable images becomes a block list, because that is the only shape the
* CLIs send to the model as pixels. An image the host could not read keeps its
* handle text, so it degrades one part instead of failing the turn.
*/
async function buildVisionFeed(feed, vision, options) {
	if (typeof feed === "string") return feed;
	if (!vision) return feedToText(feed, options.imagePath);
	const parts = resolvedFeedParts(feed, await resolveImages(feedImageRefs(feed), vision, options.readImage, options.signal));
	if (!parts.some((part) => part.type !== "text")) return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
	const content = [];
	for (const part of parts) {
		if (part.type === "text") {
			content.push(options.blocks.text(part.text));
			continue;
		}
		const path = options.imagePath?.(part.attachment);
		content.push(options.blocks.text(part.type === "image-unreadable" && path === void 0 ? `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]` : imageRefText(part.attachment, path)));
		if (part.type === "image-unreadable") continue;
		content.push(options.blocks.image(part.data, part.mediaType));
	}
	return content;
}
/**
* Default selectable reasoning efforts. The CLI catalog reports per-model
* `efforts`; this is the fallback when a model (or the static catalog)
* discloses none.
*/
const DEFAULT_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"max"
];
/** Human display name for the default effort ids. */
const EFFORT_NAMES = {
	low: "Low",
	medium: "Medium",
	high: "High",
	max: "Max"
};
/**
* Strength order used to pick a model's starting level.
*
* The providers spell their levels differently (Qoder publishes
* `low|medium|high|max`, CodeBuddy whatever its catalog declares), so the
* ranking is by name rather than by position in any one upstream list. An id
* outside this table ranks below every known one, which is what several sources
* agreeing on an unfamiliar spelling should do.
*/
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* The strongest level a model offers.
*
* Switching model or level must start at the most capable setting the route
* accepts, the same rule the sibling adapter plugin uses; the previous
* behaviour of following upstream's own default meant some models silently
* started one or two steps down (`CodeBuddy` advertises `high` as its default
* even when `max` is selectable).
*
* @param efforts - the levels the route accepts, in upstream order.
* @returns the strongest id, or undefined for a non-reasoning model.
*/
function strongestEffort(efforts) {
	if (efforts.length === 0) return void 0;
	let best;
	let bestRank = -1;
	for (const effort of efforts) {
		const rank = EFFORT_ORDER.indexOf(effort);
		if (best === void 0 || rank > bestRank) {
			best = effort;
			bestRank = rank;
		}
	}
	return best;
}
/**
* Build the `reasoning` metadata block for a resolved model, or undefined
* when the model does not support reasoning.
*
* The starting level is the strongest one the model accepts, not the level
* upstream happens to name as its default: the user's explicit choice in the
* sibling plugin, applied here too. An explicit configuration value still wins
* when the model accepts it.
*
* @param efforts - CLI-reported effort ids (absent for reasoning-less models).
* @param configuredEffort - user-configured starting level, when any.
* @param isReasoning - whether the model supports reasoning per the CLI.
* @returns the harness reasoning metadata, or undefined to omit it.
*/
function reasoningInfo(efforts, configuredEffort, isReasoning) {
	if (efforts === void 0 && isReasoning === false) return void 0;
	const ids = efforts !== void 0 && efforts.length > 0 ? efforts : DEFAULT_REASONING_EFFORTS;
	const defaultEffort = configuredEffort !== void 0 && ids.includes(configuredEffort) ? configuredEffort : strongestEffort(ids);
	return {
		efforts: ids.map((id) => ({
			id: ReasoningEffortId(id),
			name: EFFORT_NAMES[id] ?? id
		})),
		...defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }
	};
}
/**
* Decide what to feed on a continuation request. The previous list must be a
* prefix (same length growth, index 0 untouched, at most two in-place
* mutations — the host refreshes runtime-context snapshots in place every
* turn). Tail tool-result messages were already resolved into parked handlers
* and never feed; fresh user turns and mutated messages do.
*/
function planContinuation(previous, current) {
	if (current.length <= previous.length) return {
		feed: null,
		rebuild: true
	};
	const mutated = [];
	for (let i = 0; i < previous.length; i++) if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i);
	if (mutated.includes(0) || mutated.length > 2) return {
		feed: null,
		rebuild: true
	};
	const freshUser = current.slice(previous.length).filter((m) => m.role === "user");
	if (freshUser.length === 0 && mutated.length === 0) return {
		feed: null,
		rebuild: false
	};
	const parts = [];
	for (const index of mutated) {
		const message = current[index];
		if (message !== void 0) parts.push(renderRefreshed(message));
	}
	for (const message of freshUser) parts.push(renderUserTurn(message.content));
	const feed = joinFeeds(parts);
	return {
		feed: typeof feed === "string" && feed.length === 0 ? null : feed,
		rebuild: false
	};
}
//#endregion
//#region src/host/providers/qoder/usage.ts
/** How long one quota reading stays fresh by default. */
const DEFAULT_USAGE_CACHE_TTL_MS = 6e4;
/** Upper bound on one quota round trip. */
const DEFAULT_USAGE_TIMEOUT_MS = 2e4;
/** Cached quota reader for one brand. */
var QoderUsage = class {
	brand;
	ttlMs;
	timeoutMs;
	cached;
	inflight;
	/**
	* Bumped by {@link invalidate}. A fetch that started before a sign-in may
	* still resolve with the previous account's numbers, so it must neither be
	* shared with later readers nor written back to the cache.
	*/
	epoch = 0;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a reading stays fresh; read per use.
	* @param timeoutMs - how long one round trip may take.
	*/
	constructor(brand, ttlMs = DEFAULT_USAGE_CACHE_TTL_MS, timeoutMs = DEFAULT_USAGE_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* Read the quota, or serve the cached reading while it is still fresh.
	*
	* @param fresh - ignore the cache; the page's refresh button.
	* @returns the reading; `error` carries a failed lookup instead of throwing.
	*/
	async read(fresh = false) {
		if (resolveQoderCli(this.brand) === void 0) {
			this.cached = void 0;
			return this.missingCli();
		}
		const ttlMs = readLive(this.ttlMs, DEFAULT_USAGE_CACHE_TTL_MS);
		const epoch = this.epoch;
		if (!fresh && this.cached !== void 0 && Date.now() - this.cached.at < ttlMs) return this.cached;
		let entry = this.inflight;
		if (entry === void 0 || entry.epoch !== epoch) {
			const promise = this.fetch();
			entry = {
				epoch,
				promise
			};
			this.inflight = entry;
			const settled = entry;
			const clear = () => {
				if (this.inflight === settled) this.inflight = void 0;
			};
			promise.then(clear, clear);
		}
		const snapshot = await entry.promise;
		if (epoch === this.epoch) this.cached = snapshot;
		return snapshot;
	}
	/** Drop the cached reading, including any fetch that started before now. */
	invalidate() {
		this.cached = void 0;
		this.epoch += 1;
		this.inflight = void 0;
	}
	/** The reading for a machine whose CLI is not installed. */
	missingCli() {
		const command = brandProfile(this.brand).cliCommands[0];
		return {
			at: Date.now(),
			cliMissing: true,
			error: `未检测到可用的 ${command}，请先安装并登录后再使用此版本。`
		};
	}
	async fetch() {
		const at = Date.now();
		try {
			if (foreignCliOverride(this.brand) !== void 0) return {
				at,
				cliMissing: true,
				error: cliConflictMessage(this.brand)
			};
			return await withSdk(this.brand, (sdk) => this.readSnapshot(sdk, at));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const command = brandProfile(this.brand).cliCommands[0];
			return {
				at,
				error: /ENOENT|not found|Cannot find package|未安装国际版 SDK/i.test(detail) ? `未检测到可用的 ${command}，请先安装并登录后再读取额度。` : cliFailureText(detail, this.brand)
			};
		}
	}
	async readSnapshot(sdk, at) {
		const timeoutMs = readLive(this.timeoutMs, DEFAULT_USAGE_TIMEOUT_MS);
		const q = sdk.query({
			prompt: inertInput(),
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				settingSources: [],
				maxTurns: 1
			}
		});
		try {
			const usage = await withTimeout(q.getUsageInfo(), timeoutMs, "qoder request");
			const account = await withTimeout(q.accountInfo(), timeoutMs, "qoder request").catch(() => void 0);
			return {
				at,
				...usage === null || usage === void 0 ? { error: "CLI 未返回额度信息" } : { usage },
				...account === void 0 ? {} : { account }
			};
		} finally {
			await q.close().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/host/providers/qoder/adapter.ts
/**
* `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
* through the qoder-agent-sdk. One warm inner session per host session id
* carries the conversation (model turns and tool rounds live inside it); host
* tool schemas are exposed to the inner model through an in-process MCP
* server whose handlers park until the host delivers tool results on the next
* request. Side-channel requests (titles, compaction) run cold one-shots.
* @module dsh-llm-qoder/adapter
*/
/** Shared empty values, so an unset list or map allocates nothing per read. */
const NO_MODELS = [];
const NO_WINDOWS = {};
const NO_ALIASES = {};
/** The primary provider route (the CN account's own models). */
const QODER_PROVIDER = "qoder-cn";
/** The international edition's route; a second adapter instance serves it. */
const QODER_INTL_PROVIDER = "qoder-intl";
/**
* Decide the context window to report for one live model.
*
* A per-model override wins when the user chose one; otherwise upstream's own
* `defaultContextWindow` is used, which is the window that model's session
* actually runs with. `maxInputTokens` is NOT a substitute — it is the ceiling
* for a single request and is often lower than the session window (e.g. 180 000
* against a 200 000 session), so falling back to it would understate capacity.
* Callers that accept a user override should validate it against
* `availableContextWindows` first — see {@link resolveDeclaredWindow}.
*
* @param live - the live catalog entry, when the CLI answered.
* @param override - the user's chosen window for this model, if any.
* @param fallback - window used when the catalog has nothing for this model.
* @returns the window in tokens.
*/
function pickContextWindow(live, override, fallback) {
	if (override !== void 0 && Number.isFinite(override) && override > 0) return override;
	if (live === void 0) return fallback;
	return live.defaultContextWindow ?? largestWindow(live.availableContextWindows) ?? live.maxInputTokens ?? fallback;
}
/** The largest window in a catalog entry's selectable list, or undefined. */
function largestWindow(available) {
	if (available === void 0 || available.length === 0) return void 0;
	return Math.max(...available);
}
/**
* The window the CLI will actually run this route with.
*
* Not the same thing as the window the harness is told about. A deployment may
* declare any window it likes — `modelContextWindows` accepts arbitrary numbers
* — but the CLI only honours one the model advertises in
* `availableContextWindows`; anything else it silently ignores and keeps its own
* default. Since the CLI measures `context_usage_ratio` against the window it is
* really using, this is the only correct multiplier for that ratio: using the
* declared window instead inflates every reading by
* `declared / actually-honoured` (5x for a 1M override on a 200K-only model).
*
* @param live - the live catalog entry, when the CLI answered.
* @param declared - the window this route publishes to the harness.
* @returns the window the CLI runs with, or undefined when unknown.
*/
function cliContextWindow(live, declared) {
	if (live === void 0) return void 0;
	const available = live.availableContextWindows;
	if (available !== void 0 && available.includes(declared)) return declared;
	return live.defaultContextWindow ?? largestWindow(available) ?? live.maxInputTokens;
}
/**
* The window to publish for one route, which is also the one the CLI is told
* to run with.
*
* A live entry is authoritative: the user's override counts only when the
* model advertises it. The CLI silently ignores anything else (a 1M choice on
* a 200K-only route), and dividing by it would understate every reading
* fivefold. When the catalog is momentarily unavailable, the last successful
* answer is reused instead of the static 200K default — that fallback used to
* change the denominator, and the compaction budget, mid-session: a 1M
* conversation read 1M one turn and 200K the next, and then compacted at what
* looked like 10%.
*/
function resolveDeclaredWindow(live, override, remembered, fallback) {
	if (live === void 0) return remembered ?? override ?? fallback;
	const available = live.availableContextWindows;
	return pickContextWindow(live, override !== void 0 && (available === void 0 || available.length === 0 || available.includes(override)) ? override : void 0, remembered ?? fallback);
}
function modelInfo(provider, entry) {
	return {
		provider,
		id: entry.id,
		name: entry.name,
		...entry.description === void 0 ? {} : { description: entry.description },
		inputModalities: entry.isVl === true ? ["text", "image"] : ["text"]
	};
}
/**
* The Qoder-backed adapter. Session continuity, tool parking, and feed
* planning live here; chunk synthesis lives in the session's consumer.
*/
var QoderAdapter = class extends LlmAdapter {
	/**
	* The options as given, read where they are used rather than copied here.
	*
	* A `.volatile()` field is a live cell DSH updates in place, and such an edit
	* does not restart the plugin, so a value captured in the constructor would
	* stay frozen for the lifetime of the process (see `src/live.ts`).
	*/
	options;
	sessions;
	catalog;
	usage;
	readImage;
	imagePath;
	brand;
	/**
	* Memoized `Set` view of the disabled-model list.
	*
	* `updateVolatile` stores the freshly parsed array, so identity changes only
	* when the value does: caching on that identity keeps the per-model lookup a
	* hash probe instead of rebuilding a set per call, with no staleness.
	*/
	disabledCache;
	/**
	* The last window each route resolved to, plus what the model advertised.
	*
	* Reused only when a live entry is missing. Without it a failed refresh fell
	* back to the static 200K, so a 1M session suddenly declared 200K: the ring
	* denominator changed and the compaction engine budgeted against 200K,
	* compacting a history that was still only ~10% of the real window.
	*/
	knownWindows = /* @__PURE__ */ new Map();
	/**
	* Last verified image capability per route.
	*
	* A missed catalog refresh used to fall back to text-only, and DSH then
	* stripped the pixels before this adapter ran: a vision model silently lost
	* the image for that turn. Remembering the last answer keeps the declared
	* capability stable across a transient miss.
	*/
	knownVision = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		super();
		this.options = options;
		this.brand = options.brand ?? "cn";
		this.sessions = new QoderSessionManager(options.maxSessions ?? 8, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs,
			drainMs: options.drainMs,
			coldMaxTurns: options.coldMaxTurns,
			brand: this.brand
		});
		this.catalog = new QoderModelCatalog(this.brand, options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 2e4);
		this.usage = new QoderUsage(this.brand, options.usageCacheTtlMs);
		this.readImage = options.readImage;
		this.imagePath = options.imagePath;
	}
	get defaultMaxTokens() {
		return readLive(this.options.defaultMaxTokens, DEFAULT_MAX_TOKENS);
	}
	get modelContextWindows() {
		return readLive(this.options.modelContextWindows, NO_WINDOWS);
	}
	get disabledModels() {
		const source = readLive(this.options.disabledModels, NO_MODELS);
		const cached = this.disabledCache;
		if (cached !== void 0 && cached.source === source) return cached.set;
		const set = new Set(source);
		this.disabledCache = {
			source,
			set
		};
		return set;
	}
	get modelAliases() {
		return readLive(this.options.modelAliases, NO_ALIASES);
	}
	get defaultReasoningEffort() {
		return readLiveOptional(this.options.defaultReasoningEffort);
	}
	get displayName() {
		return readLive(this.options.displayName, brandProfile(this.brand).defaultDisplayName);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/**
	* Whether one catalog entry is enabled for the picker.
	*
	* Only the user's off-switch is consulted: a model the account adds later
	* appears enabled by default, which a stored allow-list could not do.
	*/
	isVisible(id) {
		return !this.disabledModels.has(id);
	}
	/**
	* The user's chosen window for one catalog id, honouring aliases.
	*
	* A window may be stored under either the Qoder id or a harness-side alias,
	* so both spellings are checked before giving up.
	*/
	windowOverride(id) {
		const direct = this.modelContextWindows[id];
		if (direct !== void 0) return direct;
		for (const [key, value] of Object.entries(this.modelContextWindows)) if (resolveQoderModelId(key, this.modelAliases) === id) return value;
	}
	/**
	* The live catalog as the page renders it.
	*
	* Unlike {@link listModels}, this is not filtered by the user's on/off
	* choices: the page must show a switched-off model in order to switch it
	* back on.
	*
	* @returns live catalog entries in upstream order.
	*/
	async describeCatalog() {
		const live = await this.catalog.liveModels();
		for (const entry of live) {
			this.declaredWindow(entry.value, entry);
			this.knownVision.set(entry.value, entry.isVl === true);
		}
		return live;
	}
	/** Forget the cached catalog; the next read asks the CLI again. */
	invalidateCatalog() {
		this.catalog.invalidate();
	}
	/** Why the last catalog refresh failed, for the settings page's guidance. */
	catalogError() {
		return this.catalog.error;
	}
	/**
	* Read the account's quota and usage, as the Qoder clients display it.
	*
	* @param fresh - ignore the cached reading.
	*/
	async usageInfo(fresh = false) {
		return this.usage.read(fresh);
	}
	/** Forget the cached quota reading; the next read asks the CLI again. */
	invalidateUsage() {
		this.usage.invalidate();
	}
	/**
	* Forget everything that was read under the account that just left.
	*
	* Signing in or out replaces the credentials on disk, but the SDK daemon and
	* every warm session loaded the old ones when they started, and the catalog
	* and quota caches describe that same old account. Signing out has to drop
	* the sessions; signing in has to drop all four, or the page keeps showing
	* the previous account until the process restarts.
	*
	* The pool stays usable: this is a credential change, not a teardown.
	*/
	resetAccount() {
		this.catalog.invalidate();
		this.usage.invalidate();
		this.sessions.closeAll("account");
		discardSdk(this.brand);
	}
	/** Whether the user switched one model off. */
	isModelDisabled(id) {
		return this.disabledModels.has(id);
	}
	/** The stored disabled-model set, as a list for rewriting the field. */
	disabledModelIds() {
		return [...this.disabledModels];
	}
	/**
	* The user's window for one model, when the provider accepts it.
	*
	* A stored choice the model does not advertise is not a real choice: the CLI
	* ignores it and keeps its own window, so publishing it would only make the
	* meter divide by a capacity the route never runs with. Until the catalog
	* has answered once the choice is trusted (there is nothing to check yet).
	*/
	contextWindowFor(id) {
		const override = this.windowOverride(id);
		if (override === void 0) return void 0;
		const target = resolveQoderModelId(id, this.modelAliases);
		const available = this.knownWindows.get(target)?.available;
		if (available === void 0 || available.length === 0) return override;
		return available.includes(override) ? override : void 0;
	}
	/** The window this route publishes, remembering it for catalog misses. */
	declaredWindow(id, live) {
		const window = resolveDeclaredWindow(live, this.windowOverride(id), this.knownWindows.get(id)?.window, DEFAULT_CONTEXT_WINDOW);
		if (live !== void 0) this.knownWindows.set(id, {
			window,
			available: live.availableContextWindows
		});
		return window;
	}
	/** The stored per-model window map, for rewriting the field. */
	modelWindowChoices() {
		return this.modelContextWindows;
	}
	async listModels(provider) {
		return (await this.catalog.models()).filter((entry) => this.isVisible(entry.id)).map((entry) => modelInfo(provider, entry));
	}
	async resolveModel(provider, model, _signal) {
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.liveModels())).find((entry) => entry.value === target);
		if (live !== void 0) {
			const vision = live.isVl === true;
			this.knownVision.set(target, vision);
			const reasoning = reasoningInfo(live.efforts, this.defaultReasoningEffort, live.isReasoning);
			return {
				provider,
				id: model,
				name: live.displayName.length > 0 ? live.displayName : live.value,
				...live.description.length > 0 ? { description: live.description } : {},
				inputModalities: vision ? ["text", "image"] : ["text"],
				context: { contextWindow: this.declaredWindow(target, live) },
				defaultMaxTokens: live.maxOutputTokens ?? this.defaultMaxTokens,
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const configured = brandProfile(this.brand).staticCatalog ? QODER_MODELS.find((entry) => entry.id === target) : void 0;
		const reasoning = reasoningInfo(void 0, this.defaultReasoningEffort, true);
		const rememberedVision = this.knownVision.get(target) === true;
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model
			} : {
				...modelInfo(provider, configured),
				id: model
			},
			inputModalities: rememberedVision ? ["text", "image"] : ["text"],
			context: { contextWindow: this.declaredWindow(target, void 0) },
			defaultMaxTokens: this.defaultMaxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	/**
	* Bind one resolution generation to its dispatch, as the seam requires of a
	* dynamic adapter: the live catalog and the CLI login can change between the
	* harness preparing a call and the inner session running it, and a turn must
	* not mix one generation's declared capabilities with another's endpoint.
	*/
	async prepareCall(provider, model, signal) {
		const generation = await this.capture(provider, model, signal);
		return {
			model: generation.info,
			stream: (options) => this.dispatch(options, generation)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options, await this.capture(options.provider, options.model, options.signal));
	}
	/** Resolve the exact route once and derive the capability facts from it. */
	async capture(provider, model, signal) {
		const info = await this.resolveModel(provider, model, signal);
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.liveModels())).find((entry) => entry.value === target);
		const declared = info.context?.contextWindow;
		return {
			info,
			vision: info.inputModalities?.includes("image") === true,
			cliContextWindow: declared === void 0 ? void 0 : cliContextWindow(live, declared)
		};
	}
	async *dispatch(options, generation) {
		const model = resolveQoderModelId(options.model, this.modelAliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderSideChannelFeed(options.system, options.messages, this.imagePath), this.imagePath);
			yield* this.sessions.coldStream(options, prompt, model);
			return;
		}
		const sessionId = String(options.sessionId);
		const declaredWindow = generation.info.context?.contextWindow;
		const policy = {
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...declaredWindow === void 0 ? {} : { contextWindow: declaredWindow },
			...generation.cliContextWindow === void 0 ? {} : { cliContextWindow: generation.cliContextWindow }
		};
		let session = this.sessions.forSession(sessionId, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		const images = await this.resolveTurnImages(tail, generation.vision, options.signal);
		session.deliverToolResults(tail, images);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, model);
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		session.setModel(model, policy);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, generation.vision, images);
		yield* session.stream(options, feed, plan.feed === null ? void 0 : feedToText(plan.feed, this.imagePath));
	}
	async *firstTurn(session, options, model, policy, vision) {
		session.setModel(model, policy);
		session.setSystem(options.system);
		const cwd = options.cwd;
		session.setCwd(cwd);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = renderInitialFeed(options.system, options.messages, this.imagePath);
		const images = await resolveImages(feedImageRefs(feed), vision, this.readImage, options.signal);
		yield* session.stream(options, await this.buildFeed(feed, vision, images), feedToText(feed, this.imagePath));
	}
	/** Image references carried by a message tail, skipping assistant content. */
	async resolveTurnImages(tail, vision, signal) {
		return await resolveTurnImages(tail, vision, this.readImage, signal);
	}
	/**
	* Turn a feed into channel content. A text feed passes through; a non-vision
	* feed flattens to the harness's own image handle text; an image the host
	* could not read keeps a note naming what was dropped, so the inner model
	* still knows the attachment was there.
	*/
	async buildFeed(feed, vision, images) {
		if (typeof feed === "string") return feed;
		if (!vision) return feedToText(feed, this.imagePath);
		const content = [];
		let pixels = 0;
		for (const part of feed) {
			if (part.type === "text") {
				if (part.text.length > 0) content.push({
					type: "text",
					text: part.text
				});
				continue;
			}
			const key = String(part.attachment.attachmentId);
			const resolved = images.get(key);
			const path = this.imagePath?.(part.attachment);
			if (resolved === void 0) {
				content.push({
					type: "text",
					text: `[图片附件 ${key} 本次未能读取${path === void 0 ? "" : `；本机文件：${path}`}，请基于文字内容继续]`
				});
				continue;
			}
			content.push({
				type: "text",
				text: imageRefText(part.attachment, path)
			});
			pixels += 1;
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: resolved.mediaType,
					data: resolved.data
				}
			});
		}
		return pixels === 0 ? content.map((block) => block.type === "text" ? block.text : "").join("\n\n") : content;
	}
	/**
	* Drop every warm inner session without unloading the plugin.
	*
	* Signing out has to invalidate them: each holds a CLI process that already
	* loaded its credentials, so it would keep answering as the account that was
	* just signed out. The next turn starts a fresh process, which then reports
	* the signed-out state honestly.
	*/
	closeSessions() {
		this.sessions.closeAll("account");
	}
	/**
	* Tear down every warm inner session (plugin dispose).
	*
	* Sealed rather than merely cleared: a step prepared before the unload can
	* still be retried through this adapter instance, and a fresh session created
	* here would outlive every owner it has.
	*/
	close() {
		this.sessions.seal("dispose");
	}
};
//#endregion
//#region src/host/infra/codebuddy-state.ts
/**
* CodeBuddy's own per-region snapshot on disk.
*
* The SDK's browser login returns a bearer token, but it is only available in
* the process that ran the login. Saving it here is what lets a later process
* switch back to a region and use the account immediately instead of opening
* the browser again. The account and quota reading are saved alongside it so
* the settings card can paint before a fresh CLI read finishes.
*
* The file is per-user, mode 0600, and contains a bearer credential: do not log
* it or copy it into bug reports.
*
* @module dsh-agent-sdk-bridge/codebuddy-state
*/
/**
* A stored account reading with its credential removed.
*
* The CLI's `accountInfo()` answer carries a bearer token, and older versions
* persisted that object whole — a second copy of the credential in a file that
* gets backed up and pasted into bug reports, one the plugin never read. A
* region holds exactly one credential, in `token`.
*/
function withoutCredential(account) {
	if (account === void 0) return void 0;
	const clean = {};
	for (const [key, value] of Object.entries(account)) {
		if (/token|secret|credential|password|cookie/i.test(key)) continue;
		clean[key] = value;
	}
	return clean;
}
/**
* The default file path.
*
* `DSH_HOME` is honoured so a desktop profile and a web profile keep separate
* credentials; `DSH_CODUBUDDY_STATE_PATH` exists for tests and power users.
*/
function defaultPath() {
	const override = process.env.DSH_CODUBUDDY_STATE_PATH;
	if (override !== void 0 && override.length > 0) return override;
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "agent-sdk-bridge", "codebuddy-state.json");
}
/**
* One CLI user-data directory per login region.
*
* The bundled CLI remembers its product environment inside this directory and
* only switches it during initialize, after the model provider has already
* chosen a catalog. Two regions sharing the default `~/.codebuddy` therefore
* read each other's catalogs after a switch, and the wrong list got cached for
* five minutes. A separate directory fixes the environment per region, so every
* boot reads its own catalog. `DSH_CODUBUDDY_CLI_DIR` exists for tests.
*/
function codeBuddyCliDir(region) {
	const override = process.env.DSH_CODUBUDDY_CLI_DIR;
	const root = override !== void 0 && override.length > 0 ? override : join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "agent-sdk-bridge", "codebuddy-cli");
	const dir = join(root, region);
	mkdirSync(dir, { recursive: true });
	return dir;
}
/** The per-user file behind {@link CodeBuddyStateStore}. */
var CodeBuddyStateStore = class {
	file;
	loaded = false;
	state = {
		version: 1,
		regions: {}
	};
	constructor(file = defaultPath()) {
		this.file = file;
	}
	ensureLoaded() {
		if (this.loaded) return this.state;
		this.loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			if (parsed.version === 1 && parsed.regions !== null && typeof parsed.regions === "object") {
				this.state = {
					version: 1,
					regions: parsed.regions
				};
				this.recoverLostTokens();
			}
		} catch {}
		return this.state;
	}
	/**
	* Lift a credential the old layout hid inside the account object.
	*
	* The CLI's `accountInfo()` answer carries a bearer token of its own, and an
	* earlier version persisted that whole object here. When the top-level
	* `token` was later dropped — which any quota failure used to do, because
	* expiry was *guessed* from the error text — the region read as signed out
	* even though a working credential still sat in the file, and nothing could
	* recover it without a fresh browser login. This picks the copy back up.
	*
	* {@link persist} no longer stores a token inside the account, so this runs
	* only over files written by those older versions.
	*/
	recoverLostTokens() {
		let recovered = false;
		for (const [key, saved] of Object.entries(this.state.regions)) {
			const region = key;
			const hidden = (saved?.account)?.token;
			if (saved === void 0 || saved.token !== void 0) continue;
			if (typeof hidden !== "string" || hidden.length === 0) continue;
			this.state.regions[region] = {
				...saved,
				token: hidden,
				signedIn: true,
				account: withoutCredential(saved.account)
			};
			recovered = true;
		}
		if (recovered) this.persist();
	}
	region(region) {
		return this.ensureLoaded().regions[region];
	}
	/** The stored bearer token, or undefined when the region is signed out. */
	token(region) {
		const token = this.region(region)?.token;
		return typeof token === "string" && token.length > 0 ? token : void 0;
	}
	user(region) {
		return this.region(region)?.user;
	}
	signedIn(region) {
		return this.region(region)?.signedIn === true;
	}
	/** The saved account reading, in the shape the usage route returns. */
	usage(region) {
		const saved = this.region(region);
		if (saved === void 0 || saved.at === void 0 || saved.signedIn !== true) return void 0;
		return {
			at: saved.at,
			...saved.account === void 0 ? {} : { account: saved.account },
			...saved.quota === void 0 ? {} : { quota: saved.quota },
			...saved.quotaError === void 0 ? {} : { quotaError: saved.quotaError }
		};
	}
	/** Merge fields into one region and write the file; `undefined` deletes. */
	patch(region, patch) {
		const state = this.ensureLoaded();
		const next = { ...state.regions[region] };
		for (const [key, value] of Object.entries(patch)) if (value === void 0) delete next[key];
		else next[key] = value;
		if (next.account !== void 0) next.account = withoutCredential(next.account);
		state.regions[region] = next;
		this.persist();
	}
	/**
	* Drop only the credential, keeping the last account reading.
	*
	* An expired token must stop being used for sessions, while the card can
	* still show which account expired so the user knows what to sign into.
	*/
	clearToken(region) {
		const saved = this.ensureLoaded().regions[region];
		if (saved === void 0) return;
		delete saved.token;
		saved.signedIn = false;
		this.persist();
	}
	/** Forget one region entirely: logout and expired credentials both land here. */
	clear(region) {
		const state = this.ensureLoaded();
		delete state.regions[region];
		this.persist();
	}
	persist() {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 384 });
			try {
				chmodSync(temporary, 384);
			} catch {}
			renameSync(temporary, this.file);
		} catch {}
	}
};
//#endregion
//#region src/host/providers/codebuddy/session.ts
/**
* CodeBuddy's account, catalog, login and warm sessions.
*
* The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
* own CLI, so unlike the Qoder brands there is no global install and no batch
* helper: login is an SDK call whose region is `external` (international) or
* `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
*
* One CodeBuddy provider serves both regions; the region is a setting, so the
* models and account shown always belong to the selected login.
*
* @module dsh-agent-sdk-bridge/codebuddy
*/
/**
* Literal characters in a channel payload; images contribute pixels, not text.
*
* The per-turn input estimate charges text only, matching how the Qoder path
* counts a feed, so a picture cannot inflate the reported prompt size.
*/
function contentChars(content) {
	return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/**
* Wrap one turn's content the way the SDK's `send()` expects it.
*
* A plain string keeps the historical shape; image turns are wrapped in a
* `UserMessage`, because a bare `ContentBlock[]` is not accepted and dropping
* the wrapper silently loses the picture.
*/
function toCodeBuddyUserMessage(sessionId, content) {
	if (typeof content === "string") return content;
	return {
		type: "user",
		session_id: sessionId,
		message: {
			role: "user",
			content
		},
		parent_tool_use_id: null
	};
}
/** Default context capacity assumed for a CodeBuddy model that declares none. */
const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default output cap when the catalog declares none. */
const CODEBUDDY_DEFAULT_MAX_TOKENS = 32e3;
/** How long one CodeBuddy account/catalog read stays fresh. */
const CODEBUDDY_CACHE_TTL_MS = 3e5;
/** Give up on one CodeBuddy control round trip after this long. */
const CODEBUDDY_FETCH_TIMEOUT_MS = 3e4;
/** How long a login waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 3e5;
/** Bound for clearing stale credentials before a fresh browser login. */
const LOGOUT_TIMEOUT_MS = 2e4;
/**
* How long an unused control session keeps its CLI process.
*
* The process is what makes a catalog read cheap, but an idle one is memory.
* Ten minutes covers a settings visit, a region switch back and the refresh
* after a login, and still gives the memory back on its own.
*/
const CONTROL_IDLE_MS = 6e5;
/**
* The key this plugin's MCP server is registered under, in the CodeBuddy CLI.
*
* It is the CLI's own normalised spelling - `dsh_host`, not `dsh-host` - and
* that choice is the fix for the recurring "tool went missing": the CLI builds
* its call-time tool map from `mcp__<key>__<tool>` with the key verbatim,
* while several of its own code paths (`parseMcpToolName`, the plugin tool
* namer, the wire-format normaliser) rewrite every non-alphanumeric character
* to `_`. With a hyphenated key the list showed `mcp__dsh-host__read_files`
* while a model that emitted the normalised `mcp__dsh_host__read_files` - as
* one did, verbatim, in a failed session - found no entry, and the CLI refused
* the call with `Tool "..." does not exist in the current tool set.` before it
* ever reached this server. Registering under the normalised spelling makes
* list, lookup and normalisation one and the same name, so there is no second
* spelling to guess.
*/
const CODEBUDDY_MCP_SERVER_KEY = "dsh_host";
/**
* Whether a CLI tool name belongs to this plugin's MCP server.
*
* Both spellings count: the key above is the normalised one this plugin now
* registers, while a name already in flight can still carry the hyphenated
* form the server used to be keyed under. See {@link mcpToolPrefixes}.
*/
function isHostTool(toolName) {
	return isHostToolName(toolName, MCP_SERVER_NAME);
}
/**
* The host-side tool name, with every MCP namespace layer removed.
*
* CodeBuddy qualifies an already-qualified name again, so the handler can be
* handed `mcp__dsh_host__mcp__dsh_host__edit`. Stripping one layer produced
* `mcp__dsh_host__edit`, a name the host does not have (its tool is `edit`), and
* DSH answered `unknown tool "mcp__dsh_host__edit"`; the model retried the
* doubled spelling next round and the CLI rejected it with `does not exist in
* the current tool set`. See {@link stripMcpNamespace}.
*/
function hostToolName(toolName) {
	return bareHostToolName(toolName, MCP_SERVER_NAME);
}
/**
* Whether the CLI answered as the anonymous fallback.
*
* With an invalid `CODEBUDDY_AUTH_TOKEN` the CLI still reports an account
* object whose uid is `anonymous`; treating that as a login would show a
* signed-in card and try the quota endpoint with a dead credential.
*/
function isUnauthenticatedAccount(account) {
	return Object.keys(account).length === 0 || (account.uid ?? account.userId) === "anonymous";
}
/** The public billing hosts; both regions speak the same quota protocol. */
const CODEBUDDY_ENDPOINTS = {
	global: "https://www.codebuddy.ai",
	cn: "https://copilot.tencent.com"
};
const QUOTA_PATH = "/v2/billing/meter/get-user-resource";
const QUOTA_RANGE_END = "2099-12-31 23:59:59";
/** Cosmetic fingerprint headers the upstream checks; kept in step with the CLI. */
const CLIENT_VERSION = "2.174.0";
/** Tokens obtained from a successful login or a silent auth read, per region. */
const bearerTokens = /* @__PURE__ */ new Map();
/** Persisted per-region login and account snapshots. */
const codeBuddyState = new CodeBuddyStateStore();
/** The region's bearer token, falling back to the persisted copy. */
function tokenFor(region) {
	const cached = bearerTokens.get(region);
	if (cached !== void 0) return cached;
	const saved = codeBuddyState.token(region);
	if (saved !== void 0) bearerTokens.set(region, saved);
	return saved;
}
/**
* The child-process environment for one region's CLI.
*
* Two things ride here:
*
* - `CODEBUDDY_AUTH_TOKEN`, so a saved login works without another browser
*   round trip.
* - `CODEBUDDY_CONFIG_DIR`, a directory of this region's own. The CLI stores
*   its product environment inside that directory and only switches it during
*   initialize, while its model provider has already chosen a catalog. With a
*   shared directory, switching regions read the other region's catalog and
*   cached it, which made the model list — and the enabled/disabled choices
*   derived from it — belong to the wrong region. One directory per region
*   pins the environment, so a fresh process always reads the right catalog.
*/
function cliEnv(region) {
	const env = cliDirEnv(region);
	const token = tokenFor(region);
	if (token !== void 0) env.CODEBUDDY_AUTH_TOKEN = token;
	return { env };
}
/**
* The region's own CLI directory, with no credential attached.
*
* The login, logout and silent-token calls need this and nothing else: they
* must not carry a bearer token (login starts fresh, logout clears), but they
* absolutely must be scoped to one region. Without it they acted on the CLI's
* default `~/.codebuddy`, which both regions share — so signing in for one
* region overwrote the other's login, and `logout` for the region the page was
* showing left the credential of the other one standing.
*/
function cliDirEnv(region) {
	return { CODEBUDDY_CONFIG_DIR: codeBuddyCliDir(region) };
}
/** Remember a bearer token in memory and on disk. */
function rememberBearerToken(region, token, user) {
	if (token.length === 0) return;
	bearerTokens.set(region, token);
	codeBuddyState.patch(region, {
		token,
		signedIn: true,
		...user === void 0 ? {} : { user }
	});
}
/** Stop using a credential without losing the remembered account card. */
function forgetToken(region) {
	bearerTokens.delete(region);
	codeBuddyState.clearToken(region);
}
/** Parse the catalog's `x0.79 credits` string into a number. */
function priceFactorOf$1(model) {
	const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(model.credits ?? "");
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : void 0;
}
/** Turn one raw catalog entry into the model row this plugin uses. */
function toCodeBuddyModel(model) {
	const windows = new Set(model.contextWindow?.supportedLengths ?? []);
	const declared = model.contextWindow?.defaultLength ?? model.maxInputTokens ?? model.maxAllowedSize ?? 2e5;
	return {
		id: model.id,
		name: model.name ?? model.id,
		...(model.description ?? model.descriptionZh ?? model.descriptionEn) === void 0 ? {} : { description: model.description ?? model.descriptionZh ?? model.descriptionEn },
		...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
		...model.maxOutputTokens === void 0 ? {} : { maxOutputTokens: model.maxOutputTokens },
		contextWindows: [...windows].sort((a, b) => a - b),
		defaultContextWindow: declared,
		vision: model.supportsImages === true && model.disabledMultimodal !== true,
		...model.reasoning?.supportedEfforts === void 0 ? model.supportsReasoning === true ? { reasoningEfforts: [
			"low",
			"medium",
			"high"
		] } : {} : { reasoningEfforts: [...model.reasoning.supportedEfforts] },
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort },
		...priceFactorOf$1(model) === void 0 ? {} : { priceFactor: priceFactorOf$1(model) }
	};
}
/**
* Boot one turn-less session for a region, connected and ready to answer.
*
* `getAvailableModelsRaw()` is a control request, but the SDK gives CodeBuddy
* no daemon: every `createSession` is a fresh child process that loads a 24 MB
* bundle before it answers. {@link CodeBuddyCatalog} keeps the result warm
* instead of paying that boot per read. A session that fails to connect is
* closed here, so no caller has to clean up a half-started process.
*/
async function openControlSession(region, timeoutMs) {
	const session = (await loadCodeBuddySdk()).unstable_v2_createSession({
		environment: codeBuddyEnvironment(region),
		sessionId: randomUUID(),
		...cliEnv(region),
		settingSources: [],
		persistSession: false
	});
	try {
		await withTimeout(session.connect(), timeoutMs, "CodeBuddy request");
		return session;
	} catch (error) {
		session.close();
		throw error;
	}
}
/**
* The account's model catalog for one region.
*
* CodeBuddy only answers this after the CLI has started, so the read costs one
* process boot. Results are cached per region and fall back to the last good
* list when a refresh fails.
*
* That boot is paid once per region rather than once per refresh: a warm
* *control* session answers every later read. It never sends a turn, so it
* holds no conversation, and it is deliberately kept out of
* `CodeBuddySessionManager` — it is not one of the host's conversations and
* must never consume a `maxSessions` slot.
*/
var CodeBuddyCatalog = class {
	region;
	ttlMs;
	timeoutMs;
	controlIdleMs;
	snapshots = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	/** Warm control sessions, one per region, released when they go idle. */
	controls = /* @__PURE__ */ new Map();
	constructor(region, ttlMs = CODEBUDDY_CACHE_TTL_MS, timeoutMs = CODEBUDDY_FETCH_TIMEOUT_MS, controlIdleMs = CONTROL_IDLE_MS) {
		this.region = region;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
		this.controlIdleMs = controlIdleMs;
	}
	/**
	* The last catalog read for a region, without fetching.
	*
	* Callers that must answer synchronously (deciding whether a model exposes a
	* context-budget choice) use this instead of awaiting a refresh.
	*/
	snapshot(requested) {
		return this.snapshots.get(requested ?? readLive(this.region, "global"))?.models;
	}
	/** Models for one region; a failed refresh keeps the last good list. */
	async models(requested) {
		const region = requested ?? readLive(this.region, "global");
		const ttl = readLive(this.ttlMs, CODEBUDDY_CACHE_TTL_MS);
		const cached = this.snapshots.get(region);
		if (cached !== void 0 && Date.now() - cached.at < ttl) return cached.models;
		let pending = this.inflight.get(region);
		if (pending === void 0) {
			pending = this.fetch(region).finally(() => {
				this.inflight.delete(region);
			});
			this.inflight.set(region, pending);
		}
		try {
			const models = await pending;
			this.snapshots.set(region, {
				at: Date.now(),
				models
			});
			this.failures.delete(region);
			return models;
		} catch (error) {
			this.failures.set(region, error instanceof Error ? error.message : String(error));
			return cached?.models ?? [];
		}
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	error(requested) {
		return this.failures.get(requested ?? readLive(this.region, "global"));
	}
	invalidate(region) {
		if (region === void 0) {
			this.snapshots.clear();
			this.failures.clear();
			return;
		}
		this.snapshots.delete(region);
		this.failures.delete(region);
	}
	/**
	* Models from the region's warm control session, booting it when needed.
	*
	* A failure discards the session: the CLI may have exited on its own, and a
	* process that cannot answer one control request must not answer the next.
	* The retry is simply the next read, which starts a fresh one.
	*/
	async fetch(region) {
		const timeout = readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS);
		const session = await this.controlSession(region, timeout);
		try {
			return (await withTimeout(session.getAvailableModelsRaw(), timeout, "CodeBuddy request")).map(toCodeBuddyModel);
		} catch (error) {
			this.discardControl(region);
			throw error;
		} finally {
			this.armControl(region);
		}
	}
	/** The region's control session, booted on first use. */
	async controlSession(region, timeoutMs) {
		const existing = this.controls.get(region);
		if (existing !== void 0) return existing.session;
		const session = await openControlSession(region, timeoutMs);
		this.controls.set(region, {
			session,
			timer: void 0
		});
		return session;
	}
	/** Release the process once the region has gone a whole idle window unused. */
	armControl(region) {
		const entry = this.controls.get(region);
		if (entry === void 0) return;
		if (entry.timer !== void 0) clearTimeout(entry.timer);
		const idle = readLive(this.controlIdleMs, CONTROL_IDLE_MS);
		if (!(idle > 0)) {
			entry.timer = void 0;
			return;
		}
		const timer = setTimeout(() => {
			this.discardControl(region);
		}, idle);
		unrefTimer(timer);
		entry.timer = timer;
	}
	/**
	* Drop the warm control session(s), so the next read boots a new process.
	*
	* Login, logout and a region switch all change what that process would
	* answer — it was started with one account's credential and one region's
	* directory — so callers must discard rather than reuse. Idle release and a
	* failed read arrive here too.
	*/
	discardControl(region) {
		for (const each of region === void 0 ? [...this.controls.keys()] : [region]) {
			const entry = this.controls.get(each);
			if (entry === void 0) continue;
			this.controls.delete(each);
			if (entry.timer !== void 0) clearTimeout(entry.timer);
			entry.session.close();
		}
	}
	/** Release every warm control session (plugin teardown). */
	close() {
		this.discardControl();
	}
};
/** Read the signed-in account once per TTL. */
var CodeBuddyAccountReader = class {
	region;
	ttlMs;
	timeoutMs;
	cached = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	constructor(region, ttlMs = CODEBUDDY_CACHE_TTL_MS, timeoutMs = CODEBUDDY_FETCH_TIMEOUT_MS) {
		this.region = region;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* The account for one region.
	*
	* A non-fresh read answers from the persisted snapshot first, so switching
	* the region selector paints immediately; the page follows with `fresh=1`
	* to replace it with a live CLI reading.
	*/
	async read(fresh = false, requested) {
		const region = requested ?? readLive(this.region, "global");
		if (!fresh) {
			const memory = this.cached.get(region);
			if (memory !== void 0) return memory;
			const saved = codeBuddyState.usage(region);
			if (saved !== void 0) {
				this.cached.set(region, saved);
				return saved;
			}
		}
		let pending = this.inflight.get(region);
		if (pending === void 0) {
			pending = this.fetch(region).finally(() => {
				this.inflight.delete(region);
			});
			this.inflight.set(region, pending);
		}
		const snapshot = await pending;
		this.cached.set(region, snapshot);
		return snapshot;
	}
	invalidate(region) {
		if (region === void 0) this.cached.clear();
		else this.cached.delete(region);
	}
	async fetch(region) {
		const at = Date.now();
		const saved = codeBuddyState.region(region);
		const token = tokenFor(region);
		if (saved?.account !== void 0 && token !== void 0) try {
			const quota = await fetchCodeBuddyQuota(region, token);
			codeBuddyState.patch(region, {
				signedIn: true,
				quota,
				quotaError: void 0,
				at
			});
			return {
				at,
				account: saved.account,
				quota
			};
		} catch (error) {
			if (!isCredentialRejected(error)) {
				const message = error instanceof Error ? error.message : String(error);
				codeBuddyState.patch(region, {
					signedIn: true,
					quota: void 0,
					quotaError: message,
					at
				});
				return {
					at,
					account: saved.account,
					quotaError: message
				};
			}
			forgetToken(region);
		}
		try {
			const account = await readAccount(region, readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS));
			if (isUnauthenticatedAccount(account)) {
				forgetToken(region);
				codeBuddyState.patch(region, {
					signedIn: false,
					account: void 0,
					quota: void 0,
					quotaError: void 0,
					at
				});
				return {
					at,
					error: `${region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版"}尚未登录，请在页面顶部选择该区域并登录。`
				};
			}
			codeBuddyState.patch(region, {
				signedIn: true,
				account,
				at
			});
			try {
				const quota = await readQuotaWithToken(region);
				codeBuddyState.patch(region, {
					quota,
					quotaError: void 0,
					at
				});
				return {
					at,
					account,
					quota
				};
			} catch (quotaError) {
				const message = quotaError instanceof Error ? quotaError.message : String(quotaError);
				if (isCredentialRejected(quotaError)) forgetToken(region);
				else codeBuddyState.patch(region, {
					quota: void 0,
					quotaError: message
				});
				return {
					at,
					account,
					quotaError: message
				};
			}
		} catch (error) {
			return {
				at,
				error: authErrorText(region, error)
			};
		}
	}
};
/**
* Read the signed-in account through a one-shot query.
*
* `createSession` exposes models but not the account, while `query()` exposes
* `accountInfo()`; the prompt never yields, so no model turn is started.
*/
async function readAccount(region, timeoutMs) {
	const q = (await loadCodeBuddySdk()).query({
		prompt: inertInput(),
		options: {
			environment: codeBuddyEnvironment(region),
			...cliEnv(region),
			tools: [],
			settingSources: [],
			maxTurns: 1
		}
	});
	try {
		await withTimeout(q.connect(), timeoutMs, "CodeBuddy request");
		return withoutCredential(await withTimeout(q.accountInfo(), timeoutMs, "CodeBuddy request")) ?? {};
	} finally {
		await q.return().catch(() => void 0);
	}
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
function authErrorText(region, error) {
	const detail = error instanceof Error ? error.message : String(error);
	const label = region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版";
	if (/auth|login|登录|credential|401|unauthor/i.test(detail)) return `${label}尚未登录，请在页面顶部选择该区域并登录。`;
	return detail;
}
/**
* The account's credits, read from CodeBuddy's billing endpoint.
*
* The SDK exposes no quota call, but the CLI's own account page uses
* `POST /v2/billing/meter/get-user-resource` on the same host. The response is
* a list of independently expiring credit packages; `CycleCapacity*Precise`
* is the live balance, while the top-level `TotalDosage` is a stale
* period-scoped figure and is deliberately ignored.
*
* @param payload - the endpoint's JSON answer.
*/
function parseCodeBuddyQuota(payload) {
	const data = payload?.data;
	if (data === null || data === void 0 || typeof data !== "object") throw new Error("额度响应缺少 data");
	const response = data.Response;
	const error = response?.Error;
	if (error?.Code !== void 0 && error.Code !== 0 && error.Code !== "0") throw new Error(`${String(error.Code)}: ${String(error.Message ?? "")}`);
	const source = (response?.Data)?.Accounts ?? response?.Accounts ?? data.Data?.Accounts ?? data.Accounts;
	if (!Array.isArray(source)) throw new Error("额度响应缺少 Accounts");
	const now = Date.now();
	let total = 0;
	let remaining = 0;
	let cycleEnd;
	const packages = [];
	for (const entry of source) {
		if (entry === null || typeof entry !== "object") continue;
		if (Number(entry.Status) !== 0) continue;
		const packageTotal = cycleCapacity(entry, "CycleCapacitySize");
		if (packageTotal <= 0) continue;
		const packageRemaining = Math.max(0, cycleCapacity(entry, "CycleCapacityRemain"));
		total += packageTotal;
		remaining += packageRemaining;
		const end = parseLocalTime(entry.CycleEndTime);
		if (packageRemaining > 0 || end !== void 0 && end > now) packages.push({
			name: String(entry.PackageName ?? ""),
			total: packageTotal,
			used: Math.max(0, packageTotal - packageRemaining),
			...end === void 0 ? {} : { end }
		});
		if (end !== void 0 && end > now && packageRemaining > 0) cycleEnd = cycleEnd === void 0 ? end : Math.min(cycleEnd, end);
	}
	return {
		remaining,
		total,
		used: Math.max(0, total - remaining),
		...cycleEnd === void 0 ? {} : { cycleEnd },
		packages
	};
}
function numeric(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function cycleCapacity(entry, key) {
	return numeric(entry[`${key}Precise`]) ?? numeric(entry[key]) ?? 0;
}
function parseLocalTime(value) {
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const parsed = Date.parse(value.trim().replace(" ", "T"));
	return Number.isFinite(parsed) ? parsed : void 0;
}
function formatLocalTime(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/**
* A bearer token for the region, from a recent login or a silent SDK read.
*
* The silent read is the documented behaviour of `authenticate` — return the
* CLI's existing token instead of opening a browser when the region is signed
* in — but it did not work as measured: on a machine with a live CodeBuddy
* login it timed out for both regions, each in the shared default directory and
* in both per-region directories. So treat it as best effort, and never as a
* place to recover from: the copy this plugin saved is the only credential a
* session can count on, which is why dropping it used to read as "not signed
* in" even while the account still worked.
*/
async function readBearerToken(region) {
	const cached = tokenFor(region);
	if (cached !== void 0) return cached;
	const result = await withTimeout((await loadCodeBuddySdk()).unstable_v2_authenticate({
		environment: codeBuddyEnvironment(region),
		env: cliDirEnv(region),
		timeout: 3e3,
		onAuthUrl: () => {}
	}), 6e3, "CodeBuddy authenticate");
	rememberBearerToken(region, result.userinfo.token, {
		userId: result.userinfo.userId,
		userName: result.userinfo.userName,
		userNickname: result.userinfo.userNickname
	});
	return result.userinfo.token;
}
/** Query the billing endpoint once. */
async function fetchCodeBuddyQuota(region, token, fetchImpl = fetch) {
	const endpoint = CODEBUDDY_ENDPOINTS[region];
	const host = new URL(endpoint).host;
	const body = {
		PageNumber: 1,
		PageSize: 200,
		Status: [0, 3],
		PackageEndTimeRangeBegin: formatLocalTime(/* @__PURE__ */ new Date()),
		PackageEndTimeRangeEnd: QUOTA_RANGE_END
	};
	const response = await fetchImpl(`${endpoint}${QUOTA_PATH}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
			"x-requested-with": "XMLHttpRequest",
			"x-stainless-arch": process.arch === "arm64" ? "arm64" : "x64",
			"x-stainless-lang": "js",
			"x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
			"x-stainless-package-version": "6.25.0",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": process.version,
			"x-conversation-id": randomUUID(),
			"x-conversation-request-id": randomBytes(16).toString("hex"),
			"x-conversation-message-id": randomUUID().replace(/-/g, ""),
			"x-request-id": randomUUID().replace(/-/g, ""),
			"x-agent-intent": "craft",
			"x-agent-purpose": "conversation",
			"x-ide-type": "CLI",
			"x-ide-name": "CLI",
			"x-ide-version": CLIENT_VERSION,
			"user-agent": `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`,
			"x-private-data": "false",
			"x-codebuddy-request": "1",
			"x-product": "SaaS",
			"x-domain": host
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15e3)
	});
	const text = await response.text();
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) throw new CredentialRejectedError("CodeBuddy 登录已过期，请重新登录");
		const detail = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
		throw new Error(`CodeBuddy 额度接口返回 HTTP ${response.status}${detail === "" ? "" : `：${detail}`}`);
	}
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("CodeBuddy 额度接口返回了非 JSON 内容");
	}
	return parseCodeBuddyQuota(payload);
}
/**
* The credential this region holds was rejected by the endpoint.
*
* Thrown where the rejection is *known* — an explicit HTTP 401/403 — rather
* than inferred from the error text. Inferring it was the bug: the loose
* matcher below used to treat any failure whose message happened to contain
* "token", "401" inside a number, or an HTML body mentioning a token, as an
* expired login. It then dropped a working credential, and because a missing
* local token reads as "signed out", the page showed an account as not signed
* in while the CLI still had a usable login.
*/
var CredentialRejectedError = class extends Error {};
/**
* Whether a quota failure genuinely means the credential no longer works.
*
* The typed error carries the CLI's own expiry sentence, which is also matched
* here because the message is ours, fixed, and not derived from server text.
* Everything else — a 5xx, a bad payload, a timeout, an unreachable endpoint —
* leaves the credential alone.
*
* @param error - whatever quota reading threw.
*/
function isCredentialRejected(error) {
	if (error instanceof CredentialRejectedError) return true;
	return (error instanceof Error ? error.message : String(error)) === "CodeBuddy 登录已过期，请重新登录";
}
/** Read quota, retrying once with a fresh token after an auth failure. */
async function readQuotaWithToken(region) {
	const token = await readBearerToken(region).catch((error) => {
		throw new Error(authErrorText(region, error));
	});
	try {
		return await fetchCodeBuddyQuota(region, token);
	} catch (error) {
		if (!isCredentialRejected(error)) throw error;
		forgetToken(region);
		return await fetchCodeBuddyQuota(region, await readBearerToken(region).catch((renewError) => {
			throw new Error(authErrorText(region, renewError));
		}));
	}
}
/**
* Browser login/logout per region.
*
* The SDK owns the browser flow: it emits a URL, waits for the CLI to report
* the result, and stores the credential where the CLI reads it. This manager
* only remembers progress so the settings page can poll it.
*/
var CodeBuddyAuth = class {
	runs = /* @__PURE__ */ new Map();
	/** Start a login; refuses while the same region is already logging in. */
	start(region, onFinish) {
		if (this.runs.get(region)?.status.running === true) return {
			started: false,
			error: "该区域正在登录，请先在浏览器中完成。"
		};
		const saved = codeBuddyState.region(region);
		const clearFirst = saved?.token !== void 0 || saved?.user !== void 0 || saved?.account !== void 0 || saved?.signedIn === true;
		bearerTokens.delete(region);
		codeBuddyState.clear(region);
		const run = {
			status: {
				running: true,
				region,
				startedAt: Date.now(),
				signedIn: false
			},
			clearFirst
		};
		this.runs.set(region, run);
		this.login(run, onFinish);
		return { started: true };
	}
	status(region) {
		const run = this.runs.get(region);
		if (run !== void 0) return run.status;
		const saved = codeBuddyState.region(region);
		return {
			running: false,
			region,
			signedIn: saved?.signedIn === true,
			...saved?.user === void 0 ? {} : { user: saved.user }
		};
	}
	/** Clear the cached credential for one region. */
	async logout(region) {
		let failure;
		try {
			await withTimeout((await loadCodeBuddySdk()).unstable_v2_logout({
				environment: codeBuddyEnvironment(region),
				env: cliDirEnv(region)
			}), CODEBUDDY_FETCH_TIMEOUT_MS, "CodeBuddy logout");
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		this.runs.delete(region);
		bearerTokens.delete(region);
		codeBuddyState.clear(region);
		return failure === void 0 ? { ok: true } : {
			ok: false,
			error: failure
		};
	}
	/** False once this run was replaced or cancelled by logout. */
	current(run) {
		return this.runs.get(run.status.region) === run;
	}
	async login(run, onFinish) {
		const { status } = run;
		const { region } = status;
		try {
			const sdk = await loadCodeBuddySdk();
			if (run.clearFirst) {
				await withTimeout(sdk.unstable_v2_logout({
					environment: codeBuddyEnvironment(region),
					env: cliDirEnv(region)
				}), LOGOUT_TIMEOUT_MS, "CodeBuddy logout").catch(() => void 0);
				if (!this.current(run)) return;
				bearerTokens.delete(region);
			}
			const result = await sdk.unstable_v2_authenticate({
				environment: codeBuddyEnvironment(region),
				env: cliDirEnv(region),
				timeout: LOGIN_TIMEOUT_MS,
				onAuthUrl: (state) => {
					status.url = state.authUrl;
				}
			});
			if (!this.current(run)) return;
			status.running = false;
			status.finishedAt = Date.now();
			const user = {
				userId: result.userinfo.userId,
				userName: result.userinfo.userName,
				userNickname: result.userinfo.userNickname
			};
			status.user = user;
			status.signedIn = true;
			rememberBearerToken(region, result.userinfo.token, user);
			onFinish?.(true);
		} catch (error) {
			if (!this.current(run)) return;
			status.running = false;
			status.finishedAt = Date.now();
			status.signedIn = false;
			status.error = authErrorText(region, error);
			onFinish?.(false);
		}
	}
};
/** A token count as a non-negative whole number; anything unusable becomes 0. */
function countOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}
/** Whether one usage frame actually measured a prompt. */
function measuredPrompt(usage) {
	return usage !== void 0 && (countOf(usage.input_tokens) > 0 || countOf(usage.cache_read_input_tokens) > 0 || countOf(usage.cache_creation_input_tokens) > 0);
}
/**
* Fold one `message_delta` usage into the turn's reading.
*
* The delta is cumulative for its own message and carries the final output
* count. Not every transport repeats the prompt fields on it, so the last
* measured values are kept rather than letting a later frame erase them.
*/
function mergeTurnUsage(previous, next) {
	const output = typeof next.output_tokens === "number" && Number.isFinite(next.output_tokens) ? next.output_tokens : previous?.output_tokens ?? 0;
	return {
		input_tokens: countOf(next.input_tokens) > 0 ? next.input_tokens : previous?.input_tokens ?? 0,
		output_tokens: output,
		cache_read_input_tokens: next.cache_read_input_tokens ?? previous?.cache_read_input_tokens ?? 0,
		cache_creation_input_tokens: next.cache_creation_input_tokens ?? previous?.cache_creation_input_tokens ?? 0
	};
}
/**
* One warm CodeBuddy session for a host session id.
*
* Mirrors the Qoder session's shape: the host's tool calls are exposed through
* an in-process MCP server; each handler parks until the host delivers that
* round's results on its next request. The inner CLI keeps the conversation,
* so a continuation carries only new user text.
*/
var CodeBuddySession = class {
	sessionId;
	session = null;
	mcp = null;
	pairing = new ToolResultPairing();
	toolSchemas = [];
	/**
	* Reconciles the live host tool list into {@link mcp}.
	*
	* Created with the MCP server, because that is what it installs into. Owned
	* here rather than inline so a tool that the host adds or withdraws during a
	* conversation is actually added or withdrawn: the MCP SDK refuses a second
	* `registerTool` for a name it already holds, so the previous
	* name→hash replay could never replace a changed schema, and `Tool "…" does
	* not exist in the current tool set.` was what the model got for its trouble.
	*/
	registry = null;
	queue = null;
	disposed = false;
	/**
	* Deferred-close state: why this session was asked to stop, and whether an
	* in-flight turn is finishing first. Same contract as the Qoder session —
	* a plugin reload used to kill the CLI mid-answer and report the cut stream
	* as a failure. See {@link CloseGate}.
	*/
	closeGate;
	/** Wall clock of the spawn, for the close log's lifetime figure. */
	spawnedAt;
	abortPending = false;
	turnEndKind;
	blockIndex = 0;
	textBlock;
	reasoningBlock;
	tools = [];
	openTool;
	callCounter = 0;
	callNonce = randomUUID().slice(0, 8);
	lastUsage;
	/**
	* The last prompt-side buckets a request actually measured.
	*
	* Kept across turns: a turn can end without a usable usage frame (aborted
	* before the first delta, or a transport that only sends the cumulative
	* result). Reusing the last real reading keeps the host's context pressure
	* at the provider's actual prompt instead of collapsing it to the CLI's
	* startup overhead.
	*/
	lastPromptUsage;
	/**
	* Ids of assistant messages whose streaming events this session consumed.
	*
	* Kept across turns, not reset with the turn: the echo of a tool round is
	* delivered on the next stream(), so the previous turn's id is exactly the
	* one that has to be recognised. Only the last few ids matter, and bounding
	* the list keeps a long-lived session from growing without limit.
	*/
	streamedMessageIds = /* @__PURE__ */ new Set();
	streamedMessageOrder = [];
	output = new TurnOutputAccounting();
	inputChars = 0;
	toolResultTimeoutMs;
	abortGraceMs;
	region = "global";
	model = "";
	effort;
	systemPrompt;
	cwd;
	/** Context budget the host shows for this session, when a model offers one. */
	contextWindow;
	/** Budget already pushed to the CLI, keyed by model and value. */
	appliedWindow;
	/** Host messages already fed to the inner session, for continuation planning. */
	fedMessages;
	/** Host system prompt last applied; informational for the adapter. */
	fedSystem;
	constructor(sessionId, initialModel, runtime = {}) {
		this.sessionId = sessionId;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 12e4);
		this.abortGraceMs = readLive(runtime.abortGraceMs, 5e3);
		this.closeGate = new CloseGate(() => readLive(runtime.drainMs, DEFAULT_DRAIN_MS), () => {
			this.teardown();
		}, (cause) => {
			this.forceEnd(cause);
		});
	}
	/** Whether a turn is in flight; the pool must never evict such a session. */
	get busy() {
		return this.queue !== null;
	}
	/** Whether this session has been asked to stop and accepts no new turn. */
	get closing() {
		return this.closeGate.cause;
	}
	/** Point the session at a region, model and optional system prompt. */
	configure(region, model, options = {}) {
		this.region = region;
		this.model = model;
		this.effort = options.effort;
		this.systemPrompt = options.system;
		if (options.cwd !== void 0) this.cwd = options.cwd;
		if (options.contextWindow !== void 0) this.contextWindow = options.contextWindow;
	}
	/**
	* Push the host-visible context window into the inner session.
	*
	* The CLI resolves its own budget (`override > model default > physical
	* limit`) and both its compaction trigger and the upstream gateway enforce
	* that budget. A global-catalog model such as `deepseek-v4.1-flash` declares
	* `supportedLengths [300K, 1M]` with a 300K default, so a session left alone
	* compacts (and the gateway rejects) anything past 276K — while the host,
	* told 1M, keeps showing and feeding a larger history. Replaying that history
	* then collapses to a summary. Applying the same number the host divides by
	* keeps the two in step; the adapter therefore sends a window for every model
	* it knows about, not only the ones that advertise a choice — the mainland
	* catalog declares no lengths anywhere and its physical `maxInputTokens` is a
	* provider number the CLI is free to ignore when left to itself.
	*
	* A rejected value keeps the CLI on its own default, which is the one case
	* where the two denominators can still disagree; it is reported nowhere, so
	* the host's figure stays the visible contract.
	*/
	async applyContextWindow(session) {
		const window = this.contextWindow;
		if (window === void 0) return;
		const key = `${this.model}:${window}`;
		if (this.appliedWindow === key) return;
		this.appliedWindow = key;
		try {
			await session.setConfig({ contextWindow: window });
		} catch {}
	}
	/**
	* Remember the host tools and register them with this session's MCP server.
	*
	* Registration must happen before the CLI connects: the MCP SDK refuses a
	* tool added afterwards. The first turn calls this before the session — and
	* therefore its MCP server — exists, so the schemas are kept and replayed by
	* {@link ensureStarted}. Returning early there left the model with no host
	* tools at all, and it fell back to CodeBuddy's built-in `Bash`, which the
	* host could only answer with "unknown tool".
	*/
	ensureTools(tools) {
		this.toolSchemas = tools;
		this.registerTools();
	}
	/**
	* Reconcile this session's MCP tool set with the host's live list.
	*
	* Add, update in place, and remove: the host withdraws tools when a mode
	* changes and adds them when `ops_discover_tools` resolves a deferred one, and
	* a tool the model can still name but the server no longer holds is answered
	* with `Tool "…" does not exist in the current tool set.` — the CLI never
	* forwards it to the host, so no tool result ever comes back.
	*/
	registerTools() {
		if (this.registry === null) return;
		this.registry.reconcile(this.toolSchemas);
	}
	/** Hand the host's tool results to parked or buffered handlers. */
	deliverToolResults(tail, images) {
		let freshUserTurn = false;
		const delivered = /* @__PURE__ */ new Set();
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			delivered.add(this.pairing.deliver(String(message.toolCallId), {
				content: renderCodeBuddyResult(message.content, images),
				isError: message.isError === true
			}));
		}
		this.pairing.beginHostRequest(delivered, freshUserTurn);
	}
	/** Run one host turn; `feed` is new user content, or null for a tool continuation. */
	async *stream(options, feed) {
		if (this.queue !== null) throw new Error(`CodeBuddy session ${this.sessionId} already has a turn in flight`);
		if (this.disposed || this.closeGate.closing) throw new LlmError(`CodeBuddy session ${this.sessionId} is closed (${this.closeGate.cause ?? "disposed"})`, "INVALID_REQUEST");
		let session;
		try {
			session = await this.ensureStarted();
		} catch (error) {
			const cause = this.closeGate.cause;
			if (cause === void 0) throw error;
			yield {
				type: "finish",
				reason: closeFinishReason(cause)
			};
			return;
		}
		this.queue = new TurnQueue();
		this.resetTurnState();
		const signal = options.signal;
		let abortTimer;
		const onAbort = () => {
			this.abortPending = true;
			session.interrupt().catch(() => void 0);
			abortTimer = setTimeout(() => this.endTurn({
				kind: "aborted",
				failure: {
					message: "CodeBuddy session aborted by host",
					code: "ABORTED"
				}
			}), this.abortGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await session.setModel(this.model);
			await this.applyContextWindow(session);
			if (feed !== null && feed.length > 0) {
				const content = typeof feed === "string" ? feed : feed.filter((block) => block.type !== "text" || block.text.length > 0);
				if (content.length > 0) {
					this.inputChars += typeof content === "string" ? content.length : contentChars(content);
					await session.send(toCodeBuddyUserMessage(this.sessionId, content));
				}
			}
			this.consume(session);
			for await (const item of this.queue) {
				if (item.kind === "chunk") {
					yield item.chunk;
					continue;
				}
				if (item.usage !== void 0) yield {
					type: "usage",
					usage: item.usage
				};
				yield {
					type: "finish",
					reason: item.reason
				};
				return;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			if (this.turnEndKind === "aborted" || this.turnEndKind === "error") this.pairing.forgetUnclaimed();
			this.queue = null;
			this.abortPending = false;
			this.closeGate.settled();
		}
	}
	/**
	* Ask the session to stop serving.
	*
	* An in-flight turn is allowed to finish first (up to `drainMs`): its chunks
	* are consumed by the harness, so the answer arrives instead of being
	* truncated into a bogus stream failure. {@link teardown} does the work.
	*
	* @param cause - why it is closing; decides how an interrupted turn reports.
	*/
	close(cause = "dispose") {
		if (this.closeGate.request(cause, this.busy) === "draining") trace("session/drain", {
			session: this.sessionId,
			brand: "codebuddy",
			region: this.region,
			cause
		});
	}
	/** End a turn that outlived its drain window, before the CLI dies. */
	forceEnd(cause) {
		this.endTurn(closeFinishReason(cause));
	}
	/** Tear the inner CLI down; parked handlers settle with a cancellation. */
	teardown() {
		if (this.disposed) return;
		this.disposed = true;
		this.pairing.clear();
		this.session?.close();
		this.session = null;
		trace("session/close", {
			session: this.sessionId,
			brand: "codebuddy",
			region: this.region,
			cause: this.closeGate.cause ?? "dispose",
			aliveMs: this.spawnedAt === void 0 ? 0 : Date.now() - this.spawnedAt
		});
	}
	async ensureStarted() {
		if (this.session !== null) return this.session;
		const sdk = await loadCodeBuddySdk();
		this.mcp ??= sdk.createSdkMcpServer({
			name: CODEBUDDY_MCP_SERVER_KEY,
			tools: []
		});
		this.registry ??= new HostToolRegistry(this.mcp.instance, () => async () => {
			const result = await this.pairing.claim(this.toolResultTimeoutMs);
			return {
				content: result.content,
				...result.isError ? { isError: true } : {}
			};
		}, (message) => console.warn(`[dsh-agent-sdk-bridge] ${message}`));
		this.registry.prepare();
		this.registerTools();
		const session = sdk.unstable_v2_createSession({
			environment: codeBuddyEnvironment(this.region),
			sessionId: randomUUID(),
			model: this.model,
			mcpServers: { [CODEBUDDY_MCP_SERVER_KEY]: this.mcp },
			canUseTool: this.canUseTool,
			tools: [],
			...cliEnv(this.region),
			settingSources: [],
			includePartialMessages: true,
			persistSession: false,
			...this.effort === void 0 ? {} : { effort: this.effort },
			...this.systemPrompt === void 0 ? {} : { systemPrompt: this.systemPrompt },
			...this.cwd === void 0 ? {} : { cwd: this.cwd }
		});
		if (this.disposed || this.closeGate.closing) {
			session.close();
			throw new LlmError(`CodeBuddy session ${this.sessionId} closed while starting`, "INVALID_REQUEST");
		}
		this.session = session;
		this.spawnedAt = Date.now();
		trace("session/spawn", {
			session: this.sessionId,
			brand: "codebuddy",
			region: this.region
		});
		return session;
	}
	canUseTool = (toolName, _input, options) => {
		if (isHostTool(toolName)) {
			if (options.toolUseID !== void 0) this.pairing.announce(options.toolUseID);
			return Promise.resolve({
				behavior: "allow",
				...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
			});
		}
		return Promise.resolve({
			behavior: "deny",
			message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
			...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
		});
	};
	async consume(session) {
		try {
			for await (const message of session.stream()) {
				this.handle(message);
				if (this.queue === null || this.queue.isClosed) return;
			}
			const cause = this.closeGate.cause;
			if (cause !== void 0) {
				this.endTurn(closeFinishReason(cause));
				return;
			}
			trace("session/stream-ended", {
				session: this.sessionId,
				brand: "codebuddy",
				region: this.region
			});
			this.endTurn({
				kind: "error",
				failure: {
					message: "CodeBuddy session stream ended unexpectedly",
					code: "STREAM_CLOSED"
				}
			});
		} catch (error) {
			const cause = this.closeGate.cause;
			if (cause !== void 0) {
				this.endTurn(closeFinishReason(cause));
				return;
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: authErrorText(this.region, error),
					code: "BACKEND_TURN_ERROR"
				}
			});
		}
	}
	handle(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event.type === "message_start") {
				const usage = event.message.usage;
				if (measuredPrompt(usage)) this.lastUsage = usage;
				this.rememberStreamedMessage(event.message.id);
				return;
			}
			if (event.type === "content_block_start") {
				const block = event.content_block;
				if (block?.type === "tool_use") {
					if (!isHostTool(block.name ?? "")) return;
					const callId = `cb-${this.callNonce}-${++this.callCounter}`;
					if (typeof block.id === "string" && block.id.length > 0) this.pairing.mapHostCall(callId, block.id);
					const chunkIndex = this.blockIndex++;
					const initial = block.input !== void 0 && block.input !== null && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
					this.openTool = {
						chunkIndex,
						callId,
						name: hostToolName(block.name ?? ""),
						arguments: initial
					};
					this.countOutput(this.openTool.name);
					this.countOutput(initial);
					this.emit({
						type: "block-start",
						index: chunkIndex,
						blockType: "tool-call"
					});
					this.emit({
						type: "tool-call-delta",
						index: chunkIndex,
						id: ToolCallId(callId),
						name: this.openTool.name,
						argumentsDelta: ""
					});
				}
				return;
			}
			if (event.type === "content_block_delta") {
				const delta = event.delta;
				if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
					if (this.textBlock === void 0) {
						this.textBlock = {
							index: this.blockIndex++,
							text: ""
						};
						this.emit({
							type: "block-start",
							index: this.textBlock.index,
							blockType: "text"
						});
					}
					this.textBlock.text += delta.text;
					this.countOutput(delta.text);
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text: delta.text
					});
				} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
					if (this.reasoningBlock === void 0) {
						this.reasoningBlock = {
							index: this.blockIndex++,
							text: ""
						};
						this.emit({
							type: "block-start",
							index: this.reasoningBlock.index,
							blockType: "reasoning"
						});
					}
					this.reasoningBlock.text += delta.thinking;
					this.output.addReasoning(delta.thinking);
					this.emit({
						type: "reasoning-delta",
						index: this.reasoningBlock.index,
						text: delta.thinking
					});
				} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.openTool !== void 0) {
					this.openTool.arguments += delta.partial_json;
					this.countOutput(delta.partial_json);
					this.emit({
						type: "tool-call-delta",
						index: this.openTool.chunkIndex,
						id: ToolCallId(this.openTool.callId),
						argumentsDelta: delta.partial_json
					});
				}
				return;
			}
			if (event.type === "content_block_stop") {
				if (this.openTool !== void 0) {
					this.emit({
						type: "block-end",
						index: this.openTool.chunkIndex,
						block: {
							type: "tool-call",
							id: ToolCallId(this.openTool.callId),
							name: this.openTool.name,
							arguments: this.openTool.arguments
						}
					});
					this.tools.push(this.openTool);
					this.openTool = void 0;
				}
				return;
			}
			if (event.type === "message_delta") {
				const usage = event.usage;
				if (usage !== void 0) this.lastUsage = mergeTurnUsage(this.lastUsage, usage);
				return;
			}
			if (event.type === "message_stop") {
				if (this.tools.length > 0) this.endTurn({ kind: "tool-calls" });
				return;
			}
			return;
		}
		if (message.type === "assistant") {
			const echoOf = message.message.id;
			if (typeof echoOf === "string" && this.streamedMessageIds.has(echoOf)) return;
			if (this.textBlock === void 0 && this.tools.length === 0) {
				for (const block of message.message.content) if (block.type === "tool_use") {
					this.countOutput(block.name);
					this.countOutput(JSON.stringify(block.input ?? ""));
				}
				const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
				if (text.length > 0) {
					this.textBlock = {
						index: this.blockIndex++,
						text
					};
					this.countOutput(text);
					this.emit({
						type: "block-start",
						index: this.textBlock.index,
						blockType: "text"
					});
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text
					});
				}
			}
			return;
		}
		if (message.type === "result") {
			if (this.abortPending) {
				this.endTurn({
					kind: "aborted",
					failure: {
						message: "CodeBuddy turn aborted by host",
						code: "ABORTED"
					}
				});
				return;
			}
			if (this.tools.length > 0) {
				this.endTurn({ kind: "tool-calls" });
				return;
			}
			if (message.is_error === true) {
				const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : "unknown error";
				this.endTurn({
					kind: "error",
					failure: {
						message: `CodeBuddy turn failed: ${errors}`,
						code: "BACKEND_TURN_ERROR"
					}
				});
				return;
			}
			if (this.textBlock === void 0 && this.reasoningBlock === void 0) {
				this.endTurn({
					kind: "error",
					failure: {
						message: "CodeBuddy returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				});
				return;
			}
			this.endTurn({ kind: "stop" });
		}
	}
	/** Record that one assistant message reached the host as streaming events. */
	rememberStreamedMessage(id) {
		if (typeof id !== "string" || id.length === 0 || this.streamedMessageIds.has(id)) return;
		this.streamedMessageIds.add(id);
		this.streamedMessageOrder.push(id);
		if (this.streamedMessageOrder.length > 32) {
			const oldest = this.streamedMessageOrder.shift();
			if (oldest !== void 0) this.streamedMessageIds.delete(oldest);
		}
	}
	resetTurnState() {
		this.blockIndex = 0;
		this.textBlock = void 0;
		this.reasoningBlock = void 0;
		this.openTool = void 0;
		this.tools = [];
		this.inputChars = 0;
		this.output.reset();
		this.lastUsage = void 0;
		this.turnEndKind = void 0;
	}
	emit(chunk) {
		this.queue?.push({
			kind: "chunk",
			chunk
		});
	}
	countOutput(text) {
		this.output.addOutput(text);
	}
	usage() {
		const metered = this.lastUsage;
		const local = this.output.usage();
		const measuredOutput = countOf(metered?.output_tokens);
		const outputTokens = measuredOutput > 0 ? measuredOutput : Math.max(1, Math.ceil(local.outputTokens));
		const reasoning = local.reasoningTokens === void 0 ? {} : { reasoningTokens: Math.min(outputTokens, Math.max(1, Math.ceil(local.reasoningTokens))) };
		if (metered !== void 0 && countOf(metered.input_tokens) > 0) {
			const cacheRead = countOf(metered.cache_read_input_tokens);
			const cacheWrite = countOf(metered.cache_creation_input_tokens);
			const inputTokens = Math.max(0, countOf(metered.input_tokens) - cacheRead - cacheWrite);
			this.lastPromptUsage = {
				inputTokens,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite
			};
			return {
				inputTokens,
				outputTokens,
				...reasoning,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens
			};
		}
		if (this.lastPromptUsage !== void 0) {
			const prompt = this.lastPromptUsage;
			return {
				inputTokens: prompt.inputTokens,
				outputTokens,
				...reasoning,
				cacheReadTokens: prompt.cacheReadTokens,
				cacheWriteTokens: prompt.cacheWriteTokens,
				totalTokens: prompt.inputTokens + prompt.cacheReadTokens + prompt.cacheWriteTokens + outputTokens
			};
		}
		const inputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.inputChars, 0)));
		return {
			inputTokens,
			outputTokens,
			...reasoning,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: inputTokens + outputTokens
		};
	}
	endTurn(reason) {
		if (this.queue === null || this.queue.isClosed) return;
		this.turnEndKind = reason.kind;
		if (this.textBlock !== void 0) this.emit({
			type: "block-end",
			index: this.textBlock.index,
			block: {
				type: "text",
				text: this.textBlock.text
			}
		});
		if (this.reasoningBlock !== void 0) this.emit({
			type: "block-end",
			index: this.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: this.reasoningBlock.text
			}
		});
		this.queue.push({
			kind: "turn-end",
			reason,
			usage: this.usage()
		});
		this.queue.close();
		const code = reason.kind === "error" || reason.kind === "aborted" ? reason.failure.code : void 0;
		trace("turn/end", {
			session: this.sessionId,
			brand: "codebuddy",
			region: this.region,
			kind: reason.kind,
			...code === void 0 ? {} : { code },
			...this.closeGate.cause === void 0 ? {} : { cause: this.closeGate.cause }
		});
	}
};
/** Render host tool-result blocks into the MCP content the inner model reads. */
function renderCodeBuddyResult(blocks, images) {
	if (!Array.isArray(blocks)) return [{
		type: "text",
		text: String(blocks ?? "")
	}];
	const content = [];
	for (const block of blocks) if (block.type === "text") content.push({
		type: "text",
		text: block.text ?? ""
	});
	else if (block.type === "image" && block.attachment !== null && typeof block.attachment === "object") {
		const attachment = block.attachment;
		const resolved = images?.get(String(attachment.attachmentId));
		content.push(resolved === void 0 ? {
			type: "text",
			text: textOnlyImageText(attachment)
		} : {
			type: "image",
			data: resolved.data,
			mimeType: resolved.mediaType
		});
	} else content.push({
		type: "text",
		text: JSON.stringify(block)
	});
	return content;
}
/**
* Warm sessions keyed by host session id. A region change retires the old
* session rather than mutating one, because the CLI process was started with
* the previous region's endpoint.
*/
var CodeBuddySessionManager = class {
	maxSessions;
	runtime;
	create;
	sessions = /* @__PURE__ */ new Map();
	/** Set by {@link seal}: this pool's plugin generation is gone. */
	sealed = false;
	/**
	* @param maxSessions - warm-session cap; read per eviction so a settings edit
	*   applies to the next session that overflows the pool.
	* @param runtime - per-session knobs, resolved when each session is created.
	* @param create - builds one session; injectable so the pool's rules are
	*   testable without spawning a CLI.
	*/
	constructor(maxSessions, runtime = {}, create = (sessionId, model) => new CodeBuddySession(sessionId, model, runtime)) {
		this.maxSessions = maxSessions;
		this.runtime = runtime;
		this.create = create;
	}
	forSession(sessionId, region, model) {
		if (this.sealed) throw new LlmError("CodeBuddy 会话池已封存（插件已卸载）", "INVALID_REQUEST");
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			if (existing.region !== region) {
				existing.session.close("region");
				this.sessions.delete(sessionId);
			} else {
				this.sessions.delete(sessionId);
				this.sessions.set(sessionId, existing);
				return existing.session;
			}
		}
		const session = this.create(sessionId, model);
		this.sessions.set(sessionId, {
			session,
			region
		});
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const victim = [...this.sessions.entries()].find(([id, entry]) => id !== sessionId && !entry.session.busy);
			if (victim === void 0) break;
			this.sessions.delete(victim[0]);
			victim[1].session.close("evicted");
		}
		return session;
	}
	dispose(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (entry === void 0) return;
		this.sessions.delete(sessionId);
		entry.session.close("rebuild");
	}
	/**
	* Drop every warm session, keeping the pool usable.
	*
	* A login or logout changes the credentials those processes loaded, so they
	* cannot answer for the new account; the pool itself keeps serving.
	*
	* @param cause - why the sessions go; decides how interrupted turns report.
	*/
	closeAll(cause = "account") {
		for (const entry of this.sessions.values()) entry.session.close(cause);
		this.sessions.clear();
	}
	/**
	* Drop every warm session and refuse to create more.
	*
	* Called from the plugin's dispose effect: a step prepared before the unload
	* can still be retried through this adapter, and a session created then would
	* outlive every owner it has.
	*/
	seal(cause = "dispose") {
		this.sealed = true;
		this.closeAll(cause);
	}
};
/** A one-shot turn, used for titles and compaction summaries. */
async function codeBuddyColdStream(region, prompt, model, options) {
	const chunks = [];
	let text = "";
	const signal = options.signal;
	const session = (await loadCodeBuddySdk()).unstable_v2_createSession({
		environment: codeBuddyEnvironment(region),
		sessionId: randomUUID(),
		...model === void 0 ? {} : { model },
		...cliEnv(region),
		tools: [],
		settingSources: [],
		persistSession: false
	});
	const onAbort = () => {
		session.interrupt().catch(() => void 0);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.send(prompt);
		for await (const message of session.stream()) {
			if (signal?.aborted === true) break;
			if (message.type === "assistant") text += message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		}
	} catch (error) {
		if (signal?.aborted !== true) throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		session.close();
	}
	if (signal?.aborted === true) {
		chunks.push({
			type: "finish",
			reason: {
				kind: "aborted",
				failure: {
					message: "aborted by host",
					code: "ABORTED"
				}
			}
		});
		return chunks;
	}
	if (text.length === 0) {
		chunks.push({
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: "CodeBuddy side-channel returned no content",
					code: EMPTY_RESPONSE_CODE
				}
			}
		});
		return chunks;
	}
	chunks.push({
		type: "block-start",
		index: 0,
		blockType: "text"
	});
	for (let i = 0; i < text.length; i += 192) chunks.push({
		type: "text-delta",
		index: 0,
		text: text.slice(i, i + 192)
	});
	chunks.push({
		type: "block-end",
		index: 0,
		block: {
			type: "text",
			text
		}
	});
	chunks.push({
		type: "usage",
		usage: {
			inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
			outputTokens: Math.max(1, Math.ceil(text.length / 4))
		}
	});
	chunks.push({
		type: "finish",
		reason: { kind: "stop" }
	});
	return chunks;
}
//#endregion
//#region src/host/providers/codebuddy/adapter.ts
/**
* `CodeBuddyAdapter`: route the harness LLM seam onto a CodeBuddy account.
*
* One CodeBuddy provider serves both login regions; the account, catalog and
* warm sessions all follow the configured region. The inner CLI owns the
* conversation, so the adapter only decides what new text to send and which
* tool round the host is answering.
*
* @module dsh-agent-sdk-bridge/codebuddy-adapter
*/
/** The CodeBuddy provider route. */
const CODEBUDDY_PROVIDER = "codebuddy";
/** Map a harness-side id onto a CodeBuddy model value. */
function resolveCodeBuddyModelId(model, aliases = {}) {
	return resolveAliasedModelId(model, aliases, "codebuddy-", "default-model");
}
/** The CodeBuddy-backed adapter. */
var CodeBuddyAdapter = class extends LlmAdapter {
	options;
	sessions;
	catalog;
	accounts;
	auth = new CodeBuddyAuth();
	deny = new DenyList();
	/** Last verified image capability, keyed `${region}:${model}`. */
	knownVision = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		super();
		this.options = options;
		this.sessions = new CodeBuddySessionManager(options.maxSessions ?? 8, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs,
			drainMs: options.drainMs
		});
		this.catalog = new CodeBuddyCatalog(options.region ?? (() => "global"), options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 3e4);
		this.accounts = new CodeBuddyAccountReader(options.region ?? (() => "global"), options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 3e4);
	}
	get region() {
		return readLive(this.options.region ?? (() => "global"), "global");
	}
	disabledFor(region) {
		return this.deny.of(region, this.options.disabledModels?.(region) ?? NO_MODELS$1);
	}
	get aliases() {
		return readLive(this.options.modelAliases, NO_ALIASES$1);
	}
	get displayName() {
		return readLive(this.options.displayName, "CodeBuddy");
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/** The live catalog, unfiltered (the page must show switched-off models). */
	async describeCatalog(region = this.region) {
		if (!this.isSignedIn(region)) return [];
		const models = await this.catalog.models(region);
		for (const model of models) this.knownVision.set(`${region}:${model.id}`, model.vision);
		return models;
	}
	/** Whether the selected (or given) region has a stored login. */
	isSignedIn(region = this.region) {
		return this.auth.status(region).signedIn === true;
	}
	/** Why the last catalog read failed, for the page's guidance. */
	catalogError(region = this.region) {
		if (!this.isSignedIn(region)) return "请先登录 CodeBuddy，登录后才会读取并显示模型目录。";
		return this.catalog.error(region);
	}
	invalidateCatalog(region) {
		this.catalog.invalidate(region);
	}
	/** The signed-in account, or the reason it could not be read. */
	async usageInfo(fresh = false, region) {
		return this.accounts.read(fresh, region);
	}
	invalidateUsage(region) {
		this.accounts.invalidate(region);
	}
	/** Login progress for one region; the page polls this. */
	authStatus(region) {
		return this.auth.status(region);
	}
	startLogin(region) {
		return this.auth.start(region, (ok) => {
			if (!ok) return;
			this.sessions.closeAll("account");
			this.catalog.discardControl(region);
			this.invalidateCatalog(region);
			this.invalidateUsage(region);
		});
	}
	async logout(region) {
		const result = await this.auth.logout(region);
		this.sessions.closeAll("account");
		this.catalog.discardControl(region);
		this.invalidateCatalog(region);
		this.invalidateUsage(region);
		return result;
	}
	isModelDisabled(id, region = this.region) {
		return this.disabledFor(region).has(id);
	}
	/** Whether the resolved model accepts images (drives whether pixels are sent). */
	async modelVision(model) {
		const target = resolveCodeBuddyModelId(model, this.aliases);
		const key = `${this.region}:${target}`;
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.models())).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			return live.vision;
		}
		return this.knownVision.get(key) === true;
	}
	/**
	* Turn a feed into what one CLI turn receives.
	*
	* A text-only feed stays a plain string (the historical shape); a feed with
	* readable images becomes the SDK's `ContentBlock[]`, because that is the
	* only shape the CLI sends to the model as pixels. See {@link buildVisionFeed}.
	*/
	async buildFeed(feed, vision, signal) {
		return await buildVisionFeed(feed, vision, {
			imagePath: this.options.imagePath,
			readImage: this.options.readImage,
			signal,
			blocks: {
				text: (text) => ({
					type: "text",
					text
				}),
				image: (data, mediaType) => ({
					type: "image",
					source: {
						type: "base64",
						media_type: mediaType,
						data
					}
				})
			}
		});
	}
	/**
	* The window this model actually runs with.
	*
	* The user's override only applies where the provider accepts one. Every
	* model in the current catalog reports `supportedLengths: null`, so the CLI
	* answers a `set_config.contextWindow` with `Allowed: <none>`; a stored
	* override would then make DSH show a denominator the upstream never uses,
	* which is exactly how the context ring drifted.
	*/
	contextWindowFor(id, region = this.region) {
		const override = this.options.modelContextWindows?.(region)[id];
		if (override === void 0) return void 0;
		const live = this.models(region).find((entry) => entry.id === id);
		if (live === void 0) return override;
		return live.contextWindows.includes(override) ? override : void 0;
	}
	/** The catalog snapshot the adapter last read (empty before the first read). */
	models(region) {
		return this.catalog.snapshot(region) ?? [];
	}
	/** Whether this model lets the user pick a context budget at all. */
	supportsContextWindowChoice(id, region = this.region) {
		const live = this.models(region).find((entry) => entry.id === id);
		return live !== void 0 && live.contextWindows.length > 0;
	}
	async listModels(provider) {
		const region = this.region;
		if (!this.isSignedIn(region)) return [];
		const models = await this.catalog.models(region);
		const disabled = this.disabledFor(region);
		return models.filter((model) => !disabled.has(model.id)).map((model) => modelInfo$1(provider, model));
	}
	async resolveModel(provider, model) {
		const target = resolveCodeBuddyModelId(model, this.aliases);
		const key = `${this.region}:${target}`;
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.models())).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			const reasoning = reasoningInfo(live.reasoningEfforts, readLiveOptional(this.options.defaultReasoningEffort), (live.reasoningEfforts?.length ?? 0) > 0);
			return {
				provider,
				id: model,
				name: live.name,
				...live.description === void 0 ? {} : { description: live.description },
				inputModalities: live.vision ? ["text", "image"] : ["text"],
				context: { contextWindow: this.contextWindowFor(target) ?? live.defaultContextWindow },
				defaultMaxTokens: live.maxOutputTokens ?? readLive(this.options.defaultMaxTokens, 32e3),
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const reasoning = reasoningInfo(void 0, readLiveOptional(this.options.defaultReasoningEffort), true);
		return {
			provider,
			id: model,
			name: model,
			inputModalities: this.knownVision.get(key) === true ? ["text", "image"] : ["text"],
			context: { contextWindow: this.contextWindowFor(target) ?? 2e5 },
			defaultMaxTokens: readLive(this.options.defaultMaxTokens, CODEBUDDY_DEFAULT_MAX_TOKENS),
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.dispatch(options)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options);
	}
	async *dispatch(options) {
		const region = this.region;
		if (!this.isSignedIn(region)) throw new Error(`${region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版"}尚未登录，请先在设置 → CodeBuddy 中登录。`);
		const model = resolveCodeBuddyModelId(options.model, this.aliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderSideChannelFeed(options.system, options.messages, this.options.imagePath), this.options.imagePath);
			for (const chunk of await codeBuddyColdStream(region, prompt, model, options)) yield chunk;
			return;
		}
		const sessionId = String(options.sessionId);
		const effort = options.reasoningEffort ?? readLiveOptional(this.options.defaultReasoningEffort);
		let session = this.sessions.forSession(sessionId, region, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		const vision = await this.modelVision(options.model);
		const images = await resolveTurnImages(tail, vision, this.options.readImage, options.signal);
		session.deliverToolResults(tail, images);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, region, model);
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options),
			...await this.windowOption(model)
		});
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, vision, options.signal);
		yield* session.stream(options, feed);
	}
	async *firstTurn(session, options, region, model, effort) {
		session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options),
			...await this.windowOption(model)
		});
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const vision = await this.modelVision(options.model);
		const feed = await this.buildFeed(renderInitialFeed(void 0, options.messages, this.options.imagePath), vision, options.signal);
		yield* session.stream(options, feed);
	}
	/**
	* The context window the host and the inner session must agree on.
	*
	* Only a model that offers selectable budgets is configured: one fixed
	* window rejects every value, so the CLI's own default already matches what
	* the host shows. For a model with choices the adapter sends the picked
	* value; returning to "default" sends the model's own default budget, since
	* the CLI rejects a null clear (`contextWindow must be a positive safe
	* integer`). The override lives for the life of the CLI process, so the
	* default has to be sent explicitly to drop a previous choice.
	*/
	async windowOption(model) {
		const live = (await this.catalog.models(this.region)).find((entry) => entry.id === model);
		if (live === void 0 || live.contextWindows.length === 0) return {};
		const chosen = this.options.modelContextWindows?.(this.region)[model];
		return { contextWindow: chosen !== void 0 && live.contextWindows.includes(chosen) ? chosen : live.defaultContextWindow };
	}
	cwdOf(options) {
		return options.cwd;
	}
	/**
	* Tear down every warm session and the control sessions (plugin dispose).
	*
	* The pool is sealed rather than merely cleared: a step prepared before the
	* unload can still be retried through this adapter instance, and a session
	* created then would outlive every owner it has.
	*/
	close() {
		this.sessions.seal("dispose");
		this.catalog.close();
	}
};
//#endregion
//#region src/host/surface/api.ts
/** Route prefix this plugin owns; the client resolves it relative to the page. */
const API_PREFIX = "/api/llm-qoder-cn";
/** Answer one request with JSON. */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** Build model rows for a Qoder adapter. */
async function buildRows(adapter) {
	return (await adapter.describeCatalog()).map((entry) => {
		const override = adapter.contextWindowFor(entry.value);
		const upstream = entry.defaultContextWindow ?? (entry.availableContextWindows !== void 0 && entry.availableContextWindows.length > 0 ? Math.max(...entry.availableContextWindows) : entry.maxInputTokens) ?? 2e5;
		const choices = new Set(entry.availableContextWindows ?? []);
		choices.add(upstream);
		if (override !== void 0) choices.add(override);
		const priceFactor = priceFactorOf(entry);
		return {
			id: entry.value,
			name: entry.displayName.length > 0 ? entry.displayName : entry.value,
			...entry.description.length > 0 ? { description: entry.description } : {},
			enabled: !adapter.isModelDisabled(entry.value),
			vision: entry.isVl === true,
			contextWindow: override ?? upstream,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: upstream,
			...override === void 0 ? {} : { override },
			...priceFactor === void 0 ? {} : { priceFactor },
			reasoning: entry.isReasoning !== false,
			contextWindowSelectable: (entry.availableContextWindows?.length ?? 0) > 1
		};
	});
}
/** Build model rows for the CodeBuddy adapter, for one login region. */
async function buildCodeBuddyRows(adapter, region) {
	return (await adapter.describeCatalog(region)).map((entry) => {
		const override = adapter.contextWindowFor(entry.id, region);
		const choices = new Set(entry.contextWindows);
		if (override !== void 0) choices.add(override);
		return {
			id: entry.id,
			name: entry.name,
			...entry.description === void 0 ? {} : { description: entry.description },
			enabled: !adapter.isModelDisabled(entry.id, region),
			vision: entry.vision,
			contextWindow: override ?? entry.defaultContextWindow,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: entry.defaultContextWindow,
			...override === void 0 ? {} : { override },
			...entry.priceFactor === void 0 ? {} : { priceFactor: entry.priceFactor },
			reasoning: (entry.reasoningEfforts?.length ?? 0) > 0,
			contextWindowSelectable: entry.contextWindows.length > 0
		};
	});
}
/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 2048;
/** Read and parse a small JSON request body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const part of req) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new Error("缺少请求体");
	return JSON.parse(text);
}
/** The brand a query-string or body selected, or undefined when it named none. */
function brandFrom(value) {
	if (value === null || value === void 0 || value === "") return "cn";
	return isBrandId(value) ? value : void 0;
}
/** A CodeBuddy region from a query or body, defaulting to the international one. */
function regionFrom(value) {
	if (value === null || value === void 0 || value === "") return "global";
	return isCodeBuddyRegion(value) ? value : void 0;
}
/** Handle one request under {@link API_PREFIX}. */
async function handleApi(req, res, adapters) {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.slice(17) || "/";
		const method = req.method ?? "GET";
		const queryBrand = brandFrom(url.searchParams.get("brand"));
		if (queryBrand === void 0) {
			send(res, 400, { error: "brand 只接受 cn、global 或 codebuddy" });
			return;
		}
		const adapter = adapters[queryBrand];
		const codebuddy = queryBrand === "codebuddy" ? adapter : void 0;
		if (path === "/models" && method === "GET") {
			const requestedRegion = url.searchParams.get("region");
			const region = requestedRegion === null || requestedRegion === "" ? void 0 : regionFrom(requestedRegion);
			if (codebuddy !== void 0 && region === void 0 && requestedRegion !== null && requestedRegion !== "") {
				send(res, 400, { error: "region 只接受 global 或 cn" });
				return;
			}
			if (url.searchParams.get("fresh") === "1") {
				if (codebuddy !== void 0) codebuddy.invalidateCatalog(region);
				else adapter.invalidateCatalog();
			}
			const signedIn = codebuddy?.isSignedIn(region);
			const rows = codebuddy !== void 0 ? signedIn === false ? [] : await buildCodeBuddyRows(codebuddy, region) : await buildRows(adapter);
			const notice = rows.length === 0 ? codebuddy !== void 0 ? codebuddy.catalogError(region) : adapter.catalogError() : void 0;
			send(res, 200, {
				brand: queryBrand,
				models: rows,
				...region === void 0 ? {} : { region },
				...signedIn === void 0 ? {} : { signedIn },
				...notice === void 0 ? {} : { notice }
			});
			return;
		}
		if (path === "/usage" && method === "GET") {
			const requested = url.searchParams.get("region");
			const region = requested === null || requested === "" ? void 0 : regionFrom(requested);
			if (codebuddy !== void 0 && region === void 0 && requested !== null && requested !== "") {
				send(res, 400, { error: "region 只接受 global 或 cn" });
				return;
			}
			const fresh = url.searchParams.get("fresh") === "1";
			send(res, 200, {
				brand: queryBrand,
				...codebuddy !== void 0 ? await codebuddy.usageInfo(fresh, region) : await adapter.usageInfo(fresh),
				...codebuddy === void 0 ? {} : { signedIn: codebuddy.isSignedIn(region) }
			});
			return;
		}
		if (path === "/auth") {
			if (method === "GET") {
				if (codebuddy === void 0) {
					send(res, 404, { error: "该 provider 没有浏览器登录流程" });
					return;
				}
				const region = regionFrom(url.searchParams.get("region"));
				if (region === void 0) {
					send(res, 400, { error: "region 只接受 global 或 cn" });
					return;
				}
				send(res, 200, {
					brand: "codebuddy",
					...codebuddy.authStatus(region)
				});
				return;
			}
			if (method === "POST") {
				let body;
				try {
					body = await readJson(req) ?? {};
				} catch (error) {
					send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				if (brandFrom(body.brand) !== "codebuddy") {
					send(res, 400, { error: "该 provider 没有浏览器登录流程" });
					return;
				}
				const region = regionFrom(body.region);
				if (region === void 0) {
					send(res, 400, { error: "region 只接受 global 或 cn" });
					return;
				}
				if (body.action !== "login" && body.action !== "logout") {
					send(res, 400, { error: "action 只接受 login 或 logout" });
					return;
				}
				const cb = adapters.codebuddy;
				if (body.action === "logout") {
					const result = await cb.logout(region);
					if (!result.ok) {
						send(res, 500, { error: result.error });
						return;
					}
					send(res, 200, {
						brand: "codebuddy",
						...cb.authStatus(region)
					});
					return;
				}
				const started = cb.startLogin(region);
				if (started.started === false) {
					send(res, 409, { error: started.error });
					return;
				}
				send(res, 200, {
					brand: "codebuddy",
					...cb.authStatus(region)
				});
				return;
			}
		}
		send(res, method === "GET" ? 404 : 405, { error: method === "GET" ? "not found" : "不支持的写入路径" });
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion
//#region src/host/core/config.ts
/**
* The plugin's configuration surface.
*
* DSH's settings service reads a plugin's exported `Config` schema and, when no
* custom page is registered for that entry, auto-generates a settings page from
* it (`autoGenerate` defaults to true in `dsh-settings`). That makes this schema
* the single source of truth for both runtime behaviour and the settings UI —
* every field documented here appears as a labelled control, and its
* `description` becomes the help text under it.
*
* Field order matters: the generated form renders in declaration order, so the
* groups below are arranged the way a user reads them (identity → capacity →
* context → timeouts → models → aliases).
*
* @module dsh-agent-sdk-bridge/config
*/
/**
* The configuration schema. This is what DSH turns into the settings page, so
* the defaults and bounds here are user-visible documentation.
*
* ## Why every field is `.volatile()`
*
* DSH's settings service builds its form from `volatileForm(schema)`, which
* keeps a field ONLY when the node (or an ancestor) carries `meta.volatile`;
* an object whose fields are all non-volatile collapses to `undefined` and the
* whole namespace is dropped from `describe()` before any client sees it. A
* plugin with a plain schema therefore registers successfully, streams models
* correctly, and still shows no settings page anywhere — the namespace never
* reaches the wire.
*
* ## What `.volatile()` costs: read every field at use
*
* A volatile-only edit does not restart the plugin. The loader writes the new
* value into the *same* `Volatile` cell the running plugin already holds and
* skips the rest of the update lifecycle, so `apply()` is never called again
* (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`). Capturing a
* field in `apply()` therefore freezes it for the lifetime of the process, and
* the plugin answers with mount-time values while the settings page and the
* profile patch on disk show the new ones.
*
* That is why the whole plugin consumes its config through {@link liveConfig},
* which returns a thunk per field: the value is unwrapped from its volatile
* reference at every read, so an in-place edit is visible immediately. See
* `src/core/live.ts` for the full mechanism.
*/
const Config$1 = z$1.object({
	cnEnabled: z$1.boolean().default(true).description("启用 Qoder CN。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	intlEnabled: z$1.boolean().default(true).description("启用 Qoder 国际版。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	codebuddyEnabled: z$1.boolean().default(true).description("启用 CodeBuddy。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	disabledModels: z$1.array(z$1.string()).default([]).description("已关闭的模型 ID 列表（以 Qoder 模型 ID 为准）。关闭的模型不会出现在模型选择器里。").volatile(),
	modelContextWindows: z$1.dict(z$1.number()).default({}).description("按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。").volatile(),
	intlDisabledModels: z$1.array(z$1.string()).default([]).description("国际版已关闭的模型 ID 列表。与 CN 列表分开，因为两边的模型目录不同。").volatile(),
	intlModelContextWindows: z$1.dict(z$1.number()).default({}).description("国际版按模型指定的上下文窗口（token 数）。").volatile(),
	intlModelAliases: z$1.dict(z$1.string()).default({}).description("国际版额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。").volatile(),
	intlDisplayName: z$1.string().default("Qoder 国际版").description("模型选择器里国际版分组的名称。").volatile(),
	codebuddyRegion: z$1.string().default("global").description("CodeBuddy 登录区域：global（国际版，codebuddy.ai）或 cn（国内版，copilot.tencent.com）。切换后使用对应区域的登录态。").volatile(),
	codebuddyDisplayName: z$1.string().default("CodeBuddy").description("模型选择器里 CodeBuddy 分组的名称。").volatile(),
	codebuddyGlobalDisabledModels: z$1.array(z$1.string()).default([]).description("CodeBuddy 国际版（codebuddy.ai）已关闭的模型 ID 列表。").volatile(),
	codebuddyCnDisabledModels: z$1.array(z$1.string()).default([]).description("CodeBuddy 国内版（copilot.tencent.com）已关闭的模型 ID 列表。").volatile(),
	codebuddyGlobalModelContextWindows: z$1.dict(z$1.number()).default({}).description("CodeBuddy 国际版按模型指定的上下文窗口（token 数）。").volatile(),
	codebuddyCnModelContextWindows: z$1.dict(z$1.number()).default({}).description("CodeBuddy 国内版按模型指定的上下文窗口（token 数）。").volatile(),
	codebuddyModelAliases: z$1.dict(z$1.string()).default({}).description("CodeBuddy 额外的模型别名映射：DSH 侧名称 → CodeBuddy 模型 ID。").volatile(),
	displayName: z$1.string().default("Qoder CN").description("模型选择器里主分组的名称。同时使用多个 Qoder 账号时可区分。").volatile(),
	maxSessions: z$1.number().step(1).min(1).max(64).default(8).description("同时保持的空闲内层会话数上限，超出后按最久未使用关闭；进行中的轮次不会被驱逐。每个会话是一个子进程。").volatile(),
	modelCacheTtlSeconds: z$1.number().step(1).min(10).max(86400).default(300).description("模型列表缓存时长（秒）。调小可更快看到账号侧变化。").volatile(),
	modelAliases: z$1.dict(z$1.string()).default({}).description("额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。内置 deepseek-v4-* 别名仍然生效。").volatile(),
	defaultReasoningEffort: z$1.string().default("").description("默认选用的思考档位；留空则用该模型支持的最强档位。").volatile(),
	defaultMaxTokens: z$1.number().step(1).min(1).default(32e3).description("模型未声明输出上限时使用的输出上限。").volatile(),
	toolResultTimeoutSeconds: z$1.number().step(1).min(5).max(3600).default(120).description("仅用于未配对 handler 的兜底时限（秒）：正常工具调用会等宿主下一次请求携带结果，不按此超时。").volatile(),
	catalogFetchTimeoutSeconds: z$1.number().step(1).min(1).max(300).default(20).description("拉取模型列表的时限（秒），超时后回退到内置列表。").volatile(),
	abortGraceSeconds: z$1.number().step(1).min(1).max(120).default(5).description("内层进程确认中断的宽限时间（秒）。").volatile(),
	disposeDrainSeconds: z$1.number().step(1).min(0).max(600).default(120).description("插件被重新加载/停用时，允许进行中的轮次跑完的宽限（秒）。0 表示立即关闭（会截断正在生成的回答）。").volatile(),
	traceEnabled: z$1.boolean().default(true).description("把会话启停、轮次结束与插件装载写入 ~/.dsh/agent-sdk-bridge/bridge.log（JSONL，4 MB 轮转）。排查「突然断线」时先看这里。").volatile(),
	coldMaxTurns: z$1.number().step(1).min(1).max(32).default(4).description("旁路请求（生成标题、压缩摘要）允许的最大内层轮次。").volatile()
});
/**
* Wrap a parsed config as {@link LiveConfig}.
*
* Every normalizer below is the single interpretation of a raw field: the
* running plugin reads its config only through this view, so a value can never
* be resolved one way at mount and another way later.
*
* @param config - the parsed plugin config, possibly partial or absent.
* @returns one thunk per resolved field, each reading the live cell.
*/
function liveConfig(config) {
	const source = config ?? {};
	/**
	* One field's current value.
	*
	* The volatile unwrap happens on every call rather than once, which is the
	* entire point: the reference object outlives an edit, only its contents
	* change.
	*/
	const field = (key) => {
		const value = source[key];
		return isVolatile(value) ? value.get() : value;
	};
	return {
		cnEnabled: () => bool(field("cnEnabled"), true),
		intlEnabled: () => bool(field("intlEnabled"), true),
		codebuddyEnabled: () => bool(field("codebuddyEnabled"), true),
		codebuddyRegion: () => field("codebuddyRegion") === "cn" ? "cn" : "global",
		displayName: () => nonEmpty(field("displayName"), "Qoder CN"),
		maxSessions: () => positive(field("maxSessions"), 8),
		modelCacheTtlMs: () => positive(field("modelCacheTtlSeconds"), 300) * 1e3,
		defaultMaxTokens: () => positive(field("defaultMaxTokens"), 32e3),
		toolResultTimeoutMs: () => positive(field("toolResultTimeoutSeconds"), 120) * 1e3,
		catalogFetchTimeoutMs: () => positive(field("catalogFetchTimeoutSeconds"), 20) * 1e3,
		abortGraceMs: () => positive(field("abortGraceSeconds"), 5) * 1e3,
		disposeDrainMs: () => nonNegative(field("disposeDrainSeconds"), 120) * 1e3,
		traceEnabled: () => bool(field("traceEnabled"), true),
		coldMaxTurns: () => positive(field("coldMaxTurns"), 4),
		disabledModels: () => stringList(field("disabledModels")),
		modelContextWindows: () => numberMap(field("modelContextWindows")),
		modelAliases: () => stringMap(field("modelAliases")),
		defaultReasoningEffort: () => {
			const raw = field("defaultReasoningEffort");
			const effort = typeof raw === "string" ? raw.trim() : "";
			return effort.length > 0 ? effort : void 0;
		},
		intlDisplayName: () => nonEmpty(field("intlDisplayName"), "Qoder 国际版"),
		intlDisabledModels: () => stringList(field("intlDisabledModels")),
		intlModelContextWindows: () => numberMap(field("intlModelContextWindows")),
		intlModelAliases: () => stringMap(field("intlModelAliases")),
		codebuddyDisplayName: () => nonEmpty(field("codebuddyDisplayName"), "CodeBuddy"),
		codebuddyGlobalDisabledModels: () => stringList(field("codebuddyGlobalDisabledModels")),
		codebuddyCnDisabledModels: () => stringList(field("codebuddyCnDisabledModels")),
		codebuddyGlobalModelContextWindows: () => numberMap(field("codebuddyGlobalModelContextWindows")),
		codebuddyCnModelContextWindows: () => numberMap(field("codebuddyCnModelContextWindows")),
		codebuddyModelAliases: () => stringMap(field("codebuddyModelAliases"))
	};
}
function nonEmpty(value, fallback) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
* A number that may legitimately be zero, with a default when absent.
*
* Separate from {@link positive} because `0` is a meaningful setting here
* (`disposeDrainSeconds: 0` means "close immediately", the old behaviour).
*/
function nonNegative(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** A boolean with a default for a value the form has not supplied yet. */
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}
/**
* Keep only the positive, finite entries of a map.
*
* A window of zero or a negative number would be passed straight to the
* harness as a capacity, so invalid entries are dropped here rather than
* rejected — one bad row must not discard the user's other choices.
*/
function numberMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = entry;
	return out;
}
function stringMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" && entry.trim().length > 0) out[key] = entry.trim();
	return out;
}
//#endregion
//#region src/host/index.ts
/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
const name = "llm-qoder-cn";
/** The LLM registry must exist before an adapter can be registered on it. */
const inject = ["llm"];
/**
* Configuration namespace: the profile entry id this plugin is mounted under.
* The settings service and the configurable-provider directory both address the
* plugin by this key, and the exported {@link ConfigSchema} is the form source,
* so no page has to be registered by hand.
*/
const NS = "llm-qoder-cn";
/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1048576;
/**
* Config fields whose value decides a registration shape rather than a runtime
* behaviour, and which therefore cannot be read lazily.
*
* The edition switches decide which routes exist at all; the two display names
* are copied into the picker directory. Everything else is read where it is
* used, so a change to these fields is the only thing that needs a republish.
*/
const STRUCTURAL_FIELDS = /* @__PURE__ */ new Set([
	"cnEnabled",
	"intlEnabled",
	"codebuddyEnabled",
	"displayName",
	"intlDisplayName",
	"codebuddyDisplayName"
]);
/**
* How many times this module's `apply()` has run in this process.
*
* A volatile-only settings edit is committed into the running plugin and does
* NOT re-enter `apply()`, so this counter is the only direct evidence of an
* entry rebuild — the question a "the conversation dropped right after I saved
* settings" report turns on. It is logged with the boot id, which changes when
* the module is re-evaluated at all.
*/
let applyCount = 0;
/** The configurable-provider directory rows for the enabled editions. */
function directoryFor(live) {
	const rows = [];
	if (live.cnEnabled()) rows.push({
		provider: QODER_PROVIDER,
		displayName: live.displayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.intlEnabled()) rows.push({
		provider: QODER_INTL_PROVIDER,
		displayName: live.intlDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.codebuddyEnabled()) rows.push({
		provider: CODEBUDDY_PROVIDER,
		displayName: live.codebuddyDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	return rows;
}
/**
* The plugin's configuration schema, re-exported under the name the loader
* looks for. DSH reads `runtime.Config` off the plugin fiber to build the
* settings page, so this must stay the exported `Config` binding.
*
* Every field is `.volatile()`, which is what makes the namespace appear in
* `settings.describe()` at all — see the note on {@link ConfigSchema}.
*/
const Config = Config$1;
/**
* Mount the adapter for the lifetime of the plugin.
*
* @param ctx - the plugin's cordis context.
* @param config - parsed plugin config, whose volatile fields arrive as
*   references. {@link liveConfig} wraps them as thunks the adapter reads where
*   it uses them, so an edit applies without this function running again; an
*   empty object is a valid deployment.
*/
function apply(ctx, config) {
	const live = liveConfig(config);
	let attachments;
	let filesystem;
	setTraceGate(live.traceEnabled);
	applyCount += 1;
	trace("apply", { n: applyCount });
	/**
	* Everything both editions share.
	*
	* Images reach the inner model only through the host attachment store, so
	* this stays a lazy lookup. An unmounted store leaves the adapter with no
	* reader, and images degrade to the harness's own handle text instead of
	* failing the turn — which is also why `attachments` is not a hard inject:
	* the provider routes must register even on a deployment without one.
	*/
	const shared = {
		maxSessions: live.maxSessions,
		modelCacheTtlMs: live.modelCacheTtlMs,
		toolResultTimeoutMs: live.toolResultTimeoutMs,
		abortGraceMs: live.abortGraceMs,
		drainMs: live.disposeDrainMs,
		coldMaxTurns: live.coldMaxTurns,
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
		defaultMaxTokens: live.defaultMaxTokens,
		defaultReasoningEffort: live.defaultReasoningEffort,
		readImage: (ref, signal) => {
			const store = attachments;
			if (store === void 0) return Promise.resolve(void 0);
			return store.readImageRequest(ref, {
				width: ref.width,
				height: ref.height,
				maxBytes: REQUEST_IMAGE_MAX_BYTES
			}, signal).then((image) => ({
				bytes: image.data,
				mediaType: image.mediaType
			}));
		},
		/**
		* Where the model can find the image on disk. Pixels let it describe the
		* picture; this path lets a "modify and save it" turn act on the file
		* instead of searching the workspace for something that was never there.
		*/
		imagePath: (ref) => {
			const store = attachments;
			if (store === void 0) return void 0;
			const hostPath = store.imageHostPath(ref);
			if (hostPath === void 0) return void 0;
			return filesystem?.processPathFromHostPath?.(hostPath) ?? hostPath;
		}
	};
	/**
	* One adapter per provider.
	*
	* Separate instances, not one instance on several routes: each carries its
	* own catalog, warm sessions, account reading and user choices, so a request
	* can never be resolved against another provider's catalog.
	*/
	const adapters = {
		cn: new QoderAdapter({
			...shared,
			brand: "cn",
			displayName: live.displayName,
			disabledModels: live.disabledModels,
			modelContextWindows: live.modelContextWindows,
			modelAliases: live.modelAliases
		}),
		global: new QoderAdapter({
			...shared,
			brand: "global",
			displayName: live.intlDisplayName,
			disabledModels: live.intlDisabledModels,
			modelContextWindows: live.intlModelContextWindows,
			modelAliases: live.intlModelAliases
		}),
		codebuddy: new CodeBuddyAdapter({
			maxSessions: live.maxSessions,
			modelCacheTtlMs: live.modelCacheTtlMs,
			catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
			toolResultTimeoutMs: live.toolResultTimeoutMs,
			abortGraceMs: live.abortGraceMs,
			drainMs: live.disposeDrainMs,
			defaultMaxTokens: live.defaultMaxTokens,
			defaultReasoningEffort: live.defaultReasoningEffort,
			displayName: live.codebuddyDisplayName,
			region: live.codebuddyRegion,
			disabledModels: (region) => region === "cn" ? live.codebuddyCnDisabledModels() : live.codebuddyGlobalDisabledModels(),
			modelContextWindows: (region) => region === "cn" ? live.codebuddyCnModelContextWindows() : live.codebuddyGlobalModelContextWindows(),
			modelAliases: live.codebuddyModelAliases,
			readImage: shared.readImage,
			imagePath: shared.imagePath
		})
	};
	ctx.inject(["attachments"], (scope) => {
		attachments = scope.attachments;
		scope.effect(() => () => {
			attachments = void 0;
		}, "llm-qoder-cn.attachments");
	});
	ctx.inject(["fs"], (scope) => {
		filesystem = scope.fs;
		scope.effect(() => () => {
			filesystem = void 0;
		}, "llm-qoder-cn.fs");
	});
	const routes = {};
	let directory;
	const enabled = (id) => {
		if (id === "cn") return live.cnEnabled();
		if (id === "global") return live.intlEnabled();
		return live.codebuddyEnabled();
	};
	/**
	* Bring the registered routes and the picker directory in line with the
	* current switches and labels.
	*
	* `registerAdapter` refuses an empty provider list, which is why a disabled
	* provider is *not registered* instead of being registered and then hidden:
	* the route itself has to disappear so no request can reach it and no model
	* list is offered for it. Turning it back on registers a fresh handle.
	*/
	const syncRegistration = () => {
		for (const brand of BRANDS) {
			const current = routes[brand.id];
			if (enabled(brand.id) && current === void 0) routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id]);
			else if (!enabled(brand.id) && current !== void 0) {
				current();
				delete routes[brand.id];
			}
		}
		const entries = directoryFor(live);
		if (entries.length === 0) {
			directory?.();
			directory = void 0;
		} else if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
	};
	syncRegistration();
	/**
	* React to a structural config edit.
	*
	* A volatile-only edit does not re-run `apply()`, so this is the only place
	* the route set, the picker labels and the enabled editions can follow it.
	*/
	ctx.on("loader/volatile-update", (paths) => {
		trace("volatile-update", { paths: paths.map((path) => path.map(String).join(".")) });
		if (!paths.some((path) => STRUCTURAL_FIELDS.has(String(path[0])))) return;
		try {
			syncRegistration();
		} catch (error) {
			ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`);
		}
	});
	ctx.effect(() => () => {
		trace("dispose", {
			n: applyCount,
			boot: BOOT_ID
		});
		adapters.cn.close();
		adapters.global.close();
		adapters.codebuddy.close();
	}, "llm-qoder-cn.sessions");
	ctx.inject(["webServer"], (scope) => {
		const server = scope.webServer;
		if (server === void 0) return;
		scope.effect(() => server.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: (req, res) => {
				handleApi(req, res, adapters);
			}
		}), "llm-qoder-cn: settings api");
		ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`);
	});
}
//#endregion
export { API_PREFIX, BRANDS, CN_BRAND, CODEBUDDY_BRAND, CODEBUDDY_DEFAULT_CONTEXT_WINDOW, CODEBUDDY_DEFAULT_MAX_TOKENS, CODEBUDDY_PROVIDER, CloseGate, CodeBuddyAccountReader, CodeBuddyAdapter, CodeBuddyAuth, CodeBuddyCatalog, CodeBuddySession, CodeBuddySessionManager, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_DRAIN_MS, DEFAULT_MAX_TOKENS, DEFAULT_SESSION_IDLE_MS, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS, GLOBAL_BRAND, MODEL_ALIASES, NARROW_CHARS_PER_TOKEN, QODER_INTL_PROVIDER, QODER_MODELS, QODER_PROVIDER, QoderAdapter, QoderModelCatalog, QoderSession, QoderSessionManager, QoderUsage, ToolResultPairing, WIDE_CHARS_PER_TOKEN, apply, brandProfile, buildRows, cliContextWindow, closeFinishReason, codeBuddyColdStream, codeBuddyEnvironment, countWideChars, estimateTextTokens, fetchCodeBuddyQuota, handleApi, inject, isBrandId, isWideChar, liveConfig, loadCodeBuddySdk, loadSdk, name, parseCodeBuddyQuota, pickContextWindow, priceFactorOf, readLive, readLiveOptional, resolveCodeBuddyModelId, resolveQoderModelId, toCodeBuddyModel };
