/**
 * Warm Qoder sessions plus the cold side-channel path.
 *
 * This module owns the pool lifecycle (LRU cap, idle sweep, seal on unload) and
 * the one-shot turn used for titles and compaction summaries. The per-turn
 * session protocol lives in `session.ts`; keeping the registry and the cold
 * path here means `session.ts` describes one conversation, not the collection
 * around it.
 *
 * @module dsh-agent-sdk-bridge/qoder/manager
 */

import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CanUseTool } from '@qodercn-ai/qodercn-agent-sdk'
import type { CloseCause } from '../../core/lifecycle.ts'
import type { Live } from '../../core/live.ts'
import { readLive } from '../../core/live.ts'
import { DEFAULT_MAX_SESSIONS, SessionPool } from '../../core/session-pool.ts'
import { approximateUsage, textStreamChunks } from '../../core/text-stream.ts'
import { cliConflictMessage, foreignCliOverride, qoderCliOptions, resolveQoderCli } from '../../infra/cli.ts'
import { isDaemonConflict, loadSdk, resetSdk } from '../../infra/sdk.ts'
import type { SdkMessage, SessionRuntimeOptions } from './session.ts'
import { QoderSession, classifyTurnError, gateTools, safeErrors } from './session.ts'

/** Inner turns allowed for one side-channel (title, compaction) request. */
const DEFAULT_COLD_MAX_TURNS = 4

/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export class QoderSessionManager {
  private readonly pool: SessionPool<QoderSession>

  /**
   * @param maxSessions - warm-session cap; read per eviction so a settings edit
   *   applies to the next session that overflows the pool.
   * @param runtime - per-session knobs, resolved when each session is created.
   * @param create - builds one session; injectable so the pool's eviction and
   *   sealing rules are testable without spawning a CLI.
   * @param idleMs - how long an unused session may live; 0 disables the sweep.
   */
  constructor(
    maxSessions: Live<number> = DEFAULT_MAX_SESSIONS,
    private readonly runtime: SessionRuntimeOptions & { coldMaxTurns?: Live<number> } = {},
    private readonly create: (sessionId: string, model: string) => QoderSession =
      (sessionId, model) => new QoderSession(sessionId, model, runtime),
    idleMs?: Live<number>,
  ) {
    this.pool = new SessionPool<QoderSession>({ label: 'qoder', maxSessions, idleMs })
  }

  /** Existing or fresh warm session for one host session id. */
  forSession(sessionId: string, model: string): QoderSession {
    return this.pool.forSession(sessionId, id => this.create(id, model))
  }

  /** Drop one session (history diverged); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    this.pool.dispose(sessionId)
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
    this.pool.closeAll(cause)
  }

  /**
   * Drop every warm session and refuse to create more.
   *
   * Called from the plugin's dispose effect. `closeAll` alone was not enough:
   * a retry of a step prepared before the unload would reach this manager and
   * spawn a fresh subprocess that nothing owns afterwards.
   */
  seal(cause: CloseCause = 'dispose'): void {
    this.pool.seal(cause)
  }

  /** One-shot turn with no warm state: side channels and cold rebuilds. */
  async *coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk> {
    const systemPrompt = options.system
    const brand = this.runtime.brand ?? 'cn'
    const conflict = foreignCliOverride(brand)
    if (conflict !== undefined) throw new Error(cliConflictMessage(brand))
    if (resolveQoderCli(brand) === undefined) throw new Error(cliConflictMessage(brand))
    const sdk = await loadSdk(brand)
    const q = sdk.query({
      prompt,
      options: {
        ...qoderCliOptions(brand),
        auth: sdk.qodercliAuth(),
        tools: [],
        allowedTools: [],
        canUseTool: gateTools as CanUseTool,
        settingSources: [],
        maxTurns: readLive(this.runtime.coldMaxTurns, DEFAULT_COLD_MAX_TURNS),
        ...systemPrompt === undefined ? {} : { systemPrompt },
        ...model === undefined ? {} : { model },
      },
    })
    const signal = options.signal
    const onAbort = (): void => { void q.interrupt().catch(() => undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let text = ''
      let failure: { message: string, code: string } | undefined
      try {
        for await (const message of q) {
          const msg = message as SdkMessage
          if (msg.type === 'assistant') {
            const chunk = (msg.message?.content ?? [])
              .filter(block => block.type === 'text')
              .map(block => block.text ?? '')
              .join('')
            if (chunk.length > 0) text += chunk
          } else if (msg.type === 'result' && msg.subtype !== 'success' && msg.subtype !== undefined) {
            const detail = `${msg.subtype} ${safeErrors(msg.errors)}`
            failure = { message: `qoder side-channel turn failed: ${detail}`, code: classifyTurnError(detail) }
          }
        }
      } catch (error) {
        // Abandoning this loop on a host abort runs the iterator's return(),
        // whose close chain rejects once the child process is already gone;
        // that is the abort, not a transport failure.
        if (signal?.aborted !== true) {
          // Same poisoning as the warm path: drop the instance so the next
          // request starts a daemon that matches the current configuration.
          if (isDaemonConflict(error)) resetSdk(brand)
          throw error
        }
      }
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } }
        return
      }
      // A turn that failed after producing partial text is still a failure:
      // reporting it as a stop would hand the harness a truncated summary and
      // swallow the very overflow the caller needs to recover from.
      if (failure !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      if (text.length === 0) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'qoder side-channel returned no content', code: EMPTY_RESPONSE_CODE } },
        }
        return
      }
      for (const chunk of textStreamChunks(text, approximateUsage(prompt, text))) yield chunk
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await q.close().catch(() => undefined)
    }
  }
}
