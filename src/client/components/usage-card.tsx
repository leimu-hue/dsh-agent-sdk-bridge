/**
 * Qoder's account quota, read through the CLI.
 *
 * This is the same data the Qoder clients show on their account panel: plan,
 * percentage used, remaining credits, add-on package, expiry and the usage and
 * upgrade links. It is fetched from the host (which asks the CLI), not from the
 * provider directly, because only the CLI holds a usable token.
 *
 * The card is stale-while-revalidate: the last reading paints immediately and
 * a fresh one replaces it. A failed read keeps the old numbers and says they
 * are old rather than replacing them with an empty card — except when the CLI
 * is gone, where the stored numbers describe a machine state that no longer
 * exists and are dropped.
 *
 * @module dsh-agent-sdk-bridge/client/components/usage-card
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { api, clearCache, readCache, writeCache } from '../api.ts'
import { dateLabel, neverExpires, percentOf, creditReading, timeLabel } from '../format.ts'
import { CLASS, css } from '../styles.ts'
import type { Brand, Translate, UsageSnapshot } from '../types.ts'
import { CreditMeter } from './credit-meter.tsx'
import { ExternalLink, LiveAlert, LiveStatus } from './primitives.tsx'

/** Everything the card takes from its page. */
export interface UsageCardProps {
  t: Translate
  brand: Brand
  /** Bumped when the page needs the stored reading re-validated. */
  refreshSignal: number
  /**
   * Re-read the whole account, when the page can.
   *
   * The quota and the model list come from two routes and the quota is the fast
   * one, so a quota-only refresh left the page showing the new numbers beside
   * the previous account's models. When the page supplies this, both buttons
   * ask for the account instead of only the quota.
   */
  onRefresh?: () => void
}

