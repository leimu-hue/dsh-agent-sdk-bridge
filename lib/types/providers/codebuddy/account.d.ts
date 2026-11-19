/**
 * CodeBuddy's account, quota and browser login.
 *
 * These reads and the login flow all speak HTTP/SDK calls that are unrelated to
 * a conversation: the account card, the persisted credential, the billing
 * endpoint, and the browser round trip. Keeping them out of `session.ts` means
 * the session module describes one turn, not the account behind it.
 *
 * @module dsh-agent-sdk-bridge/codebuddy/account
 */
import type { CodeBuddyRegion } from '../../core/brand.ts';
import type { Live } from '../../core/live.ts';
/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
    uid?: string;
    userId?: string;
    userName?: string;
    email?: string;
    organization?: string;
    subscriptionType?: string;
}
/** One credit package inside a CodeBuddy quota reading. */
export interface CodeBuddyQuotaPackage {
    name: string;
    total: number;
    used: number;
    /** Epoch milliseconds, when the package expires. */
    end?: number;
}
/** Account credits, read from CodeBuddy's billing endpoint. */
export interface CodeBuddyQuota {
    remaining: number;
    total: number;
    used: number;
    /** Earliest still-valid package expiry, in epoch milliseconds. */
    cycleEnd?: number;
    packages: CodeBuddyQuotaPackage[];
}
/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
    at: number;
    account?: CodeBuddyAccount;
    quota?: CodeBuddyQuota;
    /** Why the quota lookup failed, when the account itself was readable. */
    quotaError?: string;
    error?: string;
}
/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
    running: boolean;
    region: CodeBuddyRegion;
    startedAt?: number;
    finishedAt?: number;
    /** Browser URL, once the CLI hands one over. */
    url?: string;
    user?: {
        userId: string;
        userName: string;
        userNickname: string;
    };
    /** Whether a usable credential is available for this region. */
    signedIn?: boolean;
    error?: string;
}
/** Read the signed-in account once and reuse it until a login or region change. */
export declare class CodeBuddyAccountReader {
    private readonly region;
    private readonly timeoutMs;
    private readonly cached;
    private readonly inflight;
    constructor(region: Live<CodeBuddyRegion>, timeoutMs?: Live<number>);
    /**
     * The account for one region.
     *
     * A non-fresh read answers from the persisted snapshot first, so switching
     * the region selector paints immediately; the page follows with `fresh=1`
     * to replace it with a live CLI reading.
     */
    read(fresh?: boolean, requested?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot>;
    invalidate(region?: CodeBuddyRegion): void;
    private fetch;
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
export declare function authErrorText(region: CodeBuddyRegion, error: unknown): string;
/**
 * The account's credits, read from CodeBuddy's billing endpoint.
 *
 * The SDK exposes no quota call, but the CLI's own account page uses
 * `POST /v2/billing/meter/get-user-resource` on the same host. The response is
 * a list of independently expiring credit packages; `CycleCapacity*Precise`
 * is the live balance, while the top-level `TotalDosage` is a stale
 * period-scoped figure and is deliberately ignored.
 *
 * @param payload - the endpoint's JSON answer.
 */
export declare function parseCodeBuddyQuota(payload: unknown): CodeBuddyQuota;
/** Query the billing endpoint once. */
export declare function fetchCodeBuddyQuota(region: CodeBuddyRegion, token: string, fetchImpl?: typeof fetch): Promise<CodeBuddyQuota>;
/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export declare class CodeBuddyAuth {
    private readonly runs;
    /** Start a login; refuses while the same region is already logging in. */
    start(region: CodeBuddyRegion, onFinish?: (ok: boolean) => void): {
        started: true;
    } | {
        started: false;
        error: string;
    };
    status(region: CodeBuddyRegion): CodeBuddyAuthStatus;
    /** Clear the cached credential for one region. */
    logout(region: CodeBuddyRegion): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    /** False once this run was replaced or cancelled by logout. */
    private current;
    private login;
}
/** One tool-use block under assembly in the active turn. */
