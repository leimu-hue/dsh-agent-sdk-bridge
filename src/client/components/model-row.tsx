/**
 * One row of the model list: the on/off switch, the model identity and the
 * context-window choice.
 *
 * The row is presentational on purpose. Its two decisions — which windows may be
 * offered, and whether a window is selectable at all — are the provider-facing
 * rules the settings page must get right, so they live here rather than as
 * inline JSX in the page. Writes are callbacks, which keeps the page's revision
 * fence and busy state in one place.
 *
 * @module dsh-agent-sdk-bridge/client/components/model-row
 */

import * as React from 'react'
import type { ReactElement } from 'react'
import { priceSuffix, windowLabel } from '../format.ts'
import { CLASS, css } from '../styles.ts'
import type { ModelRow, Translate } from '../types.ts'

/** What a model row's window column chooses between. */
interface WindowChoice {
  value: string
  label: string
}

/** Everything one row renders from, plus the two writes it can request. */
export interface ModelRowViewProps {
  model: ModelRow
  /** Position in the filtered list; only used to derive a unique checkbox id. */
  index: number
  /** Provider id, so two editions' rows never share a DOM id. */
  brandId: string
  t: Translate
  /** A config write is in flight; both controls are disabled. */
  busy: boolean
  onToggle: (enabled: boolean) => void
  /** A number selects a window; undefined restores the provider's default. */
  onWindow: (window: number | undefined) => void
}

/** Render one model row. */
export function ModelRowView({
  model, index, brandId, t, busy, onToggle, onWindow,
}: ModelRowViewProps): ReactElement {
  const choices: number[] = Array.isArray(model.contextWindows) ? model.contextWindows : []
  // A model the provider pins to one window has nothing to choose: the CLI
  // rejects every other value, so a dropdown here would be a control that
  // never reaches the upstream. Show the value instead.
  const fixedWindow = model.contextWindowSelectable === false || choices.length === 0
  // The default window has its own entry; repeating it in the list reads as
  // two identical choices. A stored override equal to it still shows.
  const offered: WindowChoice[] = choices
    .filter(size => size !== model.defaultContextWindow || size === model.override)
    .map(size => ({ value: String(size), label: windowLabel(size) }))
  const checkboxId = `dssb-model-${brandId}-${index}`

  return (
    <div
      className={CLASS.row}
      style={{ ...css.row, ...(index === 0 ? css.rowFirst : {}), ...(model.enabled ? {} : css.rowOff) }}
    >
      <input
        id={checkboxId}
        type="checkbox"
        className={CLASS.check}
        style={css.switch}
        checked={model.enabled === true}
        disabled={busy}
        onChange={event => { onToggle(event.target.checked) }}
      />
      <div style={css.name}>
        <label htmlFor={checkboxId} className={CLASS.hit} style={{ display: 'flex', alignItems: 'baseline', minWidth: 0 }}>
          <span style={css.nameText} title={model.name} translate="no">{model.name}</span>
          {model.vision === true
            ? <span style={{ ...css.tag, marginLeft: '6px' }}>{t('vision')}</span>
            : null}
          {priceSuffix(t, model.priceFactor) !== ''
            ? <span style={css.price}>{` · ${priceSuffix(t, model.priceFactor)}`}</span>
            : null}
        </label>
        <div style={css.id} translate="no">{model.id}</div>
      </div>
      {fixedWindow
        ? (
            <span
              style={{ ...css.note, minWidth: '104px', textAlign: 'right' }}
              title={t('windowFixedHint')}
            >
              {`${windowLabel(model.contextWindow ?? model.defaultContextWindow)} · ${t('windowFixed')}`}
            </span>
          )
        : (
            <select
              className={CLASS.select}
              style={css.select}
              value={model.override === undefined ? '' : String(model.override)}
              disabled={busy}
              title={t('windowDefaultHint')}
              aria-label={`${model.name} ${t('windowSelectLabel')}`}
              onChange={event => {
                const next = event.target.value
                onWindow(next === '' ? undefined : Number(next))
              }}
            >
              <option value="">{`${t('windowDefault')} · ${windowLabel(model.defaultContextWindow)}`}</option>
              {offered.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          )}
    </div>
  )
}
