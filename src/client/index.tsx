/**
 * dsh-agent-sdk-bridge — browser half.
 *
 * Contributes one top-level settings section per enabled provider (`qoder-cn`,
 * `qoder-intl`, `codebuddy`), each showing its account card and then
 * the model list: every model the account exposes, with an on/off switch and a
 * context-window choice, plus a collapsed "advanced" area holding the scalars
 * worth reaching without editing YAML. The plugin manager's page for this
 * bundle carries the switches that decide which of those sections exist.
 *
 * The model list cannot come from the config form: it is fetched live from the
 * provider. So the page reads `GET <prefix>/models`, which joins that live
 * catalog with the user's stored choices, while every change goes back through
 * the host's own config form. The host owns the catalog, so the page never
 * derives state the adapter does not share.
 *
 * The page can also start the CLI helper shipped with this package
 * (`POST <prefix>/setup`, then `GET <prefix>/setup` for its output): installing
 * and signing into a CLI is a local action a browser cannot perform.
 *
 * @module dsh-agent-sdk-bridge/client
 */

import * as React from 'react'
import { BRANDS } from './brands.ts'
import { BundleSettings } from './components/bundle-settings.tsx'
import { SettingsPage } from './components/settings-page.tsx'
import { en, zh } from './copy.ts'
import { installStyles } from './styles.ts'
import type { Brand, PluginContext } from './types.ts'

/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
export const name = 'dsh-agent-sdk-bridge'

/** Everything this half needs from the shell before it can render. */
export const inject = ['slots', 'locale', 'configForms']

/** The plugin's config namespace — must equal the profile row id. */
const NS = 'llm-qoder-cn'

/**
 * Register the sections that are currently switched on, and keep that set in
 * step with the edition switches.
 *
 * A section exists only while its edition does: the plugin page's switches
 * decide whether the settings page, its models and its fields are offered at
 * all. They cannot be registered unconditionally and hidden, because a
 * registered `settings.section` is exactly what puts an entry in the nav.
 */
export function apply(ctx: PluginContext): void {
  installStyles()
  if (ctx.locale === undefined || ctx.slots === undefined || ctx.configForms === undefined) return
  const locale = ctx.locale
  const slots = ctx.slots
  const configForms = ctx.configForms
  const t = locale.bind(NS)

  ctx.effect(() => locale.register(NS, { zh, en }), 'llm-qoder-cn: dictionaries')

  // The switches live on this bundle's own page in the plugin manager. That
  // page exists whether or not any edition is currently shown.
  ctx.effect(
    () => slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-agent-sdk-bridge',
      locale: NS,
    }, props => <BundleSettings {...props} ctx={ctx} t={t} />)),
    'llm-qoder-cn: bundle options',
  )

  ctx.effect(() => configForms.whileServed([NS], () => {
    const form = configForms.get(NS)
    const live = new Map<string, () => void>()

    const sync = (): void => {
      const snapshot = form.getSnapshot()
      // Wait for the stored config before deciding what to show. Registering
      // optimistically would flash a page the user already switched off.
      if (snapshot?.status !== 'ready') return
      const value = snapshot.value ?? {}
      for (const brand of BRANDS) {
        const enabled = value[brand.fields.enabled] !== false
        const current = live.get(brand.id)
        if (enabled && current === undefined) {
          live.set(brand.id, slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: brand.settingsId,
            order: brand.order,
            label: () => locale.bind(NS)(brand.navKey),
            locale: NS,
          }, props => <SettingsPage {...props} ctx={ctx} t={t} brand={brand as Brand} />)))
        } else if (!enabled && current !== undefined) {
          current()
          live.delete(brand.id)
        }
      }
    }

    const unsubscribe = form.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      for (const off of live.values()) off()
      live.clear()
    }
  }), 'llm-qoder-cn: pages')
}
