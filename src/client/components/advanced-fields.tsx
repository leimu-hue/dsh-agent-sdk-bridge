/**
 * The collapsed "advanced" block: the scalars worth reaching without editing
 * YAML, rendered against the host's schema.
 *
 * The schema stays the source of truth for labels, help text, bounds and step;
 * {@link ADVANCED} only decides order and control. Every control is
 * uncontrolled and commits on blur: these fields write through the same
 * revision-fenced form as everything else, and a write per keystroke turned
 * typing `120` into three round trips and a race with its own echoes.
 *
 * @module dsh-agent-sdk-bridge/client/components/advanced-fields
 */

import * as React from 'react'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { CLASS, css } from '../styles.ts'
import type {
  AdvancedFields, AdvancedKind, ConfigForm, ConfigSnapshot, SchemaNode, Translate,
} from '../types.ts'
import { advancedLabels } from '../types.ts'
import { LiveAlert, useInstanceId } from './primitives.tsx'

/** What the advanced block needs from its page. */
export interface AdvancedProps {
  t: Translate
  form: ConfigForm
  snapshot: ConfigSnapshot | undefined
  fields: AdvancedFields
  /** The namespace's schema, which supplies bounds and help text. */
  namespace?: { schema?: { uid?: string, refs?: Record<string, SchemaNode> } }
  show: boolean
  onToggle: () => void
}

/** The collapsed advanced block. */
export function AdvancedBlock({
  t, form, snapshot, fields, namespace, show, onToggle,
}: AdvancedProps): ReactElement {
  const bodyId = useInstanceId('dssb-advanced')
  const [invalid, setInvalid] = useState<string | undefined>(undefined)

  const header = (
    <div style={css.bar}>
      <button
        type="button"
        className={CLASS.button}
        style={css.btn}
        aria-expanded={show}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        {show ? t('hide') : t('show')}
      </button>
      <span style={css.note}>{t('advancedHint')}</span>
    </div>
  )

  if (!show) {
    return (
      <div style={css.group}>
        <h3 style={css.h3}>{t('advanced')}</h3>
        {header}
      </div>
    )
  }

  const value = snapshot?.value ?? {}
  const user = snapshot?.user
  const schema = namespace?.schema
  const refs = schema?.refs
  const root = refs?.[schema?.uid ?? '']
  const writable = snapshot?.writable !== false
  const labels = advancedLabels(t)

  const commit = (key: string, kind: AdvancedKind, raw: string): void => {
    if (kind === 'number') {
      if (raw === '') {
        form.unset(key).catch(() => undefined)
        return
      }
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) {
        setInvalid(labels[key] ?? key)
        return
      }
      setInvalid(undefined)
      form.set(key, parsed).catch(() => undefined)
      return
    }
    if (kind === 'json') {
      try {
        form.set(key, JSON.parse(raw) as unknown).catch(() => undefined)
        setInvalid(undefined)
      } catch {
        // Keep the last valid value: half-typed JSON is not a config change.
        setInvalid(labels[key] ?? key)
      }
      return
    }
    // An emptied text field means "back to the default", which is how the
    // schema spells an unset cell.
    const op = raw === '' ? form.unset(key) : form.set(key, raw)
    op.catch(() => undefined)
  }

  const rows = fields.map(([key, kind]) => {
    const node = root === undefined ? undefined : refs?.[root.dict?.[key] ?? '']
    if (node === undefined) return null
    const help = typeof node.meta?.description === 'string' ? node.meta.description : undefined
    const current = value[key]
    const overridden = user !== null && typeof user === 'object' && Object.hasOwn(user, key)
    const inputId = `dssb-adv-${key}`
    const label = labels[key] ?? key
    // Remount when the stored value changes from elsewhere (reset, another
    // window), so an uncontrolled control shows what was actually stored.
    const syncKey = `${key}:${current === undefined ? '' : JSON.stringify(current)}`

    return (
      <div key={syncKey} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label htmlFor={inputId} style={css.advLabel}>{label}</label>
          {overridden && writable
            ? (
                <button
                  type="button"
                  className={CLASS.button}
                  style={{ fontSize: '0.75em', opacity: 0.72, background: 'none', border: 'none', textDecoration: 'underline', padding: 0, font: 'inherit', color: 'inherit' }}
                  onClick={() => { setInvalid(undefined); form.unset(key).catch(() => undefined) }}
                >
                  {t('reset')}
                </button>
              )
            : null}
        </div>
        {kind === 'json'
          ? (
              <input
                id={inputId}
                className={CLASS.input}
                style={{ ...css.input, fontFamily: 'ui-monospace, monospace' }}
                defaultValue={current === undefined ? '{}' : JSON.stringify(current)}
                disabled={!writable}
                spellCheck={false}
                autoComplete="off"
                onBlur={event => commit(key, kind, event.target.value)}
              />
            )
          : (
              <input
                id={inputId}
                className={CLASS.input}
                style={css.input}
                type={kind === 'number' ? 'number' : 'text'}
                defaultValue={current === undefined ? '' : String(current)}
                min={node.meta?.min}
                max={node.meta?.max}
                step={node.meta?.step}
                disabled={!writable}
                spellCheck={kind === 'text'}
                autoComplete="off"
                onBlur={event => commit(key, kind, event.target.value)}
              />
            )}
        {help !== undefined ? <div style={css.note}>{help}</div> : null}
      </div>
    )
  }).filter(Boolean)

  return (
    <div style={css.group}>
      <h3 style={css.h3}>{t('advanced')}</h3>
      {header}
      {invalid === undefined ? null : <LiveAlert>{`${t('advancedInvalid')} ${invalid}`}</LiveAlert>}
      <div id={bodyId} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows}
      </div>
    </div>
  )
}
