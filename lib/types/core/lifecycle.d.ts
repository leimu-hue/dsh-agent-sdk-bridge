/**
 * Why a warm inner session stopped serving, and how its in-flight turn ends.
 *
 * The plugin owns the CLI subprocess behind every conversation, so a session is
 * closed for reasons that have nothing to do with the provider: the plugin is
 * reloaded, the pool evicts it, an account changes. All of those make the SDK's
 * message iterator return `done`, which used to be reported as
 * `STREAM_CLOSED` — indistinguishable from a real upstream disconnect, and
 * shown to the user as a dropped connection.
 *
 * The cause is recorded before teardown, so the consumer can tell the two apart
 * and end the turn as `aborted` (the framework's own "not a failure" channel)
 * instead of as an error.
 *
 * `dsh-llm` normalizes a failure whose code is `ABORTED` into
 * `{ kind: 'aborted' }`, and its default retry policy does not retry that code
 * (`@deepseek-ai/dsh-llm` → `retry-policy`), so a reload cannot turn into five
 * automatic re-dispatches that each refeed the whole history.
 *
 * @module dsh-agent-sdk-bridge/lifecycle
 */
import type { FinishReason } from '@deepseek-ai/dsh-llm';
/** Who asked a session to stop serving. */
export type CloseCause = 
/** The plugin was unloaded or reloaded; a later request rebuilds cold. */
'dispose'
/** The pool needed the slot for another conversation. */
 | 'evicted'
/** The session sat unused past its idle TTL. */
 | 'idle'
/** A login, logout or account switch replaced the credentials. */
 | 'account'
/** The CodeBuddy login region changed. */
 | 'region'
/** The host history diverged, so the session cannot continue it. */
 | 'rebuild';
/**
 * How long an in-flight turn may keep running after its session was asked to
 * close.
 *
 * A turn is normally one model response, but an agentic turn can run for
 * minutes and its chunks are still being consumed by the harness: killing the
 * subprocess truncates an answer that only needed to finish. Draining is
 * therefore the default, bounded so an unloaded plugin cannot leave a
 * subprocess behind forever.
 */
export declare const DEFAULT_DRAIN_MS = 120000;
/** How long a warm session may sit unused before the pool reclaims it. */
export declare const DEFAULT_SESSION_IDLE_MS = 600000;
/**
 * The finish reason for a turn interrupted by a session close.
 *
 * `aborted` rather than `error`: the provider did not fail, the host moved the
 * session out from under the turn. `ABORTED` is the code `dsh-llm` itself maps
 * to that kind, and it is outside the framework's default retryable set.
 *
 * @param cause - why the session closed.
 * @returns the terminal reason the interrupted turn ends with.
 */
export declare function closeFinishReason(cause: CloseCause): FinishReason;
/**
 * The part of a session the pool manipulates.
 *
 * Structural so the pool can be tested with a stub, and so both providers'
 * sessions satisfy it without a shared base class.
 */
export interface PoolSession {
    readonly sessionId: string;
    /** Whether a turn is in flight and must not be interrupted. */
    readonly busy: boolean;
    /** Request a close; `cause` decides how an in-flight turn is reported. */
    close(cause?: CloseCause): void;
}
/**
 * Deferred-close state machine for one session.
 *
 * Two decisions live here rather than in each provider's session class: whether
 * a close can wait for the in-flight turn, and when it must stop waiting. Both
 * backends need exactly the same rules, and this is the only part of the
 * teardown that is worth testing on its own.
 *
 * Contract: {@link request} is idempotent; {@link settled} is how the session
 * reports that its turn finished and the deferred teardown may run; and once
 * {@link cause} is set the session accepts no new turn.
 */
export declare class CloseGate {
    private readonly drainMs;
    private readonly onTeardown;
    private readonly onForce?;
    private requested;
    private timer;
    /** Whether a turn is being allowed to finish before the teardown runs. */
    private draining;
    private torn;
    /**
     * @param drainMs - read per close, so a settings edit applies to the next one.
     * @param onTeardown - tears the subprocess down; must be safe to call once.
     * @param onForce - called when the drain window expired with the turn still
     *   running, so the session can end that turn before the subprocess dies.
     */
    constructor(drainMs: () => number, onTeardown: () => void, onForce?: ((cause: CloseCause) => void) | undefined);
    /** The cause, once a close has been requested; undefined while serving. */
    get cause(): CloseCause | undefined;
    /** Whether this session has been asked to stop (new turns must be refused). */
    get closing(): boolean;
    /**
     * Ask this session to stop.
     *
     * @param cause - why it is closing, remembered for the turn's finish reason.
     * @param busy - whether a turn is in flight right now.
     * @returns `'closed'` when teardown already ran, `'draining'` when it waits.
     */
    request(cause: CloseCause, busy: boolean): 'closed' | 'draining';
    /**
     * Report that the in-flight turn settled.
     *
     * Called from the turn's own `finally`, which is also reached when the host
     * cancels its stream, so a drain never outlives its turn.
     */
    settled(): void;
    private teardown;
}
/** Node timers hold the process open unless they are unref'd. */
export declare function unrefTimer(timer: ReturnType<typeof setTimeout>): void;
