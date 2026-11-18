/**
 * The page's look: layout inline, states in one injected stylesheet.
 *
 * Colour comes from the shell's theme variables, so the page survives a scheme
 * switch and inherits whatever brand the deployment uses. Layout stays as
 * inline style objects — it is per-element and never needs a media query —
 * while everything the guidelines care about and inline styles cannot express
 * lives in {@link installStyles}: hover, `:focus-visible`, disabled, reduced
 * motion, tap behaviour, and `content-visibility` for the long model list.
 *
 * The sheet is installed once, from `apply()`, never at module scope: the
 * shell evaluates this bundle in contexts that have no document, and a
 * top-level `document.head` write would break them.
 *
 * @module dsh-agent-sdk-bridge/client/styles
 */

import type { CSSProperties } from 'react'

/** Selectors the stylesheet owns; components reference them by class name. */
export const CLASS = {
  page: 'dssb-page',
  button: 'dssb-btn',
  buttonAlert: 'dssb-btn-alert',
  input: 'dssb-input',
  select: 'dssb-select',
  link: 'dssb-link',
  check: 'dssb-check',
  hit: 'dssb-hit',
  row: 'dssb-row',
  meter: 'dssb-meter',
  meterFill: 'dssb-meter-fill',
  log: 'dssb-log',
  packToggle: 'dssb-pack-toggle',
  visuallyHidden: 'dssb-visually-hidden',
  tabular: 'dssb-tabular',
  breakable: 'dssb-breakable',
} as const

