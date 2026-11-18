/**
 * The pure core helpers every provider leans on: token pricing, the MCP tool
 * name peeling, the catalogue snapshot rule, and the reasoning-level choice.
 *
 * They share a file because they share a property — none of them touches a
 * file, a subprocess or a provider — and because each one is a rule rather than
 * a feature: a rate, a prefix walk, a stale-while-revalidate contract, and the
 * "start on the strongest level the model accepts" default.
 *
 * The four rules, and the defects they were written against:
 *
 * - **Pricing is script aware.** The harness prices text at a flat 4 chars per
 *   token and derives `tok/s` from the reported output tokens, so a flat rate
 *   under-priced Chinese by ~2.2x and `reasoningTokens` had to stay inside
 *   `outputTokens`.
 * - **A tool name is peeled until no prefix is left.** Both the host and the
 *   CLI report `mcp__dsh_host__edit` as unknown when only one layer is peeled.
 * - **A model switch answers from the snapshot.** Awaiting a catalogue fetch
 *   froze the picker for the length of a CLI cold start.
 * - **A model starts on its strongest reasoning level.** Upstream's own default
 *   is deliberately ignored: CodeBuddy advertises `high` while `max` is
 *   selectable, and Qoder publishes none.
 *
 * @module dsh-agent-sdk-bridge/test/core/primitives
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NARROW_CHARS_PER_TOKEN, TurnOutputAccounting, WIDE_CHARS_PER_TOKEN, countWideChars, estimateTextTokens, isWideChar,
} from '../../src/host/core/tokens.ts'
import { mcpToolPrefixes, stripMcpNamespace } from '../../src/host/core/mcp-naming.ts'
import { cachedModels } from '../../src/host/core/model-cache.ts'
import { reasoningInfo, strongestEffort } from '../../src/host/core/adapter-kit.ts'

describe('wide character classification', () => {
  it('treats CJK text, kana and fullwidth forms as wide', () => {
    for (const character of '中文漢字、。ひらがなカタカナ、全角！？') expect(isWideChar(character)).toBe(true)
  })

  it('treats Latin, digits, ASCII punctuation and emoji as narrow', () => {
    for (const character of 'abcXYZ019 .,;:!?-_/\\[]{}<>@#$%^&*()"\'`~+=|') {
      expect(isWideChar(character)).toBe(false)
    }
    expect(isWideChar('🎉')).toBe(false)
  })

  it('counts a mixed string exactly', () => {
    expect(countWideChars('你好 world 再见')).toBe(4)
    expect(countWideChars('no wide text here')).toBe(0)
    expect(countWideChars('')).toBe(0)
  })
})

describe('token estimation', () => {
  it('prices pure Chinese at the measured wide rate', () => {
    const text = '这是一段中文'
    const tokens = estimateTextTokens(text.length, countWideChars(text))
    expect(tokens).toBeCloseTo(text.length / WIDE_CHARS_PER_TOKEN, 5)
  })

  it('prices pure ASCII at the measured narrow rate', () => {
    const text = 'this is plain ascii text'
    expect(estimateTextTokens(text.length, 0)).toBeCloseTo(text.length / NARROW_CHARS_PER_TOKEN, 5)
  })

  it('prices a mixed string as the sum of both rates', () => {
    const tokens = estimateTextTokens(100, 30)
    expect(tokens).toBeCloseTo(30 / WIDE_CHARS_PER_TOKEN + 70 / NARROW_CHARS_PER_TOKEN, 5)
  })

  it('under-prices Chinese at a flat 4 chars/token, which is why the rate exists', () => {
    const text = '中'.repeat(177)
    const scriptAware = estimateTextTokens(text.length, countWideChars(text))
    const flat = text.length / 4
    expect(scriptAware / flat).toBeGreaterThan(2.2)
    expect(scriptAware / flat).toBeLessThan(2.3)
  })

  it('never prices more characters than it was given, nor fewer than none', () => {
    // A wide count above the total, or negative, must not distort the result.
    expect(estimateTextTokens(10, 99)).toBeCloseTo(10 / WIDE_CHARS_PER_TOKEN, 5)
    expect(estimateTextTokens(10, -5)).toBeCloseTo(10 / NARROW_CHARS_PER_TOKEN, 5)
    expect(estimateTextTokens(0, 0)).toBe(0)
  })
})

/**
 * Per-turn output accounting.
 *
 * The regression this guards: tool-call arguments were never counted, and on an
 * agentic turn they are most of the output — measured at 86% of the characters
 * in a three-call turn. Because the harness derives `tok/s` from the reported
 * output tokens, dropping them under-reported speed several fold (a real turn
 * went from 72.5 to 311.2 tok/s once they were counted).
 */
