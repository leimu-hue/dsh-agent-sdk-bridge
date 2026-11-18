import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

const fake = vi.hoisted(() => {
  const directory = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'
  const file = `${directory}/dsh-codebuddy-auth-${process.pid}-${Date.now()}.json`
  process.env.DSH_CODUBUDDY_STATE_PATH = file
  return {
    stateFile: file,
    calls: [] as string[],
    authUrl: 'https://www.codebuddy.ai/login?state=abc&redirect_uri=dsh',
    failLogout: false,
    authenticateDelayMs: 0,
  }
})

vi.mock('../../../src/host/infra/sdk.ts', () => ({
  loadCodeBuddySdk: async () => ({
    unstable_v2_logout: async () => {
      fake.calls.push('logout')
      if (fake.failLogout) throw new Error('logout failed')
    },
    unstable_v2_authenticate: async (options: { onAuthUrl: (state: { authUrl: string }) => void }) => {
      fake.calls.push('authenticate')
      options.onAuthUrl({ authUrl: fake.authUrl })
      if (fake.authenticateDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, fake.authenticateDelayMs))
      }
      return { userinfo: { userId: 'user-1', userName: 'dev', userNickname: 'dev', token: 'token-1' } }
    },
  }),
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
}))

const { CodeBuddyAuth, codeBuddyState } = await import('../../../src/host/providers/codebuddy/session.ts')

afterAll(() => { rmSync(fake.stateFile, { force: true }) })

function run(auth: InstanceType<typeof CodeBuddyAuth>, region: 'cn' | 'global') {
  return new Promise<boolean>(resolve => { auth.start(region, resolve) })
}

describe('CodeBuddy browser login', () => {
  beforeEach(() => {
    fake.calls.length = 0
    fake.failLogout = false
    fake.authenticateDelayMs = 0
    codeBuddyState.clear('cn')
    codeBuddyState.clear('global')
  })

  it('clears the cached credential before opening the browser', async () => {
    // A region that is already signed in must clear first, or `authenticate`
    // reuses the stored token and never opens the browser.
    codeBuddyState.patch('cn', { token: 'old-token', signedIn: true })
    const auth = new CodeBuddyAuth()
    await expect(run(auth, 'cn')).resolves.toBe(true)
    expect(fake.calls).toEqual(['logout', 'authenticate'])
    expect(auth.status('cn')).toMatchObject({
      running: false, region: 'cn', signedIn: true, user: { userId: 'user-1' },
    })
    expect(auth.status('cn').url).toBe(fake.authUrl)
    expect(codeBuddyState.token('cn')).toBe('token-1')
  })

  it('does not boot the CLI just to clear a credential the region never had', async () => {
    // Signed out: there is nothing on disk to clear, and the SDK gives no
    // daemon, so a `logout` call here is a whole 24 MB process that closes
    // before the browser flow even starts.
    const auth = new CodeBuddyAuth()
    await expect(run(auth, 'cn')).resolves.toBe(true)
    expect(fake.calls).toEqual(['authenticate'])
    expect(codeBuddyState.token('cn')).toBe('token-1')
  })

  it('restores a saved login without another browser round trip', async () => {
    await run(new CodeBuddyAuth(), 'cn')
    fake.calls.length = 0
    const later = new CodeBuddyAuth()
    expect(later.status('cn')).toMatchObject({
      running: false, signedIn: true, user: { userId: 'user-1', userName: 'dev' },
    })
    expect(fake.calls).toEqual([])
  })

  it('records the auth URL for the manual fallback without opening a tab', async () => {
    const auth = new CodeBuddyAuth()
    await run(auth, 'global')
    // The bundled CLI opens the browser itself; opening it here as well was
    // what produced two identical tabs per login click. Nothing is stored for
    // this region yet, so the click costs one process, not two.
    expect(fake.calls).toEqual(['authenticate'])
    expect(auth.status('global').url).toBe(fake.authUrl)
  })

  it('still authenticates when clearing the old credential fails', async () => {
    codeBuddyState.patch('cn', { token: 'stale-token', signedIn: true })
    fake.failLogout = true
    const auth = new CodeBuddyAuth()
    await expect(run(auth, 'cn')).resolves.toBe(true)
    expect(fake.calls).toEqual(['logout', 'authenticate'])
    expect(auth.status('cn').url).toBe(fake.authUrl)
  })

  it('ignores a login result that arrives after logout', async () => {
    fake.authenticateDelayMs = 30
    const auth = new CodeBuddyAuth()
    const finished = vi.fn()
    auth.start('global', finished)
    await new Promise(resolve => setTimeout(resolve, 10))
    await auth.logout('global')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(finished).not.toHaveBeenCalled()
    expect(auth.status('global').running).toBe(false)
    expect(auth.status('global').user).toBeUndefined()
  })
})
