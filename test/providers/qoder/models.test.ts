/**
 * An empty catalogue is still an answer.
 *
 * Signing out of Qoder CN emptied the settings page (which reads
 * `describeCatalog()`) but left every model in the chat picker, which reads
 * `listModels()` → `catalog.models()`. That method treated any empty live list
 * as "the CLI is unreachable" and published the captured static plan, so a
 * signed-out account was offered models it could not run.
 *
 * Measured against CLI 1.1.81 with an empty credential store: `accountInfo()`
 * throws `Authentication required`, but `getAvailableModels()` — including the
 * `cache` and `live` fallback strategies, even with a populated
 * `~/.qoder-cn/.models` cache — returns a successful empty list. So "empty"
 * here is the account answering, not a failed read.
 *
 * The rule these cases pin: the static plan only stands in for a read that
 * never happened on a machine that has the CLI. An account that answered —
 * with an empty list — gets an empty list, and a machine without the CLI gets
 * nothing at all.
 *
 * Every case reads a fresh module graph. The "this account has answered" memo
 * is deliberately process-wide (a later failed read must not forget it), so a
 * shared instance would let one case's answer decide the next one's.
 */
import { describe, expect, it, vi } from 'vitest'

/** What the stubbed `resolveQoderCli()` reports for this machine. */
const machine = vi.hoisted(() => ({ installed: undefined as { path: string } | undefined }))

vi.mock('../../../src/host/infra/cli.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/host/infra/cli.ts')>()
  // The rest of the module stays real: `models.ts` also uses the conflict text.
  return { ...actual, resolveQoderCli: () => machine.installed }
})

/**
 * One fresh module graph, with the CLI lookup stubbed.
 *
 * The catalogue constant is taken from the same graph as the class, so an
 * identity assertion compares the very array the class would return.
 */
async function fresh(installed: boolean, onChange?: (ids: readonly string[]) => void): Promise<{
  catalog: import('../../../src/host/providers/qoder/models.ts').QoderModelCatalog
  fallback: typeof import('../../../src/host/providers/qoder/models.ts').emptyCatalogFallback
  plan: readonly { id: string }[]
}> {
  vi.resetModules()
  machine.installed = installed ? { path: 'C:/fake/qoderclicn.cjs' } : undefined
  const [models, catalog] = await Promise.all([
    import('../../../src/host/providers/qoder/models.ts'),
    import('../../../src/host/core/catalog.ts'),
  ])
  return {
    catalog: new models.QoderModelCatalog('cn', 60_000, 1_000, onChange),
    fallback: models.emptyCatalogFallback,
    plan: catalog.QODER_MODELS,
  }
}

describe('emptyCatalogFallback', () => {
  it('stays empty when the account answered with nothing', async () => {
    const { fallback } = await fresh(true)
    expect(fallback('cn', { cliInstalled: true, answered: true })).toEqual([])
  })

  it('stays empty when the CLI is not installed', async () => {
    const { fallback } = await fresh(false)
    expect(fallback('cn', { cliInstalled: false, answered: false })).toEqual([])
  })

  it('offers the captured CN plan only while an installed CLI cannot answer', async () => {
    const { fallback, plan } = await fresh(true)
    expect(fallback('cn', { cliInstalled: true, answered: false })).toBe(plan)
  })

  it('never lends the CN plan to the international edition', async () => {
    const { fallback } = await fresh(true)
    expect(fallback('global', { cliInstalled: true, answered: false })).toEqual([])
  })
})

