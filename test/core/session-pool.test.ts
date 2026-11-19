/**
 * The pool may reclaim a slot, but never from a conversation that is talking.
 *
 * Both managers used to evict strictly by least-recent-use, with no look at
 * whether that session had a turn in flight: opening one more conversation
 * killed a running one, and the victim's turn was reported as a dropped stream.
 * Sealing is the fix for the other half — a reloaded plugin's old pool could
 * still be woken by a retried step and spawn a subprocess nothing would close.
 */
import { describe, expect, it } from 'vitest'
import type { CloseCause } from '../../src/host/core/lifecycle.ts'
import { SessionPool } from '../../src/host/core/session-pool.ts'
import { QoderSessionManager } from '../../src/host/providers/qoder/manager.ts'
import type { QoderSession } from '../../src/host/providers/qoder/session.ts'
import { CodeBuddySessionManager } from '../../src/host/providers/codebuddy/session.ts'
import type { CodeBuddySession } from '../../src/host/providers/codebuddy/session.ts'

/** The pool's view of a session, with the two facts the pool reads. */
class FakeSession {
  busy = false
  closedWith: CloseCause | undefined
  closeCount = 0

  constructor(readonly sessionId: string) {}

  close(cause: CloseCause = 'dispose'): void {
    this.closeCount += 1
    this.closedWith = cause
  }
}

/** One pool under test, adapted to whichever manager's session type. */
function qoderPool(cap: number, created: FakeSession[]) {
  return new QoderSessionManager(cap, { brand: 'cn' }, (id) => {
    const fake = new FakeSession(id)
    created.push(fake)
    return fake as unknown as QoderSession
  })
}

function codeBuddyPool(cap: number, created: FakeSession[]) {
  return new CodeBuddySessionManager(cap, {}, (id) => {
    const fake = new FakeSession(id)
    created.push(fake)
    return fake as unknown as CodeBuddySession
  })
}

describe('qoder session pool', () => {
  it('evicts the least recently used IDLE session, not the one that is talking', () => {
    const created: FakeSession[] = []
    const pool = qoderPool(2, created)
    const running = pool.forSession('a', 'model')
    const idle = pool.forSession('b', 'model')
    ;(running as unknown as FakeSession).busy = true
    pool.forSession('c', 'model')
    expect((idle as unknown as FakeSession).closedWith).toBe('evicted')
    expect(running.sessionId).toBe('a')
    expect((running as unknown as FakeSession).closeCount).toBe(0)
  })

  it('temporarily exceeds the cap when every session is busy', () => {
    const created: FakeSession[] = []
    const pool = qoderPool(2, created)
    const first = pool.forSession('a', 'model')
    for (const id of ['a', 'b']) {
      const session = pool.forSession(id, 'model')
      ;(session as unknown as FakeSession).busy = true
    }
    pool.forSession('c', 'model')
    // Nothing may be killed, so the pool overflows instead of lying about a cap.
    expect(created).toHaveLength(3)
    expect(created.every(session => session.closeCount === 0)).toBe(true)
    // And the oldest is still the same live object, not a cold rebuild.
    expect(pool.forSession('a', 'model')).toBe(first)
  })

  it('reports a history rebuild as its own cause', () => {
    const created: FakeSession[] = []
    const pool = qoderPool(4, created)
    pool.forSession('a', 'model')
    pool.dispose('a')
    expect(created[0]?.closedWith).toBe('rebuild')
  })

  it('closes every session on a credential change but keeps serving', () => {
    const created: FakeSession[] = []
    const pool = qoderPool(4, created)
    pool.forSession('a', 'model')
    pool.forSession('b', 'model')
    pool.closeAll('account')
    expect(created.map(session => session.closedWith)).toEqual(['account', 'account'])
    // Still usable: a login is not a teardown.
    expect(() => pool.forSession('c', 'model')).not.toThrow()
  })

  it('refuses to revive a sealed pool', () => {
    const created: FakeSession[] = []
    const pool = qoderPool(4, created)
    pool.forSession('a', 'model')
    pool.seal('dispose')
    expect(created[0]?.closedWith).toBe('dispose')
    // A step prepared before the unload can still be retried through the old
    // adapter; creating a session then would leak a subprocess.
    expect(() => pool.forSession('a', 'model')).toThrow(/封存/)
    expect(created).toHaveLength(1)
  })
})

