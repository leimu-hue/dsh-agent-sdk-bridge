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
import type { LlmModelReasoningInfo, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Feed } from './render.ts';
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
