/**
 * The model table and the CLI helper, which every settings section renders.
 *
 * Each change posts through the host's revision-fenced config form and then
 * adopts the host's returned list, so the page shows what the adapter will
 * actually do rather than what the click hoped. A per-request ticket keeps a
 * slow earlier answer from overwriting a newer one when the user clicks
 * quickly, and a write whose result the re-read never confirms is reported as
 * not applied instead of as saved.
 *
 * @module dsh-agent-sdk-bridge/client/components/settings-page
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { api, clearCache, readCache, withDeadline, writeCache, WRITE_TIMEOUT_MS } from '../api.ts'
import { ADVANCED } from '../brands.ts'
import { priceSuffix, windowLabel } from '../format.ts'
import { codeBuddySnapshot, minimaxSnapshot } from '../snapshots.ts'
import { CLASS, css } from '../styles.ts'
import type {
  ConfigSnapshot, MinimaxUsagePayload, ModelList, ModelRow, Region, SetupStatus, SlotProps,
} from '../types.ts'
import { useUrlFlag, useUrlText } from '../url-state.ts'
import { AdvancedBlock } from './advanced-fields.tsx'
import { CodeBuddyCard } from './codebuddy-card.tsx'
import { MinimaxCard } from './minimax-card.tsx'
import { ConfirmButton, LiveAlert, LiveStatus, useInstanceId } from './primitives.tsx'
import { UsageCard } from './usage-card.tsx'

/** What a model row's window column chooses between. */
interface WindowChoice {
  value: string
  label: string
}

/**
 * Re-read until the list reflects what was just written, or give up.
 *
 * The host commits a volatile config edit into the running plugin before it
 * answers the write, so the first read after `set()` normally already shows the
 * change and this returns immediately. The retries exist for the cases where it
 * does not: a reload that briefly unpublished the route, or a host that answered
 * ahead of its own commit.
 */
async function readUntil(
  fetchModels: () => Promise<ModelList>,
  verify: ((rows: ModelRow[]) => boolean) | undefined,
  adopt: (rows: ModelRow[], notice: string | undefined, signedIn: boolean | undefined) => void,
  currentKind: () => string,
  requestedKind: string,
): Promise<ModelRow[] | undefined> {
  let rows: ModelRow[] | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = await fetchModels()
    // A region switch during the save invalidates this verification.
    if (currentKind() !== requestedKind) return undefined
    rows = read.rows
    adopt(read.rows, read.notice, read.signedIn)
    if (verify === undefined || verify(rows)) return rows
    await new Promise(resolve => setTimeout(resolve, 120 + attempt * 120))
  }
  return rows
}

