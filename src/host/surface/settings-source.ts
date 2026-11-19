/**
 * The settings pages' view of a provider, independent of which SDK serves it.
 *
 * The pages ask three questions — which models does the account advertise, what
 * does the quota/account reading say, and (CodeBuddy only) how is login going —
 * and the answers are shaped the same way for every brand. That is the seam the
 * HTTP surface talks through: `handleApi` never sees a `QoderAdapter` or a
 * `CodeBuddyAdapter`, never casts between them, and never branches on a brand
 * name. Each adapter's own quirks (CodeBuddy reads a catalog only while signed
 * in; a Qoder edition has no login route) are expressed once, in the factory
 * that wraps it.
 *
 * @module dsh-agent-sdk-bridge/surface/settings-source
 */

import type { BrandId, CodeBuddyRegion } from '../core/brand.ts'
import type { CodeBuddyAdapter } from '../providers/codebuddy/adapter.ts'
import { priceFactorOf } from '../providers/qoder/models.ts'
import type { QoderAdapter } from '../providers/qoder/adapter.ts'

/** One model row as a settings page renders it. */
export interface ModelRow {
  id: string
  name: string
  description?: string
  enabled: boolean
  vision: boolean
  contextWindow: number
  contextWindows: number[]
  defaultContextWindow: number
  override?: number
  priceFactor?: number
  reasoning: boolean
  /**
   * Whether the provider accepts a context-budget choice for this model.
   *
   * Absent (Qoder) means the ordinary menu applies. `false` means the
   * window is fixed upstream, so the page shows the value without a selector.
   */
  contextWindowSelectable?: boolean
}

/** What the page asked for: a refresh flag and, where it applies, a login region. */
export interface ModelQuery {
  /** Bypass the adapter's catalog cache before reading. */
  fresh: boolean
  /** CodeBuddy login region; ignored by providers without one. */
  region?: CodeBuddyRegion
}

/** One catalog page, plus the state the page needs to interpret it. */
export interface ModelPage {
  rows: ModelRow[]
  /** Why an empty list is empty, when the adapter has something to say. */
  notice?: string
  /** CodeBuddy only: whether the selected region has a stored login. */
  signedIn?: boolean
}

/** The login operations a provider with a browser flow exposes. */
export interface AuthFace {
  status(region: CodeBuddyRegion): unknown
  login(region: CodeBuddyRegion): { started: boolean, error?: string }
  logout(region: CodeBuddyRegion): Promise<{ ok: boolean, error?: string }>
}

/** One brand as the HTTP surface uses it. */
export interface SettingsSource {
  /** Whether the plugin config currently switches this brand on. */
  enabled(): boolean
  /** Whether the brand accepts the `region` query/body parameter. */
  readonly regionAware: boolean
  models(query: ModelQuery): Promise<ModelPage>
  usage(query: ModelQuery): Promise<Record<string, unknown>>
  /** Present only for a provider with a browser login flow. */
  readonly auth?: AuthFace
}

/** Every route's source, keyed by the brand the page names. */
export type SettingsSources = Readonly<Record<BrandId, SettingsSource>>

/**
 * Build the model rows for a Qoder edition.
 *
 * The live catalog is unfiltered: the page must show a switched-off model in
 * order to switch it back on.
 */
async function qoderRows(adapter: QoderAdapter): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog()
  return live.map(entry => {
    const override = adapter.contextWindowFor(entry.value)
    const upstream = entry.defaultContextWindow
      ?? (entry.availableContextWindows !== undefined && entry.availableContextWindows.length > 0
        ? Math.max(...entry.availableContextWindows)
        : entry.maxInputTokens)
      ?? 200_000
    const choices = new Set<number>(entry.availableContextWindows ?? [])
    choices.add(upstream)
    if (override !== undefined) choices.add(override)
    const priceFactor = priceFactorOf(entry)
    return {
      id: entry.value,
      name: entry.displayName.length > 0 ? entry.displayName : entry.value,
      ...entry.description.length > 0 ? { description: entry.description } : {},
      enabled: !adapter.isModelDisabled(entry.value),
      vision: entry.isVl === true,
      contextWindow: override ?? upstream,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: upstream,
      ...override === undefined ? {} : { override },
      ...priceFactor === undefined ? {} : { priceFactor },
      reasoning: entry.isReasoning !== false,
      // One advertised window is a fixed window: the CLI ignores anything
      // else, so the page should show the value instead of a dead selector.
      contextWindowSelectable: (entry.availableContextWindows?.length ?? 0) > 1,
    }
  })
}

/** Build the model rows for one CodeBuddy login region. */
async function codeBuddyRows(adapter: CodeBuddyAdapter, region?: CodeBuddyRegion): Promise<ModelRow[]> {
  const live = await adapter.describeCatalog(region)
  return live.map(entry => {
    // Only windows the provider accepts are offered. CodeBuddy validates
    // `set_config.contextWindow` against `contextWindow.supportedLengths` and
    // answers anything else with `Allowed: <none>`, so a menu entry the CLI
    // refuses would be a switch that does nothing upstream.
    const override = adapter.contextWindowFor(entry.id, region)
    const choices = new Set<number>(entry.contextWindows)
    if (override !== undefined) choices.add(override)
    return {
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      enabled: !adapter.isModelDisabled(entry.id, region),
      vision: entry.vision,
      contextWindow: override ?? entry.defaultContextWindow,
      contextWindows: [...choices].sort((a, b) => a - b),
      defaultContextWindow: entry.defaultContextWindow,
      ...override === undefined ? {} : { override },
      ...entry.priceFactor === undefined ? {} : { priceFactor: entry.priceFactor },
      reasoning: (entry.reasoningEfforts?.length ?? 0) > 0,
      contextWindowSelectable: entry.contextWindows.length > 0,
    }
  })
}

/** The settings source for one Qoder edition. */
export function qoderSettings(adapter: QoderAdapter, enabled: () => boolean = () => true): SettingsSource {
  return {
    enabled,
    regionAware: false,
    async models({ fresh }) {
      if (fresh) adapter.invalidateCatalog()
      const rows = await qoderRows(adapter)
      const notice = rows.length === 0 ? adapter.catalogError() : undefined
      return { rows, ...notice === undefined ? {} : { notice } }
    },
    async usage({ fresh }) {
      return await adapter.usageInfo(fresh) as unknown as Record<string, unknown>
    },
  }
}

/** The settings source for CodeBuddy, including its browser login flow. */
export function codeBuddySettings(adapter: CodeBuddyAdapter, enabled: () => boolean = () => true): SettingsSource {
  return {
    enabled,
    regionAware: true,
    async models({ fresh, region }) {
      if (fresh) adapter.invalidateCatalog(region)
      const signedIn = adapter.isSignedIn(region)
      const rows = signedIn === false ? [] : await codeBuddyRows(adapter, region)
      const notice = rows.length === 0 ? adapter.catalogError(region) : undefined
      return {
        rows,
        signedIn,
        ...notice === undefined ? {} : { notice },
      }
    },
    async usage({ fresh, region }) {
      const snapshot = await adapter.usageInfo(fresh, region)
      return { ...snapshot, signedIn: adapter.isSignedIn(region) }
    },
    auth: {
      status: region => adapter.authStatus(region),
      login: region => adapter.startLogin(region),
      logout: region => adapter.logout(region),
    },
  }
}
