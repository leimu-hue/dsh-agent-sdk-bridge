/**
 * The dependency direction `index → surface/providers → infra → core` is a rule,
 * not a preference: `core` is what every provider shares, so one provider
 * reaching into another makes two siblings inseparable and hides the real owner
 * of a symbol. Both shapes appeared here — CodeBuddy and MiniMax imported
 * `reasoningInfo` / `planContinuation` / the host-tool kit from `providers/qoder`
 * simply because Qoder defined them first.
 *
 * These cases read the source files, because nothing at runtime can tell a legal
 * import from an illegal one: the modules load either way.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Every `.ts` file under `src`, with its path relative to `src/` (POSIX style). */
function sources(directory = SRC): { path: string, text: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) return sources(full)
    if (!entry.name.endsWith('.ts')) return []
    return [{ path: relative(SRC, full).replaceAll('\\', '/'), text: readFileSync(full, 'utf8') }]
  })
}

/** The module specifiers one file imports or re-exports. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map(match => match[1]!)
}

const SOURCES = sources()

describe('module layering', () => {
  it('never lets one provider import another', () => {
    const offences: string[] = []
    for (const file of SOURCES) {
      const own = /^providers\/([^/]+)\//.exec(file.path)?.[1]
      if (own === undefined) continue
      for (const specifier of specifiers(file.text)) {
        const sibling = /^\.\.\/([^/]+)\//.exec(specifier)?.[1]
        if (sibling === undefined || sibling === own || sibling === 'core') continue
        if (!['qoder', 'codebuddy', 'minimax'].includes(sibling)) continue
        offences.push(`${file.path} → ${specifier}`)
      }
    }
    expect(offences).toEqual([])
  })

  it('keeps core free of the layers above it', () => {
    const offences: string[] = []
    for (const file of SOURCES) {
      if (!file.path.startsWith('core/')) continue
      for (const specifier of specifiers(file.text)) {
        // A sibling inside core is the only upward-free target.
        if (!specifier.startsWith('.')) continue
        const target = join(file.path, '..', specifier)
        if (target.replaceAll('\\', '/').startsWith('core/')) continue
        offences.push(`${file.path} → ${specifier}`)
      }
    }
    expect(offences).toEqual([])
  })
})
