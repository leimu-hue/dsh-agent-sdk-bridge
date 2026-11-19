/**
 * CodeBuddy's per-region process environment and credential cache.
 *
 * Every CodeBuddy call is a fresh child process, and two facts decide what that
 * process sees: which `CODEBUDDY_CONFIG_DIR` it runs against and whether a
 * bearer token is attached. Both are region-scoped — a shared directory let one
 * region read the other's catalog and overwrite its login — so they live here,
 * once, instead of being threaded through the catalog, account and session
 * modules separately.
 *
 * @module dsh-agent-sdk-bridge/codebuddy/cli
 */
import type { CodeBuddyRegion } from '../../core/brand.ts';
import type { CodeBuddySavedUser } from '../../infra/codebuddy-state.ts';
import { CodeBuddyStateStore } from '../../infra/codebuddy-state.ts';
/** How long one CodeBuddy account/catalog read stays fresh. */
export declare const CODEBUDDY_CACHE_TTL_MS = 300000;
/** Give up on one CodeBuddy control round trip after this long. */
export declare const CODEBUDDY_FETCH_TIMEOUT_MS = 30000;
/** The session object the SDK's createSession returns (not a named export). */
export type SessionImpl = ReturnType<typeof import('@tencent-ai/agent-sdk').unstable_v2_createSession>;
/** Persisted per-region login and account snapshots. */
export declare const codeBuddyState: CodeBuddyStateStore;
/** The region's bearer token, falling back to the persisted copy. */
export declare function tokenFor(region: CodeBuddyRegion): string | undefined;
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
export declare function cliEnv(region: CodeBuddyRegion): {
    env: Record<string, string>;
};
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
export declare function cliDirEnv(region: CodeBuddyRegion): Record<string, string>;
/** Remember a bearer token in memory and on disk. */
export declare function rememberBearerToken(region: CodeBuddyRegion, token: string, user?: CodeBuddySavedUser): void;
/** Stop using a credential without losing the remembered account card. */
export declare function forgetToken(region: CodeBuddyRegion): void;
