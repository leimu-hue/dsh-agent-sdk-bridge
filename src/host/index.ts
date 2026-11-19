/**
 * Register one adapter per provider on `ctx.llm`: `qoder-cn` and `qoder-intl`
 * backed by Qoder's CN and international Agent SDKs, and `codebuddy` backed by
 * Tencent's CodeBuddy Agent SDK.
 *
 * Each provider's inner sessions ride on its own local login state (the Qoder
 * CLIs, or CodeBuddy's bundled CLI), so no API key or credential entry is
 * required: the account's model catalog is fetched live and split into the
 * account's built-in models and its custom ones. Everything a deployment may
 * want to tune — session pool size, context window, timeouts, model allow/deny
 * lists, aliases, per provider — is declared in {@link Config}, which DSH
 * renders as this plugin's settings pages.
 *
 * ## Settings edits apply without a restart, and that shapes this module
 *
 * Every config field is volatile, and DSH commits a volatile-only edit into the
 * running plugin's config cells instead of restarting it — `apply()` is not
 * called again. The adapter is therefore handed {@link liveConfig} thunks and
 * reads each value where it uses it; the only thing captured at mount is the
 * picker-directory registration (`directoryFor`), which is republished through
 * its `replace` handle when the display name changes.
 * See `src/core/live.ts` for the mechanism.
 *
 * @module dsh-agent-sdk-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { QoderAdapter, QODER_PROVIDER, QODER_INTL_PROVIDER } from './providers/qoder/adapter.ts'
import { CodeBuddyAdapter, CODEBUDDY_PROVIDER } from './providers/codebuddy/adapter.ts'
import { API_PREFIX, handleApi } from './surface/api.ts'
import type { BrandId } from './core/brand.ts'
import { BRANDS } from './core/brand.ts'
import type { LiveConfig, ParsedConfig } from './core/config.ts'
import { Config as ConfigSchema, liveConfig } from './core/config.ts'
import { BOOT_ID, setTraceGate, trace } from './infra/log.ts'

/**
 * The web carrier this plugin mounts its settings API on.
 *
 * Declared locally rather than imported from `@deepseek-ai/dsh-host-webserver`
 * so the plugin keeps only the peer dependencies it actually needs: a
 * deployment that boots without a web server must still load this plugin, and
 * an import of the carrier package would make it a hard requirement.
 */
interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * The mounted filesystem provider, used only to translate a host path into
 * the execution world the host tools run in. Declared minimally so the plugin
 * keeps only the peer dependencies it actually needs.
 */
interface FileSystemService {
  processPathFromHostPath?(hostPath: string): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in web compositions; reached through a nested inject. */
    webServer?: WebServerService
    /** Present when a filesystem provider is mounted; reached by inject. */
    fs?: FileSystemService
  }

  interface Events {
    /**
     * The loader committed a volatile-only config edit into this fiber.
     *
     * Emitted by `cordis-plugin-loader` from `Entry._commitVolatile` with the
     * config paths whose cells changed. The plugin does not restart for such an
     * edit, so this is the only notification that one happened; see
     * `src/core/live.ts`. Declared here because it is an internal loader event that
     * the framework's own `Events` interface does not carry.
     *
     * @param paths - one path array per committed field, e.g. `[['displayName']]`.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void

    /**
     * One provider's advertised models or display metadata changed.
     *
     * The host forwards it to every connected GUI, whose model picker reloads
     * the catalog. Declared here because the `@deepseek-ai/dsh-llm` version this
     * plugin compiles against predates the event, while the harnesses it runs
     * on (0.2.2-rc.5 and later) declare and dispatch it; emitting an event a
     * slightly older host does not know is harmless — nothing listens.
     *
     * @param provider - the route whose catalog changed.
     */
    'llm/models-updated'(provider: string): void
  }
}

