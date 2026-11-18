/**
 * MiniMax Code's account card: login region, CLI presence, browser login and
 * the plan's quota windows.
 *
 * The login is a CLI process: `mcode login` opens the browser and writes an
 * auth file, so the card polls the host while that process runs and re-reads
 * the account when it finishes. Installing that CLI is left to the user — the
 * card only reports whether this machine has it.
 *
 * @module dsh-agent-sdk-bridge/client/components/minimax-card
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { api, withDeadline, WRITE_TIMEOUT_MS } from '../api.ts'
import { creditsOf, dateLabel, timeLabel, tokenExpiryText } from '../format.ts'
import { minimaxSnapshot, rememberMinimax } from '../snapshots.ts'
import { CLASS, css } from '../styles.ts'
import type {
  AuthStatus, Brand, ConfigSnapshot, MinimaxUsagePayload, PluginContext, Region, Translate,
} from '../types.ts'
import {
  ConfirmButton, ExternalLink, LiveAlert, LiveStatus, Meter, useInstanceId,
} from './primitives.tsx'

/** Everything the card takes from its page. */
export interface MinimaxCardProps {
  t: Translate
  ctx: PluginContext
  brand: Brand
  /** Bumped when the page asks every card to re-read. */
  refreshSignal: number
  /** Called whenever the sign-in state is known to have changed. */
  onAuthChange?: (signedIn: boolean) => void
  /** Called before the region write commits, so the page can follow at once. */
  onRegionChange?: (region: Region) => void
  /** Called with every account reading, which also carries the region verdict. */
  onUsage?: (payload: MinimaxUsagePayload) => void
}

