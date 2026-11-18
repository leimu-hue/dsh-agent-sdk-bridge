/**
 * The agent SDKs this plugin serves.
 *
 * Each provider ships its own SDK, CLI and credential store; their wire
 * protocols are similar enough that the rest of the plugin is keyed by brand
 * rather than duplicated. This module is the only place those differences are
 * spelled out: which package to import and where the CLI lives.
 *
 * @module dsh-agent-sdk-bridge/brand
 */

/** The Qoder editions, whose provider ids predate this bridge. */
export type QoderBrand = 'cn' | 'global'
/** The CodeBuddy integration. Its login region is a config choice, not a brand. */
export type CodeBuddyBrandId = 'codebuddy'
/** Every provider route this plugin registers. */
export type BrandId = QoderBrand | CodeBuddyBrandId

/** CodeBuddy's two public login regions. Enterprise domains are out of scope. */
export type CodeBuddyRegion = 'global' | 'cn'

/** Everything that differs between provider brands. */
export interface BrandProfile {
  id: BrandId
  /** LLM provider route id registered on the harness. */
  provider: string
  /** Display name used when the config leaves it empty. */
  defaultDisplayName: string
  /** SDK package that speaks this brand's protocol. */
  sdkPackage: string
  /** npm packages the CLI can be installed as, most specific first. */
  cliPackages: readonly { scope: string, name: string }[]
  /** Command names an npm global shim exposes. */
  cliCommands: readonly string[]
  /** Per-user state directory, relative to the home directory. */
  configDirName: string
  /** Whether the static Qoder catalog is a valid fallback. */
  staticCatalog: boolean
}

/** The CN edition, which the plugin was originally built for. */
export const CN_BRAND: BrandProfile = {
  id: 'cn',
  provider: 'qoder-cn',
  defaultDisplayName: 'Qoder CN',
  sdkPackage: '@qodercn-ai/qodercn-agent-sdk',
  cliPackages: [{ scope: '@qodercn-ai', name: 'qoderclicn' }],
  cliCommands: ['qoderclicn', 'qodercn'],
  configDirName: '.qoder-cn',
  staticCatalog: true,
}

/**
 * The international edition.
 *
 * The static CN catalog is deliberately NOT reused: model ids differ between
 * the two plans, and a fallback the account cannot actually run would put
 * unusable entries in the picker.
 */
export const GLOBAL_BRAND: BrandProfile = {
  id: 'global',
  provider: 'qoder-intl',
  defaultDisplayName: 'Qoder 国际版',
  sdkPackage: '@qoder-ai/qoder-agent-sdk',
  cliPackages: [{ scope: '@qoder-ai', name: 'qodercli' }],
  cliCommands: ['qodercli', 'qoder'],
  configDirName: '.qoder',
  staticCatalog: false,
}

/**
 * CodeBuddy, served through Tencent's Agent SDK.
 *
 * The SDK bundles its own CLI (`@tencent-ai/codebuddy-code`), so there is no
 * global install step and no setup script: login is an SDK call whose region
 * is chosen per request (`external` for the international site, `internal`
 * for the mainland one). Enterprise/IOA/self-hosted login is out of scope.
 */
export const CODEBUDDY_BRAND: BrandProfile = {
  id: 'codebuddy',
  provider: 'codebuddy',
  defaultDisplayName: 'CodeBuddy',
  sdkPackage: '@tencent-ai/agent-sdk',
  cliPackages: [{ scope: '@tencent-ai', name: 'codebuddy-code' }],
  cliCommands: ['codebuddy', 'cbc'],
  configDirName: '.codebuddy',
  staticCatalog: false,
}

/** Every brand, in the order the settings pages list them. */
export const BRANDS: readonly BrandProfile[] = [CN_BRAND, GLOBAL_BRAND, CODEBUDDY_BRAND]

/** Whether a value names a Qoder edition. */
export function isQoderBrand(value: unknown): value is QoderBrand {
  return value === 'cn' || value === 'global'
}

/** Whether a value names one of the provider brands. */
export function isBrandId(value: unknown): value is BrandId {
  return isQoderBrand(value) || value === 'codebuddy'
}

/** Whether a value names a CodeBuddy login region. */
export function isCodeBuddyRegion(value: unknown): value is CodeBuddyRegion {
  return value === 'global' || value === 'cn'
}

/** The profile for one brand. */
export function brandProfile(brand: BrandId): BrandProfile {
  if (brand === 'codebuddy') return CODEBUDDY_BRAND
  return brand === 'global' ? GLOBAL_BRAND : CN_BRAND
}

/** The SDK environment a CodeBuddy region logs into. */
export function codeBuddyEnvironment(region: CodeBuddyRegion): 'external' | 'internal' {
  return region === 'cn' ? 'internal' : 'external'
}
