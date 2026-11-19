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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CloseCause } from '../../core/lifecycle.ts';
import type { Live } from '../../core/live.ts';
import type { SessionRuntimeOptions } from './session.ts';
import { QoderSession } from './session.ts';
/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export declare class QoderSessionManager {
    private readonly runtime;
    private readonly create;
    private readonly pool;
    /**
     * @param maxSessions - warm-session cap; read per eviction so a settings edit
     *   applies to the next session that overflows the pool.
     * @param runtime - per-session knobs, resolved when each session is created.
     * @param create - builds one session; injectable so the pool's eviction and
     *   sealing rules are testable without spawning a CLI.
     * @param idleMs - how long an unused session may live; 0 disables the sweep.
     */
    constructor(maxSessions?: Live<number>, runtime?: SessionRuntimeOptions & {
        coldMaxTurns?: Live<number>;
    }, create?: (sessionId: string, model: string) => QoderSession, idleMs?: Live<number>);
    /** Existing or fresh warm session for one host session id. */
    forSession(sessionId: string, model: string): QoderSession;
    /** Drop one session (history diverged); the next request rebuilds it cold. */
    dispose(sessionId: string): void;
    /**
     * Drop every warm session, keeping the pool usable.
     *
     * For a credential change: the processes loaded the old account, and the
     * conversations are over, but the adapter keeps serving new ones.
     *
     * @param cause - why the sessions go; decides how interrupted turns report.
     */
    closeAll(cause?: CloseCause): void;
    /**
     * Drop every warm session and refuse to create more.
     *
     * Called from the plugin's dispose effect. `closeAll` alone was not enough:
     * a retry of a step prepared before the unload would reach this manager and
     * spawn a fresh subprocess that nothing owns afterwards.
     */
    seal(cause?: CloseCause): void;
    /** One-shot turn with no warm state: side channels and cold rebuilds. */
    coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk>;
}