export { QoderAdapter, QODER_PROVIDER, QODER_INTL_PROVIDER, cliContextWindow, pickContextWindow } from './providers/qoder/adapter.ts'
export type { ImageRequestReader } from './core/adapter-kit.ts'
export type { QoderAdapterOptions } from './providers/qoder/adapter.ts'
export { CodeBuddyAdapter, CODEBUDDY_PROVIDER, resolveCodeBuddyModelId } from './providers/codebuddy/adapter.ts'
export type { CodeBuddyAdapterOptions } from './providers/codebuddy/adapter.ts'
export {
  CodeBuddyAuth, CodeBuddyAccountReader, CodeBuddyCatalog, CodeBuddySession, CodeBuddySessionManager,
  CODEBUDDY_DEFAULT_CONTEXT_WINDOW, CODEBUDDY_DEFAULT_MAX_TOKENS, codeBuddyColdStream,
  fetchCodeBuddyQuota, parseCodeBuddyQuota, toCodeBuddyModel,
} from './providers/codebuddy/session.ts'
export type {
  CodeBuddyAccount, CodeBuddyAuthStatus, CodeBuddyModel, CodeBuddyQuota, CodeBuddyQuotaPackage,
  CodeBuddyUsageSnapshot,
} from './providers/codebuddy/session.ts'
export { BRANDS, CN_BRAND, GLOBAL_BRAND, CODEBUDDY_BRAND, brandProfile, codeBuddyEnvironment, isBrandId } from './core/brand.ts'
export type { BrandId, BrandProfile, CodeBuddyRegion, QoderBrand } from './core/brand.ts'
export { loadCodeBuddySdk, loadSdk } from './infra/sdk.ts'
export { QoderUsage, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS } from './providers/qoder/usage.ts'
export type { UsageSnapshot } from './providers/qoder/usage.ts'
export { QoderSession, QoderSessionManager } from './providers/qoder/session.ts'
export type { SessionModelPolicy, SessionRuntimeOptions } from './providers/qoder/session.ts'
export { ToolResultPairing } from './core/host-session.ts'
export { CloseGate, DEFAULT_DRAIN_MS, DEFAULT_SESSION_IDLE_MS, closeFinishReason } from './core/lifecycle.ts'
export type { CloseCause, PoolSession } from './core/lifecycle.ts'
export { NARROW_CHARS_PER_TOKEN, WIDE_CHARS_PER_TOKEN, countWideChars, estimateTextTokens, isWideChar } from './core/tokens.ts'
export { QODER_MODELS, MODEL_ALIASES, resolveQoderModelId, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './core/catalog.ts'
export { QoderModelCatalog, priceFactorOf } from './providers/qoder/models.ts'
export { API_PREFIX, buildRows, handleApi } from './surface/api.ts'
export type { Live } from './core/live.ts'
export { readLive, readLiveOptional } from './core/live.ts'
export { liveConfig } from './core/config.ts'
// The authoring shape is re-exported as `ConfigShape` because this module also
// exports the `Config` *schema* value the loader reads; one module cannot
// re-export a type and declare a value under the same name.
export type {
  Config as ConfigShape, LiveConfig, ParsedConfig, ResolvedConfig,
} from './core/config.ts'

/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
export const name = 'llm-qoder-cn'
/** The LLM registry must exist before an adapter can be registered on it. */
export const inject = ['llm']

/**
 * Configuration namespace: the profile entry id this plugin is mounted under.
 * The settings service and the configurable-provider directory both address the
 * plugin by this key, and the exported {@link ConfigSchema} is the form source,
 * so no page has to be registered by hand.
 */
const NS = 'llm-qoder-cn'

/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Config fields whose value decides a registration shape rather than a runtime
 * behaviour, and which therefore cannot be read lazily.
 *
 * The edition switches decide which routes exist at all; the two display names
 * are copied into the picker directory. Everything else is read where it is
 * used, so a change to these fields is the only thing that needs a republish.
 */
const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'cnEnabled', 'intlEnabled', 'codebuddyEnabled',
  'displayName', 'intlDisplayName', 'codebuddyDisplayName',
])

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

/** The configurable-provider directory rows for the enabled editions. */
function directoryFor(live: LiveConfig): {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
}[] {
  const rows = []
  if (live.cnEnabled()) {
    rows.push({ provider: QODER_PROVIDER, displayName: live.displayName(), settingsNs: NS, settingsPath: [] })
  }
  if (live.intlEnabled()) {
    rows.push({ provider: QODER_INTL_PROVIDER, displayName: live.intlDisplayName(), settingsNs: NS, settingsPath: [] })
  }
  if (live.codebuddyEnabled()) {
    rows.push({ provider: CODEBUDDY_PROVIDER, displayName: live.codebuddyDisplayName(), settingsNs: NS, settingsPath: [] })
  }
  return rows
}

