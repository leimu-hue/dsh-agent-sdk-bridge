/**
 * The settings pages' data source, served same-origin.
 *
 * The pages cannot read the model catalog from the config form: the catalog is
 * fetched live from the provider, while the form only carries what the user
 * stored. So the host answers these JSON routes:
 *
 * - `GET <prefix>/models?brand=cn|global|codebuddy` — the account's
 *   models, each with its enabled state and the windows it may use.
 * - `GET <prefix>/usage?brand=...` — the account reading. Qoder returns quota;
 *   CodeBuddy returns the signed-in account (its SDK exposes no quota call).
 * - `GET/POST <prefix>/auth` — CodeBuddy browser login/logout.
 *
 * The handler is deliberately brand-agnostic: it resolves a {@link SettingsSource}
 * and never sees a provider adapter, so adding a route or a brand does not
 * reintroduce a union type and a cast per branch.
 *
 * Config writes deliberately do NOT come through here. The browser half holds
 * a revision-fenced form for this plugin's namespace (`ctx.configForms`), and
 * routing every change through it means one write path and one revision fence.
 *
 * @module dsh-agent-sdk-bridge/api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SettingsSources } from './settings-source.ts';
/** Route prefix this plugin owns; the client resolves it relative to the page. */
export declare const API_PREFIX = "/api/llm-qoder-cn";
/** Handle one request under {@link API_PREFIX}. */
export declare function handleApi(req: IncomingMessage, res: ServerResponse, sources: SettingsSources): Promise<void>;
