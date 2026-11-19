/**
 * The settings pages' view of a provider, independent of which SDK serves it.
 *
 * The pages ask three questions — which models does the account advertise, what
 * does the quota/account reading say, and (CodeBuddy only) how is login going —
 * and the answers are shaped the same way for every brand. That is the seam the
 * HTTP surface talks through: `handleApi` never sees a `QoderAdapter` or a
 * `CodeBuddyAdapter`, never casts between them, and never branches on a brand
 * name. Each adapter's own quirks (CodeBuddy reads a catalog only while signed
 * in; a Qoder edition has no login route) are expressed once, in the factory
 * that wraps it.
 *
 * @module dsh-agent-sdk-bridge/surface/settings-source
 */
import type { BrandId, CodeBuddyRegion } from '../core/brand.ts';
import type { CodeBuddyAdapter } from '../providers/codebuddy/adapter.ts';
import type { QoderAdapter } from '../providers/qoder/adapter.ts';
/** One model row as a settings page renders it. */
export interface ModelRow {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    vision: boolean;
    contextWindow: number;
    contextWindows: number[];
    defaultContextWindow: number;
    override?: number;
    priceFactor?: number;
    reasoning: boolean;
    /**
     * Whether the provider accepts a context-budget choice for this model.
     *
     * Absent (Qoder) means the ordinary menu applies. `false` means the
     * window is fixed upstream, so the page shows the value without a selector.
     */
    contextWindowSelectable?: boolean;
}
/** What the page asked for: a refresh flag and, where it applies, a login region. */
export interface ModelQuery {
    /** Bypass the adapter's catalog cache before reading. */
    fresh: boolean;
    /** CodeBuddy login region; ignored by providers without one. */
    region?: CodeBuddyRegion;
}
/** One catalog page, plus the state the page needs to interpret it. */
export interface ModelPage {
    rows: ModelRow[];
    /** Why an empty list is empty, when the adapter has something to say. */
    notice?: string;
    /** CodeBuddy only: whether the selected region has a stored login. */
    signedIn?: boolean;
}
/** The login operations a provider with a browser flow exposes. */
export interface AuthFace {
    status(region: CodeBuddyRegion): unknown;
    login(region: CodeBuddyRegion): {
        started: boolean;
        error?: string;
    };
    logout(region: CodeBuddyRegion): Promise<{
        ok: boolean;
        error?: string;
    }>;
}
/** One brand as the HTTP surface uses it. */
export interface SettingsSource {
    /** Whether the plugin config currently switches this brand on. */
    enabled(): boolean;
    /** Whether the brand accepts the `region` query/body parameter. */
    readonly regionAware: boolean;
    models(query: ModelQuery): Promise<ModelPage>;
    usage(query: ModelQuery): Promise<Record<string, unknown>>;
    /** Present only for a provider with a browser login flow. */
    readonly auth?: AuthFace;
}
/** Every route's source, keyed by the brand the page names. */
export type SettingsSources = Readonly<Record<BrandId, SettingsSource>>;
/** The settings source for one Qoder edition. */
export declare function qoderSettings(adapter: QoderAdapter, enabled?: () => boolean): SettingsSource;
/** The settings source for CodeBuddy, including its browser login flow. */
export declare function codeBuddySettings(adapter: CodeBuddyAdapter, enabled?: () => boolean): SettingsSource;
