/**
 * The three settings sections, and the advanced scalars each of them edits.
 *
 * They share one page component, the same API routes and the same copy keys;
 * only the config fields, the brand and the account card differ. The order
 * here is the order the shell lists them in the settings navigation.
 *
 * @module dsh-agent-sdk-bridge/client/brands
 */

import type { AdvancedFields, Brand } from './types.ts'

/** One settings section per provider. */
export const BRANDS: readonly Brand[] = [
  {
    id: 'cn',
    kind: 'qoder',
    settingsId: 'qoder-cn',
    order: 36,
    titleKey: 'title',
    navKey: 'nav',
    introKey: 'intro',
    noModelsKey: 'noModels',
    cliGroupKey: 'cliGroup',
    cliHintKey: 'cliHint',
    fields: {
      enabled: 'cnEnabled',
      disabled: 'disabledModels',
      windows: 'modelContextWindows',
    },
  },
  {
    id: 'global',
    kind: 'qoder',
    settingsId: 'qoder-intl',
    order: 37,
    titleKey: 'intlTitle',
    navKey: 'intlNav',
    introKey: 'intlIntro',
    noModelsKey: 'intlNoModels',
    cliGroupKey: 'intlCliGroup',
    cliHintKey: 'intlCliHint',
    fields: {
      enabled: 'intlEnabled',
      disabled: 'intlDisabledModels',
      windows: 'intlModelContextWindows',
    },
  },
  {
    id: 'codebuddy',
    kind: 'codebuddy',
    settingsId: 'codebuddy',
    order: 38,
    titleKey: 'codebuddyTitle',
    navKey: 'codebuddyNav',
    introKey: 'codebuddyIntro',
    noModelsKey: 'codebuddyNoModels',
    fields: {
      enabled: 'codebuddyEnabled',
      // The page swaps these for the selected login region's own fields.
      disabled: 'codebuddyGlobalDisabledModels',
      windows: 'codebuddyGlobalModelContextWindows',
    },
  },
]

/**
 * Scalars shown under Advanced, in order, with the control each one gets.
 *
 * The host's schema stays the source of truth for labels, help text and bounds;
 * this list only decides order and which control to render.
 */
export const ADVANCED: Record<'cn' | 'global' | 'codebuddy', AdvancedFields> = {
  cn: [
    ['displayName', 'text'],
    ['maxSessions', 'number'],
    ['sessionIdleSeconds', 'number'],
    ['modelCacheTtlSeconds', 'number'],
    ['defaultReasoningEffort', 'text'],
    ['defaultMaxTokens', 'number'],
    ['toolResultTimeoutSeconds', 'number'],
    ['catalogFetchTimeoutSeconds', 'number'],
    ['abortGraceSeconds', 'number'],
    ['coldMaxTurns', 'number'],
    ['modelAliases', 'json'],
  ],
  // The shared scalars above already have a home on the CN page; the intl page
  // only adds what is specific to that edition, so the same setting is never
  // edited in two places with two different values.
  global: [
    ['intlDisplayName', 'text'],
    ['intlModelAliases', 'json'],
  ],
  codebuddy: [
    ['codebuddyDisplayName', 'text'],
    ['codebuddyModelAliases', 'json'],
  ],
}
