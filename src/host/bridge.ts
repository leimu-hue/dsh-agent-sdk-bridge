/**
 * Mounts the three provider adapters and keeps their registrations in step with
 * the plugin's live configuration.
 *
 * The plugin entry (`host/index.ts`) answers one question — how DSH mounts a
 * plugin — and this module answers the next one — which routes, picker groups,
 * attachment readers and warm sessions exist while it is mounted. Separating
 * them matters because the second set of decisions is large and stateful:
 * routes must appear and disappear with the edition switches, the picker
 * directory is republished through a handle rather than re-registered, and the
 * adapters must be closed exactly once when the plugin unloads. A caller does
 * not need any of that to mount the plugin: it calls {@link createBridge} and
 * receives the adapter instances the HTTP surface reads.
 *
 * @module dsh-agent-sdk-bridge/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BrandId } from './core/brand.ts'
import { BRANDS } from './core/brand.ts'
import type { LiveConfig } from './core/config.ts'
import { trace } from './infra/log.ts'
import { CodeBuddyAdapter, CODEBUDDY_PROVIDER } from './providers/codebuddy/adapter.ts'
import { QODER_INTL_PROVIDER, QODER_PROVIDER, QoderAdapter } from './providers/qoder/adapter.ts'

/** The settings namespace: the profile entry id this plugin is mounted under. */
export const SETTINGS_NS = 'llm-qoder-cn'

/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Config fields whose value decides a registration shape rather than a runtime
 * behaviour, and which therefore cannot be read lazily.
 *
 * The edition switches decide which routes exist at all; the display names are
 * copied into the picker directory. Everything else is read where it is used,
 * so a change to these fields is the only thing that needs a republish.
 */
const STRUCTURAL_FIELDS: ReadonlySet<string> = new Set([
  'cnEnabled', 'intlEnabled', 'codebuddyEnabled',
  'displayName', 'intlDisplayName', 'codebuddyDisplayName',
])

/** The adapter instances, typed per route so the settings surface needs no casts. */
export interface BridgeAdapters {
  cn: QoderAdapter
  global: QoderAdapter
  codebuddy: CodeBuddyAdapter
}

/** What the plugin entry keeps from a mounted bridge. */
export interface Bridge {
  readonly adapters: BridgeAdapters
  /** Close every warm inner process; registrations are disposed with the fiber. */
  close(): void
}

/**
 * Mount the adapters for the lifetime of the plugin.
 *
 * Every value is read through `live` at the point it is used: a volatile-only
 * edit is committed into the running plugin without re-entering `apply()`, so a
 * value captured here would stay frozen for the process lifetime. The two
 * exceptions are the structural fields above, which own registrations and are
 * re-synced by the loader's volatile-update event.
 *
 * @param ctx - the plugin's cordis context.
 * @param live - the configuration view whose thunks read the live cells.
 * @returns the adapters and the teardown for their subprocesses.
 */
export function createBridge(ctx: Context, live: LiveConfig): Bridge {
  let attachments: AttachmentStore | undefined
  let filesystem: Context['fs'] | undefined

  /**
   * Tell the harness that one route's advertised models changed.
   *
   * A connected GUI caches the model catalog for the lifetime of its Host
   * generation and reloads it only when the Host says something changed:
   * `llm/adapters-updated` (a route was registered or withdrawn) or
   * `llm/models-updated` (the list itself moved). Observer-only: a listener
   * failure must never break the catalog read that produced it, and the trace
   * line is what makes "did the picker get told?" answerable from `bridge.log`.
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
    idleMs: live.sessionIdleMs,
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
  const adapters: BridgeAdapters = {
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
      idleMs: live.sessionIdleMs,
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
  let directory: ReturnType<Context['llm']['registerConfigurableProviders']> | undefined

  const enabled = (id: BrandId): boolean => {
    if (id === 'cn') return live.cnEnabled()
    if (id === 'global') return live.intlEnabled()
    return live.codebuddyEnabled()
  }

  const directoryFor = (): {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: string[]
  }[] => {
    const rows = []
    if (live.cnEnabled()) {
      rows.push({ provider: QODER_PROVIDER, displayName: live.displayName(), settingsNs: SETTINGS_NS, settingsPath: [] })
    }
    if (live.intlEnabled()) {
      rows.push({ provider: QODER_INTL_PROVIDER, displayName: live.intlDisplayName(), settingsNs: SETTINGS_NS, settingsPath: [] })
    }
    if (live.codebuddyEnabled()) {
      rows.push({ provider: CODEBUDDY_PROVIDER, displayName: live.codebuddyDisplayName(), settingsNs: SETTINGS_NS, settingsPath: [] })
    }
    return rows
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
    const entries = directoryFor()
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
    // Paired with the `apply` line in the entry, this is what tells a hot update
    // from an entry rebuild when a saved setting is followed by a dropped turn.
    trace('volatile-update', { paths: paths.map(path => path.map(String).join('.')) })
    if (!paths.some(path => STRUCTURAL_FIELDS.has(String(path[0])))) return
    try {
      syncRegistration()
    } catch (error) {
      ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`)
    }
  })

  return {
    adapters,
    close: () => {
      adapters.cn.close()
      adapters.global.close()
      adapters.codebuddy.close()
    },
  }
}
