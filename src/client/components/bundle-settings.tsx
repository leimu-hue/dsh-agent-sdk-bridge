/**
 * The edition switches, contributed to this bundle's own page in the plugin
 * manager (`plugins.bundle.config`).
 *
 * They live here rather than on any settings page because they decide whether
 * those pages exist at all: a page cannot own the switch that removes it. The
 * write goes through the shared config form, so it uses the same revision fence
 * as every other setting.
 *
 * @module dsh-agent-sdk-bridge/client/components/bundle-settings
 */

import * as React from 'react'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { withDeadline, WRITE_TIMEOUT_MS } from '../api.ts'
import { BRANDS } from '../brands.ts'
import { CLASS, css } from '../styles.ts'
import type { Brand, ConfigSnapshot, PluginContext, Translate } from '../types.ts'
import { LiveAlert, LiveStatus, useInstanceId } from './primitives.tsx'

/** What the plugin manager's slot passes down. */
export interface BundleSettingsProps {
  ctx: PluginContext
  t: Translate
  /** `page` is the full page; anything else is the one-line summary. */
  view?: unknown
  [key: string]: unknown
}

/** The three edition switches. */
export function BundleSettings({ ctx, t, view }: BundleSettingsProps): ReactElement {
  const form = ctx.configForms!.get('llm-qoder-cn')
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const read = useCallback(() => form.getSnapshot(), [form])
  // The third argument is the server snapshot: the shell renders these pages
  // through `react-dom`, where a hook without it throws.
  const snapshot = useSyncExternalStore(subscribe, read, read) as ConfigSnapshot | undefined
  const value = snapshot?.value ?? {}
  const writable = snapshot?.writable !== false
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const writeTicket = useRef(0)
  const statusId = useInstanceId('dssb-toggle-status')

  const toggle = useCallback(async (key: string, next: boolean) => {
    const mine = ++writeTicket.current
    setBusy(true)
    setStatus(t('saving'))
    setError(undefined)
    try {
      const accepted = await withDeadline(form.set(key, next), WRITE_TIMEOUT_MS, t('timeout'))
      if (accepted === false) throw new Error(t('pluginOptionsRejected'))
      if (mine === writeTicket.current) setStatus(t('saved'))
    } catch (caught) {
      if (mine !== writeTicket.current) return
      setError(`${t('saveFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
      setStatus(undefined)
    } finally {
      if (mine === writeTicket.current) setBusy(false)
    }
  }, [form, t])

  const labelOf = (brand: Brand): string => {
    const key = brand.id === 'cn'
      ? 'displayName'
      : brand.id === 'global' ? 'intlDisplayName' : 'codebuddyDisplayName'
    const fallback = t(brand.navKey)
    const stored = value[key]
    return typeof stored === 'string' && stored !== '' ? stored : fallback
  }

  if (view !== undefined && view !== 'page') {
    const names = BRANDS
      .filter(brand => value[brand.fields.enabled] !== false)
      .map(labelOf)
    return <span>{names.join(' · ')}</span>
  }

  return (
    <div style={css.group}>
      <h3 style={css.h3}>{t('pluginOptionsTitle')}</h3>
      <div style={css.note}>{t('pluginOptionsHint')}</div>
      <div>
        {BRANDS.map((brand, index) => {
          const enabled = value[brand.fields.enabled] !== false
          const name = labelOf(brand)
          const checkboxId = `dssb-toggle-${brand.id}`
          return (
            <div
              key={brand.id}
              style={{ ...css.optionRow, ...(index === 0 ? css.optionFirst : {}) }}
            >
              <input
                id={checkboxId}
                type="checkbox"
                className={CLASS.check}
                style={css.switch}
                checked={enabled}
                disabled={busy || !writable}
                aria-describedby={statusId}
                onChange={event => { void toggle(brand.fields.enabled, event.target.checked) }}
              />
              <label htmlFor={checkboxId} className={CLASS.hit} style={css.optionText}>
                <span style={css.optionName} translate="no">{name}</span>
                <span style={css.optionStatus}>{enabled ? t('pluginOptionsOn') : t('pluginOptionsOff')}</span>
              </label>
            </div>
          )
        })}
      </div>
      {writable ? null : <div style={css.note}>{t('pluginOptionsReadOnly')}</div>}
      <LiveAlert>{error}</LiveAlert>
      <span id={statusId}>
        <LiveStatus>{error === undefined ? status : undefined}</LiveStatus>
      </span>
    </div>
  )
}
