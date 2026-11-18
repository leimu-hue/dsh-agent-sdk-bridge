/**
 * The context window the CLI runs with, and the one the plugin publishes.
 *
 * Two rules meet here. The CLI honours a requested window only when the model
 * advertises it, so reading a 1M declaration as fact inflated every token
 * reading fivefold on a 200K-only route. And the published window is the
 * denominator of the context ring and the budget the compaction engine plans
 * against, so it must not move by accident — a transient catalog miss used to
 * drop a 1M session to 200K and trigger a pointless compaction.
 */
import { describe, expect, it } from 'vitest'
import { cliContextWindow, resolveDeclaredWindow } from '../../../src/providers/qoder/adapter.ts'

describe('cli context window', () => {
  const withWindows = (available?: readonly number[], fallback: { defaultContextWindow?: number, maxInputTokens?: number } = {}) => ({
    ...fallback,
    ...available === undefined ? {} : { availableContextWindows: available },
  })

  it('keeps a declared window the model advertises', () => {
    expect(cliContextWindow(withWindows([200_000, 400_000, 1_000_000], { defaultContextWindow: 200_000 }), 1_000_000))
      .toBe(1_000_000)
    expect(cliContextWindow(withWindows([200_000, 400_000, 1_000_000], { defaultContextWindow: 200_000 }), 400_000))
      .toBe(400_000)
  })

  it('falls back to the model\'s own window when the declared one is not advertised', () => {
    // The reported bug: a 1M declaration on a 200K-only model. The CLI ignores
    // it, so multiplying its ratio by 1M read five times too high.
    expect(cliContextWindow(withWindows([200_000], { defaultContextWindow: 200_000 }), 1_000_000))
      .toBe(200_000)
    // A declared window below every advertised one is equally unhonoured.
    expect(cliContextWindow(withWindows([200_000, 1_000_000], { defaultContextWindow: 200_000 }), 150_000))
      .toBe(200_000)
  })

  it('answers nothing when the catalog said nothing, rather than guessing', () => {
    expect(cliContextWindow(undefined, 1_000_000)).toBeUndefined()
    expect(cliContextWindow({}, 1_000_000)).toBeUndefined()
  })

  it('prefers the declared default and the largest advertised window as fallbacks', () => {
    expect(cliContextWindow(withWindows(undefined, { defaultContextWindow: 200_000 }), 1_000_000)).toBe(200_000)
    expect(cliContextWindow(withWindows([200_000, 400_000]), 1_000_000)).toBe(400_000)
    expect(cliContextWindow(withWindows(undefined, { maxInputTokens: 180_000 }), 1_000_000)).toBe(180_000)
  })
})

describe('declared context window', () => {
  const model = (available?: readonly number[], fallback: { defaultContextWindow?: number, maxInputTokens?: number } = {}) => ({
    ...fallback,
    ...available === undefined ? {} : { availableContextWindows: available },
  })

  it('honours an override the model advertises', () => {
    expect(resolveDeclaredWindow(model([200_000, 400_000, 1_000_000], { defaultContextWindow: 200_000 }), 1_000_000, undefined, 200_000))
      .toBe(1_000_000)
  })

  it('ignores an override the model does not advertise', () => {
    // A 1M choice on a 200K-only route: the CLI keeps 200K, so publishing 1M
    // would divide every reading by five.
    expect(resolveDeclaredWindow(model([200_000], { defaultContextWindow: 200_000 }), 1_000_000, undefined, 200_000))
      .toBe(200_000)
  })

  it('keeps the last live window when the catalog goes missing', () => {
    // The reported Qoder jump: a transient catalog miss fell back to the static
    // 200K after a 1M session. That changed the ring denominator and the
    // compaction budget, so the next compaction ran at what looked like 10%.
    expect(resolveDeclaredWindow(undefined, undefined, 1_000_000, 200_000)).toBe(1_000_000)
    // A remembered effective window also beats a stale unsupported override.
    expect(resolveDeclaredWindow(undefined, 1_000_000, 200_000, 200_000)).toBe(200_000)
  })

  it('uses the static default only before a route ever resolved', () => {
    expect(resolveDeclaredWindow(undefined, undefined, undefined, 200_000)).toBe(200_000)
    // The user's choice is still better than guessing when nothing is known.
    expect(resolveDeclaredWindow(undefined, 1_000_000, undefined, 200_000)).toBe(1_000_000)
  })
})
