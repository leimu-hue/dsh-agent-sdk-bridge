/**
 * The model table, which every settings section renders.
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
import { api, readCache, withDeadline, writeCache, WRITE_TIMEOUT_MS } from '../api.ts'
import { ADVANCED } from '../brands.ts'
import { priceSuffix, windowLabel } from '../format.ts'
import { codeBuddySnapshot } from '../snapshots.ts'
import { CLASS, css } from '../styles.ts'
import type {
  ConfigSnapshot, ModelList, ModelRow, Region, SlotProps,
} from '../types.ts'
import { useUrlFlag, useUrlText } from '../url-state.ts'
import { AdvancedBlock } from './advanced-fields.tsx'
import { CodeBuddyCard } from './codebuddy-card.tsx'
import { LiveAlert, LiveStatus, useInstanceId } from './primitives.tsx'
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
  /** CodeBuddy has two login regions and its own catalog per region. */
  const regional = brand.id === 'codebuddy'
  const initialSnapshot = form.getSnapshot()?.value ?? {}
  const initialRegion: Region = initialSnapshot.codebuddyRegion === 'cn' ? 'cn' : 'global'
  const snapshotFor = (target: Region) => codeBuddySnapshot(target)
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
  /**
   * Whether a catalog read is in flight.
   *
   * Kept apart from `busy`, which belongs to config writes: a refresh is a
   * read that can take as long as a CLI cold start, and it used to give no
   * feedback at all — the list silently changed shape seconds after the click.
   * The refresh action is also the account refresh, so this is what tells the
   * user that the quota card and the model table are being re-read together.
   */
  const [reading, setReading] = useState(false)
  const [query, setQuery] = useUrlText('q', '')
  const [onlyEnabled, setOnlyEnabled] = useUrlFlag('only', false)
  const [showAdvanced, setShowAdvanced] = useUrlFlag('advanced', false)
  const [usageTick, setUsageTick] = useState(0)
  const ticket = useRef(0)
  /** Separate from `ticket`: `load()` bumps that one, so sharing it would make
   *  every write look stale the moment its own refresh landed. */
  const writeTicket = useRef(0)
  const modelSearchId = useInstanceId('dssb-model-search')

  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const read = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, read, read) as ConfigSnapshot | undefined

  const configuredRegion: Region = snapshot?.value?.codebuddyRegion === 'cn' ? 'cn' : 'global'
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
      throw new Error(t('codebuddyRegionMismatch'))
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
    setReading(true)
    const mine = ++ticket.current
    try {
      const read = await fetchModels(fresh)
      if (mine !== ticket.current || kindRef.current !== requestedKind) return
      adopt(read.rows, read.notice, read.signedIn)
    } catch (caught) {
      if (mine !== ticket.current || kindRef.current !== requestedKind) return
      setError(String((caught as Error | undefined)?.message ?? caught))
      setModels(previous => previous ?? [])
    } finally {
      // Only the newest read owns the indicator: an older one may settle after
      // the newer one already answered.
      if (mine === ticket.current) setReading(false)
    }
  }, [adopt, fetchModels, modelsKind])

  const loadRef = useRef(load)
  loadRef.current = load
  /** The region of the last model read; a change forces a fresh read. */
  const lastLoaded = useRef<Region | undefined>(undefined)
  const refresh = useCallback(() => { void loadRef.current() }, [])

  /**
   * Re-read the whole account: the model list and the quota card together.
   *
   * They come from two routes, and the quota is the fast one — a single control
   * call — while the catalog is a cold-start round trip that an account just
   * logged in may wait on for seconds. Refreshing only one of them showed the
   * new quota beside the previous account's model list, which reads as "the
   * models are not there yet" even though nothing had asked for them. One
   * action starts both, so the page converges instead of half-updating.
   */
  const refreshAccount = useCallback(() => {
    setUsageTick(value => value + 1)
    void loadRef.current(true)
  }, [])

  /**
   * On a region switch, paint that region's remembered table first and then
   * verify it with the host. The read carries the region explicitly, so it
   * stays correct even before the config write commits.
   */
  useEffect(() => {
    if (regional) {
      const saved = readCache<{ rows?: ModelRow[], notice?: string, signedIn?: boolean }>(brand.id, modelsKind)
      const codeBuddyAccount = brand.id === 'codebuddy' ? codeBuddySnapshot(region) : undefined
      setModels(Array.isArray(saved?.rows) ? saved.rows : undefined)
      setCatalogNotice(typeof saved?.notice === 'string' ? saved.notice : undefined)
      // The account snapshot already knows whether this region is signed in,
      // so the locked view does not flash while the catalog boots.
      setSignedIn(saved?.signedIn === true || codeBuddyAccount?.auth?.signedIn === true)
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
    : null

  /**
   * Red guidance for "no models".
   *
   * An empty list is almost always the machine, not the account: the CLI is
   * missing or signed out, so the catalog has nothing to return. This page
   * says what the machine is missing; running the installer is not its job.
   */
  const guide = (
    <div style={css.guide}>
      <div style={css.guideText}>{t(brand.noModelsKey)}</div>
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
            {t('codebuddyModelsHint')}
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
                  disabled={reading}
                  onClick={refreshAccount}
                >
                  {reading ? t('refreshing') : t('retry')}
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
      {regional ? authCard : <UsageCard t={t} brand={brand} refreshSignal={usageTick} onRefresh={refreshAccount} />}

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
        <button
          type="button"
          className={CLASS.button}
          style={css.btn}
          disabled={busy || reading}
          onClick={refreshAccount}
        >
          {reading ? t('refreshing') : t('refresh')}
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

      {brand.cliGroupKey === undefined || brand.cliHintKey === undefined
        ? null
        : (
            <div style={css.group}>
              <h3 style={css.h3}>{t(brand.cliGroupKey)}</h3>
              <div style={css.note}>{t(brand.cliHintKey)}</div>
            </div>
          )}

      {advanced}
    </div>
  )
}
