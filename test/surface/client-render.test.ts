/**
 * The pages, rendered once outside a browser.
 *
 * The bundle test loads the built file and checks its pure helpers; this one
 * renders the components themselves through `react-dom`, with the host's
 * services stubbed. It exists to catch the class of mistake a bundle test
 * cannot see — a hook destructured from nothing, a label pointing at an id
 * that is never minted, a control that reads state the host never supplies.
 *
 * Nothing here runs an effect: `renderToStaticMarkup` paints the first frame
 * only, which is exactly the frame a user sees while the host is still
 * answering.
 *
 * @module dsh-agent-sdk-bridge/test/client-render
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeCache } from '../../src/client/api.ts'
import { BRANDS } from '../../src/client/brands.ts'
import { BundleSettings } from '../../src/client/components/bundle-settings.tsx'
import { CodeBuddyCard } from '../../src/client/components/codebuddy-card.tsx'
import { MinimaxCard } from '../../src/client/components/minimax-card.tsx'
import { SettingsPage } from '../../src/client/components/settings-page.tsx'
import { UsageCard } from '../../src/client/components/usage-card.tsx'
import { zh } from '../../src/client/copy.ts'
import type { ConfigSnapshot, PluginContext, Translate } from '../../src/client/types.ts'

/** The bundled Chinese copy, addressed the way the host's translator is. */
const t = ((key: string) => {
  const value = (zh as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : key
}) as Translate

function snapshot(value: Record<string, unknown> = {}): ConfigSnapshot {
  return { status: 'ready', writable: true, user: null, value }
}

/** A host context that answers immediately and never notifies. */
function makeCtx(value: Record<string, unknown> = {}): PluginContext {
  const held = snapshot(value)
  const form = {
    subscribe: () => () => undefined,
    getSnapshot: () => held,
    set: async () => true,
    unset: async () => true,
  }
  return {
    configForms: {
      get: () => form,
      describe: () => ({
        subscribe: () => () => undefined,
        getSnapshot: () => ({ view: { namespaces: [] } }),
        ensure: async () => undefined,
      }),
      whileServed: (_namespaces, run) => run(),
    },
    slots: {
      inject: (_name, run) => run(),
      register: () => () => undefined,
    },
    locale: {
      register: () => () => undefined,
      bind: () => t,
    },
    effect: () => undefined,
  }
}

function render(component: unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(component as never, props as never))
}

const CN = BRANDS[0]!
const CODEBUDDY = BRANDS[2]!
const MINIMAX = BRANDS[3]!

beforeEach(() => {
  // Each case seeds only what it asserts on; the cache is module-scoped.
  writeCache('cn', 'models', undefined)
  writeCache('cn', 'usage', undefined)
})

describe('model list page', () => {
  it('renders the catalog with usable controls and no label drift', () => {
    writeCache('cn', 'models', {
      rows: [
        {
          id: 'qwen-max', name: 'Qwen Max', enabled: true, vision: true, priceFactor: 1.5,
          contextWindows: [128_000, 200_000], defaultContextWindow: 128_000, contextWindowSelectable: true,
        },
        {
          id: 'pinned', name: 'Pinned', enabled: false,
          contextWindows: [64_000], defaultContextWindow: 64_000, contextWindowSelectable: false,
        },
      ],
      signedIn: true,
    })
    const html = render(SettingsPage, { ctx: makeCtx({ cnEnabled: true }), t, brand: CN })

    expect(html).toContain('Qwen Max')
    expect(html).toContain('已启用 1 / 2')
    // A window the provider pins has no selector, and says so.
    expect(html).toContain('上游固定')
    // Every checkbox is named by a label that exists in the same document.
    const checkboxId = /id="(dssb-model-cn-0)"/.exec(html)?.[1]
    expect(checkboxId).toBeDefined()
    expect(html).toContain(`for="${checkboxId}"`)
    // The model id is a code token, not prose a translator may rewrite.
    expect(html).toContain('translate="no"')
    // The search field is labelled, and is a search field.
    expect(html).toContain('type="search"')
    expect(html).toContain('dssb-visually-hidden')
  })

  it('keeps the region select on a labelled row for the regional providers', () => {
    const html = render(SettingsPage, { ctx: makeCtx({ minimaxRegion: 'cn' }), t, brand: MINIMAX })
    // Signed out: the page shows the account card and the reason, not a table.
    expect(html).toContain('登录区域')
    expect(html).toContain('请先安装并登录 MiniMax Code')
  })
})

describe('account cards', () => {
  it('draws a quota meter that assistive technology can read', () => {
    writeCache('cn', 'usage', {
      usage: {
        userQuota: { used: 10, total: 100, unit: 'credits' },
        isQuotaExceeded: false,
        expiresAt: 253_402_300_799_000,
      },
      account: { name: 'dev', subscriptionType: 'Pro' },
      at: 1_800_000_000_000,
    })
    const html = render(UsageCard, { t, brand: CN, refreshSignal: 0, resetSignal: 0 })
    expect(html).toContain('Pro')
    expect(html).toContain('10 / 100')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="10"')
    // The year-9999 sentinel reads as "no expiry", never as a date.
    expect(html).toContain('长期有效')
  })

  it('offers the sign-in path before a region has an account', () => {
    const ctx = makeCtx({ codebuddyRegion: 'global' })
    const html = render(CodeBuddyCard, { t, ctx, brand: CODEBUDDY, refreshSignal: 0 })
    expect(html).toContain('codebuddy.ai')
    expect(html).toContain('登录')
  })

  it('renders a signed-in MiniMax account with its quota windows', () => {
    writeCache('minimax', 'snapshot:cn', {
      auth: { signedIn: true, running: false, region: 'cn' },
      usage: {
        installed: true,
        signedIn: true,
        plan: { kind: 'token-plan', name: 'Token Plan 5h' },
        credits: { remaining: 42 },
        windows: [{ id: 'w1', label: '5 小时', remainingPercent: 80, resetAt: 1_800_000_000_000 }],
      },
    })
    const ctx = makeCtx({ minimaxRegion: 'cn' })
    const html = render(MinimaxCard, { t, ctx, brand: MINIMAX, refreshSignal: 0 })
    expect(html).toContain('Token Plan 5h')
    expect(html).toContain('42')
    expect(html).toContain('role="progressbar"')
  })
})

describe('edition switches', () => {
  it('renders one labelled switch per edition', () => {
    const html = render(BundleSettings, { ctx: makeCtx({ cnEnabled: true }), t, view: 'page' })
    expect(html).toContain('启用的版本')
    expect(html.match(/type="checkbox"/g)?.length).toBe(BRANDS.length)
    expect(html.match(/<label/g)?.length).toBe(BRANDS.length)
  })

  it('summarizes the enabled editions in one line', () => {
    const html = render(BundleSettings, {
      ctx: makeCtx({ cnEnabled: true, intlEnabled: false }),
      t,
      view: 'toolbar',
    })
    expect(html).toBe('<span>Qoder CN · CodeBuddy · MiniMax Code</span>')
  })
})
