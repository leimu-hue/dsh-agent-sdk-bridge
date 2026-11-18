/**
 * Reading upstream numbers into the strings the cards print.
 *
 * Every figure on these pages arrives from a provider's own endpoint, which
 * quotes the same quantity in at least two shapes (`used` + `total`, or
 * `remaining` + `total`, with the organization package calling the total
 * `cap`). The normalizers here are the single place that reconciles them, so a
 * bar and the label above it can never disagree.
 *
 * Formatting is locale-aware on purpose: the shell runs this page in Chinese
 * and in English, and a hard-coded `zh-CN` left English users reading
 * `2026/1/5` and `1,850` in a page that otherwise spoke English.
 *
 * @module dsh-agent-sdk-bridge/client/format
 */

import type { Translate } from './types.ts'
import type { CreditBucket, CreditReading } from './types.ts'

/** The active UI language, as a BCP-47 tag the `Intl` APIs accept. */
export function localeTag(): string {
  try {
    if (typeof document !== 'undefined') {
      const lang = document.documentElement?.lang
      if (typeof lang === 'string' && lang !== '') return lang
    }
    if (typeof navigator !== 'undefined') {
      const lang = navigator.language
      if (typeof lang === 'string' && lang !== '') return lang
    }
  } catch {
    /* a shell without a document: fall through to the default */
  }
  return 'zh-CN'
}

/** `Intl` formatters are expensive to build and stable, so they are reused. */
const formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>()

function numberFormatter(locale: string): Intl.NumberFormat | undefined {
  const key = `n:${locale}`
  const held = formatters.get(key)
  if (held !== undefined) return held as Intl.NumberFormat
  try {
    const made = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
    formatters.set(key, made)
    return made
  } catch {
    return undefined
  }
}

function dateFormatter(locale: string): Intl.DateTimeFormat | undefined {
  const key = `d:${locale}`
  const held = formatters.get(key)
  if (held !== undefined) return held as Intl.DateTimeFormat
  try {
    const made = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    formatters.set(key, made)
    return made
  } catch {
    return undefined
  }
}

function timeFormatter(locale: string): Intl.DateTimeFormat | undefined {
  const key = `t:${locale}`
  const held = formatters.get(key)
  if (held !== undefined) return held as Intl.DateTimeFormat
  try {
    const made = new Intl.DateTimeFormat(locale, { timeStyle: 'short' })
    formatters.set(key, made)
    return made
  } catch {
    return undefined
  }
}

