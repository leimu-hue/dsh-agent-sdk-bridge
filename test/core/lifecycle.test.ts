/**
 * A closed session and a dropped connection are not the same event.
 *
 * Both make the SDK's message iterator return `done`, which the plugin used to
 * report as `STREAM_CLOSED` either way — so a plugin reload, a pool reclaim or
 * a login switch all reached the user as "the connection dropped". These pin
 * the two halves of the fix: the reason a turn is reported with, and the
 * deferred-close machine that lets an in-flight turn finish first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseGate, DEFAULT_DRAIN_MS, closeFinishReason } from '../../src/host/core/lifecycle.ts'

describe('close finish reason', () => {
  it('reports every host-initiated close as aborted, never as a stream error', () => {
    for (const cause of ['dispose', 'evicted', 'account', 'region', 'rebuild'] as const) {
      const reason = closeFinishReason(cause)
      expect(reason.kind).toBe('aborted')
      // `ABORTED` is the code dsh-llm itself maps to `kind: 'aborted'`, and it
      // is outside the framework's default retryable set: a reload must not
      // become five automatic re-dispatches that each refeed the history.
      expect(reason.kind === 'aborted' && reason.failure.code).toBe('ABORTED')
    }
  })

  it('names the actual cause instead of a generic message', () => {
    const messages = new Set(
      (['dispose', 'evicted', 'account', 'region', 'rebuild'] as const)
        .map(cause => closeFinishReason(cause))
        .map(reason => reason.kind === 'aborted' ? reason.failure.message : ''),
    )
    expect(messages.size).toBe(5)
    expect([...messages].every(message => message.length > 0)).toBe(true)
  })
})

describe('close gate', () => {
  let teardowns = 0
  let forced: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    teardowns = 0
    forced = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const gate = (drainMs: number = DEFAULT_DRAIN_MS): CloseGate =>
    new CloseGate(() => drainMs, () => { teardowns += 1 }, cause => { forced.push(cause) })

  it('closes immediately when no turn is in flight', () => {
    const subject = gate()
    expect(subject.request('dispose', false)).toBe('closed')
    expect(teardowns).toBe(1)
    expect(subject.cause).toBe('dispose')
    expect(subject.closing).toBe(true)
  })

  it('lets an in-flight turn finish before tearing down', () => {
    const subject = gate()
    expect(subject.request('dispose', true)).toBe('draining')
    expect(teardowns).toBe(0)
    // The turn ending is what releases the teardown; its chunks reach the
    // harness first, so the answer is not truncated.
    subject.settled()
    expect(teardowns).toBe(1)
    expect(forced).toEqual([])
  })

  it('forces the close once the drain window expires', () => {
    const subject = gate(1_000)
    subject.request('dispose', true)
    vi.advanceTimersByTime(999)
    expect(teardowns).toBe(0)
    vi.advanceTimersByTime(1)
    // The turn must end as this cause before the subprocess dies, or it would
    // wait forever for a `result` frame that can never arrive.
    expect(forced).toEqual(['dispose'])
    expect(teardowns).toBe(1)
  })

  it('tears down exactly once when the turn settles after the forced close', () => {
    const subject = gate(10)
    subject.request('evicted', true)
    vi.advanceTimersByTime(10)
    subject.settled()
    expect(teardowns).toBe(1)
  })

  it('treats a zero drain window as the old immediate close', () => {
    const subject = gate(0)
    expect(subject.request('dispose', true)).toBe('closed')
    expect(teardowns).toBe(1)
  })

  it('keeps the first cause and never tears down twice on repeated requests', () => {
    const subject = gate()
    subject.request('evicted', false)
    expect(subject.request('dispose', false)).toBe('closed')
    expect(subject.request('dispose', false)).toBe('closed')
    expect(teardowns).toBe(1)
    expect(subject.cause).toBe('evicted')
  })

  it('ignores a settle that arrives before any close was requested', () => {
    const subject = gate()
    subject.settled()
    expect(teardowns).toBe(0)
    expect(subject.closing).toBe(false)
  })
})
