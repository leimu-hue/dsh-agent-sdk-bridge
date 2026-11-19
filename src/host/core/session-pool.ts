/**
 * The warm-session pool both provider backends run.
 *
 * A pool is the only thing that decides when a subprocess is evicted, when a
 * credential change drops it, when an idle one is reclaimed, and when an
 * unloaded plugin refuses to spawn a new one. Those are provider-independent
 * rules — a session is just `{ sessionId, busy, close(cause) }` — so they live
 * here once instead of twice. Each backend supplies only how to build one and,
 * where it has one, the fact that makes a held session unusable (CodeBuddy's
 * login region).
 *
 * The pool's interface is deliberately narrow: `forSession`, `dispose`,
 * `closeAll`, `seal`, `sweepIdle`. Eviction order, the busy guard, the idle
 * sweep and the sealed state are implementation detail, so both backends'
 * managers are thin adapters over the same behaviour rather than two copies.
 *
 * @module dsh-agent-sdk-bridge/core/session-pool
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CloseCause, PoolSession } from './lifecycle.ts'
import { unrefTimer } from './lifecycle.ts'
import type { Live } from './live.ts'
import { readLive } from './live.ts'

/** Warm sessions kept alive when the deployment names no cap. */
export const DEFAULT_MAX_SESSIONS = 8

/** How often the pool looks for idle sessions; the timer is unref'd. */
const IDLE_SWEEP_MS = 30_000

/** What a pool needs to know beyond the sessions themselves. */
export interface SessionPoolOptions {
  /** Name used in the sealed-pool error: `<label> 会话池已封存…`. */
  label: string
  /** Warm-session cap, read per eviction so a settings edit applies next time. */
  maxSessions: Live<number>
  /** Cap used when `maxSessions` resolves to undefined. */
  fallbackMaxSessions?: number
  /**
   * How long a session may sit unused before the sweep reclaims it.
   *
   * Read per sweep, so a settings edit applies to the next tick; `0` disables
   * reclamation without stopping the timer. Omit the option entirely (as tests
   * and one-off pools do) to avoid creating a timer at all.
   */
  idleMs?: Live<number>
}

/**
 * An LRU pool of warm sessions with an optional idle sweep.
 *
 * Insertion order is the LRU order: a session read through {@link forSession}
 * is re-inserted at the end, so the first idle entry is always the least
 * recently used. Eviction never takes a `busy` session or the one being
 * requested; when every session is busy the pool overflows rather than
 * reporting a cap it did not enforce.
 */
export class SessionPool<T extends PoolSession> {
  private readonly sessions = new Map<string, T>()
  /** When each held session was last requested, for {@link sweepIdle}. */
  private readonly lastUsed = new Map<string, number>()
  /** Set by {@link seal}: this pool's plugin generation is gone. */
  private sealed = false
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: SessionPoolOptions) {
    if (options.idleMs !== undefined) {
      // Unref'd, so an idle plugin never keeps the host process alive.
      this.sweepTimer = setInterval(() => { this.sweepIdle() }, IDLE_SWEEP_MS)
      unrefTimer(this.sweepTimer)
    }
  }

  /**
   * The existing session for `sessionId`, or a fresh one.
   *
   * @param sessionId - the host session id the warm process belongs to.
   * @param create - builds the session when none is held (or the held one is stale).
   * @param stale - why a held session can no longer serve, if it can't.
   */
  forSession(
    sessionId: string,
    create: (sessionId: string) => T,
    stale?: (session: T) => CloseCause | undefined,
  ): T {
    // A sealed pool belonged to a plugin generation that is gone. Reviving it
    // would spawn a subprocess nothing will ever close: the harness can still
    // hold a `prepareCall()` generation from before the reload and retry its
    // step through this adapter. See `seal`.
    if (this.sealed) {
      throw new LlmError(`${this.options.label} 会话池已封存（插件已卸载）`, 'INVALID_REQUEST')
    }
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      const cause = stale?.(existing)
      if (cause === undefined) {
        // Re-insert to move it to the end of the LRU order.
        this.sessions.delete(sessionId)
        this.sessions.set(sessionId, existing)
        this.lastUsed.set(sessionId, Date.now())
        return existing
      }
      this.sessions.delete(sessionId)
      this.lastUsed.delete(sessionId)
      existing.close(cause)
    }

    const session = create(sessionId)
    this.sessions.set(sessionId, session)
    this.lastUsed.set(sessionId, Date.now())
    this.evictToCap(sessionId)
    return session
  }

  /** Drop one session (history diverged); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    this.lastUsed.delete(sessionId)
    session.close('rebuild')
  }

  /**
   * Drop every warm session, keeping the pool usable.
   *
   * For a credential change: the processes loaded the old account, and the
   * conversations are over, but the adapter keeps serving new ones.
   *
   * @param cause - why the sessions go; decides how interrupted turns report.
   */
  closeAll(cause: CloseCause = 'account'): void {
    for (const session of this.sessions.values()) session.close(cause)
    this.sessions.clear()
    this.lastUsed.clear()
  }

  /**
   * Drop every warm session and refuse to create more.
   *
   * Called from the plugin's dispose effect. `closeAll` alone is not enough: a
   * retry of a step prepared before the unload would spawn a fresh subprocess
   * that nothing owns afterwards.
   */
  seal(cause: CloseCause = 'dispose'): void {
    this.sealed = true
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    this.closeAll(cause)
  }

  /**
   * Reclaim sessions that have been unused for longer than `idleMs`.
   *
   * A session with a turn in flight is never reclaimed: killing it would report
   * the turn as a stream failure and discard an answer that was arriving. The
   * method is public so the sweep can be tested at a chosen timestamp instead of
   * waiting for the timer.
   *
   * @param now - the wall clock to measure against; defaults to now.
   */
  sweepIdle(now: number = Date.now()): void {
    if (this.sealed) return
    const idleMs = this.options.idleMs === undefined ? 0 : readLive(this.options.idleMs, 0)
    if (!(idleMs > 0)) return
    for (const [id, session] of [...this.sessions.entries()]) {
      if (session.busy) continue
      const seen = this.lastUsed.get(id) ?? now
      if (now - seen < idleMs) continue
      this.sessions.delete(id)
      this.lastUsed.delete(id)
      session.close('idle')
    }
  }

  /** How many warm sessions the pool holds, for diagnostics and tests. */
  get size(): number {
    return this.sessions.size
  }

  /** Whether this pool refuses new sessions. */
  get isSealed(): boolean {
    return this.sealed
  }

  /**
   * Close idle sessions until the pool is within its cap.
   *
   * @param keep - the session just requested, which must never be the victim.
   */
  private evictToCap(keep: string): void {
    const cap = readLive(this.options.maxSessions, this.options.fallbackMaxSessions ?? DEFAULT_MAX_SESSIONS)
    for (const [id, candidate] of this.sessions) {
      if (this.sessions.size <= cap) return
      // Never evict a session with a turn in flight: killing it reports the
      // turn as a stream failure and throws away an answer that was arriving.
      if (id === keep || candidate.busy) continue
      this.sessions.delete(id)
      this.lastUsed.delete(id)
      candidate.close('evicted')
    }
  }
}
