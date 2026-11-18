/**
 * Talking to the host's settings API, and remembering the last answers.
 *
 * The page cannot read the model catalog from the config form — the catalog is
 * fetched live from the provider, while the form only carries what the user
 * stored. So the host answers JSON routes under {@link apiBase}, and every
 * change goes back through the host's own revision-fenced config form rather
 * than through a write route here.
 *
 * The cache is deliberately stale-while-revalidate: reopening a settings page
 * paints the previous content immediately and refreshes behind it. `localStorage`
 * keeps the snapshot across a reload; an in-memory map covers a deployment where
 * storage is unavailable.
 *
 * @module dsh-agent-sdk-bridge/client/api
 */

/**
 * Same-origin API base, resolved against the document so a deployment under a
 * sub-path still reaches its own host.
 *
 * Resolved per call, not at module scope: the shell evaluates this bundle
 * before there is a document to resolve against, and a top-level `document`
 * read would make the file unloadable in its own test harness.
 */
export function apiBase(): string {
  try {
    return new URL('api/llm-qoder-cn', document.baseURI).pathname
  } catch {
    return '/api/llm-qoder-cn'
  }
}

/** One API call's options: `fetch`'s own, plus the page's timeout. */
export interface ApiOptions extends Omit<RequestInit, 'signal'> {
  timeout?: number
}

/** Call the plugin's API and parse its JSON answer. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { timeout = 30_000, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`${apiBase()}${path}`, { ...rest, signal: controller.signal })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      payload = { error: text.slice(0, 200) }
    }
    if (!response.ok) {
      const message = (payload as { error?: unknown } | undefined)?.error
      throw new Error(typeof message === 'string' ? message : `HTTP ${response.status}`)
    }
    return payload as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long a settings write may take before the page gives up on it.
 *
 * A config write is a round trip to the host, which commits the value into the
 * running plugin before it answers, so this is not a normal-path limit — it is
 * a floor under the UI. Without it a wire call that never settles leaves every
 * control disabled forever.
 */
export const WRITE_TIMEOUT_MS = 20_000

/** Settle with `promise`, or reject with `message` once `ms` elapse. */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

const CACHE_PREFIX = 'dsh-agent-sdk-bridge/cache/v1'
const cacheMemory = new Map<string, unknown>()

function cacheKey(brand: string, kind: string): string {
  return `${CACHE_PREFIX}:${brand}:${kind}`
}

/** The last successful answer for one edition and kind, or undefined. */
export function readCache<T>(brand: string, kind: string): T | undefined {
  const key = cacheKey(brand, kind)
  if (cacheMemory.has(key)) return cacheMemory.get(key) as T
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    cacheMemory.set(key, parsed)
    return parsed as T
  } catch {
    return undefined
  }
}

/** Remember one answer, in memory and (when possible) across reloads. */
export function writeCache(brand: string, kind: string, value: unknown): void {
  const key = cacheKey(brand, kind)
  cacheMemory.set(key, value)
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or a full quota: the in-memory copy still works */
  }
}

/**
 * Forget one cached answer.
 *
 * Needed when the cache has become wrong rather than merely old: after an
 * uninstall the stored quota describes an account read through a CLI that is
 * no longer on the machine, and painting it again would keep showing numbers
 * nobody can reproduce.
 */
export function clearCache(brand: string, kind: string): void {
  const key = cacheKey(brand, kind)
  cacheMemory.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* storage unavailable: the in-memory copy is already gone */
  }
}
