/**
 * One credit bucket, in the shape both account cards use: `used / total` with
 * the percentage on the right and a bar underneath.
 *
 * A bucket the account does not have reports no numbers at all, so it renders
 * nothing rather than an empty bar. The label doubles as the bar's accessible
 * name, which is why it is a required string wherever one is drawn.
 *
 * @module dsh-agent-sdk-bridge/client/components/credit-meter
 */

import * as React from 'react'
import type { ReactElement } from 'react'
import { css } from '../styles.ts'
import { creditsOf, creditReading, creditUnit } from '../format.ts'
import type { Translate } from '../types.ts'
import { Meter } from './primitives.tsx'

/** What one meter needs: the copy, its heading and the upstream bucket. */
export interface CreditMeterProps {
  t: Translate
  label?: string
  bucket: unknown
  /** Fills the bar in the alert colour (quota exhausted). */
  danger?: boolean
}

/** One bucket's figures and bar, or nothing when the bucket carries no numbers. */
export function CreditMeter({ t, label, bucket, danger }: CreditMeterProps): ReactElement | null {
  const reading = creditReading(bucket)
  if (reading === undefined) return null
  const { used, total, remaining, pct } = reading
  const amount = total !== undefined && used !== undefined
    ? `${creditsOf(used)} / ${creditsOf(total)} ${creditUnit(t, bucket)}`
    : total !== undefined && remaining !== undefined
      ? `${creditsOf(remaining)} / ${creditsOf(total)} ${creditUnit(t, bucket)}`
      : used !== undefined
        ? `${creditsOf(used)} ${creditUnit(t, bucket)}`
        : remaining !== undefined
          ? `${creditsOf(remaining)} ${creditUnit(t, bucket)}`
          : undefined
  return (
    <div style={css.creditMeter}>
      {label === undefined ? null : <div style={css.creditName}>{label}</div>}
      <div style={css.creditRow}>
        {amount === undefined ? null : <span style={css.creditLabel}>{used !== undefined ? t('usageUsed') : t('usageRemaining')}</span>}
        {amount === undefined ? null : <span style={css.creditAmount}>{amount}</span>}
        {pct === undefined ? null : <span style={css.creditPct}>{`${Number(pct.toFixed(1))}%`}</span>}
      </div>
      {pct === undefined
        ? null
        : <Meter pct={pct} label={label ?? t('usageTitle')} danger={danger} />}
    </div>
  )
}