describe('turn output accounting', () => {
  it('counts tool-call arguments as generated output', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('write_file')
    account.addOutput('{"path":"src/a.ts","content":"export const x = 1"}')
    const { outputTokens } = account.usage()
    const withoutArguments = new TurnOutputAccounting()
    withoutArguments.addOutput('write_file')
    expect(outputTokens).toBeGreaterThan(withoutArguments.usage().outputTokens * 3)
  })

  it('counts reasoning toward output, and reports it as a subset', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('answer')
    account.addReasoning('thinking about the answer')
    const { outputTokens, reasoningTokens } = account.usage()
    expect(reasoningTokens).toBeDefined()
    expect(reasoningTokens!).toBeLessThanOrEqual(outputTokens)
    // Reasoning is inside the total, not added on top of it.
    const total = new TurnOutputAccounting()
    total.addOutput('answer')
    total.addOutput('thinking about the answer')
    expect(outputTokens).toBe(total.usage().outputTokens)
  })

  it('reports no reasoning field on a turn that did not reason', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('plain answer')
    expect(account.usage().reasoningTokens).toBeUndefined()
  })

  it('always reports at least one output token', () => {
    expect(new TurnOutputAccounting().usage().outputTokens).toBe(1)
  })

  it('forgets everything on reset, so a retried turn is not double-counted', () => {
    const account = new TurnOutputAccounting()
    account.addOutput('discarded first attempt')
    account.addReasoning('discarded reasoning')
    account.reset()
    expect(account.outputChars).toBe(0)
    expect(account.reasoningCharsTotal).toBe(0)
    account.addOutput('好')
    expect(account.usage().reasoningTokens).toBeUndefined()
  })

  it('keeps a metered reasoning figure inside the provider total', () => {
    const account = new TurnOutputAccounting()
    account.addReasoning('很长的思考过程'.repeat(50))
    // A provider that counted fewer output tokens than the local reasoning
    // estimate must not be handed a reasoning figure above its own total.
    expect(account.reasoningTokensWithin(10).reasoningTokens).toBe(10)
    // And a provider that counted none must not be given 1, which would exceed 0.
    expect(account.reasoningTokensWithin(0).reasoningTokens).toBe(0)
    // A turn that did not reason carries no field at all.
    expect(new TurnOutputAccounting().reasoningTokensWithin(100)).toEqual({})
  })
})

/** One tool name, however many times it was namespaced. */
const CODEBUDDY_PREFIXES = mcpToolPrefixes('dsh-host')

describe('MCP namespace spellings', () => {
  it('accepts both spellings each backend produces', () => {
    // CodeBuddy rewrites the server name's hyphen to `_`; the Qoder and MiniMax
    // CLIs keep it. One server, two names on the wire.
    expect(CODEBUDDY_PREFIXES).toEqual(['mcp__dsh-host__', 'mcp__dsh_host__'])
  })

  it('collapses to one prefix when the server name needs no rewriting', () => {
    expect(mcpToolPrefixes('dshhost')).toEqual(['mcp__dshhost__'])
  })
})

