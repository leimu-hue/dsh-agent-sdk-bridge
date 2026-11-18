/**
 * The adapter-side primitives every provider shares: how an image occurrence is
 * read into request bytes, which reasoning levels a route advertises, and how a
 * continuation request is turned into inner-session feed (or a rebuild).
 *
 * Each backend answers these the same way, so they live in `core` rather than
 * in the provider that happened to define them first.
 *
 * @module dsh-agent-sdk-bridge/core/adapter-kit
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { joinFeeds, renderRefreshed, renderUserTurn } from './render.ts'
import type { Feed } from './render.ts'

/**
 * Read one durable image occurrence into the bytes a request sends.
 * Implemented over `ctx.attachments`; returns undefined when the object is
 * unreadable, which degrades that one image instead of failing the turn.
 */
export type ImageRequestReader = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ bytes: Uint8Array, mediaType: string } | undefined>

/**
 * Default selectable reasoning efforts. The CLI catalog reports per-model
 * `efforts`; this is the fallback when a model (or the static catalog)
 * discloses none.
 */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const

/** Human display name for the default effort ids. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

/**
 * Strength order used to pick a model's starting level.
 *
 * The three providers spell their levels differently (Qoder publishes
 * `low|medium|high|max`, MiniMax `low|high`, CodeBuddy whatever its catalog
 * declares), so the ranking is by name rather than by position in any one
 * upstream list. An id outside this table ranks below every known one, which is
 * what several sources agreeing on an unfamiliar spelling should do.
 */
const EFFORT_ORDER: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The strongest level a model offers.
 *
 * Switching model or level must start at the most capable setting the route
 * accepts, the same rule the sibling adapter plugin uses; the previous
 * behaviour of following upstream's own default meant some models silently
 * started one or two steps down (`CodeBuddy` advertises `high` as its default
 * even when `max` is selectable).
 *
 * @param efforts - the levels the route accepts, in upstream order.
 * @returns the strongest id, or undefined for a non-reasoning model.
 */
export function strongestEffort(efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined
  let best: string | undefined
  let bestRank = -1
  for (const effort of efforts) {
    // First occurrence wins a tie, which keeps an upstream-ordered list stable
    // when it repeats a level.
    const rank = EFFORT_ORDER.indexOf(effort)
    if (best === undefined || rank > bestRank) {
      best = effort
      bestRank = rank
    }
  }
  return best
}

/**
 * Build the `reasoning` metadata block for a resolved model, or undefined
 * when the model does not support reasoning.
 *
 * The starting level is the strongest one the model accepts, not the level
 * upstream happens to name as its default: the user's explicit choice in the
 * sibling plugin, applied here too. An explicit configuration value still wins
 * when the model accepts it.
 *
 * @param efforts - CLI-reported effort ids (absent for reasoning-less models).
 * @param configuredEffort - user-configured starting level, when any.
 * @param isReasoning - whether the model supports reasoning per the CLI.
 * @returns the harness reasoning metadata, or undefined to omit it.
 */
export function reasoningInfo(
  efforts: readonly string[] | undefined,
  configuredEffort: string | undefined,
  isReasoning: boolean | undefined,
): LlmModelReasoningInfo | undefined {
  if (efforts === undefined && isReasoning === false) return undefined
  const ids = efforts !== undefined && efforts.length > 0
    ? efforts
    : DEFAULT_REASONING_EFFORTS
  const defaultEffort = configuredEffort !== undefined && ids.includes(configuredEffort)
    ? configuredEffort
    : strongestEffort(ids)
  return {
    efforts: ids.map(id => ({
      id: ReasoningEffortId(id),
      name: EFFORT_NAMES[id] ?? id,
    })),
    ...defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) },
  }
}

interface ContinuationPlan {
  /** Feed for the inner session this turn, or null for a pure continuation. */
  feed: Feed | null
  /** Whether the warm session must be rebuilt (history diverged past repair). */
  rebuild: boolean
}

/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export function planContinuation(
  previous: readonly RequestMessage[],
  current: readonly RequestMessage[],
): ContinuationPlan {
  if (current.length <= previous.length) return { feed: null, rebuild: true }
  const mutated: number[] = []
  for (let i = 0; i < previous.length; i++) {
    if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i)
  }
  if (mutated.includes(0) || mutated.length > 2) return { feed: null, rebuild: true }
  const tail = current.slice(previous.length)
  const freshUser = tail.filter(m => m.role === 'user')
  if (freshUser.length === 0 && mutated.length === 0) return { feed: null, rebuild: false }
  const parts: Feed[] = []
  for (const index of mutated) {
    const message = current[index]
    if (message !== undefined) parts.push(renderRefreshed(message))
  }
  for (const message of freshUser) parts.push(renderUserTurn(message.content))
  const feed = joinFeeds(parts)
  return { feed: typeof feed === 'string' && feed.length === 0 ? null : feed, rebuild: false }
}