/** MiniMax Code's settings-section account card. */
export function MinimaxCard({
  ctx, t, brand, refreshSignal, onAuthChange, onRegionChange, onUsage,
}: MinimaxCardProps): ReactElement {
  const form = ctx.configForms!.get('llm-qoder-cn')
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const read = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, read, read) as ConfigSnapshot | undefined
  const value = snapshot?.value ?? {}
  const configuredRegion: Region = value.minimaxRegion === 'global' ? 'global' : 'cn'
  const [region, setRegionState] = useState<Region>(configuredRegion)
  const regionRef = useRef<Region>(configuredRegion)
  const initial = minimaxSnapshot(configuredRegion)
  const [auth, setAuth] = useState<AuthStatus | undefined>(initial?.auth)
  const [usage, setUsage] = useState<MinimaxUsagePayload | undefined>(initial?.usage)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const lastRunning = useRef(false)
  /**
   * The region the account reading was last requested for.
   *
   * A switch must re-probe the network instead of serving the previous
   * region's cached verdict: the user changes region precisely because the
   * machine was (or is now) on the other side of the border. The first mount
   * keeps the snapshot-first behaviour and reads from cache.
   */
  const lastUsageRegion = useRef<Region>(configuredRegion)
  const regionSelectId = useInstanceId('dssb-minimax-region')
  const signingIn = auth?.running === true
  const signedIn = auth?.signedIn === true
  const installed = usage?.installed === true

  const applySnapshot = useCallback((target: Region) => {
    const cached = minimaxSnapshot(target)
    setAuth(cached?.auth)
    setUsage(cached?.usage)
  }, [])

  const loadUsage = useCallback(async (fresh = false, target = regionRef.current) => {
    try {
      const payload = await api<MinimaxUsagePayload>(`/usage?brand=minimax&region=${target}${fresh ? '&fresh=1' : ''}`, { timeout: 30_000 })
      if (regionRef.current !== target) return
      setUsage(payload)
      rememberMinimax(target, { usage: payload })
      onUsage?.(payload)
      if (typeof payload?.signedIn === 'boolean') {
        setAuth(previous => (previous?.running === true
          ? previous
          : { ...previous, running: false, region: target, signedIn: payload.signedIn }))
      }
    } catch (caught) {
      if (regionRef.current !== target) return
      setUsage({ error: String((caught as Error | undefined)?.message ?? caught) })
    }
  }, [onUsage])

  const pollAuth = useCallback(async (target = regionRef.current) => {
    try {
      const next = await api<AuthStatus>(`/auth?brand=minimax&region=${target}`, { timeout: 10_000 })
      if (regionRef.current !== target) return
      setAuth(next)
      rememberMinimax(target, { auth: next })
      if (lastRunning.current && next.running === false) {
        lastRunning.current = false
        if (next.signedIn === true) {
          await loadUsage(true, target)
          onAuthChange?.(true)
        }
      }
      if (next.running === true) lastRunning.current = true
    } catch (caught) {
      if (regionRef.current !== target) return
      setError(String((caught as Error | undefined)?.message ?? caught))
    }
  }, [loadUsage, onAuthChange])

  useEffect(() => {
    regionRef.current = region
    applySnapshot(region)
    setError(undefined)
    const switched = lastUsageRegion.current !== region
    lastUsageRegion.current = region
    void pollAuth(region)
    // `fresh` drops both the 60s account cache and the region-access verdict,
    // so a switch always re-probes the network before deciding.
    void loadUsage(switched, region)
  }, [region, refreshSignal, applySnapshot, loadUsage, pollAuth])

  useEffect(() => {
    if (configuredRegion === regionRef.current) return
    setRegionState(configuredRegion)
    regionRef.current = configuredRegion
    applySnapshot(configuredRegion)
  }, [configuredRegion, applySnapshot])

  useEffect(() => {
    if (!signingIn) return undefined
    const timer = setInterval(() => { void pollAuth(region) }, 1500)
    return () => clearInterval(timer)
  }, [signingIn, pollAuth, region])

  const authResolved = auth !== undefined
  useEffect(() => {
    if (!authResolved) return
    onAuthChange?.(signedIn)
  }, [authResolved, signedIn, onAuthChange])

  const setRegion = useCallback((next: Region) => {
    if (next === regionRef.current) return
    regionRef.current = next
    lastRunning.current = false
    setRegionState(next)
    applySnapshot(next)
    setError(undefined)
    onRegionChange?.(next)
    void (async () => {
      try {
        const accepted = await withDeadline(form.set('minimaxRegion', next), WRITE_TIMEOUT_MS, t('timeout'))
        if (accepted === false) throw new Error(t('saveFailed'))
      } catch (caught) {
        if (regionRef.current !== next) return
        setError(`${t('saveFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
        const fallback: Region = form.getSnapshot()?.value?.minimaxRegion === 'global' ? 'global' : 'cn'
        regionRef.current = fallback
        setRegionState(fallback)
        applySnapshot(fallback)
        onRegionChange?.(fallback)
      }
    })()
  }, [applySnapshot, form, onRegionChange, t])

  const startLogin = useCallback(async () => {
    const target = regionRef.current
    setBusy(true)
    setError(undefined)
    try {
      const next = await api<AuthStatus>('/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand: 'minimax', region: target, action: 'login' }),
        timeout: 20_000,
      })
      if (regionRef.current !== target) return
      setAuth(next)
      rememberMinimax(target, { auth: next })
      if (next.running === true) lastRunning.current = true
    } catch (caught) {
      if (regionRef.current !== target) return
      setError(`${t('minimaxLoginFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
    } finally {
      setBusy(false)
    }
  }, [t])

  const logout = useCallback(async () => {
    const target = regionRef.current
    setBusy(true)
    setError(undefined)
    try {
      const next = await api<AuthStatus>('/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand: 'minimax', region: target, action: 'logout' }),
        timeout: 30_000,
      })
      if (regionRef.current !== target) return
      setAuth(next)
      rememberMinimax(target, { auth: next })
      onAuthChange?.(false)
    } catch (caught) {
      if (regionRef.current !== target) return
      setError(`${t('minimaxLoginFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
    } finally {
      setBusy(false)
    }
  }, [onAuthChange, t])

  const account = usage?.account
  const plan = usage?.plan
  const credits = usage?.credits
  const quotas = Array.isArray(usage?.windows) ? usage.windows : []
  const planLabel = plan?.kind === 'token-plan'
    ? t('minimaxPlanTokenPlan')
    : plan?.kind === 'credits' ? t('minimaxPlanCredits') : t('minimaxPlanFree')
  const blocked = usage?.regionBlocked === true
  const hasQuotaData = account !== undefined || plan !== undefined
    || credits !== undefined || quotas.length > 0

  const quotaBlock = !signedIn
    ? <div style={css.note}>{installed ? t('minimaxNoUsage') : t('minimaxCliRequired')}</div>
    : blocked
      ? (
          <div style={css.guide}>
            <div style={css.guideText}>{usage?.error ?? t('minimaxIpBlocked')}</div>
            <button
              type="button"
              className={`${CLASS.button} ${CLASS.buttonAlert}`}
              style={{ ...css.btn, ...css.btnAlert }}
              disabled={busy}
              onClick={() => setRegion(region === 'global' ? 'cn' : 'global')}
            >
              {region === 'global' ? t('minimaxSwitchToCn') : t('minimaxSwitchToGlobal')}
            </button>
          </div>
        )
      : usage === undefined
        ? <LiveStatus>{t('minimaxUsageLoading')}</LiveStatus>
        : !hasQuotaData && usage.error !== undefined
          ? <LiveAlert>{`${t('minimaxUsageFailed')}：${usage.error}`}</LiveAlert>
          : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {account === undefined
                  ? null
                  : (
                      <div style={css.usageLine}>
                        <span style={css.usageLabel}>{t('minimaxAccount')}</span>
                        <span className={CLASS.breakable} style={css.usageValue}>
                          {account.name ?? account.email ?? t('minimaxAccountUnknown')}
                        </span>
                      </div>
                    )}
                {plan === undefined
                  ? null
                  : (
                      <div style={css.usageLine}>
                        <span style={css.usageLabel}>{t('minimaxPlan')}</span>
                        <span className={CLASS.breakable} style={css.usageValue}>{plan.name ?? planLabel}</span>
                        {plan.hasTokenPlan === true
                          ? <span style={{ ...css.tag, marginLeft: '6px' }}>{t('minimaxPlanTokenPlan')}</span>
                          : null}
                        {plan.expiresAt === undefined
                          ? null
                          : <span style={css.note}>{t('minimaxPlanExpires')} {dateLabel(plan.expiresAt)}</span>}
                      </div>
                    )}
                {credits === undefined
                  ? null
                  : (
                      <div style={css.usageLine}>
                        <span style={css.usageLabel}>{t('minimaxCredits')}</span>
                        <span style={css.usageValue}>{creditsOf(credits.remaining)}</span>
                        {typeof credits.purchasedRemaining === 'number' && credits.purchasedRemaining > 0
                          ? <span style={css.note}>{t('minimaxCreditsPurchased')} {creditsOf(credits.purchasedRemaining)}</span>
                          : null}
                        {typeof credits.freeRemaining === 'number' && credits.freeRemaining > 0
                          ? <span style={css.note}>{t('minimaxCreditsFree')} {creditsOf(credits.freeRemaining)}</span>
                          : null}
                      </div>
                    )}
                {quotas.length === 0
                  ? <div style={css.note}>{t('minimaxQuotaNone')}</div>
                  : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                        {quotas.map(quota => {
                          const remaining = typeof quota.remainingPercent === 'number' ? quota.remainingPercent : undefined
                          const used = remaining === undefined ? undefined : 100 - remaining
                          return (
                            <div key={quota.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={css.usageLine}>
                                <span style={css.usageLabel}>{quota.label}</span>
                                <span style={css.usageValue}>
                                  {quota.unlimited
                                    ? t('minimaxQuotaUnlimited')
                                    : remaining === undefined
                                      ? (quota.remainingCount === undefined ? '—' : `${creditsOf(quota.remainingCount)} / ${creditsOf(quota.totalCount ?? 0)}`)
                                      : `${t('minimaxQuotaRemaining')} ${remaining}%`}
                                </span>
                                {typeof quota.resetAt === 'number'
                                  ? <span style={css.note}>{t('minimaxQuotaReset')} {timeLabel(quota.resetAt)}</span>
                                  : null}
                              </div>
                              {used === undefined || quota.unlimited
                                ? null
                                : <Meter pct={used} label={quota.label} danger={remaining !== undefined && remaining < 20} />}
                            </div>
                          )
                        })}
                      </div>
                    )}
                {usage.error !== undefined
                  ? <LiveAlert>{`${t('minimaxUsageFailed')}：${usage.error}`}</LiveAlert>
                  : null}
              </div>
            )

  return (
    <div style={css.usageCard}>
      <div style={css.usageHead}>
        <h3 style={css.h3}>{t('minimaxAuthTitle')}</h3>
        <span style={{ ...css.note, opacity: 0.78 }}>
          {blocked ? t('minimaxRegionBlockedShort') : signedIn ? t('minimaxSignedIn') : t('minimaxNotLoggedIn')}
        </span>
        {signedIn
          ? (
              <button
                type="button"
                className={CLASS.button}
                style={{ ...css.btn, marginLeft: 'auto' }}
                disabled={busy}
                onClick={() => void loadUsage(true)}
              >
                {t('usageRefresh')}
              </button>
            )
          : null}
      </div>
      <div style={css.note}>{t('minimaxAuthHint')}</div>

      <div style={css.usageLine}>
        <label htmlFor={regionSelectId} style={css.usageLabel}>{t('minimaxRegionLabel')}</label>
        <select
          id={regionSelectId}
          className={CLASS.select}
          style={css.select}
          value={region}
          disabled={busy}
          onChange={event => setRegion(event.target.value === 'global' ? 'global' : 'cn')}
        >
          <option value="cn">{t('minimaxRegionCn')}</option>
          <option value="global">{t('minimaxRegionGlobal')}</option>
        </select>
        {signedIn
          ? (
              <ConfirmButton
                label={t('minimaxLogout')}
                question={t('minimaxConfirmLogout')}
                confirmLabel={t('confirmYes')}
                cancelLabel={t('confirmCancel')}
                disabled={busy || signingIn}
                alert
                onConfirm={() => void logout()}
              />
            )
          : (
              <button
                type="button"
                className={CLASS.button}
                style={css.btn}
                disabled={busy || signingIn || (!signedIn && !installed)}
                onClick={() => void startLogin()}
              >
                {signingIn ? t('minimaxLoggingIn') : t('minimaxLogin')}
              </button>
            )}
      </div>

      {quotaBlock}

      {typeof auth?.expiresAt === 'number' && !blocked
        ? (
            <div style={css.usageFoot}>
              <span>{tokenExpiryText(t, auth.expiresAt)}</span>
              <span style={css.note}>{t('minimaxTokenRenew')}</span>
            </div>
          )
        : null}

      {typeof auth?.url === 'string' && signingIn
        ? (
            <div style={css.usageLine}>
              <ExternalLink href={auth.url}>{t('minimaxOpenUrl')}</ExternalLink>
              <span style={css.note}>{t('minimaxLoginStarted')}</span>
            </div>
          )
        : null}

      {auth?.error !== undefined ? <LiveAlert>{`${t('minimaxLoginFailed')}：${auth.error}`}</LiveAlert> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={css.usageLine}>
          <span style={css.usageLabel}>{t('minimaxCliGroup')}</span>
          <span style={css.usageValue}>{installed ? t('minimaxCliInstalled') : t('minimaxCliMissing')}</span>
        </div>
        <div style={css.note}>{t('minimaxCliHint')}</div>
      </div>

      {error !== undefined ? <LiveAlert>{error}</LiveAlert> : null}
    </div>
  )
}