describe('stripping the MCP namespace', () => {
  it('peels a single layer', () => {
    expect(stripMcpNamespace('mcp__dsh_host__ops_bash', CODEBUDDY_PREFIXES)).toBe('ops_bash')
    expect(stripMcpNamespace('mcp__dsh-host__ops_bash', CODEBUDDY_PREFIXES)).toBe('ops_bash')
  })

  it('peels every layer, which is the case that produced both errors', () => {
    // The name the CLI handed over after the model re-sent an already-qualified
    // one. One layer would yield `mcp__dsh_host__edit` — the exact string DSH
    // reported as `unknown tool`.
    const doubled = 'mcp__dsh_host__mcp__dsh_host__edit'
    expect(stripMcpNamespace(doubled, CODEBUDDY_PREFIXES)).toBe('edit')
    // And the mixed-spelling variant, because the CLI's rewrite is per layer.
    expect(stripMcpNamespace('mcp__dsh-host__mcp__dsh_host__edit', CODEBUDDY_PREFIXES)).toBe('edit')
    expect(stripMcpNamespace('mcp__dsh_host__mcp__dsh_host__mcp__dsh_host__read', CODEBUDDY_PREFIXES)).toBe('read')
  })

  it('reports "not mine" rather than inventing a name', () => {
    // A bare tool name is not this server's; each backend falls back to treating
    // it as its own native tool, so the distinction has to survive.
    expect(stripMcpNamespace('ops_bash', CODEBUDDY_PREFIXES)).toBeNull()
    expect(stripMcpNamespace('Bash', CODEBUDDY_PREFIXES)).toBeNull()
    // Nothing but namespaces leaves no tool name at all.
    expect(stripMcpNamespace('mcp__dsh_host__', CODEBUDDY_PREFIXES)).toBeNull()
    expect(stripMcpNamespace('mcp__dsh_host__mcp__dsh_host__', CODEBUDDY_PREFIXES)).toBeNull()
  })

  it('ignores an empty prefix instead of matching everything', () => {
    // `startsWith('')` is always true, so an unguarded empty entry would make
    // every tool name look like this server's and strip nothing.
    expect(stripMcpNamespace('anything', ['', 'mcp__x__'])).toBeNull()
    expect(stripMcpNamespace('mcp__x__t', ['', 'mcp__x__'])).toBe('t')
  })

  it('terminates on a name made only of prefixes', () => {
    // The walk is bounded, so a pathological name cannot spin forever.
    expect(stripMcpNamespace('mcp__x__'.repeat(50), ['mcp__x__'])).toBeNull()
  })

  it('makes every backend agree on the doubled name', async () => {
    const { hostToolName: codeBuddyName, isHostTool } = await import('../../src/host/providers/codebuddy/session.ts')
    const qoder = await import('../../src/host/providers/qoder/session.ts')
    const minimax = await import('../../src/host/providers/minimax/session.ts')

    // Each backend is asked about its own namespaced spelling of the same tool.
    expect(codeBuddyName('mcp__dsh_host__mcp__dsh_host__ops_edit_file')).toBe('ops_edit_file')
    expect(qoder.hostToolName('mcp__dsh-host__mcp__dsh-host__ops_edit_file')).toBe('ops_edit_file')
    expect(minimax.hostMcpToolName('mcp__dsh-host__mcp__dsh-host__ops_edit_file')).toBe('ops_edit_file')

    // And each still recognises its own namespaced tools while rejecting bare
    // names, which is what routes a call to the host at all.
    expect(isHostTool('mcp__dsh_host__ops_edit_file')).toBe(true)
    expect(isHostTool('ops_edit_file')).toBe(false)
    expect(minimax.isHostMcpTool('mcp__dsh-host__ops_bash')).toBe(true)
    expect(minimax.isHostMcpTool('ops_bash')).toBe(false)
  })
})

