/**
 * Each region's catalog must come from its own CLI user-data directory.
 *
 * The bundled CLI remembers its product environment inside that directory and
 * only switches it during initialize, after the model provider has already
 * chosen a catalog. Sharing the default directory between regions let a switch
 * read the other region's catalog, which was then cached for minutes: the page
 * showed the wrong model list, and the enabled/disabled choices written from
 * it belonged to the wrong region. These cases pin the isolation and the
 * single read per refresh.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as { environment: string, env?: Record<string, string> }[],
  failReads: false,
  /** Extra entries the next read answers, to make the list change. */
  extra: [] as string[],
}))

// The CLI directory override is read per session, so it is enough to set it
// before the first test runs; the state path keeps the tests off the real file.
const root = mkdtempSync(join(tmpdir(), 'codebuddy-cli-'))
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')

vi.mock('../../../src/host/infra/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    unstable_v2_createSession: (options: { environment: string, env?: Record<string, string> }) => {
      fake.calls.push({ environment: options.environment, env: options.env })
      return {
        connect: async () => {},
        getAvailableModelsRaw: async () => {
          if (fake.failReads) throw new Error('CLI is gone')
          return [
            { id: `${options.environment}-model`, name: 'Model' },
            ...fake.extra.map(id => ({ id, name: id })),
          ]
        },
        close: () => {},
      }
    },
  }),
}))

const { CodeBuddyCatalog } = await import('../../../src/host/providers/codebuddy/session.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('CodeBuddy catalog isolation per region', () => {
  it('boots each region in its own directory and reads once', async () => {
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'global')
    const global = await catalog.models('global')
    const cn = await catalog.models('cn')

    expect(global.map(model => model.id)).toEqual(['external-model'])
    expect(cn.map(model => model.id)).toEqual(['internal-model'])
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0].environment).toBe('external')
    expect(fake.calls[1].environment).toBe('internal')
    // Distinct directories: the CLI's remembered environment is per directory,
    // so one region can never make the other read the wrong catalog.
    expect(fake.calls[0].env?.CODEBUDDY_CONFIG_DIR).toBe(join(root, 'global'))
    expect(fake.calls[1].env?.CODEBUDDY_CONFIG_DIR).toBe(join(root, 'cn'))
  })

  it('serves repeat reads from the cache instead of booting again', async () => {
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'cn')
    await catalog.models('cn')
    await catalog.models('cn')
    expect(fake.calls).toHaveLength(1)
  })

  it('answers a cache-expired read from the warm control session', async () => {
    // A zero TTL forces a fresh CLI read every time; the process behind it must
    // still be booted once. This is the whole point of keeping it warm: a
    // settings visit used to pay a 24 MB boot per read.
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'cn', () => 0)
    await catalog.models('cn')
    await catalog.models('cn')
    expect(fake.calls).toHaveLength(1)
  })

  it('boots a new control session after the warm one is discarded', async () => {
    // Login, logout and a region switch all change what the process would
    // answer, so they discard it; the next read starts a fresh one.
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'cn', () => 0)
    await catalog.models('cn')
    catalog.discardControl('cn')
    await catalog.models('cn')
    expect(fake.calls).toHaveLength(2)
  })

  it('does not reuse a control session whose read failed', async () => {
    fake.calls.length = 0
    const catalog = new CodeBuddyCatalog(() => 'cn', () => 0)
    fake.failReads = true
    await expect(catalog.models('cn')).resolves.toEqual([])
    // The failed process is gone, so the next read can only answer by booting
    // another one — a wedged CLI must not poison every later catalog read.
    fake.failReads = false
    await expect(catalog.models('cn')).resolves.toMatchObject([{ id: 'internal-model' }])
    expect(fake.calls).toHaveLength(2)
  })

  /**
   * The chat model picker caches one catalog per Host generation and reloads it
   * only when the Host reports a change, so one notification per real change is
   * what keeps it current — and no notification for a refresh that answered the
   * same list keeps it from reloading for nothing.
   */
  it('notifies once per changed list', async () => {
    fake.calls.length = 0
    fake.extra = []
    const seen: string[][] = []
    const catalog = new CodeBuddyCatalog(() => 'cn', () => 0, undefined, undefined, ids => seen.push([...ids]))

    await catalog.models('cn')
    await catalog.models('cn')
    expect(seen).toEqual([['internal-model']])

    fake.extra = ['extra-model']
    await catalog.models('cn')
    expect(seen).toEqual([['internal-model'], ['internal-model', 'extra-model']])
    fake.extra = []
  })
})