/**
 * The plugin's configuration schema, re-exported under the name the loader
 * looks for. DSH reads `runtime.Config` off the plugin fiber to build the
 * settings page, so this must stay the exported `Config` binding.
 *
 * Every field is `.volatile()`, which is what makes the namespace appear in
 * `settings.describe()` at all — see the note on {@link ConfigSchema}.
 */
export const Config = ConfigSchema

/**
 * Mount the adapter for the lifetime of the plugin.
 *
 * @param ctx - the plugin's cordis context.
 * @param config - parsed plugin config, whose volatile fields arrive as
 *   references. {@link liveConfig} wraps them as thunks the adapter reads where
 *   it uses them, so an edit applies without this function running again; an
 *   empty object is a valid deployment.
 */
export function apply(ctx: Context, config: ParsedConfig): void {
  // Every field is read through this view rather than snapshotted, because a
  // volatile-only edit updates the config cells in place and never re-runs
  // `apply()` — see `live.ts`. A single resolved value taken here would be the
  // plugin's answer for the rest of the process lifetime.
  const live = liveConfig(config)
  let attachments: AttachmentStore | undefined
  let filesystem: FileSystemService | undefined

  // `apply()` running again means the loader rebuilt this entry rather than
  // committing a volatile edit in place. See {@link applyCount}.
  setTraceGate(live.traceEnabled)
  applyCount += 1
  trace('apply', { n: applyCount })

  /**
   * Tell the harness that one route's advertised models changed.
   *
   * A connected GUI caches the model catalog for the lifetime of its Host
   * generation and reloads it only when the Host says something changed:
   * `llm/adapters-updated` (a route was registered or withdrawn — startup, an
   * edition switch) or `llm/models-updated` (the list itself moved). This
   * plugin used to fire neither after a CLI login. Its own settings page reads
   * the catalog through its API, so the page showed the new models while the
   * chat model picker kept the pre-login list until a restart re-registered the
   * adapter and produced the first kind of event.
   *
   * Observer-only: a listener failure must never break the catalog read that
   * produced it, and the trace line is what makes "did the picker get told?"
   * answerable from `bridge.log`.
   *
   * @param provider - the route whose catalog changed.
   * @param ids - the advertised model ids; only their count is logged.
   */
  const announceModels = (provider: string, ids: readonly string[]): void => {
    trace('catalog/updated', { provider, models: ids.length })
    try {
      ctx.emit('llm/models-updated', provider)
    } catch (error) {
      ctx.logger?.warn(`llm-qoder-cn: 通知模型目录变化失败：${String(error)}`)
    }
  }

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
    readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => {
      const store = attachments
      if (store === undefined) return Promise.resolve(undefined)
      // Ask for the attachment's own dimensions: the host already normalized
      // it, so only the byte ceiling binds the request version.
      return store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES }, signal)
        .then(image => ({ bytes: image.data, mediaType: image.mediaType }))
    },
    /**
     * Where the model can find the image on disk. Pixels let it describe the
     * picture; this path lets a "modify and save it" turn act on the file
     * instead of searching the workspace for something that was never there.
     */
    imagePath: (ref: ImageAttachmentRef): string | undefined => {
      const store = attachments
      if (store === undefined) return undefined
      const hostPath = store.imageHostPath(ref)
      if (hostPath === undefined) return undefined
      // Prefer the mounted tools' view of the same file; the local provider
      // maps identically, a sandboxed one may not.
      return filesystem?.processPathFromHostPath?.(hostPath) ?? hostPath
    },
  }

  /**
   * One adapter per provider.
   *
   * Separate instances, not one instance on several routes: each carries its
   * own catalog, warm sessions, account reading and user choices, so a request
   * can never be resolved against another provider's catalog.
   */
  const adapters: Record<BrandId, QoderAdapter | CodeBuddyAdapter> = {
    cn: new QoderAdapter({
      ...shared,
      brand: 'cn',
      displayName: live.displayName,
      disabledModels: live.disabledModels,
      modelContextWindows: live.modelContextWindows,
      modelAliases: live.modelAliases,
      onModelsChanged: ids => announceModels(QODER_PROVIDER, ids),
    }),
    global: new QoderAdapter({
      ...shared,
      brand: 'global',
      displayName: live.intlDisplayName,
      disabledModels: live.intlDisabledModels,
      modelContextWindows: live.intlModelContextWindows,
      modelAliases: live.intlModelAliases,
      onModelsChanged: ids => announceModels(QODER_INTL_PROVIDER, ids),
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
      disabledModels: region => region === 'cn'
        ? live.codebuddyCnDisabledModels()
        : live.codebuddyGlobalDisabledModels(),
      modelContextWindows: region => region === 'cn'
        ? live.codebuddyCnModelContextWindows()
        : live.codebuddyGlobalModelContextWindows(),
      modelAliases: live.codebuddyModelAliases,
      readImage: shared.readImage,
      imagePath: shared.imagePath,
      onModelsChanged: ids => announceModels(CODEBUDDY_PROVIDER, ids),
    }),
  }

  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined }, 'llm-qoder-cn.attachments')
  })

  ctx.inject(['fs'], (scope) => {
    filesystem = scope.fs
    scope.effect(() => () => { filesystem = undefined }, 'llm-qoder-cn.fs')
  })

  // Routes and the provider directory are the two shapes a live value cannot
  // reach on its own: which provider ids exist, and the labels the selection
  // surfaces render. A disabled provider must own neither, so both are kept in
  // step with the switches rather than registered once for the process lifetime.
  const routes: Partial<Record<BrandId, () => void>> = {}
  let directory: ReturnType<typeof ctx.llm.registerConfigurableProviders> | undefined

  const enabled = (id: BrandId): boolean => {
    if (id === 'cn') return live.cnEnabled()
    if (id === 'global') return live.intlEnabled()
    return live.codebuddyEnabled()
  }

  /**
   * Bring the registered routes and the picker directory in line with the
   * current switches and labels.
   *
   * `registerAdapter` refuses an empty provider list, which is why a disabled
   * provider is *not registered* instead of being registered and then hidden:
   * the route itself has to disappear so no request can reach it and no model
   * list is offered for it. Turning it back on registers a fresh handle.
   */
  const syncRegistration = (): void => {
    for (const brand of BRANDS) {
      const current = routes[brand.id]
      if (enabled(brand.id) && current === undefined) {
        routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id])
      } else if (!enabled(brand.id) && current !== undefined) {
        current()
        delete routes[brand.id]
      }
    }
    const entries = directoryFor(live)
    if (entries.length === 0) {
      directory?.()
      directory = undefined
    } else if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
  }

  syncRegistration()

  /**
   * React to a structural config edit.
   *
   * A volatile-only edit does not re-run `apply()`, so this is the only place
   * the route set, the picker labels and the enabled editions can follow it.
   */
  ctx.on('loader/volatile-update', (paths: readonly (readonly string[])[]) => {
    // Paired with the `apply` line, this is what tells a hot update from an
    // entry rebuild when a saved setting is followed by a dropped turn.
    trace('volatile-update', { paths: paths.map(path => path.map(String).join('.')) })
    if (!paths.some(path => STRUCTURAL_FIELDS.has(String(path[0])))) return
    try {
      syncRegistration()
    } catch (error) {
      ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`)
    }
  })

  // registerAdapter's disposer only withdraws the routes; the warm qodercli
  // subprocesses are owned by the adapters and must close with the plugin.
  //
  // `close()` seals the pools rather than merely emptying them, and each
  // session's own close drains an in-flight turn instead of truncating it — see
  // `core/lifecycle.ts`. That is why a plugin reload no longer surfaces as a
  // dropped connection.
  ctx.effect(() => () => {
    trace('dispose', { n: applyCount, boot: BOOT_ID })
    adapters.cn.close()
    adapters.global.close()
    ;(adapters.codebuddy as CodeBuddyAdapter).close()
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
        handler: (req, res) => { void handleApi(req, res, adapters) },
      }),
      'llm-qoder-cn: settings api',
    )
    ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`)
  })
}