/** Everything the inline style objects carry. */
export const css = {
  page: { maxWidth: '860px', display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary, CanvasText)' },
  h2: { margin: '0', fontSize: '1.25em' },
  intro: { margin: '0', opacity: 0.78, lineHeight: 1.55, fontSize: '0.92em' },
  bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  btn: { padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '0.88em' },
  input: { padding: '6px 10px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', font: 'inherit', fontSize: '0.88em' },
  search: { flex: '1 1 180px', minWidth: '140px' },
  count: { fontSize: '0.85em', opacity: 0.72, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' },
  list: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', overflow: 'hidden' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
  rowFirst: { borderTop: 'none' },
  rowOff: { opacity: 0.62 },
  name: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  nameText: { fontSize: '0.92em', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  id: { fontSize: '0.76em', opacity: 0.62, fontFamily: 'ui-monospace, monospace' },
  tag: { fontSize: '0.72em', padding: '1px 6px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', opacity: 0.8 },
  price: { fontSize: '0.9em', opacity: 0.72, fontWeight: 400 },
  select: { padding: '5px 8px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))', background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', font: 'inherit', fontSize: '0.85em', minWidth: '104px' },
  switch: { width: '17px', height: '17px', margin: 0, accentColor: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
  note: { fontSize: '0.82em', opacity: 0.68, lineHeight: 1.5 },
  err: { fontSize: '0.86em', color: 'var(--dsw-alias-label-danger, #e03131)' },
  guide: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--dsw-alias-label-danger, #e03131)', background: 'rgba(224,49,49,0.07)' },
  guideText: { flex: '1 1 240px', fontSize: '0.88em', lineHeight: 1.5, color: 'var(--dsw-alias-label-danger, #e03131)' },
  btnAlert: { border: '1px solid var(--dsw-alias-label-danger, #e03131)', color: 'var(--dsw-alias-label-danger, #e03131)' },
  group: { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', borderRadius: '10px', padding: '14px 16px' },
  advLabel: { fontSize: '0.88em' },
  h3: { margin: 0, fontSize: '0.95em' },
  log: { margin: '0', maxHeight: '240px', overflowY: 'auto', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-base, rgba(128,128,128,0.05))', fontFamily: 'ui-monospace, monospace', fontSize: '0.76em', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  usageCard: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', background: 'var(--dsw-alias-bg-base, rgba(128,128,128,0.03))' },
  usageHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
  progressOuter: { height: '8px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))', overflow: 'hidden' },
  progressInner: { height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
  progressDanger: { background: 'var(--dsw-alias-label-danger, #e03131)' },
  creditStack: { display: 'flex', flexDirection: 'column', gap: '14px' },
  creditMeter: { display: 'flex', flexDirection: 'column', gap: '6px' },
  creditName: { fontSize: '0.8em', opacity: 0.62 },
  creditRow: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', fontSize: '0.9em' },
  creditLabel: { opacity: 0.68, minWidth: '56px' },
  creditAmount: { fontWeight: 600, fontSize: '1.04em', fontVariantNumeric: 'tabular-nums' },
  creditPct: { marginLeft: 'auto', opacity: 0.68, fontVariantNumeric: 'tabular-nums' },
  creditBar: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))', overflow: 'hidden' },
  creditBarFill: { height: '100%', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
  usageLine: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '0.86em' },
  usageLabel: { opacity: 0.68, minWidth: '72px' },
  usageValue: { fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' },
  link: { color: 'var(--dsw-alias-brand-primary, #4c6ef5)', textDecoration: 'none', fontSize: '0.86em' },
  usageFoot: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '0.8em', opacity: 0.68 },
  packBlock: { display: 'flex', flexDirection: 'column', gap: '6px' },
  packHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '0.86em' },
  packToggle: { marginLeft: 'auto', background: 'none', border: 'none', padding: '2px 0', font: 'inherit', fontSize: '0.8em', color: 'var(--dsw-alias-brand-primary, #4c6ef5)' },
  packList: { display: 'flex', flexDirection: 'column', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', overflow: 'hidden' },
  packListScroll: { maxHeight: '190px', overflowY: 'auto' },
  packRow: { display: 'grid', gridTemplateColumns: 'minmax(90px, 1.5fr) auto auto', alignItems: 'baseline', gap: '10px', padding: '6px 10px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))', fontSize: '0.82em' },
  packFirst: { borderTop: 'none' },
  packLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  packAmount: { fontFamily: 'ui-monospace, monospace', textAlign: 'right' as const, whiteSpace: 'nowrap' as const },
  packExpiry: { opacity: 0.68, whiteSpace: 'nowrap' as const, fontSize: '0.92em' },
  optionRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))' },
  optionFirst: { borderTop: 'none', paddingTop: 0 },
  optionText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  optionName: { fontSize: '0.92em', fontWeight: 500, overflowWrap: 'anywhere' as const },
  optionStatus: { fontSize: '0.82em', opacity: 0.68 },
  /** One control cluster that keeps its buttons together on a narrow panel. */
  actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
} satisfies Record<string, CSSProperties>

const STYLE_ID = 'dsh-agent-sdk-bridge/styles'

const RULES = `
.dssb-page { overscroll-behavior: contain; }
.dssb-btn { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease; }
.dssb-btn:hover:not(:disabled) { background-color: var(--dsw-alias-bg-hover, rgba(128,128,128,0.14)); }
.dssb-btn:active:not(:disabled) { background-color: var(--dsw-alias-bg-active, rgba(128,128,128,0.22)); }
.dssb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c6ef5); outline-offset: 2px; }
.dssb-btn:disabled { opacity: .45; cursor: not-allowed; }
.dssb-btn-alert { border-color: var(--dsw-alias-label-danger, #e03131); color: var(--dsw-alias-label-danger, #e03131); }
.dssb-input:focus-visible, .dssb-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c6ef5); outline-offset: 1px; }
.dssb-input:disabled, .dssb-select:disabled { opacity: .55; }
.dssb-link { text-decoration: none; }
.dssb-link:hover { text-decoration: underline; }
.dssb-link:focus-visible, .dssb-pack-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c6ef5); outline-offset: 2px; border-radius: 4px; }
.dssb-pack-toggle { cursor: pointer; touch-action: manipulation; }
.dssb-pack-toggle:hover { text-decoration: underline; }
.dssb-check { cursor: pointer; touch-action: manipulation; }
.dssb-check:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4c6ef5); outline-offset: 2px; }
.dssb-hit { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; border-radius: 6px; }
.dssb-hit:hover { background-color: rgba(128,128,128,0.08); }
/* The catalog can run to hundreds of rows: keep the paint cost near the viewport. */
.dssb-row { content-visibility: auto; contain-intrinsic-size: auto 58px; }
.dssb-meter-fill { transition: width .25s ease; }
.dssb-log { overscroll-behavior: contain; }
.dssb-tabular { font-variant-numeric: tabular-nums; }
.dssb-breakable { overflow-wrap: anywhere; min-width: 0; }
.dssb-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  .dssb-btn, .dssb-meter-fill { transition: none; }
}
`

/**
 * Install the state styles once, before the first render.
 *
 * Kept out of module scope so the bundle stays evaluable without a document,
 * and idempotent so a reloaded plugin does not stack sheets.
 */
export function installStyles(): void {
  try {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID) !== null) return
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = RULES
    document.head.appendChild(element)
  } catch {
    /* a shell with an unwritable head keeps the inline layout and default states */
  }
}