describe('cachedModels', () => {
  it('answers from the snapshot without waiting for the refresh', async () => {
    const snapshot = [{ id: 'model-1' }]
    const fetch = vi.fn(() => new Promise<readonly { id: string }[]>(() => {}))
    const started = Date.now()
    const models = await cachedModels(snapshot, fetch)
    const elapsed = Date.now() - started
    expect(models).toBe(snapshot)
    // The refresh was started but deliberately not awaited: the promise above
    // never settles, and this call still returned.
    expect(fetch).toHaveBeenCalledOnce()
    expect(elapsed).toBeLessThan(50)
  })

  it('waits for the fetch when nothing has been read yet', async () => {
    const models = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => models)
    expect(await cachedModels(undefined, fetch)).toBe(models)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('waits when the snapshot is empty, so a real list can replace it', async () => {
    const models = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => models)
    expect(await cachedModels([], fetch)).toBe(models)
  })

  it('keeps answering from the snapshot when the refresh rejects', async () => {
    const snapshot = [{ id: 'model-1' }]
    const fetch = vi.fn(async () => { throw new Error('cli down') })
    await expect(cachedModels(snapshot, fetch)).resolves.toBe(snapshot)
    // Let the swallowed rejection settle; an unhandled one would fail the run.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

/** The ids one reasoning block offers, in declared order. */
function effortIds(info: ReturnType<typeof reasoningInfo>): string[] {
  return info?.efforts.map(effort => String(effort.id)) ?? []
}

describe('strongestEffort', () => {
  it('picks the strongest level regardless of the order it is listed in', () => {
    expect(strongestEffort(['low', 'medium', 'high', 'max'])).toBe('max')
    expect(strongestEffort(['max', 'high', 'low'])).toBe('max')
    expect(strongestEffort(['low', 'high'])).toBe('high')
    expect(strongestEffort(['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
  })

  it('handles the levels the three providers actually publish', () => {
    // Qoder's fallback list, MiniMax's thinkingEffort options, CodeBuddy's
    // per-model supportedEfforts.
    expect(strongestEffort(['low', 'medium', 'high', 'max'])).toBe('max')
    expect(strongestEffort(['low', 'high'])).toBe('high')
    expect(strongestEffort(['low', 'medium', 'high'])).toBe('high')
  })

  it('keeps an unfamiliar id below every known level', () => {
    // An unknown spelling still resolves to something usable rather than
    // dropping the control, but never outranks a level we understand.
    expect(strongestEffort(['low', 'turbo'])).toBe('low')
    expect(strongestEffort(['turbo'])).toBe('turbo')
  })

  it('reports nothing for a model without levels', () => {
    expect(strongestEffort([])).toBeUndefined()
  })
})

describe('reasoningInfo', () => {
  it('defaults to the strongest level, not the upstream default', () => {
    // CodeBuddy names `high` as its default while `max` is selectable.
    const info = reasoningInfo(['low', 'high', 'max'], undefined, true)
    expect(effortIds(info)).toEqual(['low', 'high', 'max'])
    expect(String(info?.defaultEffort)).toBe('max')
  })

  it('uses the configured level when the model accepts it', () => {
    const info = reasoningInfo(['low', 'high', 'max'], 'low', true)
    expect(String(info?.defaultEffort)).toBe('low')
  })

  it('falls back to the strongest level when the configured one is not offered', () => {
    // A stored `max` against a model that only exposes low/high must not make
    // the host reject the turn with UNSUPPORTED_REASONING_EFFORT.
    const info = reasoningInfo(['low', 'high'], 'max', true)
    expect(String(info?.defaultEffort)).toBe('high')
  })

  it('declares the widest fallback list when the model reports none', () => {
    const info = reasoningInfo(undefined, undefined, true)
    expect(effortIds(info)).toEqual(['low', 'medium', 'high', 'max'])
    expect(String(info?.defaultEffort)).toBe('max')
  })

  it('omits reasoning entirely for a non-reasoning model', () => {
    expect(reasoningInfo(undefined, undefined, false)).toBeUndefined()
  })
})
