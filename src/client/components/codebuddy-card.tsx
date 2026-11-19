/**
 * CodeBuddy's account card: region choice, browser sign-in and the signed-in
 * account with its credit packages.
 *
 * The region is a config write (the host starts the CLI with it), but the card
 * does not wait for it: the target region's snapshot paints first and the live
 * account read follows. Both regions keep their own saved login, so switching
 * back does not open the browser again.
 *
 * @module dsh-agent-sdk-bridge/client/components/codebuddy-card
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { api, withDeadline, WRITE_TIMEOUT_MS } from '../api.ts'
import { creditsOf, dateLabel, packageSummary } from '../format.ts'
import { codeBuddySnapshot, rememberCodeBuddy } from '../snapshots.ts'
import { CLASS, css } from '../styles.ts'
import type {
  AuthStatus, Brand, CodeBuddyAccountPayload, ConfigSnapshot, PluginContext, Region, Translate,
} from '../types.ts'
import { CreditMeter } from './credit-meter.tsx'
import {
  ConfirmButton, ExternalLink, LiveAlert, LiveStatus, useInstanceId,
} from './primitives.tsx'

/** Everything the card takes from its page. */
export interface CodeBuddyCardProps {
  t: Translate
  ctx: PluginContext
  brand: Brand
  /** Bumped after a CLI install or uninstall. */
  refreshSignal: number
  /** Called when the card has just learned the account is usable. */
  onSignedIn?: () => void
  /** Called when the region write commits, with the new region. */
  onAuthChange?: (signedIn: boolean) => void
  /** Called before the region write commits, so the page can follow at once. */
  onRegionChange?: (region: Region) => void
}