describe('codebuddy session pool', () => {
  it('evicts the least recently used IDLE session, not the one that is talking', () => {
    const created: FakeSession[] = []
    const pool = codeBuddyPool(2, created)
    const running = pool.forSession('a', 'global', 'model')
    const idle = pool.forSession('b', 'global', 'model')
    ;(running as unknown as FakeSession).busy = true
    pool.forSession('c', 'global', 'model')
    expect((idle as unknown as FakeSession).closedWith).toBe('evicted')
    expect((running as unknown as FakeSession).closeCount).toBe(0)
  })

  it('retires a session whose login region changed', () => {
    const created: FakeSession[] = []
    const pool = codeBuddyPool(4, created)
    pool.forSession('a', 'global', 'model')
    pool.forSession('a', 'cn', 'model')
    expect(created[0]?.closedWith).toBe('region')
    expect(created).toHaveLength(2)
  })

  it('closes every session on a login change but keeps serving', () => {
    const created: FakeSession[] = []
    const pool = codeBuddyPool(4, created)
    pool.forSession('a', 'global', 'model')
    pool.closeAll('account')
    expect(created[0]?.closedWith).toBe('account')
    expect(() => pool.forSession('b', 'global', 'model')).not.toThrow()
  })

  it('refuses to revive a sealed pool', () => {
    const created: FakeSession[] = []
    const pool = codeBuddyPool(4, created)
    pool.forSession('a', 'global', 'model')
    pool.seal('dispose')
    expect(() => pool.forSession('a', 'global', 'model')).toThrow(/封存/)
    expect(created).toHaveLength(1)
  })
})

describe('shared session pool', () => {
  it('retires a session its stale hook rejects and builds a replacement', () => {
    const created: FakeSession[] = []
    const pool = new SessionPool<FakeSession>({ label: 'test', maxSessions: 4 })
    const first = pool.forSession('a', id => {
      const fake = new FakeSession(id)
      created.push(fake)
      return fake
    })
    const second = pool.forSession('a', id => {
      const fake = new FakeSession(id)
      created.push(fake)
      return fake
    }, () => 'region')
    expect(second).not.toBe(first)
    expect(first.closedWith).toBe('region')
    expect(created).toHaveLength(2)
  })

  it('names its own label in the sealed-pool error', () => {
    const pool = new SessionPool<FakeSession>({ label: 'demo', maxSessions: 1 })
    pool.seal()
    expect(() => pool.forSession('a', id => new FakeSession(id))).toThrow(/demo 会话池已封存/)
  })
})
describe('idle sweep', () => {
  it('closes only sessions unused past the ttl and leaves busy ones alone', () => {
    const created: FakeSession[] = []
    const pool = new SessionPool<FakeSession>({ label: 'idle', maxSessions: 8, idleMs: 1_000 })
    const stale = pool.forSession('stale', id => {
      const fake = new FakeSession(id)
      created.push(fake)
      return fake
    })
    const busy = pool.forSession('busy', id => {
      const fake = new FakeSession(id)
      created.push(fake)
      return fake
    })
    busy.busy = true

    pool.sweepIdle(Date.now() + 1_500)
    expect(stale.closedWith).toBe('idle')
    expect(busy.closedWith).toBeUndefined()
    expect(pool.size).toBe(1)
    pool.seal()
  })

  it('does nothing when reclamation is disabled', () => {
    const pool = new SessionPool<FakeSession>({ label: 'idle', maxSessions: 8, idleMs: 0 })
    const session = pool.forSession('a', id => new FakeSession(id))
    pool.sweepIdle(Date.now() + 10_000_000)
    expect(session.closedWith).toBeUndefined()
    pool.seal()
  })
})