/** A finite number, or undefined for anything else. */
export function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Compact label for a token count. */
export function windowLabel(n: unknown): string {
  const value = countOf(n)
  if (value === undefined) return '—'
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}M`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/**
 * The credit multiplier upstream quotes, as a short suffix.
 *
 * `0` renders as the word for free rather than `x0`, matching how the Qoder
 * client shows a free model. A model upstream quoted no multiplier for gets no
 * suffix at all — inventing one would misstate its cost.
 */
export function priceSuffix(t: Translate, factor: unknown): string {
  const value = countOf(factor)
  if (value === undefined || value < 0) return ''
  if (value === 0) return t('free')
  return `x${Number(value.toFixed(4))}`
}

/** A 0–100 percentage, clamped, or undefined when the value is not a number. */
export function percentOf(value: unknown): number | undefined {
  const measured = countOf(value)
  if (measured === undefined) return undefined
  return Math.max(0, Math.min(100, measured))
}

/** A credit count with the active locale's group separators; dashes when absent. */
export function creditsOf(value: unknown, locale = localeTag()): string {
  const measured = countOf(value)
  if (measured === undefined) return '—'
  const formatter = numberFormatter(locale)
  return formatter === undefined ? String(measured) : formatter.format(measured)
}

/**
 * Whether a timestamp means "no expiry".
 *
 * The quota endpoint reports plan end dates as a sentinel far in the future
 * (year 9999). Rendering that as a date is technically true and practically
 * noise, so it is shown as "never".
 */
export function neverExpires(ms: unknown): boolean {
  const value = countOf(ms)
  return value === undefined || value <= 0 || value > Date.now() + 50 * 365 * 24 * 3600 * 1000
}

/** A short localized date for an epoch-millisecond value. */
export function dateLabel(ms: unknown, locale = localeTag()): string {
  const value = countOf(ms)
  if (value === undefined) return '—'
  const formatter = dateFormatter(locale)
  try {
    return formatter === undefined ? new Date(value).toLocaleDateString(locale) : formatter.format(value)
  } catch {
    return String(ms)
  }
}

/** A localized clock time, used for "updated at" and quota resets. */
export function timeLabel(ms: unknown, locale = localeTag()): string {
  const value = countOf(ms)
  if (value === undefined) return '—'
  const formatter = timeFormatter(locale)
  try {
    return formatter === undefined ? new Date(value).toLocaleTimeString(locale) : formatter.format(value)
  } catch {
    return String(ms)
  }
}

/**
 * The collapsed-row figures for a set of credit packages.
 *
 * A region can carry a dozen packages, so the card shows one summary row
 * (count, combined total, nearest expiry) and lists them only when asked.
 * `nearest` skips the endpoint's "never expires" sentinel: printing year 9999
 * as the earliest expiry is noise.
 */
export function packageSummary(packages: unknown): { count: number, total: number, nearest?: number } {
  const list = Array.isArray(packages) ? packages as { total?: number, used?: number, end?: number }[] : []
  let total = 0
  for (const pkg of list) {
    if (typeof pkg?.total === 'number' && Number.isFinite(pkg.total)) total += pkg.total
    else if (typeof pkg?.used === 'number' && Number.isFinite(pkg.used)) total += pkg.used
  }
  const nearest = list
    .map(pkg => pkg?.end)
    .filter((value): value is number => !neverExpires(value))
    .sort((a, b) => a - b)[0]
  return { count: list.length, total, nearest }
}

/**
 * How long a short-lived credential still has, phrased as a countdown.
 *
 * The MiniMax CLI's OAuth access token lives about an hour and the CLI renews
 * it on its next call, so an absolute date is always "today" and reads like a
 * problem that does not exist. A countdown carries the information the date
 * pretended to give.
 */
export function tokenExpiryText(t: Translate, ms: unknown, now = Date.now()): string {
  const expiresAt = countOf(ms)
  if (expiresAt === undefined || expiresAt <= 0) return t('minimaxTokenExpired')
  const minutes = Math.round((expiresAt - now) / 60_000)
  if (minutes <= 0) return t('minimaxTokenExpired')
  if (minutes < 60) return t('minimaxTokenRemaining').replace('{n}', String(minutes))
  return t('minimaxTokenRemainingHours').replace('{n}', String(Math.floor(minutes / 60)))
}

/**
 * The used/total reading one credit bucket is rendered from.
 *
 * The percentage is computed from the same numbers the row prints: an upstream
 * percentage that disagreed with them would make the bar contradict its own
 * label. A bucket that reports only a percentage still fills a bar.
 */
export function creditReading(bucket: unknown): CreditReading | undefined {
  if (bucket === null || typeof bucket !== 'object') return undefined
  const held = bucket as CreditBucket
  const total = countOf(held.total) ?? countOf(held.cap)
  const remaining = countOf(held.remaining)
  const used = countOf(held.used)
    ?? (total !== undefined && remaining !== undefined ? Math.max(0, total - remaining) : undefined)
  const measured = total !== undefined && total > 0 && used !== undefined
    ? Math.max(0, Math.min(100, (used / total) * 100))
    : undefined
  const pct = measured ?? percentOf(held.percentage)
  if (used === undefined && total === undefined && remaining === undefined) {
    return pct === undefined ? undefined : { pct }
  }
  return { used, total, remaining, pct }
}

/** A bucket's unit, localized when upstream says the generic "credits". */
export function creditUnit(t: Translate, bucket: unknown): string {
  const unit = typeof (bucket as CreditBucket | undefined)?.unit === 'string'
    ? (bucket as CreditBucket).unit!.trim()
    : ''
  if (unit === '') return t('usageCredits')
  return /^credits?$/i.test(unit) ? t('usageCredits') : unit
}