describe('Qoder model list after a sign-out', () => {
  /**
   * Replace the private CLI read, so `liveModels()` still runs its own logic:
   * it is `liveModels()` — not the test — that decides whether an empty list
   * counts as the account answering.
   */
  function stubRead(catalog: object, read: () => Promise<readonly never[]>): void {
    Object.assign(catalog, { fetch: read })
  }

  it('publishes the plan when an installed CLI could not be read', async () => {
    const { catalog, plan } = await fresh(true)
    stubRead(catalog, async () => { throw new Error('CLI unavailable') })
    await catalog.liveModels()
    await expect(catalog.models()).resolves.toBe(plan)
  })

  it('publishes nothing when the CLI is missing, even though the read failed', async () => {
    const { catalog } = await fresh(false)
    stubRead(catalog, async () => { throw new Error('CLI unavailable') })
    await catalog.liveModels()
    await expect(catalog.models()).resolves.toEqual([])
  })

  it('publishes nothing once the account has answered an empty list', async () => {
    const { catalog } = await fresh(true)
    stubRead(catalog, async () => [])
    await catalog.liveModels()
    await expect(catalog.models()).resolves.toEqual([])
  })

  it('does not resurrect the plan when the read after a sign-out fails', async () => {
    const { catalog } = await fresh(true)
    stubRead(catalog, async () => [])
    await catalog.liveModels()
    // A dropped connection right after signing out used to look exactly like
    // "this CLI was never reachable" — the one case the plan is for.
    stubRead(catalog, async () => { throw new Error('network down') })
    await catalog.liveModels()
    await expect(catalog.models()).resolves.toEqual([])
  })

  it('keeps that answer across the invalidate a sign-out performs', async () => {
    const { catalog } = await fresh(true)
    stubRead(catalog, async () => [])
    await catalog.liveModels()
    catalog.invalidate()
    stubRead(catalog, async () => { throw new Error('network down') })
    await catalog.liveModels()
    await expect(catalog.models()).resolves.toEqual([])
  })
})

/**
 * The chat picker caches one catalog per Host generation and only reloads it
 * when the Host says the advertised list changed. These cases pin when this
 * plugin says so: a real change, once, and never for a refresh that answered
 * the same list (every connected GUI pays a full catalog reload for it).
 */
describe('Qoder catalog change notification', () => {
  /** Replace the private CLI read, leaving the announce logic under test. */
  function stubRead(catalog: object, read: () => Promise<readonly any[]>): void {
    Object.assign(catalog, { fetch: read })
  }

  /** One live entry, complete enough for the signature and the filter. */
  function entry(value: string, displayName = value): any {
    return {
      value,
      displayName,
      description: '',
      isVl: false,
      isEnabled: true,
      source: 'system',
      maxInputTokens: 200_000,
      defaultContextWindow: 200_000,
      availableContextWindows: [200_000],
    }
  }

  it('announces the first list the picker has not seen', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    expect(seen).toEqual([['qm1']])
  })

  it('stays quiet when a refresh answers the same list', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    catalog.invalidate()
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    expect(seen).toEqual([['qm1']])
  })

  it('announces a model the account gained after a login', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    // The account was empty before; the picker was told about that list.
    catalog.invalidate()
    stubRead(catalog, async () => [entry('qm1'), entry('qm2')])
    await catalog.liveModels()
    expect(seen).toEqual([['qm1'], ['qm1', 'qm2']])
  })

  it('announces an emptied list so the picker drops the models', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    catalog.invalidate()
    stubRead(catalog, async () => [])
    await catalog.liveModels()
    expect(seen).toEqual([['qm1'], []])
  })

  it('stays quiet when a failed refresh keeps the published list', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    catalog.invalidate()
    stubRead(catalog, async () => { throw new Error('network down') })
    await catalog.liveModels()
    expect(seen).toEqual([['qm1']])
  })

  it('ignores account-added models, which this route never advertises', async () => {
    const seen: string[][] = []
    const { catalog } = await fresh(true, ids => seen.push([...ids]))
    stubRead(catalog, async () => [entry('qm1')])
    await catalog.liveModels()
    catalog.invalidate()
    // A bring-your-own-key entry is filtered out before the picker sees it, so
    // it is not a change to what this route advertises.
    stubRead(catalog, async () => [entry('qm1'), { ...entry('byok'), source: 'user' }])
    await catalog.liveModels()
    expect(seen).toEqual([['qm1']])
  })
})