/** Account quota and usage, read through the CLI. */
export function UsageCard({ t, brand, refreshSignal, onRefresh }: UsageCardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | undefined>(() => readCache<UsageSnapshot>(brand.id, 'usage'))
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** The CLI is not installed: show that, and never any cached numbers. */
  const [missing, setMissing] = useState(false)
  const ticket = useRef(0)

  const load = useCallback(async (fresh = false) => {
    const mine = ++ticket.current
    setBusy(true)
    setFailure(undefined)
    try {
      const payload = await api<UsageSnapshot>(`/usage?brand=${brand.id}${fresh ? '&fresh=1' : ''}`, { timeout: 45_000 })
      if (mine !== ticket.current) return
      // The CLI is gone: the stored reading describes an installation that no
      // longer exists, so drop it (memory and storage) instead of labelling old
      // credits "last reading".
      if (payload?.cliMissing === true) {
        clearCache(brand.id, 'usage')
        setSnapshot(undefined)
        setMissing(true)
        setFailure(String(payload.error ?? t('usageCliMissing')))
        return
      }
      // Any other failed lookup (signed out, endpoint down) must not replace the
      // last good reading with an empty card: keep it and say so.
      if (payload?.usage === undefined && payload?.error !== undefined) {
        setMissing(false)
        setFailure(String(payload.error))
        return
      }
      setMissing(false)
      setSnapshot(payload)
      writeCache(brand.id, 'usage', payload)
    } catch (error) {
      if (mine !== ticket.current) return
      setFailure(String((error as Error | undefined)?.message ?? error))
    } finally {
      if (mine === ticket.current) setBusy(false)
    }
  }, [brand.id, t])

  // `refreshSignal` changes when the page's refresh asks the whole account to
  // be re-read, so that pass must not be served from the cached reading: a
  // login performed in between would otherwise keep showing the signed-out
  // answer for up to the cache TTL.
  useEffect(() => { void load(refreshSignal > 0) }, [load, refreshSignal])

  /**
   * Re-read the account: the page's action when it has one, otherwise this
   * card's own quota read.
   *
   * Both buttons use it. A quota failure is how a not-yet-signed-in CLI shows
   * up here, so retrying only the quota would leave the model list — the thing
   * the user is about to look for — exactly as stale as before.
   */
  const requestRefresh = useCallback(() => {
    if (onRefresh === undefined) {
      void load(true)
      return
    }
    onRefresh()
  }, [load, onRefresh])

  const usage = snapshot?.usage
  const account = snapshot?.account
  const error = failure
    ?? (snapshot?.usage === undefined && snapshot?.error !== undefined ? String(snapshot.error) : undefined)
  const plan = account?.subscriptionType ?? usage?.userType ?? t('usageUnknownPlan')
  const identity = account?.name ?? account?.email ?? usage?.userId
  const exceeded = usage?.isQuotaExceeded === true

  const head = (
    <div style={css.usageHead}>
      <h3 style={css.h3}>{t('usageTitle')}</h3>
      {identity === undefined
        ? null
        : <span style={{ ...css.note, opacity: 0.78 }}>{t('usageAccount')} {identity}</span>}
      <button
        type="button"
        className={CLASS.button}
        style={{ ...css.btn, marginLeft: 'auto' }}
        disabled={busy}
        onClick={requestRefresh}
      >
        {busy ? t('refreshing') : t('usageRefresh')}
      </button>
    </div>
  )

  if (snapshot === undefined || usage === undefined) {
    return (
      <div style={css.usageCard}>
        {head}
        {/*
         * Nothing is shown for a missing CLI beyond the reason: the account,
         * plan and credits a previous install reported are not this machine's
         * state any more.
         */}
        {missing
          ? <div style={css.note}>{error ?? t('usageCliMissing')}</div>
          : error === undefined
            ? <LiveStatus>{t('usageLoading')}</LiveStatus>
            : <LiveAlert>{`${t('usageUnavailable')}：${error}`}</LiveAlert>}
        {error === undefined
          ? null
          : (
              <div style={css.bar}>
                <button type="button" className={CLASS.button} style={css.btn} disabled={busy} onClick={requestRefresh}>
                  {t('usageRetry')}
                </button>
              </div>
            )}
      </div>
    )
  }

  const expiry = usage.expiresAt
  const buckets: [string, unknown][] = [
    [t('usagePlanQuota'), usage.userQuota],
    [t('usageAddOn'), usage.addOnQuota],
    [t('usageOrgPackage'), usage.orgResourcePackage],
  ]
  // Some accounts report only the overall percentage; a card with no meter at
  // all would hide the one number the endpoint did give.
  const meters = buckets.some(([, bucket]) => creditReading(bucket) !== undefined)
    ? buckets.map(([label, bucket]) => (
        <CreditMeter key={label} t={t} label={label} bucket={bucket} danger={exceeded} />
      ))
    : percentOf(usage.totalUsagePercentage) === undefined
      ? null
      : (
          <CreditMeter
            t={t}
            label={t('usagePlanQuota')}
            bucket={{ percentage: usage.totalUsagePercentage }}
            danger={exceeded}
          />
        )

  return (
    <div style={css.usageCard}>
      {head}
      <div style={css.usageLine}>
        <span style={css.usageLabel}>{t('usagePlan')}</span>
        <span style={css.usageValue}>{plan}</span>
        {exceeded ? <span style={{ ...css.err, fontWeight: 600 }}>{t('usageExceeded')}</span> : null}
      </div>
      <div style={css.creditStack}>{meters}</div>
      <div style={css.usageFoot}>
        <span>
          {t('usageExpires')}{' '}
          {expiry === undefined || neverExpires(expiry) ? t('usageNever') : dateLabel(expiry)}
        </span>
        {snapshot.at === undefined ? null : <span>{t('usageUpdated')} {timeLabel(snapshot.at)}</span>}
        {typeof usage.addOnQuota?.detailUrl === 'string'
          ? <ExternalLink href={usage.addOnQuota.detailUrl}>{t('usageDetail')}</ExternalLink>
          : null}
        {typeof usage.upgradeUrl === 'string' && usage.upgradeUrl !== ''
          ? <ExternalLink href={usage.upgradeUrl}>{t('usageUpgrade')}</ExternalLink>
          : null}
        {failure === undefined ? null : <span style={css.err}>{t('usageStale')}：{failure}</span>}
      </div>
    </div>
  )
}