/** The account card CodeBuddy's settings section renders. */
export function CodeBuddyCard({
  t, ctx, refreshSignal, onSignedIn, onAuthChange, onRegionChange,
}: CodeBuddyCardProps): ReactElement {
  const form = ctx.configForms!.get('llm-qoder-cn')
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const read = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, read, read) as ConfigSnapshot | undefined
  const value = snapshot?.value ?? {}
  const configuredRegion: Region = value.codebuddyRegion === 'cn' ? 'cn' : 'global'
  const [region, setRegionState] = useState<Region>(configuredRegion)
  const regionRef = useRef<Region>(configuredRegion)
  const initial = codeBuddySnapshot(configuredRegion)
  const [auth, setAuth] = useState<AuthStatus | undefined>(initial?.auth)
  const [account, setAccount] = useState<CodeBuddyAccountPayload | undefined>(initial?.account)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Credit packages default to one summary row; the per-package list only
  // opens on request, inside a bounded scroll area.
  const [packsExpanded, setPacksExpanded] = useState(false)
  const packsId = useInstanceId('dssb-packs')
  const regionSelectId = useInstanceId('dssb-codebuddy-region')
  const lastRunning = useRef(false)
  const signingIn = auth?.running === true
  const accountFields = account?.account ?? {}
  const accountSignedIn = account?.error === undefined
    && ['uid', 'userName', 'email', 'organization', 'subscriptionType']
      .some(key => typeof accountFields[key as keyof typeof accountFields] === 'string'
        && accountFields[key as keyof typeof accountFields] !== '')
  // The host's status is authoritative once it has answered; the account
  // reading only covers the first paint before that answer arrives.
  const signedIn = auth === undefined ? accountSignedIn : auth.signedIn === true
  const resolved = auth !== undefined || account !== undefined

  const applySnapshot = useCallback((target: Region) => {
    const cached = codeBuddySnapshot(target)
    setAuth(cached?.auth)
    setAccount(cached?.account)
  }, [])

  const loadAccount = useCallback(async (fresh = false, target = regionRef.current) => {
    try {
      const payload = await api<CodeBuddyAccountPayload>(`/usage?brand=codebuddy&region=${target}${fresh ? '&fresh=1' : ''}`, { timeout: 45_000 })
      if (regionRef.current !== target) return
      setAccount(payload)
      rememberCodeBuddy(target, { account: payload })
      // A quota 401 clears the server's credential; mirror that here so the
      // button flips back to sign-in without waiting for a page reload.
      if (typeof payload?.signedIn === 'boolean') {
        const next: AuthStatus = { running: false, region: target, signedIn: payload.signedIn }
        setAuth(previous => (previous?.running === true ? previous : next))
        rememberCodeBuddy(target, { auth: next })
      }
    } catch (caught) {
      if (regionRef.current !== target) return
      setAccount({ error: String((caught as Error | undefined)?.message ?? caught) })
    }
  }, [])

  const poll = useCallback(async (target = regionRef.current) => {
    try {
      const next = await api<AuthStatus>(`/auth?brand=codebuddy&region=${target}`, { timeout: 10_000 })
      if (regionRef.current !== target) return
      setAuth(next)
      rememberCodeBuddy(target, { auth: next })
      if (lastRunning.current && next.running === false) {
        lastRunning.current = false
        if (next.error === undefined) await loadAccount(true, target)
      }
      if (next.running === true) lastRunning.current = true
    } catch (caught) {
      if (regionRef.current !== target) return
      setError(String((caught as Error | undefined)?.message ?? caught))
    }
  }, [loadAccount])

  // Paint the target region from its snapshot, then verify in the background.
  useEffect(() => {
    regionRef.current = region
    applySnapshot(region)
    setError(undefined)
    void poll(region)
    void loadAccount(false, region)
    const timer = setTimeout(() => { void loadAccount(true, region) }, 250)
    return () => clearTimeout(timer)
  }, [region, refreshSignal, applySnapshot, loadAccount, poll])

  // A config edit from elsewhere (or a reload) becomes the new selection.
  useEffect(() => {
    if (configuredRegion === regionRef.current) return
    setRegionState(configuredRegion)
    regionRef.current = configuredRegion
    applySnapshot(configuredRegion)
    setPacksExpanded(false)
  }, [configuredRegion, applySnapshot])

  useEffect(() => {
    if (auth?.running !== true) return undefined
    const timer = setInterval(() => { void poll(region) }, 1500)
    return () => clearInterval(timer)
  }, [auth?.running, poll, region])

  useEffect(() => { if (resolved) onAuthChange?.(signedIn) }, [resolved, signedIn, onAuthChange])

  const setRegion = useCallback((next: Region) => {
    if (next === regionRef.current) return
    // Local paint first; the config write is only needed by the adapter.
    regionRef.current = next
    lastRunning.current = false
    setRegionState(next)
    applySnapshot(next)
    setPacksExpanded(false)
    setError(undefined)
    onRegionChange?.(next)
    void (async () => {
      try {
        const accepted = await withDeadline(form.set('codebuddyRegion', next), WRITE_TIMEOUT_MS, t('timeout'))
        if (accepted === false) throw new Error(t('saveFailed'))
        if (regionRef.current === next) onSignedIn?.()
      } catch (caught) {
        if (regionRef.current !== next) return
        setError(`${t('saveFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
        const fallback: Region = form.getSnapshot()?.value?.codebuddyRegion === 'cn' ? 'cn' : 'global'
        regionRef.current = fallback
        setRegionState(fallback)
        applySnapshot(fallback)
        onRegionChange?.(fallback)
      }
    })()
  }, [applySnapshot, form, onRegionChange, onSignedIn, t])

  const startLogin = useCallback(async () => {
    const target = regionRef.current
    setBusy(true)
    setError(undefined)
    try {
      const next = await api<AuthStatus>('/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand: 'codebuddy', region: target, action: 'login' }),
        timeout: 20_000,
      })
      if (regionRef.current !== target) return
      setAuth(next)
      rememberCodeBuddy(target, { auth: next })
      if (next.running === true) lastRunning.current = true
    } catch (caught) {
      if (regionRef.current !== target) return
      setError(`${t('codebuddyLoginFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
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
        body: JSON.stringify({ brand: 'codebuddy', region: target, action: 'logout' }),
        timeout: 20_000,
      })
      if (regionRef.current !== target) return
      setAuth(next)
      setAccount(undefined)
      rememberCodeBuddy(target, { auth: next, account: undefined })
      onAuthChange?.(false)
      await loadAccount(true, target)
    } catch (caught) {
      if (regionRef.current !== target) return
      // The host clears its local credential even when the CLI refuses the
      // logout, so the card must not keep presenting the account.
      const signedOut: AuthStatus = { running: false, region: target, signedIn: false }
      setAuth(signedOut)
      setAccount(undefined)
      rememberCodeBuddy(target, { auth: signedOut, account: undefined })
      onAuthChange?.(false)
      setError(String((caught as Error | undefined)?.message ?? caught))
    } finally {
      setBusy(false)
    }
  }, [loadAccount, onAuthChange, t])

  const accountText = account?.account === undefined
    ? (account?.error ?? t('codebuddyAccountUnknown'))
    : [account.account.email, account.account.organization, account.account.subscriptionType]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · ')
  const quota = account?.quota
  // Every package is kept: the collapsed row carries the count and the combined
  // total, so nothing disappears behind an invisible cut.
  const packages = Array.isArray(quota?.packages)
    ? [...quota.packages].sort((a, b) => (a.end ?? Number.MAX_SAFE_INTEGER) - (b.end ?? Number.MAX_SAFE_INTEGER))
    : []
  // The website's own usage page, under the profile the CLI login belongs to.
  // Both regions serve it at the same path.
  const usageLink = (
    <ExternalLink href={region === 'cn'
      ? 'https://copilot.tencent.com/profile/plans-usage'
      : 'https://www.codebuddy.ai/profile/plans-usage'}
    >
      {t('usageDetail')}
    </ExternalLink>
  )

  return (
    <div style={css.usageCard}>
      <div style={css.usageHead}>
        <h3 style={css.h3}>{t('codebuddyAuthTitle')}</h3>
        <span style={{ ...css.note, opacity: 0.78 }}>{signedIn ? t('codebuddySignedIn') : t('codebuddyNotLoggedIn')}</span>
        {signedIn
          ? (
              <button
                type="button"
                className={CLASS.button}
                style={{ ...css.btn, marginLeft: 'auto' }}
                disabled={busy}
                onClick={() => void loadAccount(true)}
              >
                {t('usageRefresh')}
              </button>
            )
          : null}
      </div>
      <div style={css.note}>{t('codebuddyAuthHint')}</div>

      <div style={css.usageLine}>
        <label htmlFor={regionSelectId} style={css.usageLabel}>{t('codebuddyRegionLabel')}</label>
        <select
          id={regionSelectId}
          className={CLASS.select}
          style={css.select}
          value={region}
          disabled={busy}
          onChange={event => setRegion(event.target.value === 'cn' ? 'cn' : 'global')}
        >
          <option value="global">{t('codebuddyRegionGlobal')}</option>
          <option value="cn">{t('codebuddyRegionCn')}</option>
        </select>
        {signedIn
          ? (
              <ConfirmButton
                label={t('codebuddyLogout')}
                question={t('codebuddyConfirmLogout')}
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
                disabled={busy || signingIn}
                onClick={() => void startLogin()}
              >
                {signingIn ? t('codebuddyLoggingIn') : t('codebuddyLogin')}
              </button>
            )}
      </div>

      {signedIn
        ? (
            <div style={css.usageLine}>
              <span style={css.usageLabel}>{t('usageAccount')}</span>
              <span className={CLASS.breakable} style={css.usageValue}>{accountText}</span>
            </div>
          )
        : <div style={css.note}>{t('codebuddyLoginPrompt')}</div>}

      {signedIn
        ? (quota === undefined
            ? (account?.quotaError !== undefined
                ? <LiveAlert>{`${t('codebuddyQuotaFailed')}：${account.quotaError}`}</LiveAlert>
                : <div style={css.note}>{t('codebuddyNoQuota')}</div>)
            : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <CreditMeter
                    t={t}
                    label={t('codebuddyQuotaTitle')}
                    bucket={quota}
                    danger={(quota.total ?? 0) > 0 && (quota.used ?? 0) >= (quota.total ?? 0)}
                  />
                  {packages.length === 0 ? null : (() => {
                    // Same rule as the other adapters: collapsed is one summary
                    // row (count, combined total, nearest expiry), expanded is
                    // the per-package list.
                    const summary = packageSummary(packages)
                    return (
                      <div style={css.packBlock}>
                        <div style={css.packHead}>
                          <span style={css.usageLabel}>{`${t('codebuddyQuotaPackages')} (${summary.count})`}</span>
                          <span style={css.usageValue}>{`${creditsOf(summary.total)} ${t('usageCredits')}`}</span>
                          {summary.nearest === undefined
                            ? null
                            : <span style={css.packExpiry}>{t('codebuddyQuotaExpires')} {dateLabel(summary.nearest)}</span>}
                          <button
                            type="button"
                            className={CLASS.packToggle}
                            style={css.packToggle}
                            aria-expanded={packsExpanded}
                            aria-controls={packsId}
                            onClick={() => setPacksExpanded(value => !value)}
                          >
                            {packsExpanded ? t('codebuddyQuotaPackCollapse') : t('codebuddyQuotaPackDetail')}
                          </button>
                        </div>
                        {packsExpanded
                          ? (
                              <div id={packsId} style={css.packBlock}>
                                <div style={css.packHead}>
                                  <span style={css.usageLabel}>{t('codebuddyQuotaPackUsage')}</span>
                                </div>
                                <div style={{ ...css.packList, ...css.packListScroll }}>
                                  {packages.map((pkg, index) => (
                                    <div
                                      key={`${pkg.name ?? 'package'}-${index}`}
                                      style={{ ...css.packRow, ...(index === 0 ? css.packFirst : {}) }}
                                    >
                                      <span style={css.packLabel} title={pkg.name ?? '—'}>{pkg.name ?? '—'}</span>
                                      <span style={css.packAmount}>{`${creditsOf(pkg.used)} / ${creditsOf(pkg.total)}`}</span>
                                      <span style={css.packExpiry}>{pkg.end === undefined ? '' : dateLabel(pkg.end)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          : null}
                      </div>
                    )
                  })()}
                  <div style={css.usageFoot}>
                    {quota.cycleEnd === undefined
                      ? null
                      : <span>{t('codebuddyQuotaExpires')} {dateLabel(quota.cycleEnd)}</span>}
                    {usageLink}
                  </div>
                </div>
              ))
        : null}

      {signedIn && quota === undefined
        ? <div style={css.usageFoot}>{usageLink}</div>
        : null}

      {typeof auth?.url === 'string' && signingIn
        ? (
            <div style={css.usageLine}>
              <ExternalLink href={auth.url}>{t('codebuddyOpenUrl')}</ExternalLink>
              <span style={css.note}>{t('codebuddyLoginStarted')}</span>
            </div>
          )
        : null}

      {auth?.error !== undefined ? <LiveAlert>{`${t('codebuddyLoginFailed')}：${auth.error}`}</LiveAlert> : null}
      {error !== undefined ? <LiveAlert>{error}</LiveAlert> : null}
      <LiveStatus>{signingIn ? t('codebuddyLoggingIn') : null}</LiveStatus>
    </div>
  )
}