/** One settings section: the account card, the model list and the advanced block. */
export function SettingsPage({ ctx, t, brand }: SlotProps): ReactElement {
  const form = ctx.configForms!.get('llm-qoder-cn')
  /** CodeBuddy and MiniMax both have two login regions and their own catalogs. */
  const regional = brand.id === 'codebuddy' || brand.id === 'minimax'
  const initialSnapshot = form.getSnapshot()?.value ?? {}
  const initialRegion: Region = brand.id === 'minimax'
    ? (initialSnapshot.minimaxRegion === 'global' ? 'global' : 'cn')
    : (initialSnapshot.codebuddyRegion === 'cn' ? 'cn' : 'global')
  const snapshotFor = (target: Region) => brand.id === 'minimax'
    ? minimaxSnapshot(target)
    : codeBuddySnapshot(target)
  // Each login region has its own catalog, deny-list and windows; the cache key
  // follows the region so switching shows that region's choices.
  const [region, setRegion] = useState<Region>(initialRegion)
  const modelsKind = regional ? `models:${region}` : 'models'
  const [models, setModels] = useState<ModelRow[] | undefined>(() => {
    const cached = readCache<{ rows?: ModelRow[] }>(brand.id, modelsKind)
    return Array.isArray(cached?.rows) ? cached.rows : undefined
  })
  const [catalogNotice, setCatalogNotice] = useState<string | undefined>(() => {
    const cached = readCache<{ notice?: string }>(brand.id, modelsKind)
    return typeof cached?.notice === 'string' ? cached.notice : undefined
  })
  const [signedIn, setSignedIn] = useState<boolean | undefined>(() => {
    if (!regional) return undefined
    const cached = readCache<{ signedIn?: boolean }>(brand.id, modelsKind)
    const authSignedIn = snapshotFor(initialRegion)?.auth?.signedIn === true
    return cached?.signedIn === true || authSignedIn
  })
  const [error, setError] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useUrlText('q', '')
  const [onlyEnabled, setOnlyEnabled] = useUrlFlag('only', false)
  const [showAdvanced, setShowAdvanced] = useUrlFlag('advanced', false)
  const [logOpen, setLogOpen] = useUrlFlag('log', false)
  const [usageTick, setUsageTick] = useState(0)
  // Bumped only by a successful sign-out: the quota card must drop its stored
  // account rather than label it "last reading".
  const [usageReset, setUsageReset] = useState(0)
  const ticket = useRef(0)
  /** Separate from `ticket`: `load()` bumps that one, so sharing it would make
   *  every write look stale the moment its own refresh landed. */
  const writeTicket = useRef(0)
  const modelSearchId = useInstanceId('dssb-model-search')

  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const read = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, read, read) as ConfigSnapshot | undefined

  const configuredRegion: Region = brand.id === 'minimax'
    ? (snapshot?.value?.minimaxRegion === 'global' ? 'global' : 'cn')
    : (snapshot?.value?.codebuddyRegion === 'cn' ? 'cn' : 'global')
  /**
   * The region the user just picked, until the config write lands.
   *
   * Without this, a snapshot that still carries the old value would pull the
   * selection back mid-switch.
   */
  const pendingRegion = useRef<Region | null>(null)
  useEffect(() => {
    if (!regional) return
    if (pendingRegion.current !== null) {
      if (pendingRegion.current === configuredRegion) pendingRegion.current = null
      return
    }
    setRegion(current => (current === configuredRegion ? current : configuredRegion))
  }, [regional, configuredRegion])

  const selectRegion = useCallback((next: Region) => {
    pendingRegion.current = next
    setRegion(next)
  }, [])

  const fields = brand.id === 'codebuddy'
    ? {
        disabled: region === 'cn' ? 'codebuddyCnDisabledModels' : 'codebuddyGlobalDisabledModels',
        windows: region === 'cn' ? 'codebuddyCnModelContextWindows' : 'codebuddyGlobalModelContextWindows',
      }
    : brand.id === 'minimax'
      ? {
          disabled: region === 'cn' ? 'minimaxCnDisabledModels' : 'minimaxGlobalDisabledModels',
          windows: region === 'cn' ? 'minimaxCnModelContextWindows' : 'minimaxGlobalModelContextWindows',
        }
      : brand.fields

  const describeFace = ctx.configForms!.describe()
  const describeSubscribe = useCallback((listener: () => void) => describeFace.subscribe(listener), [describeFace])
  const describeRead = useCallback(() => describeFace.getSnapshot(), [describeFace])
  const describeSnapshot = useSyncExternalStore(describeSubscribe, describeRead, describeRead)
  useEffect(() => { describeFace.ensure().catch(() => undefined) }, [describeFace])

  const fetchModels = useCallback(async (fresh = false): Promise<ModelList> => {
    const regionQuery = regional ? `&region=${region}` : ''
    const payload = await api<{ models?: ModelRow[], notice?: string, signedIn?: boolean, region?: string }>(
      `/models?brand=${brand.id}${regionQuery}${fresh ? '&fresh=1' : ''}`,
    )
    // Never adopt a table the host answered for another login region.
    if (regional && typeof payload?.region === 'string' && payload.region !== region) {
      throw new Error(t(brand.id === 'minimax' ? 'minimaxRegionMismatch' : 'codebuddyRegionMismatch'))
    }
    return {
      rows: Array.isArray(payload?.models) ? payload.models : [],
      notice: typeof payload?.notice === 'string' ? payload.notice : undefined,
      signedIn: regional ? payload?.signedIn === true : undefined,
    }
  }, [brand.id, regional, region, t])

  /** Adopt one read and remember it for the next visit to this region. */
  const adopt = useCallback((rows: ModelRow[], notice: string | undefined, nextSignedIn: boolean | undefined) => {
    setModels(rows)
    setCatalogNotice(notice)
    setSignedIn(nextSignedIn)
    writeCache(brand.id, modelsKind, { rows, notice, signedIn: nextSignedIn, at: Date.now() })
  }, [brand.id, modelsKind])

  /** Latest values for callbacks the account card holds across renders. */
  const kindRef = useRef(modelsKind)
  kindRef.current = modelsKind

  /** Read the list. `fresh` asks the host to drop its catalog cache first. */
  const load = useCallback(async (fresh = false) => {
    const requestedKind = modelsKind
    setError(undefined)
    const mine = ++ticket.current
    try {
      const read = await fetchModels(fresh)
      if (mine !== ticket.current || kindRef.current !== requestedKind) return
      adopt(read.rows, read.notice, read.signedIn)
    } catch (caught) {
      if (mine !== ticket.current || kindRef.current !== requestedKind) return
      setError(String((caught as Error | undefined)?.message ?? caught))
      setModels(previous => previous ?? [])
    }
  }, [adopt, fetchModels, modelsKind])

  const loadRef = useRef(load)
  loadRef.current = load
  /** The region of the last model read; a change forces a fresh read. */
  const lastLoaded = useRef<Region | undefined>(undefined)
  const refresh = useCallback(() => { void loadRef.current() }, [])

  /** The last region verdict, so recovering from a block reloads the list. */
  const blockedRegion = useRef<Region | undefined>(undefined)

  /**
   * Keep the model list in step with the region verdict.
   *
   * A blocked region has no readable catalog, so its remembered table is
   * dropped. The reverse matters too: a manual refresh re-probes the network,
   * and if the verdict flips back the list must be read again without asking
   * the user to switch region and back.
   */
  const handleMinimaxUsage = useCallback((payload: MinimaxUsagePayload) => {
    if (brand.id !== 'minimax') return
    const wasBlocked = blockedRegion.current === region
    if (payload?.regionBlocked !== true) {
      if (wasBlocked) {
        blockedRegion.current = undefined
        refresh()
      }
      return
    }
    blockedRegion.current = region
    const notice = typeof payload.error === 'string' ? payload.error : t('minimaxIpBlocked')
    setModels([])
    setCatalogNotice(notice)
    setError(undefined)
    writeCache(brand.id, kindRef.current, { rows: [], notice, signedIn: true, at: Date.now() })
  }, [brand.id, region, refresh, t])

  /**
   * On a region switch, paint that region's remembered table first and then
   * verify it with the host. The read carries the region explicitly, so it
   * stays correct even before the config write commits.
   */
  useEffect(() => {
    if (regional) {
      const saved = readCache<{ rows?: ModelRow[], notice?: string, signedIn?: boolean }>(brand.id, modelsKind)
      // One provider's snapshot per branch: the two shapes only agree on `auth`,
      // and reading the wrong one's `usage` is how the blocked-region rule and
      // the locked view drifted apart before.
      const minimaxAccount = brand.id === 'minimax' ? minimaxSnapshot(region) : undefined
      const codeBuddyAccount = brand.id === 'codebuddy' ? codeBuddySnapshot(region) : undefined
      const blocked = minimaxAccount?.usage?.regionBlocked === true
      if (blocked) {
        // Never paint a remembered table for a region this machine cannot reach.
        setModels([])
        setCatalogNotice(typeof minimaxAccount?.usage?.error === 'string'
          ? minimaxAccount.usage.error
          : t('minimaxIpBlocked'))
      } else {
        setModels(Array.isArray(saved?.rows) ? saved.rows : undefined)
        setCatalogNotice(typeof saved?.notice === 'string' ? saved.notice : undefined)
      }
      // The account snapshot already knows whether this region is signed in,
      // so the locked view does not flash while the catalog boots.
      setSignedIn(saved?.signedIn === true
        || minimaxAccount?.auth?.signedIn === true
        || codeBuddyAccount?.auth?.signedIn === true)
      setError(undefined)
    }
    // A switch must not be served from the host's cached catalog: the CLI only
    // settles into the new login environment on a fresh read.
    const switched = regional
      && lastLoaded.current !== undefined
      && lastLoaded.current !== region
    lastLoaded.current = region
    void load(switched)
  }, [brand.id, regional, modelsKind, region, load, t])

  /** Login/logout flips which catalog the page is allowed to show. */
  const handleAuthChange = useCallback((next: boolean) => {
    if (!regional) return
    setSignedIn(next)
    if (next) {
      refresh()
      return
    }
    setModels([])
    setCatalogNotice(undefined)
    writeCache(brand.id, kindRef.current, { rows: [], notice: undefined, signedIn: false, at: Date.now() })
  }, [brand.id, regional, refresh])

  /**
   * Apply one change through the shared config form, then re-read until the
   * list reflects it.
   *
   * `busy` is owned by the newest write alone, and is always cleared in
   * `finally`. It must NOT be gated on the read generation: the read bumps that
   * counter, so gating there would leave `busy` set forever and every control
   * disabled.
   */
  const write = useCallback(async (key: string, next: unknown, verify?: (rows: ModelRow[]) => boolean) => {
    const mine = ++writeTicket.current
    setBusy(true)
    setStatus(t('saving'))
    setError(undefined)
    try {
      const op = next === undefined ? form.unset(key) : form.set(key, next)
      const accepted = await withDeadline(op, WRITE_TIMEOUT_MS, t('timeout'))
      if (accepted === false) throw new Error(t('saveFailed'))
      const rows = await readUntil(fetchModels, verify, adopt, () => kindRef.current, kindRef.current)
      if (rows !== undefined && verify !== undefined && !verify(rows)) throw new Error(t('notApplied'))
      if (mine === writeTicket.current) setStatus(t('saved'))
    } catch (caught) {
      if (mine !== writeTicket.current) return
      setError(`${t('saveFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
      setStatus(undefined)
      // The rows now hold an optimistic guess; re-read so the page shows what
      // the host actually stored rather than what the click hoped for.
      await load()
    } finally {
      if (mine === writeTicket.current) setBusy(false)
    }
  }, [adopt, fetchModels, form, load, t])

  /**
   * Write the whole disabled-model list, derived from the rows the user just
   * changed, so rapid toggles cannot lose each other's edits.
   *
   * The row is updated locally first: the host commits the value before it
   * answers, so the re-read confirms this instead of correcting it, and the
   * switch never appears to snap back to where it was.
   */
  const writeDisabled = useCallback((rows: ModelRow[], id: string, enabled: boolean) => {
    const next = new Set(rows.filter(model => !model.enabled).map(model => model.id))
    if (enabled) next.delete(id)
    else next.add(id)
    setModels(current => current?.map(model => (model.id === id ? { ...model, enabled } : model)))
    return write(fields.disabled, [...next], list => list.some(model => model.id === id && model.enabled === enabled))
  }, [fields.disabled, write])

  /** Write the whole per-model window map, again showing the choice at once. */
  const writeWindow = useCallback((rows: ModelRow[], id: string, window: number | undefined) => {
    const next: Record<string, number> = {}
    for (const model of rows) if (model.override !== undefined) next[model.id] = model.override
    if (window === undefined) delete next[id]
    else next[id] = window
    setModels(current => current?.map(model => (model.id === id
      ? { ...model, override: window, contextWindow: window ?? model.defaultContextWindow }
      : model)))
    return write(
      fields.windows,
      next,
      list => list.some(model => model.id === id
        && (window === undefined ? model.override === undefined : model.override === window)),
    )
  }, [fields.windows, write])

  /**
   * Flip every model at once.
   *
   * Enabling all writes an empty deny-list rather than every id, so a model the
   * account publishes later still defaults to on.
   */
  const writeAll = useCallback((enabled: boolean) => {
    const ids = (models ?? []).map(model => model.id)
    setModels(current => current?.map(model => ({ ...model, enabled })))
    return write(fields.disabled, enabled ? [] : ids, list => list.every(model => model.enabled === enabled))
  }, [fields.disabled, models, write])

  // ── CLI helper ────────────────────────────────────────────────────────────
  // The host runs the script, so the page only asks and then reads what it
  // printed. `setup` stays undefined-shaped until the first answer arrives: a
  // host older than this route simply never answers, and the group still
  // renders with both buttons working.
  const [setup, setSetup] = useState<SetupStatus | undefined>(undefined)
  const [setupError, setSetupError] = useState<string | undefined>(undefined)
  const logRef = useRef<HTMLPreElement | null>(null)

  const pollSetup = useCallback(async () => {
    try {
      setSetup(await api<SetupStatus>(`/setup?brand=${brand.id}`, { timeout: 10_000 }))
    } catch {
      /* no run to report, or a host without the route */
    }
  }, [brand.id])

  const startCliSetup = useCallback(async (mode: string) => {
    setSetupError(undefined)
    try {
      setSetup(await api<SetupStatus>('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand: brand.id, mode }),
        timeout: 15_000,
      }))
    } catch (caught) {
      setSetupError(`${t('cliStartFailed')}：${String((caught as Error | undefined)?.message ?? caught)}`)
    }
  }, [brand.id, t])

  const setupRunning = setup?.running === true
  const setupCode = setup !== undefined && setup.running === false ? setup.code : undefined
  const setupFinishedAt = setup?.finishedAt
  const setupLines = Array.isArray(setup?.lines) ? setup.lines : []
  // `installed` is read from the host's own CLI lookup, so the button follows
  // the machine rather than the last run: after an uninstall it reads false
  // even though that run exited 0, and the page offers "install" again instead
  // of a dead "uninstall". Until the first status arrives the old layout is
  // kept, so opening the page does not flash an "install" button on a machine
  // that already has the CLI.
  const cliInstalled = setup === undefined ? true : setup.installed === true
  const setupCancelled = setup?.cancelled === true

  useEffect(() => { void pollSetup() }, [pollSetup])
  useEffect(() => {
    if (!setupRunning) return undefined
    const timer = setInterval(() => { void pollSetup() }, 1200)
    return () => clearInterval(timer)
  }, [setupRunning, pollSetup])

  /**
   * The output panel follows the run, not the history: open while the script is
   * alive, folded away one second after it ends. A finished run from before a
   * reload is never re-expanded, because the panel starts closed.
   */
  useEffect(() => {
    if (setupRunning) {
      setLogOpen(true)
      return undefined
    }
    if (setupFinishedAt === undefined) return undefined
    const timer = setTimeout(() => setLogOpen(false), 1000)
    return () => clearTimeout(timer)
  }, [setupRunning, setupFinishedAt, setLogOpen])

  // The catalog is read from the CLI, so a helper that just installed, signed
  // into, or removed it changes what the list and quota should show — and the
  // host has already dropped its cached answers for that case.
  useEffect(() => {
    if (setupCode !== 0) return
    if (setup?.mode === 'logout') {
      // Signing out invalidates the account itself, not just its freshness: the
      // stored catalog and quota were read through credentials that no longer
      // exist. Drop both instead of refetching — a read now would only fail
      // with an authentication error that looks like a fault.
      clearCache(brand.id, modelsKind)
      setModels([])
      setCatalogNotice(t('modelsSignedOut'))
      setSignedIn(regional ? false : undefined)
      setUsageReset(value => value + 1)
      return
    }
    void load(true)
    setUsageTick(value => value + 1)
  }, [setupCode, setupFinishedAt, setup?.mode, load, brand.id, modelsKind, regional, t, setLogOpen])

  useEffect(() => {
    const node = logRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [setupLines.length])

  const all = models ?? []
  const enabledTotal = all.filter(model => model.enabled).length

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter(model => {
      if (onlyEnabled && !model.enabled) return false
      if (needle === '') return true
      return String(model.name).toLowerCase().includes(needle) || String(model.id).toLowerCase().includes(needle)
    })
  }, [all, query, onlyEnabled])

  const regionalLocked = regional && signedIn !== true
  const authCard = brand.kind === 'codebuddy'
    ? (
        <CodeBuddyCard
          t={t}
          ctx={ctx}
          brand={brand}
          refreshSignal={usageTick}
          onSignedIn={() => { refresh(); setUsageTick(value => value + 1) }}
          onAuthChange={handleAuthChange}
          onRegionChange={selectRegion}
        />
      )
    : brand.kind === 'minimax'
      ? (
          <MinimaxCard
            t={t}
            ctx={ctx}
            brand={brand}
            refreshSignal={usageTick}
            onAuthChange={handleAuthChange}
            onRegionChange={selectRegion}
            onUsage={handleMinimaxUsage}
          />
        )
      : null

  /**
   * Red guidance for "no models", with the one action that can fix it.
   *
   * An empty list is almost always the machine, not the account: the CLI is
   * missing or signed out, so the catalog has nothing to return. Pointing at
   * the helper and offering to run it beats a grey sentence nobody reads.
   */
  const guide = (
    <div style={css.guide}>
      <div style={css.guideText}>{t(brand.noModelsKey)}</div>
      {brand.kind !== 'qoder'
        ? null
        : (
            <button
              type="button"
              className={`${CLASS.button} ${CLASS.buttonAlert}`}
              style={{ ...css.btn, ...css.btnAlert }}
              disabled={setupRunning}
              onClick={() => void startCliSetup('configure')}
            >
              {t('cliRun')}
            </button>
          )}
    </div>
  )

  // Signed out: do not read or show a catalog that the CLI would refuse.
  if (regionalLocked) {
    return (
      <div className={CLASS.page} style={css.page}>
        <h2 style={css.h2}>{t(brand.titleKey)}</h2>
        <p style={css.intro}>{t(brand.introKey)}</p>
        {authCard}
        <div style={css.guide}>
          <div style={css.guideText}>
            {t(brand.id === 'minimax' ? 'minimaxModelsHint' : 'codebuddyModelsHint')}
          </div>
        </div>
        <LiveAlert>{error}</LiveAlert>
      </div>
    )
  }

  if (models === undefined) {
    return (
      <div className={CLASS.page} style={css.page}>
        <h2 style={css.h2}>{t(brand.titleKey)}</h2>
        {/*
         * Same leading shape as the loaded page: a differing child index
         * remounts the account card and makes it snap back to the region the
         * config still holds while the switch is in flight.
         */}
        <p style={css.intro}>{t(brand.introKey)}</p>
        {regional ? authCard : null}
        {error === undefined
          ? <LiveStatus>{t('loading')}</LiveStatus>
          : (
              <div>
                <LiveAlert>{`${t('loadFailed')}：${error}`}</LiveAlert>
                <button
                  type="button"
                  className={CLASS.button}
                  style={{ ...css.btn, marginTop: '8px' }}
                  onClick={() => void load(true)}
                >
                  {t('retry')}
                </button>
                <div style={{ marginTop: '10px' }}>{guide}</div>
              </div>
            )}
      </div>
    )
  }

  const rows = shown.map((model, index) => {
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
    const checkboxId = `dssb-model-${brand.id}-${index}`
    return (
      <div
        key={model.id}
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
          onChange={event => { void writeDisabled(all, model.id, event.target.checked) }}
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
                  void writeWindow(all, model.id, next === '' ? undefined : Number(next))
                }}
              >
                <option value="">{`${t('windowDefault')} · ${windowLabel(model.defaultContextWindow)}`}</option>
                {offered.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            )}
      </div>
    )
  })

  const advanced = (
    <AdvancedBlock
      t={t}
      form={form}
      snapshot={snapshot}
      fields={ADVANCED[brand.id]}
      namespace={describeSnapshot?.view?.namespaces?.find(namespace => namespace.ns === 'llm-qoder-cn')}
      show={showAdvanced}
      onToggle={() => setShowAdvanced(!showAdvanced)}
    />
  )

  return (
    <div className={CLASS.page} style={css.page}>
      <h2 style={css.h2}>{t(brand.titleKey)}</h2>
      <p style={css.intro}>{t(brand.introKey)}</p>
      {regional ? authCard : <UsageCard t={t} brand={brand} refreshSignal={usageTick} resetSignal={usageReset} />}

      {/* Search row: the field grows, the filter sits beside it. */}
      <div style={css.bar}>
        <label htmlFor={modelSearchId} className={CLASS.visuallyHidden}>{t('searchLabel')}</label>
        <input
          id={modelSearchId}
          name="dsh-agent-sdk-bridge-model-search"
          type="search"
          className={CLASS.input}
          style={{ ...css.input, ...css.search }}
          placeholder={t('search')}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
        />
        <label style={{ ...css.note, display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <input
            type="checkbox"
            className={CLASS.check}
            style={{ ...css.switch, width: '15px', height: '15px' }}
            checked={onlyEnabled}
            onChange={event => setOnlyEnabled(event.target.checked)}
          />
          {t('onlyEnabled')}
        </label>
      </div>

      {/* Action row: wraps rather than overflowing a narrow settings panel. */}
      <div style={css.actions}>
        <button type="button" className={CLASS.button} style={css.btn} disabled={busy} onClick={() => void load(true)}>
          {busy ? t('refreshing') : t('refresh')}
        </button>
        <button
          type="button"
          className={CLASS.button}
          style={css.btn}
          disabled={busy || all.every(model => model.enabled)}
          onClick={() => void writeAll(true)}
        >
          {t('selectAll')}
        </button>
        <button
          type="button"
          className={CLASS.button}
          style={css.btn}
          disabled={busy || enabledTotal === 0}
          onClick={() => void writeAll(false)}
        >
          {t('selectNone')}
        </button>
        <span className={CLASS.tabular} style={css.count}>{`${t('enabledCount')} ${enabledTotal} / ${all.length}`}</span>
      </div>

      {all.length === 0
        ? guide
        : (
            <div style={css.list} role="group" aria-label={t('modelListLabel')}>
              {rows.length > 0
                ? rows
                : <div style={{ ...css.note, padding: '12px 14px' }}>{t('noMatch')}</div>}
            </div>
          )}

      {catalogNotice === undefined ? null : <div style={css.note}>{catalogNotice}</div>}
      {all.length > 0 ? <div style={css.note}>{t('windowWarn')}</div> : null}
      <LiveAlert>{error}</LiveAlert>
      <LiveStatus>{error === undefined ? status : undefined}</LiveStatus>

      {brand.kind !== 'qoder'
        ? null
        : (
            <div style={css.group}>
              <h3 style={css.h3}>{t(brand.cliGroupKey ?? 'cliGroup')}</h3>
              <div style={css.note}>{t(brand.cliHintKey ?? 'cliHint')}</div>
              {/*
               * The CLI moves on its own (`qodercli update`), so only a build
               * older than the SDK's pin is reported: that is the one that
               * fails every session with a bare exit code.
               */}
              {setup?.versionMismatch === true
                ? (
                    <LiveAlert style={{ marginTop: '6px' }}>
                      {`${t('cliVersionMismatch')} ${setup.cliVersion ?? '?'} ${t('cliVersionMismatchTail')} ${setup.requiredCliVersion ?? '?'}`}
                    </LiveAlert>
                  )
                : null}
              <div style={css.actions}>
                {/*
                 * The primary action follows the machine: install when the CLI
                 * is gone, configure/re-login when it is there.
                 */}
                <button
                  type="button"
                  className={CLASS.button}
                  style={css.btn}
                  disabled={setupRunning}
                  onClick={() => void startCliSetup('configure')}
                >
                  {cliInstalled && setup?.versionMismatch !== true ? t('cliRun') : t('cliInstall')}
                </button>
                {cliInstalled
                  ? (
                      <button
                        type="button"
                        className={CLASS.button}
                        style={css.btn}
                        disabled={setupRunning}
                        onClick={() => void startCliSetup('login')}
                      >
                        {t('cliLogin')}
                      </button>
                    )
                  : null}
                {cliInstalled
                  ? (
                      <ConfirmButton
                        label={t('cliLogout')}
                        question={t('cliLogoutConfirm')}
                        confirmLabel={t('confirmYes')}
                        cancelLabel={t('confirmCancel')}
                        disabled={setupRunning}
                        onConfirm={() => void startCliSetup('logout')}
                      />
                    )
                  : null}
                {cliInstalled
                  ? (
                      <ConfirmButton
                        label={t('cliUninstall')}
                        question={t('cliUninstallConfirm')}
                        confirmLabel={t('confirmYes')}
                        cancelLabel={t('confirmCancel')}
                        disabled={setupRunning}
                        alert
                        onConfirm={() => void startCliSetup('uninstall')}
                      />
                    )
                  : null}
                {/*
                 * The login step waits for a browser callback; closing that tab
                 * used to leave this row spinning forever. Cancelling settles
                 * the run so the buttons come back.
                 */}
                {setupRunning
                  ? (
                      <button
                        type="button"
                        className={`${CLASS.button} ${CLASS.buttonAlert}`}
                        style={{ ...css.btn, ...css.btnAlert }}
                        onClick={() => void startCliSetup('cancel')}
                      >
                        {t('cliCancel')}
                      </button>
                    )
                  : null}
                {setupLines.length > 0 && !setupRunning
                  ? (
                      <button
                        type="button"
                        className={CLASS.button}
                        style={css.btn}
                        aria-expanded={logOpen}
                        aria-controls="dssb-cli-log"
                        onClick={() => setLogOpen(!logOpen)}
                      >
                        {logOpen ? t('cliHideLog') : t('cliShowLog')}
                      </button>
                    )
                  : null}
              </div>
              <LiveStatus>
                {setupRunning
                  ? (setup?.mode === 'uninstall'
                      ? t('cliUninstalling')
                      : setup?.mode === 'logout' ? t('cliLoggingOut') : t('cliRunning'))
                  : setupError !== undefined
                    ? setupError
                    : setupCancelled
                      ? t('cliCancelled')
                      : setupCode === 0
                        ? (setup?.mode === 'uninstall'
                            ? t('cliUninstallOk')
                            : setup?.mode === 'logout' ? t('cliLogoutOk') : t('cliExitOk'))
                        : setupCode === undefined || setupCode === null
                          ? null
                          : `${t('cliExitFail')} ${setupCode}`}
              </LiveStatus>
              {logOpen && setupLines.length > 0
                ? (
                    <pre
                      id="dssb-cli-log"
                      ref={logRef}
                      className={CLASS.log}
                      style={css.log}
                      aria-label={t('cliLogLabel')}
                    >
                      {setupLines.join('\n')}
                    </pre>
                  )
                : null}
            </div>
          )}

      {advanced}
    </div>
  )
}
