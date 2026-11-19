/**
 * The chunk sequence for a side-channel answer, shared by both backends.
 *
 * Titles and compaction summaries do not stream from the inner CLI in a shape
 * the harness can consume directly, so each backend replays the finished text
 * as one synthetic text block. That replay — block start, 192-character
 * deltas, block end, usage — was identical in both providers, and a change to
 * the delta size or the usage estimate had to be made twice.
 *
 * @module dsh-agent-sdk-bridge/core/text-stream
 */
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
/** Characters per synthetic text delta. */
export declare const TEXT_CHUNK_SIZE = 192;
/**
 * The coarse token split the side-channel path has always reported.
 *
 * The harness prices text at four characters per token; a side-channel answer
 * is short and never carries images, so that flat rate is deliberate here.
 */
export declare function approximateUsage(prompt: string, text: string): TokenUsage;
/**
 * Replay finished text as the chunks of one text block.
 *
 * @param text - the answer to replay.
 * @param usage - the usage line to report with it.
 * @returns the block, delta, and usage chunks, in order.
 */
export declare function textStreamChunks(text: string, usage: TokenUsage): StreamChunk[];
