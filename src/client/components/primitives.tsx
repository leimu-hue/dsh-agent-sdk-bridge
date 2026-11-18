/**
 * The small pieces every card is built from: identifiers, live regions, meters
 * and the two-step confirmation for destructive actions.
 *
 * They exist because the state rules here are accessibility rules — an update
 * that is not announced, a bar a screen reader cannot read, a destructive
 * button that fires on the first click — and repeating them at each call site
 * is exactly how one of them ends up different from the others.
 *
 * @module dsh-agent-sdk-bridge/client/components/primitives
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { CLASS, css } from '../styles.ts'

/** Monotonic ids, so a label can name the control it describes without a hook. */
let sequence = 0

/** A document-unique id for one mounted control and its label. */
export function useInstanceId(prefix: string): string {
  const [id] = useState(() => `${prefix}-${++sequence}`)
  return id
}

/** A status line that assistive technology is told about, politely. */
export function LiveStatus({ children, style }: { children: ReactNode, style?: CSSProperties }): ReactElement | null {
  if (children === null || children === undefined || children === false) return null
  return (
    <div role="status" aria-live="polite" style={{ ...css.note, ...style }}>{children}</div>
  )
}

/** An error line: announced at once, because the user is waiting on an action. */
export function LiveAlert({ children, style }: { children: ReactNode, style?: CSSProperties }): ReactElement | null {
  if (children === null || children === undefined || children === false) return null
  return (
    <div role="alert" style={{ ...css.err, ...style }}>{children}</div>
  )
}

/**
 * One percentage bar.
 *
 * A `div` with a width is invisible to assistive technology, so the meter
 * carries the role and the value itself and the fill is decoration.
 */
export function Meter({ pct, label, danger }: { pct: number, label: string, danger?: boolean }): ReactElement {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-valuetext={`${Number(clamped.toFixed(1))}%`}
      style={css.creditBar}
    >
      <div
        className={CLASS.meterFill}
        style={{ ...css.creditBarFill, width: `${clamped}%`, ...(danger === true || clamped >= 100 ? css.progressDanger : {}) }}
      />
    </div>
  )
}

/** A link out of the shell; every one of them opens in a new tab. */
export function ExternalLink({ href, children, style }: { href: string, children: ReactNode, style?: CSSProperties }): ReactElement {
  return (
    <a className={CLASS.link} href={href} target="_blank" rel="noreferrer noopener" style={{ ...css.link, ...style }}>
      {children}
    </a>
  )
}

/** What a two-step confirmation needs to say. */
export interface ConfirmProps {
  /** The ordinary label: what the first click would do. */
  label: string
  /** The question shown once the button is armed. */
  question: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  disabled?: boolean
  /** Renders the first button in the alert colour. */
  alert?: boolean
  style?: CSSProperties
}

/**
 * A destructive button that takes two clicks.
 *
 * Not `window.confirm`: that blocks the shell's own event loop, cannot be
 * themed, and — worse — is unavailable in some embeddings, where the old code
 * returned early and left the button silently doing nothing. Here the first
 * click only arms the action, the second performs it, and an armed button
 * disarms itself after a few seconds so a stray click cannot complete it later.
 */
export function ConfirmButton({
  label, question, confirmLabel, cancelLabel, onConfirm, disabled, alert, style,
}: ConfirmProps): ReactElement {
  const [armed, setArmed] = useState(false)
  const target = useRef<HTMLButtonElement | null>(null)
  const questionId = useInstanceId('dssb-confirm')

  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), 8000)
    return () => clearTimeout(timer)
  }, [armed])

  // The revealed control takes focus: a keyboard user clicked nothing into
  // existence, and leaving focus on the button that just changed shape loses
  // their place.
  useEffect(() => {
    if (armed) target.current?.focus()
  }, [armed])

  const confirm = useCallback(() => {
    setArmed(false)
    onConfirm()
  }, [onConfirm])

  if (!armed) {
    return (
      <button
        type="button"
        className={alert === true ? `${CLASS.button} ${CLASS.buttonAlert}` : CLASS.button}
        style={{ ...css.btn, ...(alert === true ? css.btnAlert : {}), ...style }}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    )
  }

  return (
    <div role="group" aria-labelledby={questionId} style={css.actions}>
      <span id={questionId} style={{ ...css.note, flex: '1 1 220px' }}>{question}</span>
      <button type="button" ref={target} className={`${CLASS.button} ${CLASS.buttonAlert}`} style={{ ...css.btn, ...css.btnAlert }} onClick={confirm}>
        {confirmLabel}
      </button>
      <button type="button" className={CLASS.button} style={css.btn} onClick={() => setArmed(false)}>
        {cancelLabel}
      </button>
    </div>
  )
}
