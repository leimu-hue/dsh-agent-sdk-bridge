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
import type { LlmModelInfo, LlmModelReasoningInfo, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ResolvedImages } from './host-session.ts';
import type { Feed, ImagePathResolver } from './render.ts';
/** Empty values, so an unset option allocates nothing per read. */
export declare const NO_MODELS: readonly string[];
export declare const NO_ALIASES: Readonly<Record<string, string>>;
/**
 * Read one durable image occurrence into the bytes a request sends.
 * Implemented over `ctx.attachments`; returns undefined when the object is
 * unreadable, which degrades that one image instead of failing the turn.
 */
export type ImageRequestReader = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{
    bytes: Uint8Array;
    mediaType: string;
} | undefined>;
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
export declare function resolveAliasedModelId(model: string, aliases: Readonly<Record<string, string>>, prefix: string, fallback?: string): string;
/**
 * A deny-list as the set a per-model lookup needs, memoized per scope.
 *
 * The live config hands out a fresh array on every read, so the memo compares
 * by content: rebuilding the set per lookup would turn each model toggle into
 * a linear scan of the list. The scope is a login region for the providers
 * whose deny-list differs per region.
 */
export declare class DenyList<K extends string = string> {
    private readonly perScope;
    /** The current membership of `scope`'s list, rebuilt only when it changed. */
    of(scope: K, source: readonly string[]): ReadonlySet<string>;
}
/** One catalog entry, as every provider describes it to the harness. */
export interface ModelListItem {
    id: string;
    name: string;
    description?: string;
    vision?: boolean;
}
/**
 * One picker row. The three providers differ only in which field carries the
 * image capability (`vision`, `isVl`), so callers normalize that first.
 */
export declare function modelInfo(provider: string, model: ModelListItem): LlmModelInfo;
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
export declare function resolveImages(refs: readonly ImageAttachmentRef[], vision: boolean, readImage: ImageRequestReader | undefined, signal?: AbortSignal): Promise<ResolvedImages>;
/**
 * Images carried by the messages the inner session has not seen yet.
 *
 * Tool results are included: `read_image` hands its pixels back through the MCP
 * tool result, not through the prompt text, so this tail is the only place the
 * bytes can come from.
 */
export declare function resolveTurnImages(tail: readonly RequestMessage[], vision: boolean, readImage: ImageRequestReader | undefined, signal?: AbortSignal): Promise<ResolvedImages>;
/** How one provider wraps the two things a feed can carry. */
export interface VisionBlockSink<TBlock> {
    text(text: string): TBlock;
    image(data: string, mediaType: string): TBlock;
}
/**
 * Turn a feed into what one CLI turn receives, in a provider's block shape.
 *
 * A text-only feed stays a plain string (the historical shape). A feed with
 * readable images becomes a block list, because that is the only shape the
 * CLIs send to the model as pixels. An image the host could not read keeps its
 * handle text, so it degrades one part instead of failing the turn.
 */
export declare function buildVisionFeed<TBlock>(feed: Feed, vision: boolean, options: {
    imagePath?: ImagePathResolver;
    readImage?: ImageRequestReader;
    signal?: AbortSignal;
    blocks: VisionBlockSink<TBlock>;
}): Promise<string | TBlock[]>;
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
export declare function strongestEffort(efforts: readonly string[]): string | undefined;
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
export declare function reasoningInfo(efforts: readonly string[] | undefined, configuredEffort: string | undefined, isReasoning: boolean | undefined): LlmModelReasoningInfo | undefined;
interface ContinuationPlan {
    /** Feed for the inner session this turn, or null for a pure continuation. */
    feed: Feed | null;
    /** Whether the warm session must be rebuilt (history diverged past repair). */
    rebuild: boolean;
}
/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export declare function planContinuation(previous: readonly RequestMessage[], current: readonly RequestMessage[]): ContinuationPlan;
export {};
