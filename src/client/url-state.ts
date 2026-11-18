/**
 * The parts of the page's state worth keeping in the address bar.
 *
 * A settings page holds four pieces of view state a user can be looking for
 * when they come back — the search term, the "enabled only" filter, whether
 * advanced is expanded, whether the package list is open — plus the CLI output
 * panel. Keeping them in the URL means a reload, a bookmark or a shared link
 * lands on the same view instead of a reset one.
 *
 * The parameters are namespaced (`dssb.*`) and written with `history.replaceState`,
 * so nothing navigates and no other query parameter the shell owns is touched.
 * Every entry point is guarded: a shell without a writable history simply gets
 * the in-memory behaviour.
 *
 * @module dsh-agent-sdk-bridge/client/url-state
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const PREFIX = 'dssb.'

/** The document's query parameters, or undefined where there is no document. */
function readParams(): URLSearchParams | undefined {
  try {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return undefined
    return new URLSearchParams(window.location.search)
  } catch {
    return undefined
  }
}

/** One namespaced parameter's value, if the URL carries it. */
export function readUrlValue(key: string): string | undefined {
  const params = readParams()
  return params?.get(`${PREFIX}${key}`) ?? undefined
}

/**
 * Write one namespaced parameter, leaving the rest of the query untouched.
 *
 * An empty value removes the parameter, so a default view has a clean URL.
 */
export function writeUrlValue(key: string, value: string | undefined): void {
  try {
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return
    const url = new URL(window.location.href)
    const name = `${PREFIX}${key}`
    if (value === undefined || value === '') url.searchParams.delete(name)
    else url.searchParams.set(name, value)
    if (url.toString() !== window.location.href) {
      window.history.replaceState(window.history.state, '', url.toString())
    }
  } catch {
    /* a shell without a writable history keeps the in-memory state */
  }
}

/** A boolean view flag mirrored into the URL. */
export function useUrlFlag(key: string, initial = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const held = readUrlValue(key)
    return held === undefined ? initial : held === '1'
  })
  const first = useRef(true)
  useEffect(() => {
    // The initial value came from the URL; writing it back would add parameters
    // to a clean address for a page nobody has touched.
    if (first.current) {
      first.current = false
      return
    }
    writeUrlValue(key, value ? '1' : undefined)
  }, [key, value])
  const set = useCallback((next: boolean) => setValue(next), [])
  return [value, set]
}

/** A text view value (the model search term) mirrored into the URL. */
export function useUrlText(key: string, initial = ''): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => readUrlValue(key) ?? initial)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return undefined
    }
    // Typing is a burst of states, and some browsers throttle `replaceState`.
    // One write after the burst keeps the address bar in step without it.
    const timer = setTimeout(() => writeUrlValue(key, value), 200)
    return () => clearTimeout(timer)
  }, [key, value])
  const set = useCallback((next: string) => setValue(next), [])
  return [value, set]
}
