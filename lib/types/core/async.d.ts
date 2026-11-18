/**
 * The two async primitives every backend needs: a prompt that never yields, and
 * a deadline on one control round trip.
 *
 * Both are shape-of-the-wire concerns rather than provider ones. A "closed"
 * prompt is how a query is opened just to run a control request — reading the
 * account, the catalog or the quota — without letting a model turn start, and
 * every SDK here accepts a streaming prompt instead of a string, so the closed
 * generator is the only thing that keeps such a query from answering. The
 * deadline is the same idea in the other direction: a control request that never
 * settles must not strand a settings read or a session start.
 *
 * They live in `core` because all three backends use them verbatim; the copies
 * they replace had already drifted apart in wording while behaving identically.
 *
 * @module dsh-agent-sdk-bridge/core/async
 */
/**
 * A prompt that produces nothing and never ends.
 *
 * The SDKs read a stream of input turns; handing them this one keeps the query
 * alive and idle, so a control request (`getUsageInfo`, `getAvailableModels`,
 * `accountInfo`) can be answered without any turn ever being requested.
 */
export declare function inertInput(): AsyncGenerator<never>;
/**
 * Settle with `promise`, or reject once `ms` elapse.
 *
 * @param promise - the round trip to bound.
 * @param ms - how long it may take.
 * @param label - what the caller was doing, for the timeout message.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T>;
