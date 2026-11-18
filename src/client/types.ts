/**
 * The shapes the settings pages carry, as the host actually answers them.
 *
 * Almost every number and string here comes from a provider's own API through
 * the host, so every field is optional: an account can report a quota without
 * a plan, a package list without expiries, or a region verdict without a
 * catalog. The components read each field defensively rather than trusting a
 * shape the wallet-side API never promised.
 *
 * @module dsh-agent-sdk-bridge/client/types
 */

import type { CopyKey } from './copy.ts'

/** The four settings sections this bundle contributes. */
export type BrandId = 'cn' | 'global' | 'codebuddy' | 'minimax'

/** Which account card a section renders under its title. */
export type BrandKind = 'qoder' | 'codebuddy' | 'minimax'

/** A login region. Qoder editions are separate sections instead of regions. */
export type Region = 'cn' | 'global'

/** One settings section: its copy keys, its order, and the config fields behind it. */
export interface Brand {
  id: BrandId
  kind: BrandKind
  settingsId: string
  order: number
  titleKey: CopyKey
  navKey: CopyKey
  introKey: CopyKey
  noModelsKey: CopyKey
  /**
   * The CLI section this edition renders under its title, if it has one.
   *
   * The page only *reports* on that CLI; installing and signing in stay with
   * the user, because install commands change and a copy baked into this
   * bundle would go stale.
   */
  cliGroupKey?: CopyKey
  cliHintKey?: CopyKey
  fields: {
    enabled: string
    /** The deny-list; regions replace it with their own field. */
    disabled: string
    /** The per-model window map; regions replace it too. */
    windows: string
  }
}

/** One row of the model list, as `GET /models` renders it. */
export interface ModelRow {
  id: string
  name: string
  enabled: boolean
  contextWindow?: number
  defaultContextWindow?: number
  contextWindows?: number[]
  contextWindowSelectable?: boolean
  override?: number
  vision?: boolean
  priceFactor?: number
}

/** The `GET /models` answer, normalized: the host answered for this region. */
export interface ModelList {
  rows: ModelRow[]
  notice?: string
  signedIn?: boolean
}

/** One credit bucket, in either of the upstream shapes. */
export interface CreditBucket {
  used?: number
  total?: number
  cap?: number
  remaining?: number
  percentage?: number
  unit?: string
  detailUrl?: string
}

/** A used/total reading normalized from a bucket. */
export interface CreditReading {
  used?: number
  total?: number
  remaining?: number
  pct?: number
}

/** Qoder's quota reading. */
export interface QoderUsage {
  userQuota?: CreditBucket
  addOnQuota?: CreditBucket
  orgResourcePackage?: CreditBucket
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number
  userType?: string
  userId?: string
  upgradeUrl?: string
}

/** The account half of Qoder's quota answer. */
export interface QoderAccount {
  name?: string
  email?: string
  subscriptionType?: string
}

/** `GET /usage?brand=cn|global` answer. */
export interface UsageSnapshot {
  usage?: QoderUsage
  account?: QoderAccount
  at?: number
  error?: string
  cliMissing?: boolean
}

/** One purchased CodeBuddy credit package. */
export interface CodeBuddyPackage {
  name?: string
  used?: number
  total?: number
  end?: number
}

/** CodeBuddy's quota, which its SDK reports separately from the account. */
export interface CodeBuddyQuota extends CreditBucket {
  packages?: CodeBuddyPackage[]
  cycleEnd?: number
}

/** `GET /usage?brand=codebuddy` answer: the signed-in account plus its quota. */
export interface CodeBuddyAccountPayload {
  signedIn?: boolean
  account?: {
    uid?: string
    userName?: string
    email?: string
    organization?: string
    subscriptionType?: string
  }
  quota?: CodeBuddyQuota
  quotaError?: string
  error?: string
}

/** `GET /auth` answer for both regional providers. */
export interface AuthStatus {
  running?: boolean
  signedIn?: boolean
  region?: Region
  url?: string
  error?: string
  /** MiniMax only: the OAuth access token's expiry, phrased as a countdown. */
  expiresAt?: number
}

/** One Token Plan window on a MiniMax account. */
export interface MinimaxQuotaWindow {
  id: string
  label: string
  unlimited?: boolean
  remainingPercent?: number
  remainingCount?: number
  totalCount?: number
  resetAt?: number
}

/** `GET /usage?brand=minimax` answer. */
export interface MinimaxUsagePayload {
  installed?: boolean
  signedIn?: boolean
  regionBlocked?: boolean
  error?: string
  account?: { name?: string; email?: string }
  plan?: { kind?: 'token-plan' | 'credits' | 'free'; name?: string; hasTokenPlan?: boolean; expiresAt?: number }
  credits?: { remaining?: number; purchasedRemaining?: number; freeRemaining?: number }
  windows?: MinimaxQuotaWindow[]
}

/** A config form snapshot, as the host's settings service reports it. */
export interface ConfigSnapshot {
  status?: string
  value?: Record<string, unknown>
  user?: Record<string, unknown> | null
  writable?: boolean
}

/** The revision-fenced form one namespace is edited through. */
export interface ConfigForm {
  subscribe(listener: () => void): () => void
  getSnapshot(): ConfigSnapshot | undefined
  set(key: string, value: unknown): Promise<boolean | void>
  unset(key: string): Promise<boolean | void>
}

/** The host's schema description, which the advanced block labels itself from. */
export interface DescribeFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): DescribeSnapshot | undefined
  ensure(): Promise<unknown>
}

/** A schema node the advanced block reads bounds and help text from. */
export interface SchemaNode {
  meta?: { description?: string; min?: number; max?: number; step?: number }
  dict?: Record<string, string>
}

/** `configForms.describe()` snapshot, reduced to what the page uses. */
export interface DescribeSnapshot {
  view?: {
    namespaces?: {
      ns?: string
      schema?: { uid?: string; refs?: Record<string, SchemaNode> }
    }[]
  }
}

/** The slot registry entry a bundle contributes. */
export interface SlotSpec {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  locale?: string
}

/** The host context this bundle's `apply` receives, reduced to what it touches. */
export interface PluginContext {
  configForms?: {
    get(ns: string): ConfigForm
    describe(): DescribeFace
    whileServed(namespaces: string[], run: () => () => void): () => void
  }
  slots?: {
    inject(name: string, run: () => () => void): () => void
    register(spec: SlotSpec, component: (props: Record<string, unknown>) => unknown): () => void
  }
  locale?: {
    register(ns: string, dictionaries: Record<string, unknown>): () => void
    bind(ns: string): Translate
  }
  effect(run: () => () => void, label?: string): void
}

/** The host's bound translator: flat keys render, `advancedFields` returns the table. */
export type Translate = (key: CopyKey) => string

/** What a settings section receives from the slot shell. */
export interface SlotProps {
  ctx: PluginContext
  t: Translate
  brand: Brand
}

/** The advanced block's field list: name plus which control it gets. */
export type AdvancedKind = 'text' | 'number' | 'json'
export type AdvancedFields = readonly (readonly [string, AdvancedKind])[]

/** The nested advanced-label table, or an empty table when the host omitted it. */
export function advancedLabels(t: Translate): Record<string, string> {
  const table = (t as unknown as (key: string) => unknown)('advancedFields')
  return table !== null && typeof table === 'object' ? table as Record<string, string> : {}
}
