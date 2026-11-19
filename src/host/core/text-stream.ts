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

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Characters per synthetic text delta. */
export const TEXT_CHUNK_SIZE = 192

/**
 * The coarse token split the side-channel path has always reported.
 *
 * The harness prices text at four characters per token; a side-channel answer
 * is short and never carries images, so that flat rate is deliberate here.
 */
export function approximateUsage(prompt: string, text: string): TokenUsage {
  return {
    inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
    outputTokens: Math.max(1, Math.ceil(text.length / 4)),
  }
}

/**
 * Replay finished text as the chunks of one text block.
 *
 * @param text - the answer to replay.
 * @param usage - the usage line to report with it.
 * @returns the block, delta, and usage chunks, in order.
 */
export function textStreamChunks(text: string, usage: TokenUsage): StreamChunk[] {
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let i = 0; i < text.length; i += TEXT_CHUNK_SIZE) {
    chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + TEXT_CHUNK_SIZE) })
  }
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  chunks.push({ type: 'usage', usage })
  return chunks
}
