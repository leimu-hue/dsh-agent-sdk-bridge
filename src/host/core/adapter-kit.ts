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
import type { LlmModelInfo, LlmModelReasoningInfo, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ResolvedImages } from './host-session.ts'
import { feedImageRefs, feedToText, imageRefText, imageRefs, joinFeeds, renderRefreshed, renderUserTurn, resolvedFeedParts } from './render.ts'
import type { Feed, ImagePathResolver } from './render.ts'

/** Empty values, so an unset option allocates nothing per read. */
export const NO_MODELS: readonly string[] = []
export const NO_ALIASES: Readonly<Record<string, string>> = {}

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
 * Map a harness-side model id onto a provider's own model value.
 *
 * A configured alias always wins, under either spelling of the id; then the
 * provider's own `prefix-` form is unwrapped. `fallback` answers an id that
 * unwraps to nothing at all.
 *
 * @param model - the id the harness addressed the route with.
 * @param aliases - user-configured aliases for this provider.
 * @param prefix - the provider's own id prefix, with its trailing dash.
 * @param fallback - the value an empty remainder maps to.
 */
export function resolveAliasedModelId(
  model: string,
  aliases: Readonly<Record<string, string>>,
  prefix: string,
  fallback = '',
): string {
  const configured = aliases[model] ?? aliases[model.toLowerCase()]
  if (configured !== undefined && configured.length > 0) return configured
  const stripped = model.startsWith(prefix) ? model.slice(prefix.length) : model
  return stripped.length > 0 ? stripped : fallback
}

/**
 * A deny-list as the set a per-model lookup needs, memoized per scope.
 *
 * The live config hands out a fresh array on every read, so the memo compares
 * by content: rebuilding the set per lookup would turn each model toggle into
 * a linear scan of the list. The scope is a login region for the providers
 * whose deny-list differs per region.
 */
export class DenyList<K extends string = string> {
  private readonly perScope = new Map<K, { key: string, set: ReadonlySet<string> }>()

  /** The current membership of `scope`'s list, rebuilt only when it changed. */
  of(scope: K, source: readonly string[]): ReadonlySet<string> {
    // The separator cannot appear in a model id, so no two lists share a key.
    const key = source.join('\u0000')
    const held = this.perScope.get(scope)
    if (held !== undefined && held.key === key) return held.set
    const set = new Set(source)
    this.perScope.set(scope, { key, set })
    return set
  }
}

/** One catalog entry, as every provider describes it to the harness. */
export interface ModelListItem {
  id: string
  name: string
  description?: string
  vision?: boolean
}

/**
 * One picker row. The three providers differ only in which field carries the
 * image capability (`vision`, `isVl`), so callers normalize that first.
 */
export function modelInfo(provider: string, model: ModelListItem): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.vision === true ? ['text', 'image'] : ['text'],
  }
}

/**
 * Resolve image references into base64 request bytes.
 *
 * Only references the host can actually read become pixels; the rest keep their
 * handle text, so one unreadable attachment degrades that part of the prompt
 * instead of failing the whole turn.
 *
 * @param refs - the occurrences to read, in block order.
 * @param vision - whether the resolved model accepts images at all.
 * @param readImage - the host's reader; absent when no attachment store exists.
 * @param signal - the turn's abort signal.
 */
export async function resolveImages(
  refs: readonly ImageAttachmentRef[],
  vision: boolean,
  readImage: ImageRequestReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedImages> {
  const map = new Map<string, { data: string, mediaType: string }>()
  if (!vision || readImage === undefined || refs.length === 0) return map
  for (const ref of refs) {
    const key = String(ref.attachmentId)
    if (map.has(key)) continue
    try {
      const image = await readImage(ref, signal)
      if (image !== undefined) {
        map.set(key, { data: Buffer.from(image.bytes).toString('base64'), mediaType: image.mediaType })
      }
    } catch {
      // Degrade this attachment to its handle text.
    }
  }
  return map
}

/**
 * Images carried by the messages the inner session has not seen yet.
 *
 * Tool results are included: `read_image` hands its pixels back through the MCP
 * tool result, not through the prompt text, so this tail is the only place the
 * bytes can come from.
 */
export async function resolveTurnImages(
  tail: readonly RequestMessage[],
  vision: boolean,
  readImage: ImageRequestReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedImages> {
  const refs = tail.flatMap(message => message.role === 'assistant' ? [] : imageRefs(message.content))
  return await resolveImages(refs, vision, readImage, signal)
}

/** How one provider wraps the two things a feed can carry. */
export interface VisionBlockSink<TBlock> {
  text(text: string): TBlock
  image(data: string, mediaType: string): TBlock
}

/**
 * Turn a feed into what one CLI turn receives, in a provider's block shape.
 *
 * A text-only feed stays a plain string (the historical shape). A feed with
 * readable images becomes a block list, because that is the only shape the
 * CLIs send to the model as pixels. An image the host could not read keeps its
 * handle text, so it degrades one part instead of failing the turn.
 */
export async function buildVisionFeed<TBlock>(
  feed: Feed,
  vision: boolean,
  options: {
    imagePath?: ImagePathResolver
    readImage?: ImageRequestReader
    signal?: AbortSignal
    blocks: VisionBlockSink<TBlock>
  },
): Promise<string | TBlock[]> {
  if (typeof feed === 'string') return feed
  if (!vision) return feedToText(feed, options.imagePath)
  const images = await resolveImages(feedImageRefs(feed), vision, options.readImage, options.signal)
  const parts = resolvedFeedParts(feed, images)
  if (!parts.some(part => part.type !== 'text')) {
    return parts.map(part => part.type === 'text' ? part.text : '').join('\n\n')
  }
  const content: TBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      content.push(options.blocks.text(part.text))
      continue
    }
    // The pixels let the model read the image; this handle lets it find and
    // edit the source file. Without it a "modify this image" turn searches the
    // workspace for a file that was never there.
    const path = options.imagePath?.(part.attachment)
    content.push(options.blocks.text(part.type === 'image-unreadable' && path === undefined
      ? `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]`
      : imageRefText(part.attachment, path)))
    if (part.type === 'image-unreadable') continue
    content.push(options.blocks.image(part.data, part.mediaType))
  }
  return content
}

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
 * The providers spell their levels differently (Qoder publishes
 * `low|medium|high|max`, CodeBuddy whatever its catalog declares), so the
 * ranking is by name rather than by position in any one upstream list. An id
 * outside this table ranks below every known one, which is what several sources
 * agreeing on an unfamiliar spelling should do.
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

