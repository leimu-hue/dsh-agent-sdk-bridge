/**
 * The plugin entry: what DSH calls to mount the bridge.
 *
 * This module answers one question — how the harness mounts a plugin — and
 * delegates the two substantial answers next to it. {@link createBridge} owns
 * the provider adapters, the routes and picker groups that follow the edition
 * switches, and the warm-session teardown; `surface/api.ts` owns the settings
 * pages' HTTP reads. What remains here is the plugin contract itself: the
 * `name`/`inject`/`Config`/`apply` exports the loader reads, one counter that
 * makes an entry rebuild visible in the trace log, and the two mounts.
 *
 * ## Settings edits apply without a restart, and that shapes the wiring
 *
 * Every config field is volatile, and DSH commits a volatile-only edit into the
 * running plugin's config cells instead of restarting it — `apply()` is not
 * called again. The bridge is therefore handed {@link liveConfig} thunks and
 * reads each value where it uses it; see `src/core/live.ts` for the mechanism.
 *
 * @module dsh-agent-sdk-bridge
 */

import './core/events.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createBridge, SETTINGS_NS } from './bridge.ts'
import type { Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig } from './core/config.ts'
import { Config as ConfigSchema, liveConfig } from './core/config.ts'
import { BOOT_ID, setTraceGate, trace } from './infra/log.ts'
import { API_PREFIX, handleApi } from './surface/api.ts'
import { codeBuddySettings, qoderSettings } from './surface/settings-source.ts'
import type { SettingsSources } from './surface/settings-source.ts'

export { QODER_PROVIDER, QODER_INTL_PROVIDER, QoderAdapter } from './providers/qoder/adapter.ts'
export type { QoderAdapterOptions } from './providers/qoder/adapter.ts'
export { CODEBUDDY_PROVIDER, CodeBuddyAdapter, resolveCodeBuddyModelId } from './providers/codebuddy/adapter.ts'
export type { CodeBuddyAdapterOptions } from './providers/codebuddy/adapter.ts'
export type { ImageRequestReader } from './core/adapter-kit.ts'
export type { Live } from './core/live.ts'
export { liveConfig } from './core/config.ts'
// The authoring shape is re-exported as `ConfigShape` because this module also
// exports the `Config` *schema* value the loader reads; one module cannot
// re-export a type and declare a value under the same name.
export type { ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig }
export { API_PREFIX } from './surface/api.ts'

/**
 * Cordis plugin name; equals the profile row id this bundle inserts.
 *
 * @see SETTINGS_NS
 */
export const name = SETTINGS_NS

/** The LLM registry must exist before an adapter can be registered on it. */
export const inject = ['llm']

/** The plugin's configuration schema, under the name the loader looks for. */
export const Config = ConfigSchema

/**
 * How many times this module's `apply()` has run in this process.
 *
 * A volatile-only settings edit is committed into the running plugin and does
 * NOT re-enter `apply()`, so this counter is the only direct evidence of an
 * entry rebuild — the question a "the conversation dropped right after I saved
 * settings" report turns on. It is logged with the boot id, which changes when
 * the module is re-evaluated at all.
 */
let applyCount = 0

/**
 * Mount the adapters and the settings API for the lifetime of the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - parsed plugin config, whose volatile fields arrive as
 *   references. {@link liveConfig} wraps them as thunks the bridge reads where
 *   it uses them, so an edit applies without this function running again; an
 *   empty object is a valid deployment.
 */
export function apply(ctx: Context, config: ParsedConfig): void {
  const live = liveConfig(config)

  // `apply()` running again means the loader rebuilt this entry rather than
  // committing a volatile edit in place. See {@link applyCount}.
  setTraceGate(live.traceEnabled)
  applyCount += 1
  trace('apply', { n: applyCount })

  const bridge = createBridge(ctx, live)
  const sources: SettingsSources = {
    cn: qoderSettings(bridge.adapters.cn, live.cnEnabled),
    global: qoderSettings(bridge.adapters.global, live.intlEnabled),
    codebuddy: codeBuddySettings(bridge.adapters.codebuddy, live.codebuddyEnabled),
  }

  // registerAdapter's disposer only withdraws the routes; the warm qodercli
  // subprocesses are owned by the adapters and must close with the plugin.
  //
  // `close()` seals the pools rather than merely emptying them, and each
  // session's own close drains an in-flight turn instead of truncating it — see
  // `core/lifecycle.ts`. That is why a plugin reload no longer surfaces as a
  // dropped connection.
  ctx.effect(() => () => {
    trace('dispose', { n: applyCount, boot: BOOT_ID })
    bridge.close()
  }, 'llm-qoder-cn.sessions')

  // The settings page's data source: the live catalog joined with the user's
  // on/off and window choices. Served from its own route because the catalog
  // comes from the CLI and cannot ride the config form.
  //
  // `webServer` publishes after plugin load, so this pends on a nested fiber
  // rather than reading the service at apply time — a `ctx.get('webServer')`
  // here answers undefined in a real web composition.
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined) return
    scope.effect(
      () => server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => { void handleApi(req, res, sources) },
      }),
      'llm-qoder-cn: settings api',
    )
    ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`)
  })
}
