window.__ModuleLoader__.load({
	id: "dsh-agent-sdk-bridge",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/brands.ts
		/** One settings section per provider. */
		const BRANDS = [
			{
				id: "cn",
				kind: "qoder",
				settingsId: "qoder-cn",
				order: 36,
				titleKey: "title",
				navKey: "nav",
				introKey: "intro",
				noModelsKey: "noModels",
				cliGroupKey: "cliGroup",
				cliHintKey: "cliHint",
				fields: {
					enabled: "cnEnabled",
					disabled: "disabledModels",
					windows: "modelContextWindows"
				}
			},
			{
				id: "global",
				kind: "qoder",
				settingsId: "qoder-intl",
				order: 37,
				titleKey: "intlTitle",
				navKey: "intlNav",
				introKey: "intlIntro",
				noModelsKey: "intlNoModels",
				cliGroupKey: "intlCliGroup",
				cliHintKey: "intlCliHint",
				fields: {
					enabled: "intlEnabled",
					disabled: "intlDisabledModels",
					windows: "intlModelContextWindows"
				}
			},
			{
				id: "codebuddy",
				kind: "codebuddy",
				settingsId: "codebuddy",
				order: 38,
				titleKey: "codebuddyTitle",
				navKey: "codebuddyNav",
				introKey: "codebuddyIntro",
				noModelsKey: "codebuddyNoModels",
				fields: {
					enabled: "codebuddyEnabled",
					disabled: "codebuddyGlobalDisabledModels",
					windows: "codebuddyGlobalModelContextWindows"
				}
			}
		];
		/**
		* Scalars shown under Advanced, in order, with the control each one gets.
		*
		* The host's schema stays the source of truth for labels, help text and bounds;
		* this list only decides order and which control to render.
		*/
		const ADVANCED = {
			cn: [
				["displayName", "text"],
				["maxSessions", "number"],
				["modelCacheTtlSeconds", "number"],
				["defaultReasoningEffort", "text"],
				["defaultMaxTokens", "number"],
				["toolResultTimeoutSeconds", "number"],
				["catalogFetchTimeoutSeconds", "number"],
				["abortGraceSeconds", "number"],
				["coldMaxTurns", "number"],
				["modelAliases", "json"]
			],
			global: [["intlDisplayName", "text"], ["intlModelAliases", "json"]],
			codebuddy: [["codebuddyDisplayName", "text"], ["codebuddyModelAliases", "json"]]
		};
		//#endregion
		//#region src/client/api.ts
		/**
		* Talking to the host's settings API, and remembering the last answers.
		*
		* The page cannot read the model catalog from the config form — the catalog is
		* fetched live from the provider, while the form only carries what the user
		* stored. So the host answers JSON routes under {@link apiBase}, and every
		* change goes back through the host's own revision-fenced config form rather
		* than through a write route here.
		*
		* The cache is deliberately stale-while-revalidate: reopening a settings page
		* paints the previous content immediately and refreshes behind it. `localStorage`
		* keeps the snapshot across a reload; an in-memory map covers a deployment where
		* storage is unavailable.
		*
		* @module dsh-agent-sdk-bridge/client/api
		*/
		/**
		* Same-origin API base, resolved against the document so a deployment under a
		* sub-path still reaches its own host.
		*
		* Resolved per call, not at module scope: the shell evaluates this bundle
		* before there is a document to resolve against, and a top-level `document`
		* read would make the file unloadable in its own test harness.
		*/
		function apiBase() {
			try {
				return new URL("api/llm-qoder-cn", document.baseURI).pathname;
			} catch {
				return "/api/llm-qoder-cn";
			}
		}
		/** Call the plugin's API and parse its JSON answer. */
		async function api(path, options = {}) {
			const { timeout = 3e4, ...rest } = options;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			try {
				const response = await fetch(`${apiBase()}${path}`, {
					...rest,
					signal: controller.signal
				});
				const text = await response.text();
				let payload;
				try {
					payload = text === "" ? {} : JSON.parse(text);
				} catch {
					payload = { error: text.slice(0, 200) };
				}
				if (!response.ok) {
					const message = payload?.error;
					throw new Error(typeof message === "string" ? message : `HTTP ${response.status}`);
				}
				return payload;
			} finally {
				clearTimeout(timer);
			}
		}
		/** Settle with `promise`, or reject with `message` once `ms` elapse. */
		function withDeadline(promise, ms, message) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(message)), ms);
				promise.then((value) => {
					clearTimeout(timer);
					resolve(value);
				}, (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
		}
		const CACHE_PREFIX = "dsh-agent-sdk-bridge/cache/v1";
		const cacheMemory = /* @__PURE__ */ new Map();
		function cacheKey(brand, kind) {
			return `${CACHE_PREFIX}:${brand}:${kind}`;
		}
		/** The last successful answer for one edition and kind, or undefined. */
		function readCache(brand, kind) {
			const key = cacheKey(brand, kind);
			if (cacheMemory.has(key)) return cacheMemory.get(key);
			try {
				const raw = window.localStorage.getItem(key);
				if (raw === null) return void 0;
				const parsed = JSON.parse(raw);
				cacheMemory.set(key, parsed);
				return parsed;
			} catch {
				return;
			}
		}
		/** Remember one answer, in memory and (when possible) across reloads. */
		function writeCache(brand, kind, value) {
			const key = cacheKey(brand, kind);
			cacheMemory.set(key, value);
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch {}
		}
		/**
		* Forget one cached answer.
		*
		* Needed when the cache has become wrong rather than merely old: after an
		* uninstall the stored quota describes an account read through a CLI that is
		* no longer on the machine, and painting it again would keep showing numbers
		* nobody can reproduce.
		*/
		function clearCache(brand, kind) {
			const key = cacheKey(brand, kind);
			cacheMemory.delete(key);
			try {
				window.localStorage.removeItem(key);
			} catch {}
		}
		//#endregion
		//#region src/client/styles.ts
		/** Selectors the stylesheet owns; components reference them by class name. */
		const CLASS = {
			page: "dssb-page",
			button: "dssb-btn",
			buttonAlert: "dssb-btn-alert",
			input: "dssb-input",
			select: "dssb-select",
			link: "dssb-link",
			check: "dssb-check",
			hit: "dssb-hit",
			row: "dssb-row",
			meterFill: "dssb-meter-fill",
			packToggle: "dssb-pack-toggle",
			visuallyHidden: "dssb-visually-hidden",
			tabular: "dssb-tabular",
			breakable: "dssb-breakable"
		};
		/** Everything the inline style objects carry. */
		const css = {
			page: {
				maxWidth: "860px",
				display: "flex",
				flexDirection: "column",
				gap: "14px",
				color: "var(--dsw-alias-label-primary, CanvasText)"
			},
			h2: {
				margin: "0",
				fontSize: "1.25em"
			},
			intro: {
				margin: "0",
				opacity: .78,
				lineHeight: 1.55,
				fontSize: "0.92em"
			},
			bar: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap"
			},
			btn: {
				padding: "6px 12px",
				borderRadius: "7px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "0.88em"
			},
			input: {
				padding: "6px 10px",
				borderRadius: "7px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
				background: "var(--dsw-alias-bg-base, Canvas)",
				color: "var(--dsw-alias-label-primary, CanvasText)",
				font: "inherit",
				fontSize: "0.88em"
			},
			search: {
				flex: "1 1 180px",
				minWidth: "140px"
			},
			count: {
				fontSize: "0.85em",
				opacity: .72,
				marginLeft: "auto",
				fontVariantNumeric: "tabular-nums"
			},
			list: {
				display: "flex",
				flexDirection: "column",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				borderRadius: "10px",
				overflow: "hidden"
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: "12px",
				padding: "10px 14px",
				borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))"
			},
			rowFirst: { borderTop: "none" },
			rowOff: { opacity: .62 },
			name: {
				flex: "1 1 auto",
				minWidth: 0,
				display: "flex",
				flexDirection: "column",
				gap: "2px"
			},
			nameText: {
				fontSize: "0.92em",
				fontWeight: 500,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			id: {
				fontSize: "0.76em",
				opacity: .62,
				fontFamily: "ui-monospace, monospace"
			},
			tag: {
				fontSize: "0.72em",
				padding: "1px 6px",
				borderRadius: "5px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
				opacity: .8
			},
			price: {
				fontSize: "0.9em",
				opacity: .72,
				fontWeight: 400
			},
			select: {
				padding: "5px 8px",
				borderRadius: "7px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
				background: "var(--dsw-alias-bg-base, Canvas)",
				color: "var(--dsw-alias-label-primary, CanvasText)",
				font: "inherit",
				fontSize: "0.85em",
				minWidth: "104px"
			},
			switch: {
				width: "17px",
				height: "17px",
				margin: 0,
				accentColor: "var(--dsw-alias-brand-primary, #4c6ef5)"
			},
			note: {
				fontSize: "0.82em",
				opacity: .68,
				lineHeight: 1.5
			},
			err: {
				fontSize: "0.86em",
				color: "var(--dsw-alias-label-danger, #e03131)"
			},
			guide: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				flexWrap: "wrap",
				padding: "12px 14px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-label-danger, #e03131)",
				background: "rgba(224,49,49,0.07)"
			},
			guideText: {
				flex: "1 1 240px",
				fontSize: "0.88em",
				lineHeight: 1.5,
				color: "var(--dsw-alias-label-danger, #e03131)"
			},
			btnAlert: {
				border: "1px solid var(--dsw-alias-label-danger, #e03131)",
				color: "var(--dsw-alias-label-danger, #e03131)"
			},
			group: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				borderRadius: "10px",
				padding: "14px 16px"
			},
			advLabel: { fontSize: "0.88em" },
			h3: {
				margin: 0,
				fontSize: "0.95em"
			},
			usageCard: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				background: "var(--dsw-alias-bg-base, rgba(128,128,128,0.03))"
			},
			usageHead: {
				display: "flex",
				alignItems: "baseline",
				gap: "10px",
				flexWrap: "wrap"
			},
			progressDanger: { background: "var(--dsw-alias-label-danger, #e03131)" },
			creditStack: {
				display: "flex",
				flexDirection: "column",
				gap: "14px"
			},
			creditMeter: {
				display: "flex",
				flexDirection: "column",
				gap: "6px"
			},
			creditName: {
				fontSize: "0.8em",
				opacity: .62
			},
			creditRow: {
				display: "flex",
				alignItems: "baseline",
				gap: "10px",
				flexWrap: "wrap",
				fontSize: "0.9em"
			},
			creditLabel: {
				opacity: .68,
				minWidth: "56px"
			},
			creditAmount: {
				fontWeight: 600,
				fontSize: "1.04em",
				fontVariantNumeric: "tabular-nums"
			},
			creditPct: {
				marginLeft: "auto",
				opacity: .68,
				fontVariantNumeric: "tabular-nums"
			},
			creditBar: {
				height: "6px",
				borderRadius: "999px",
				background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.22))",
				overflow: "hidden"
			},
			creditBarFill: {
				height: "100%",
				borderRadius: "999px",
				background: "var(--dsw-alias-brand-primary, #4c6ef5)"
			},
			usageLine: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				flexWrap: "wrap",
				fontSize: "0.86em"
			},
			usageLabel: {
				opacity: .68,
				minWidth: "72px"
			},
			usageValue: {
				fontWeight: 500,
				minWidth: 0,
				overflowWrap: "anywhere"
			},
			link: {
				color: "var(--dsw-alias-brand-primary, #4c6ef5)",
				textDecoration: "none",
				fontSize: "0.86em"
			},
			usageFoot: {
				display: "flex",
				alignItems: "center",
				gap: "14px",
				flexWrap: "wrap",
				fontSize: "0.8em",
				opacity: .68
			},
			packBlock: {
				display: "flex",
				flexDirection: "column",
				gap: "6px"
			},
			packHead: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				flexWrap: "wrap",
				fontSize: "0.86em"
			},
			packToggle: {
				marginLeft: "auto",
				background: "none",
				border: "none",
				padding: "2px 0",
				font: "inherit",
				fontSize: "0.8em",
				color: "var(--dsw-alias-brand-primary, #4c6ef5)"
			},
			packList: {
				display: "flex",
				flexDirection: "column",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				overflow: "hidden"
			},
			packListScroll: {
				maxHeight: "190px",
				overflowY: "auto"
			},
			packRow: {
				display: "grid",
				gridTemplateColumns: "minmax(90px, 1.5fr) auto auto",
				alignItems: "baseline",
				gap: "10px",
				padding: "6px 10px",
				borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))",
				fontSize: "0.82em"
			},
			packFirst: { borderTop: "none" },
			packLabel: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			packAmount: {
				fontFamily: "ui-monospace, monospace",
				textAlign: "right",
				whiteSpace: "nowrap"
			},
			packExpiry: {
				opacity: .68,
				whiteSpace: "nowrap",
				fontSize: "0.92em"
			},
			optionRow: {
				display: "flex",
				alignItems: "center",
				gap: "12px",
				padding: "10px 0",
				borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))"
			},
			optionFirst: {
				borderTop: "none",
				paddingTop: 0
			},
			optionText: {
				flex: "1 1 auto",
				minWidth: 0,
				display: "flex",
				flexDirection: "column",
				gap: "2px"
			},
			optionName: {
				fontSize: "0.92em",
				fontWeight: 500,
				overflowWrap: "anywhere"
			},
			optionStatus: {
				fontSize: "0.82em",
				opacity: .68
			},
			/** One control cluster that keeps its buttons together on a narrow panel. */
			actions: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap"
			}
		};
		const STYLE_ID = "dsh-agent-sdk-bridge/styles";
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
.dssb-tabular { font-variant-numeric: tabular-nums; }
.dssb-breakable { overflow-wrap: anywhere; min-width: 0; }
.dssb-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  .dssb-btn, .dssb-meter-fill { transition: none; }
}
`;
		/**
		* Install the state styles once, before the first render.
		*
		* Kept out of module scope so the bundle stays evaluable without a document,
		* and idempotent so a reloaded plugin does not stack sheets.
		*/
		function installStyles() {
			try {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID) !== null) return;
				const element = document.createElement("style");
				element.id = STYLE_ID;
				element.textContent = RULES;
				document.head.appendChild(element);
			} catch {}
		}
		//#endregion
		//#region src/client/components/primitives.tsx
		/**
		* The small pieces every card is built from: identifiers, live regions, meters
		* and the two-step confirmation for destructive actions.
		*
		* They exist because the state rules here are accessibility rules — an update
		* that is not announced, a bar a screen reader cannot read, a destructive
		* button that fires on the first click — and repeating them at each call site
		* is exactly how one of them ends up different from the others.
		*
		* @module dsh-agent-sdk-bridge/client/components/primitives
		*/
		/** Monotonic ids, so a label can name the control it describes without a hook. */
		let sequence = 0;
		/** A document-unique id for one mounted control and its label. */
		function useInstanceId(prefix) {
			const [id] = (0, react.useState)(() => `${prefix}-${++sequence}`);
			return id;
		}
		/** A status line that assistive technology is told about, politely. */
		function LiveStatus({ children, style }) {
			if (children === null || children === void 0 || children === false) return null;
			return /* @__PURE__ */ react.createElement("div", {
				role: "status",
				"aria-live": "polite",
				style: {
					...css.note,
					...style
				}
			}, children);
		}
		/** An error line: announced at once, because the user is waiting on an action. */
		function LiveAlert({ children, style }) {
			if (children === null || children === void 0 || children === false) return null;
			return /* @__PURE__ */ react.createElement("div", {
				role: "alert",
				style: {
					...css.err,
					...style
				}
			}, children);
		}
		/**
		* One percentage bar.
		*
		* A `div` with a width is invisible to assistive technology, so the meter
		* carries the role and the value itself and the fill is decoration.
		*/
		function Meter({ pct, label, danger }) {
			const clamped = Math.max(0, Math.min(100, pct));
			return /* @__PURE__ */ react.createElement("div", {
				role: "progressbar",
				"aria-label": label,
				"aria-valuemin": 0,
				"aria-valuemax": 100,
				"aria-valuenow": Math.round(clamped),
				"aria-valuetext": `${Number(clamped.toFixed(1))}%`,
				style: css.creditBar
			}, /* @__PURE__ */ react.createElement("div", {
				className: CLASS.meterFill,
				style: {
					...css.creditBarFill,
					width: `${clamped}%`,
					...danger === true || clamped >= 100 ? css.progressDanger : {}
				}
			}));
		}
		/** A link out of the shell; every one of them opens in a new tab. */
		function ExternalLink({ href, children, style }) {
			return /* @__PURE__ */ react.createElement("a", {
				className: CLASS.link,
				href,
				target: "_blank",
				rel: "noreferrer noopener",
				style: {
					...css.link,
					...style
				}
			}, children);
		}
		/**
		* A destructive button that takes two clicks.
		*
		* Not `window.confirm`: that blocks the shell's own event loop, cannot be
		* themed, and — worse — is unavailable in some embeddings, where the old code
		* returned early and left the button silently doing nothing. Here the first
		* click only arms the action, the second performs it, and an armed button
		* disarms itself after a few seconds so a stray click cannot complete it later.
		*/
		function ConfirmButton({ label, question, confirmLabel, cancelLabel, onConfirm, disabled, alert, style }) {
			const [armed, setArmed] = (0, react.useState)(false);
			const target = (0, react.useRef)(null);
			const questionId = useInstanceId("dssb-confirm");
			(0, react.useEffect)(() => {
				if (!armed) return void 0;
				const timer = setTimeout(() => setArmed(false), 8e3);
				return () => clearTimeout(timer);
			}, [armed]);
			(0, react.useEffect)(() => {
				if (armed) target.current?.focus();
			}, [armed]);
			const confirm = (0, react.useCallback)(() => {
				setArmed(false);
				onConfirm();
			}, [onConfirm]);
			if (!armed) return /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: alert === true ? `${CLASS.button} ${CLASS.buttonAlert}` : CLASS.button,
				style: {
					...css.btn,
					...alert === true ? css.btnAlert : {},
					...style
				},
				disabled,
				onClick: () => setArmed(true)
			}, label);
			return /* @__PURE__ */ react.createElement("div", {
				role: "group",
				"aria-labelledby": questionId,
				style: css.actions
			}, /* @__PURE__ */ react.createElement("span", {
				id: questionId,
				style: {
					...css.note,
					flex: "1 1 220px"
				}
			}, question), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				ref: target,
				className: `${CLASS.button} ${CLASS.buttonAlert}`,
				style: {
					...css.btn,
					...css.btnAlert
				},
				onClick: confirm
			}, confirmLabel), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				onClick: () => setArmed(false)
			}, cancelLabel));
		}
		//#endregion
		//#region src/client/components/bundle-settings.tsx
		/**
		* The edition switches, contributed to this bundle's own page in the plugin
		* manager (`plugins.bundle.config`).
		*
		* They live here rather than on any settings page because they decide whether
		* those pages exist at all: a page cannot own the switch that removes it. The
		* write goes through the shared config form, so it uses the same revision fence
		* as every other setting.
		*
		* @module dsh-agent-sdk-bridge/client/components/bundle-settings
		*/
		/** The three edition switches. */
		function BundleSettings({ ctx, t, view }) {
			const form = ctx.configForms.get("llm-qoder-cn");
			const subscribe = (0, react.useCallback)((listener) => form.subscribe(listener), [form]);
			const read = (0, react.useCallback)(() => form.getSnapshot(), [form]);
			const snapshot = (0, react.useSyncExternalStore)(subscribe, read, read);
			const value = snapshot?.value ?? {};
			const writable = snapshot?.writable !== false;
			const [busy, setBusy] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const writeTicket = (0, react.useRef)(0);
			const statusId = useInstanceId("dssb-toggle-status");
			const toggle = (0, react.useCallback)(async (key, next) => {
				const mine = ++writeTicket.current;
				setBusy(true);
				setStatus(t("saving"));
				setError(void 0);
				try {
					if (await withDeadline(form.set(key, next), 2e4, t("timeout")) === false) throw new Error(t("pluginOptionsRejected"));
					if (mine === writeTicket.current) setStatus(t("saved"));
				} catch (caught) {
					if (mine !== writeTicket.current) return;
					setError(`${t("saveFailed")}：${String(caught?.message ?? caught)}`);
					setStatus(void 0);
				} finally {
					if (mine === writeTicket.current) setBusy(false);
				}
			}, [form, t]);
			const labelOf = (brand) => {
				const key = brand.id === "cn" ? "displayName" : brand.id === "global" ? "intlDisplayName" : "codebuddyDisplayName";
				const fallback = t(brand.navKey);
				const stored = value[key];
				return typeof stored === "string" && stored !== "" ? stored : fallback;
			};
			if (view !== void 0 && view !== "page") {
				const names = BRANDS.filter((brand) => value[brand.fields.enabled] !== false).map(labelOf);
				return /* @__PURE__ */ react.createElement("span", null, names.join(" · "));
			}
			return /* @__PURE__ */ react.createElement("div", { style: css.group }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t("pluginOptionsTitle")), /* @__PURE__ */ react.createElement("div", { style: css.note }, t("pluginOptionsHint")), /* @__PURE__ */ react.createElement("div", null, BRANDS.map((brand, index) => {
				const enabled = value[brand.fields.enabled] !== false;
				const name = labelOf(brand);
				const checkboxId = `dssb-toggle-${brand.id}`;
				return /* @__PURE__ */ react.createElement("div", {
					key: brand.id,
					style: {
						...css.optionRow,
						...index === 0 ? css.optionFirst : {}
					}
				}, /* @__PURE__ */ react.createElement("input", {
					id: checkboxId,
					type: "checkbox",
					className: CLASS.check,
					style: css.switch,
					checked: enabled,
					disabled: busy || !writable,
					"aria-describedby": statusId,
					onChange: (event) => {
						toggle(brand.fields.enabled, event.target.checked);
					}
				}), /* @__PURE__ */ react.createElement("label", {
					htmlFor: checkboxId,
					className: CLASS.hit,
					style: css.optionText
				}, /* @__PURE__ */ react.createElement("span", {
					style: css.optionName,
					translate: "no"
				}, name), /* @__PURE__ */ react.createElement("span", { style: css.optionStatus }, enabled ? t("pluginOptionsOn") : t("pluginOptionsOff"))));
			})), writable ? null : /* @__PURE__ */ react.createElement("div", { style: css.note }, t("pluginOptionsReadOnly")), /* @__PURE__ */ react.createElement(LiveAlert, null, error), /* @__PURE__ */ react.createElement("span", { id: statusId }, /* @__PURE__ */ react.createElement(LiveStatus, null, error === void 0 ? status : void 0)));
		}
		//#endregion
		//#region src/client/format.ts
		/** The active UI language, as a BCP-47 tag the `Intl` APIs accept. */
		function localeTag() {
			try {
				if (typeof document !== "undefined") {
					const lang = document.documentElement?.lang;
					if (typeof lang === "string" && lang !== "") return lang;
				}
				if (typeof navigator !== "undefined") {
					const lang = navigator.language;
					if (typeof lang === "string" && lang !== "") return lang;
				}
			} catch {}
			return "zh-CN";
		}
		/** `Intl` formatters are expensive to build and stable, so they are reused. */
		const formatters = /* @__PURE__ */ new Map();
		function numberFormatter(locale) {
			const key = `n:${locale}`;
			const held = formatters.get(key);
			if (held !== void 0) return held;
			try {
				const made = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
				formatters.set(key, made);
				return made;
			} catch {
				return;
			}
		}
		function dateFormatter(locale) {
			const key = `d:${locale}`;
			const held = formatters.get(key);
			if (held !== void 0) return held;
			try {
				const made = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
				formatters.set(key, made);
				return made;
			} catch {
				return;
			}
		}
		function timeFormatter(locale) {
			const key = `t:${locale}`;
			const held = formatters.get(key);
			if (held !== void 0) return held;
			try {
				const made = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
				formatters.set(key, made);
				return made;
			} catch {
				return;
			}
		}
		/** A finite number, or undefined for anything else. */
		function countOf(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : void 0;
		}
		/** Compact label for a token count. */
		function windowLabel(n) {
			const value = countOf(n);
			if (value === void 0) return "—";
			if (value >= 1e6) return `${Number((value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1))}M`;
			if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
			return String(value);
		}
		/**
		* The credit multiplier upstream quotes, as a short suffix.
		*
		* `0` renders as the word for free rather than `x0`, matching how the Qoder
		* client shows a free model. A model upstream quoted no multiplier for gets no
		* suffix at all — inventing one would misstate its cost.
		*/
		function priceSuffix(t, factor) {
			const value = countOf(factor);
			if (value === void 0 || value < 0) return "";
			if (value === 0) return t("free");
			return `x${Number(value.toFixed(4))}`;
		}
		/** A 0–100 percentage, clamped, or undefined when the value is not a number. */
		function percentOf(value) {
			const measured = countOf(value);
			if (measured === void 0) return void 0;
			return Math.max(0, Math.min(100, measured));
		}
		/** A credit count with the active locale's group separators; dashes when absent. */
		function creditsOf(value, locale = localeTag()) {
			const measured = countOf(value);
			if (measured === void 0) return "—";
			const formatter = numberFormatter(locale);
			return formatter === void 0 ? String(measured) : formatter.format(measured);
		}
		/**
		* Whether a timestamp means "no expiry".
		*
		* The quota endpoint reports plan end dates as a sentinel far in the future
		* (year 9999). Rendering that as a date is technically true and practically
		* noise, so it is shown as "never".
		*/
		function neverExpires(ms) {
			const value = countOf(ms);
			return value === void 0 || value <= 0 || value > Date.now() + 15768e8;
		}
		/** A short localized date for an epoch-millisecond value. */
		function dateLabel(ms, locale = localeTag()) {
			const value = countOf(ms);
			if (value === void 0) return "—";
			const formatter = dateFormatter(locale);
			try {
				return formatter === void 0 ? new Date(value).toLocaleDateString(locale) : formatter.format(value);
			} catch {
				return String(ms);
			}
		}
		/** A localized clock time, used for "updated at" and quota resets. */
		function timeLabel(ms, locale = localeTag()) {
			const value = countOf(ms);
			if (value === void 0) return "—";
			const formatter = timeFormatter(locale);
			try {
				return formatter === void 0 ? new Date(value).toLocaleTimeString(locale) : formatter.format(value);
			} catch {
				return String(ms);
			}
		}
		/**
		* The collapsed-row figures for a set of credit packages.
		*
		* A region can carry a dozen packages, so the card shows one summary row
		* (count, combined total, nearest expiry) and lists them only when asked.
		* `nearest` skips the endpoint's "never expires" sentinel: printing year 9999
		* as the earliest expiry is noise.
		*/
		function packageSummary(packages) {
			const list = Array.isArray(packages) ? packages : [];
			let total = 0;
			for (const pkg of list) if (typeof pkg?.total === "number" && Number.isFinite(pkg.total)) total += pkg.total;
			else if (typeof pkg?.used === "number" && Number.isFinite(pkg.used)) total += pkg.used;
			const nearest = list.map((pkg) => pkg?.end).filter((value) => !neverExpires(value)).sort((a, b) => a - b)[0];
			return {
				count: list.length,
				total,
				nearest
			};
		}
		/**
		* The used/total reading one credit bucket is rendered from.
		*
		* The percentage is computed from the same numbers the row prints: an upstream
		* percentage that disagreed with them would make the bar contradict its own
		* label. A bucket that reports only a percentage still fills a bar.
		*/
		function creditReading(bucket) {
			if (bucket === null || typeof bucket !== "object") return void 0;
			const held = bucket;
			const total = countOf(held.total) ?? countOf(held.cap);
			const remaining = countOf(held.remaining);
			const used = countOf(held.used) ?? (total !== void 0 && remaining !== void 0 ? Math.max(0, total - remaining) : void 0);
			const pct = (total !== void 0 && total > 0 && used !== void 0 ? Math.max(0, Math.min(100, used / total * 100)) : void 0) ?? percentOf(held.percentage);
			if (used === void 0 && total === void 0 && remaining === void 0) return pct === void 0 ? void 0 : { pct };
			return {
				used,
				total,
				remaining,
				pct
			};
		}
		/** A bucket's unit, localized when upstream says the generic "credits". */
		function creditUnit(t, bucket) {
			const unit = typeof bucket?.unit === "string" ? bucket.unit.trim() : "";
			if (unit === "") return t("usageCredits");
			return /^credits?$/i.test(unit) ? t("usageCredits") : unit;
		}
		//#endregion
		//#region src/client/snapshots.ts
		/**
		* The last account answer per provider and login region.
		*
		* A region switch must paint instantly — the browser already knows what the
		* other region looked like a minute ago, and waiting on a CLI round trip to
		* show it is the difference between a page and a spinner. So each region keeps
		* its own snapshot, and the page renders from it before verifying.
		*
		* Keeping the snapshot rule in one place is deliberate: the page needs to read
		* a region's sign-in state before the card has mounted, and a second copy of
		* that rule in the settings page is how the locked view started flashing on
		* region switches.
		*
		* @module dsh-agent-sdk-bridge/client/snapshots
		*/
		function read(brand, region) {
			const cached = readCache(brand, `snapshot:${region}`);
			return cached !== null && typeof cached === "object" ? cached : void 0;
		}
		function merge(brand, region, previous, patch) {
			writeCache(brand, `snapshot:${region}`, {
				...previous ?? {},
				...patch,
				at: Date.now()
			});
		}
		/** The remembered CodeBuddy answer for one region. */
		function codeBuddySnapshot(region) {
			return read("codebuddy", region);
		}
		/** Remember part of one CodeBuddy region's answer. */
		function rememberCodeBuddy(region, patch) {
			merge("codebuddy", region, codeBuddySnapshot(region), patch);
		}
		//#endregion
		//#region src/client/url-state.ts
		/**
		* The parts of the page's state worth keeping in the address bar.
		*
		* A settings page holds four pieces of view state a user can be looking for
		* when they come back — the search term, the "enabled only" filter, whether
		* advanced is expanded, whether the package list is open — plus the CLI output
		* panel. Keeping them in the URL means a reload, a bookmark or a shared link
		* lands on the same view instead of a reset one.
		*
		* The parameters are namespaced (`dssb.*`) and written with `history.replaceState`,
		* so nothing navigates and no other query parameter the shell owns is touched.
		* Every entry point is guarded: a shell without a writable history simply gets
		* the in-memory behaviour.
		*
		* @module dsh-agent-sdk-bridge/client/url-state
		*/
		const PREFIX = "dssb.";
		/** The document's query parameters, or undefined where there is no document. */
		function readParams() {
			try {
				if (typeof window === "undefined" || typeof window.location === "undefined") return void 0;
				return new URLSearchParams(window.location.search);
			} catch {
				return;
			}
		}
		/** One namespaced parameter's value, if the URL carries it. */
		function readUrlValue(key) {
			return readParams()?.get(`${PREFIX}${key}`) ?? void 0;
		}
		/**
		* Write one namespaced parameter, leaving the rest of the query untouched.
		*
		* An empty value removes the parameter, so a default view has a clean URL.
		*/
		function writeUrlValue(key, value) {
			try {
				if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return;
				const url = new URL(window.location.href);
				const name = `${PREFIX}${key}`;
				if (value === void 0 || value === "") url.searchParams.delete(name);
				else url.searchParams.set(name, value);
				if (url.toString() !== window.location.href) window.history.replaceState(window.history.state, "", url.toString());
			} catch {}
		}
		/** A boolean view flag mirrored into the URL. */
		function useUrlFlag(key, initial = false) {
			const [value, setValue] = (0, react.useState)(() => {
				const held = readUrlValue(key);
				return held === void 0 ? initial : held === "1";
			});
			const first = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				if (first.current) {
					first.current = false;
					return;
				}
				writeUrlValue(key, value ? "1" : void 0);
			}, [key, value]);
			return [value, (0, react.useCallback)((next) => setValue(next), [])];
		}
		/** A text view value (the model search term) mirrored into the URL. */
		function useUrlText(key, initial = "") {
			const [value, setValue] = (0, react.useState)(() => readUrlValue(key) ?? initial);
			const first = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				if (first.current) {
					first.current = false;
					return;
				}
				const timer = setTimeout(() => writeUrlValue(key, value), 200);
				return () => clearTimeout(timer);
			}, [key, value]);
			return [value, (0, react.useCallback)((next) => setValue(next), [])];
		}
		//#endregion
		//#region src/client/types.ts
		/** The nested advanced-label table, or an empty table when the host omitted it. */
		function advancedLabels(t) {
			const table = t("advancedFields");
			return table !== null && typeof table === "object" ? table : {};
		}
		//#endregion
		//#region src/client/components/advanced-fields.tsx
		/**
		* The collapsed "advanced" block: the scalars worth reaching without editing
		* YAML, rendered against the host's schema.
		*
		* The schema stays the source of truth for labels, help text, bounds and step;
		* {@link ADVANCED} only decides order and control. Every control is
		* uncontrolled and commits on blur: these fields write through the same
		* revision-fenced form as everything else, and a write per keystroke turned
		* typing `120` into three round trips and a race with its own echoes.
		*
		* @module dsh-agent-sdk-bridge/client/components/advanced-fields
		*/
		/** The collapsed advanced block. */
		function AdvancedBlock({ t, form, snapshot, fields, namespace, show, onToggle }) {
			const bodyId = useInstanceId("dssb-advanced");
			const [invalid, setInvalid] = (0, react.useState)(void 0);
			const header = /* @__PURE__ */ react.createElement("div", { style: css.bar }, /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				"aria-expanded": show,
				"aria-controls": bodyId,
				onClick: onToggle
			}, show ? t("hide") : t("show")), /* @__PURE__ */ react.createElement("span", { style: css.note }, t("advancedHint")));
			if (!show) return /* @__PURE__ */ react.createElement("div", { style: css.group }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t("advanced")), header);
			const value = snapshot?.value ?? {};
			const user = snapshot?.user;
			const schema = namespace?.schema;
			const refs = schema?.refs;
			const root = refs?.[schema?.uid ?? ""];
			const writable = snapshot?.writable !== false;
			const labels = advancedLabels(t);
			const commit = (key, kind, raw) => {
				if (kind === "number") {
					if (raw === "") {
						form.unset(key).catch(() => void 0);
						return;
					}
					const parsed = Number(raw);
					if (!Number.isFinite(parsed)) {
						setInvalid(labels[key] ?? key);
						return;
					}
					setInvalid(void 0);
					form.set(key, parsed).catch(() => void 0);
					return;
				}
				if (kind === "json") {
					try {
						form.set(key, JSON.parse(raw)).catch(() => void 0);
						setInvalid(void 0);
					} catch {
						setInvalid(labels[key] ?? key);
					}
					return;
				}
				(raw === "" ? form.unset(key) : form.set(key, raw)).catch(() => void 0);
			};
			const rows = fields.map(([key, kind]) => {
				const node = root === void 0 ? void 0 : refs?.[root.dict?.[key] ?? ""];
				if (node === void 0) return null;
				const help = typeof node.meta?.description === "string" ? node.meta.description : void 0;
				const current = value[key];
				const overridden = user !== null && typeof user === "object" && Object.hasOwn(user, key);
				const inputId = `dssb-adv-${key}`;
				const label = labels[key] ?? key;
				const syncKey = `${key}:${current === void 0 ? "" : JSON.stringify(current)}`;
				return /* @__PURE__ */ react.createElement("div", {
					key: syncKey,
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px"
					}
				}, /* @__PURE__ */ react.createElement("div", { style: {
					display: "flex",
					alignItems: "center",
					gap: "8px"
				} }, /* @__PURE__ */ react.createElement("label", {
					htmlFor: inputId,
					style: css.advLabel
				}, label), overridden && writable ? /* @__PURE__ */ react.createElement("button", {
					type: "button",
					className: CLASS.button,
					style: {
						fontSize: "0.75em",
						opacity: .72,
						background: "none",
						border: "none",
						textDecoration: "underline",
						padding: 0,
						font: "inherit",
						color: "inherit"
					},
					onClick: () => {
						setInvalid(void 0);
						form.unset(key).catch(() => void 0);
					}
				}, t("reset")) : null), kind === "json" ? /* @__PURE__ */ react.createElement("input", {
					id: inputId,
					className: CLASS.input,
					style: {
						...css.input,
						fontFamily: "ui-monospace, monospace"
					},
					defaultValue: current === void 0 ? "{}" : JSON.stringify(current),
					disabled: !writable,
					spellCheck: false,
					autoComplete: "off",
					onBlur: (event) => commit(key, kind, event.target.value)
				}) : /* @__PURE__ */ react.createElement("input", {
					id: inputId,
					className: CLASS.input,
					style: css.input,
					type: kind === "number" ? "number" : "text",
					defaultValue: current === void 0 ? "" : String(current),
					min: node.meta?.min,
					max: node.meta?.max,
					step: node.meta?.step,
					disabled: !writable,
					spellCheck: kind === "text",
					autoComplete: "off",
					onBlur: (event) => commit(key, kind, event.target.value)
				}), help !== void 0 ? /* @__PURE__ */ react.createElement("div", { style: css.note }, help) : null);
			}).filter(Boolean);
			return /* @__PURE__ */ react.createElement("div", { style: css.group }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t("advanced")), header, invalid === void 0 ? null : /* @__PURE__ */ react.createElement(LiveAlert, null, `${t("advancedInvalid")} ${invalid}`), /* @__PURE__ */ react.createElement("div", {
				id: bodyId,
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "10px"
				}
			}, rows));
		}
		//#endregion
		//#region src/client/components/credit-meter.tsx
		/**
		* One credit bucket, in the shape both account cards use: `used / total` with
		* the percentage on the right and a bar underneath.
		*
		* A bucket the account does not have reports no numbers at all, so it renders
		* nothing rather than an empty bar. The label doubles as the bar's accessible
		* name, which is why it is a required string wherever one is drawn.
		*
		* @module dsh-agent-sdk-bridge/client/components/credit-meter
		*/
		/** One bucket's figures and bar, or nothing when the bucket carries no numbers. */
		function CreditMeter({ t, label, bucket, danger }) {
			const reading = creditReading(bucket);
			if (reading === void 0) return null;
			const { used, total, remaining, pct } = reading;
			const amount = total !== void 0 && used !== void 0 ? `${creditsOf(used)} / ${creditsOf(total)} ${creditUnit(t, bucket)}` : total !== void 0 && remaining !== void 0 ? `${creditsOf(remaining)} / ${creditsOf(total)} ${creditUnit(t, bucket)}` : used !== void 0 ? `${creditsOf(used)} ${creditUnit(t, bucket)}` : remaining !== void 0 ? `${creditsOf(remaining)} ${creditUnit(t, bucket)}` : void 0;
			return /* @__PURE__ */ react.createElement("div", { style: css.creditMeter }, label === void 0 ? null : /* @__PURE__ */ react.createElement("div", { style: css.creditName }, label), /* @__PURE__ */ react.createElement("div", { style: css.creditRow }, amount === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: css.creditLabel }, used !== void 0 ? t("usageUsed") : t("usageRemaining")), amount === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: css.creditAmount }, amount), pct === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: css.creditPct }, `${Number(pct.toFixed(1))}%`)), pct === void 0 ? null : /* @__PURE__ */ react.createElement(Meter, {
				pct,
				label: label ?? t("usageTitle"),
				danger
			}));
		}
		//#endregion
		//#region src/client/components/codebuddy-card.tsx
		/**
		* CodeBuddy's account card: region choice, browser sign-in and the signed-in
		* account with its credit packages.
		*
		* The region is a config write (the host starts the CLI with it), but the card
		* does not wait for it: the target region's snapshot paints first and the live
		* account read follows. Both regions keep their own saved login, so switching
		* back does not open the browser again.
		*
		* @module dsh-agent-sdk-bridge/client/components/codebuddy-card
		*/
		/** The account card CodeBuddy's settings section renders. */
		function CodeBuddyCard({ t, ctx, brand, refreshSignal, onSignedIn, onAuthChange, onRegionChange }) {
			const form = ctx.configForms.get("llm-qoder-cn");
			const subscribe = (0, react.useCallback)((listener) => form.subscribe(listener), [form]);
			const read = (0, react.useCallback)(() => form.getSnapshot(), [form]);
			const configuredRegion = ((0, react.useSyncExternalStore)(subscribe, read, read)?.value ?? {}).codebuddyRegion === "cn" ? "cn" : "global";
			const [region, setRegionState] = (0, react.useState)(configuredRegion);
			const regionRef = (0, react.useRef)(configuredRegion);
			const initial = codeBuddySnapshot(configuredRegion);
			const [auth, setAuth] = (0, react.useState)(initial?.auth);
			const [account, setAccount] = (0, react.useState)(initial?.account);
			const [error, setError] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [packsExpanded, setPacksExpanded] = (0, react.useState)(false);
			const packsId = useInstanceId("dssb-packs");
			const regionSelectId = useInstanceId("dssb-codebuddy-region");
			const lastRunning = (0, react.useRef)(false);
			const signingIn = auth?.running === true;
			const accountFields = account?.account ?? {};
			const accountSignedIn = account?.error === void 0 && [
				"uid",
				"userName",
				"email",
				"organization",
				"subscriptionType"
			].some((key) => typeof accountFields[key] === "string" && accountFields[key] !== "");
			const signedIn = auth === void 0 ? accountSignedIn : auth.signedIn === true;
			const resolved = auth !== void 0 || account !== void 0;
			const applySnapshot = (0, react.useCallback)((target) => {
				const cached = codeBuddySnapshot(target);
				setAuth(cached?.auth);
				setAccount(cached?.account);
			}, []);
			const loadAccount = (0, react.useCallback)(async (fresh = false, target = regionRef.current) => {
				try {
					const payload = await api(`/usage?brand=codebuddy&region=${target}${fresh ? "&fresh=1" : ""}`, { timeout: 45e3 });
					if (regionRef.current !== target) return;
					setAccount(payload);
					rememberCodeBuddy(target, { account: payload });
					if (typeof payload?.signedIn === "boolean") {
						const next = {
							running: false,
							region: target,
							signedIn: payload.signedIn
						};
						setAuth((previous) => previous?.running === true ? previous : next);
						rememberCodeBuddy(target, { auth: next });
					}
				} catch (caught) {
					if (regionRef.current !== target) return;
					setAccount({ error: String(caught?.message ?? caught) });
				}
			}, []);
			const poll = (0, react.useCallback)(async (target = regionRef.current) => {
				try {
					const next = await api(`/auth?brand=codebuddy&region=${target}`, { timeout: 1e4 });
					if (regionRef.current !== target) return;
					setAuth(next);
					rememberCodeBuddy(target, { auth: next });
					if (lastRunning.current && next.running === false) {
						lastRunning.current = false;
						if (next.error === void 0) await loadAccount(true, target);
					}
					if (next.running === true) lastRunning.current = true;
				} catch (caught) {
					if (regionRef.current !== target) return;
					setError(String(caught?.message ?? caught));
				}
			}, [loadAccount]);
			(0, react.useEffect)(() => {
				regionRef.current = region;
				applySnapshot(region);
				setError(void 0);
				poll(region);
				loadAccount(false, region);
				const timer = setTimeout(() => {
					loadAccount(true, region);
				}, 250);
				return () => clearTimeout(timer);
			}, [
				region,
				refreshSignal,
				applySnapshot,
				loadAccount,
				poll
			]);
			(0, react.useEffect)(() => {
				if (configuredRegion === regionRef.current) return;
				setRegionState(configuredRegion);
				regionRef.current = configuredRegion;
				applySnapshot(configuredRegion);
				setPacksExpanded(false);
			}, [configuredRegion, applySnapshot]);
			(0, react.useEffect)(() => {
				if (auth?.running !== true) return void 0;
				const timer = setInterval(() => {
					poll(region);
				}, 1500);
				return () => clearInterval(timer);
			}, [
				auth?.running,
				poll,
				region
			]);
			(0, react.useEffect)(() => {
				if (resolved) onAuthChange?.(signedIn);
			}, [
				resolved,
				signedIn,
				onAuthChange
			]);
			const setRegion = (0, react.useCallback)((next) => {
				if (next === regionRef.current) return;
				regionRef.current = next;
				lastRunning.current = false;
				setRegionState(next);
				applySnapshot(next);
				setPacksExpanded(false);
				setError(void 0);
				onRegionChange?.(next);
				(async () => {
					try {
						if (await withDeadline(form.set("codebuddyRegion", next), 2e4, t("timeout")) === false) throw new Error(t("saveFailed"));
						if (regionRef.current === next) onSignedIn?.();
					} catch (caught) {
						if (regionRef.current !== next) return;
						setError(`${t("saveFailed")}：${String(caught?.message ?? caught)}`);
						const fallback = form.getSnapshot()?.value?.codebuddyRegion === "cn" ? "cn" : "global";
						regionRef.current = fallback;
						setRegionState(fallback);
						applySnapshot(fallback);
						onRegionChange?.(fallback);
					}
				})();
			}, [
				applySnapshot,
				form,
				onRegionChange,
				onSignedIn,
				t
			]);
			const startLogin = (0, react.useCallback)(async () => {
				const target = regionRef.current;
				setBusy(true);
				setError(void 0);
				try {
					const next = await api("/auth", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							brand: "codebuddy",
							region: target,
							action: "login"
						}),
						timeout: 2e4
					});
					if (regionRef.current !== target) return;
					setAuth(next);
					rememberCodeBuddy(target, { auth: next });
					if (next.running === true) lastRunning.current = true;
				} catch (caught) {
					if (regionRef.current !== target) return;
					setError(`${t("codebuddyLoginFailed")}：${String(caught?.message ?? caught)}`);
				} finally {
					setBusy(false);
				}
			}, [t]);
			const logout = (0, react.useCallback)(async () => {
				const target = regionRef.current;
				setBusy(true);
				setError(void 0);
				try {
					const next = await api("/auth", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							brand: "codebuddy",
							region: target,
							action: "logout"
						}),
						timeout: 2e4
					});
					if (regionRef.current !== target) return;
					setAuth(next);
					setAccount(void 0);
					rememberCodeBuddy(target, {
						auth: next,
						account: void 0
					});
					onAuthChange?.(false);
					await loadAccount(true, target);
				} catch (caught) {
					if (regionRef.current !== target) return;
					const signedOut = {
						running: false,
						region: target,
						signedIn: false
					};
					setAuth(signedOut);
					setAccount(void 0);
					rememberCodeBuddy(target, {
						auth: signedOut,
						account: void 0
					});
					onAuthChange?.(false);
					setError(String(caught?.message ?? caught));
				} finally {
					setBusy(false);
				}
			}, [
				loadAccount,
				onAuthChange,
				t
			]);
			const accountText = account?.account === void 0 ? account?.error ?? t("codebuddyAccountUnknown") : [
				account.account.email,
				account.account.organization,
				account.account.subscriptionType
			].filter((part) => typeof part === "string" && part.length > 0).join(" · ");
			const quota = account?.quota;
			const packages = Array.isArray(quota?.packages) ? [...quota.packages].sort((a, b) => (a.end ?? Number.MAX_SAFE_INTEGER) - (b.end ?? Number.MAX_SAFE_INTEGER)) : [];
			const usageLink = /* @__PURE__ */ react.createElement(ExternalLink, { href: region === "cn" ? "https://copilot.tencent.com/profile/plans-usage" : "https://www.codebuddy.ai/profile/plans-usage" }, t("usageDetail"));
			return /* @__PURE__ */ react.createElement("div", { style: css.usageCard }, /* @__PURE__ */ react.createElement("div", { style: css.usageHead }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t("codebuddyAuthTitle")), /* @__PURE__ */ react.createElement("span", { style: {
				...css.note,
				opacity: .78
			} }, signedIn ? t("codebuddySignedIn") : t("codebuddyNotLoggedIn")), signedIn ? /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: {
					...css.btn,
					marginLeft: "auto"
				},
				disabled: busy,
				onClick: () => void loadAccount(true)
			}, t("usageRefresh")) : null), /* @__PURE__ */ react.createElement("div", { style: css.note }, t("codebuddyAuthHint")), /* @__PURE__ */ react.createElement("div", { style: css.usageLine }, /* @__PURE__ */ react.createElement("label", {
				htmlFor: regionSelectId,
				style: css.usageLabel
			}, t("codebuddyRegionLabel")), /* @__PURE__ */ react.createElement("select", {
				id: regionSelectId,
				className: CLASS.select,
				style: css.select,
				value: region,
				disabled: busy,
				onChange: (event) => setRegion(event.target.value === "cn" ? "cn" : "global")
			}, /* @__PURE__ */ react.createElement("option", { value: "global" }, t("codebuddyRegionGlobal")), /* @__PURE__ */ react.createElement("option", { value: "cn" }, t("codebuddyRegionCn"))), signedIn ? /* @__PURE__ */ react.createElement(ConfirmButton, {
				label: t("codebuddyLogout"),
				question: t("codebuddyConfirmLogout"),
				confirmLabel: t("confirmYes"),
				cancelLabel: t("confirmCancel"),
				disabled: busy || signingIn,
				alert: true,
				onConfirm: () => void logout()
			}) : /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				disabled: busy || signingIn,
				onClick: () => void startLogin()
			}, signingIn ? t("codebuddyLoggingIn") : t("codebuddyLogin"))), signedIn ? /* @__PURE__ */ react.createElement("div", { style: css.usageLine }, /* @__PURE__ */ react.createElement("span", { style: css.usageLabel }, t("usageAccount")), /* @__PURE__ */ react.createElement("span", {
				className: CLASS.breakable,
				style: css.usageValue
			}, accountText)) : /* @__PURE__ */ react.createElement("div", { style: css.note }, t("codebuddyLoginPrompt")), signedIn ? quota === void 0 ? account?.quotaError !== void 0 ? /* @__PURE__ */ react.createElement(LiveAlert, null, `${t("codebuddyQuotaFailed")}：${account.quotaError}`) : /* @__PURE__ */ react.createElement("div", { style: css.note }, t("codebuddyNoQuota")) : /* @__PURE__ */ react.createElement("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "10px"
			} }, /* @__PURE__ */ react.createElement(CreditMeter, {
				t,
				label: t("codebuddyQuotaTitle"),
				bucket: quota,
				danger: (quota.total ?? 0) > 0 && (quota.used ?? 0) >= (quota.total ?? 0)
			}), packages.length === 0 ? null : (() => {
				const summary = packageSummary(packages);
				return /* @__PURE__ */ react.createElement("div", { style: css.packBlock }, /* @__PURE__ */ react.createElement("div", { style: css.packHead }, /* @__PURE__ */ react.createElement("span", { style: css.usageLabel }, `${t("codebuddyQuotaPackages")} (${summary.count})`), /* @__PURE__ */ react.createElement("span", { style: css.usageValue }, `${creditsOf(summary.total)} ${t("usageCredits")}`), summary.nearest === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: css.packExpiry }, t("codebuddyQuotaExpires"), " ", dateLabel(summary.nearest)), /* @__PURE__ */ react.createElement("button", {
					type: "button",
					className: CLASS.packToggle,
					style: css.packToggle,
					"aria-expanded": packsExpanded,
					"aria-controls": packsId,
					onClick: () => setPacksExpanded((value) => !value)
				}, packsExpanded ? t("codebuddyQuotaPackCollapse") : t("codebuddyQuotaPackDetail"))), packsExpanded ? /* @__PURE__ */ react.createElement("div", {
					id: packsId,
					style: css.packBlock
				}, /* @__PURE__ */ react.createElement("div", { style: css.packHead }, /* @__PURE__ */ react.createElement("span", { style: css.usageLabel }, t("codebuddyQuotaPackUsage"))), /* @__PURE__ */ react.createElement("div", { style: {
					...css.packList,
					...css.packListScroll
				} }, packages.map((pkg, index) => /* @__PURE__ */ react.createElement("div", {
					key: `${pkg.name ?? "package"}-${index}`,
					style: {
						...css.packRow,
						...index === 0 ? css.packFirst : {}
					}
				}, /* @__PURE__ */ react.createElement("span", {
					style: css.packLabel,
					title: pkg.name ?? "—"
				}, pkg.name ?? "—"), /* @__PURE__ */ react.createElement("span", { style: css.packAmount }, `${creditsOf(pkg.used)} / ${creditsOf(pkg.total)}`), /* @__PURE__ */ react.createElement("span", { style: css.packExpiry }, pkg.end === void 0 ? "" : dateLabel(pkg.end)))))) : null);
			})(), /* @__PURE__ */ react.createElement("div", { style: css.usageFoot }, quota.cycleEnd === void 0 ? null : /* @__PURE__ */ react.createElement("span", null, t("codebuddyQuotaExpires"), " ", dateLabel(quota.cycleEnd)), usageLink)) : null, signedIn && quota === void 0 ? /* @__PURE__ */ react.createElement("div", { style: css.usageFoot }, usageLink) : null, typeof auth?.url === "string" && signingIn ? /* @__PURE__ */ react.createElement("div", { style: css.usageLine }, /* @__PURE__ */ react.createElement(ExternalLink, { href: auth.url }, t("codebuddyOpenUrl")), /* @__PURE__ */ react.createElement("span", { style: css.note }, t("codebuddyLoginStarted"))) : null, auth?.error !== void 0 ? /* @__PURE__ */ react.createElement(LiveAlert, null, `${t("codebuddyLoginFailed")}：${auth.error}`) : null, error !== void 0 ? /* @__PURE__ */ react.createElement(LiveAlert, null, error) : null, /* @__PURE__ */ react.createElement(LiveStatus, null, signingIn ? t("codebuddyLoggingIn") : null));
		}
		//#endregion
		//#region src/client/components/usage-card.tsx
		/**
		* Qoder's account quota, read through the CLI.
		*
		* This is the same data the Qoder clients show on their account panel: plan,
		* percentage used, remaining credits, add-on package, expiry and the usage and
		* upgrade links. It is fetched from the host (which asks the CLI), not from the
		* provider directly, because only the CLI holds a usable token.
		*
		* The card is stale-while-revalidate: the last reading paints immediately and
		* a fresh one replaces it. A failed read keeps the old numbers and says they
		* are old rather than replacing them with an empty card — except when the CLI
		* is gone, where the stored numbers describe a machine state that no longer
		* exists and are dropped.
		*
		* @module dsh-agent-sdk-bridge/client/components/usage-card
		*/
		/** Account quota and usage, read through the CLI. */
		function UsageCard({ t, brand, refreshSignal, onRefresh }) {
			const [snapshot, setSnapshot] = (0, react.useState)(() => readCache(brand.id, "usage"));
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			/** The CLI is not installed: show that, and never any cached numbers. */
			const [missing, setMissing] = (0, react.useState)(false);
			const ticket = (0, react.useRef)(0);
			const load = (0, react.useCallback)(async (fresh = false) => {
				const mine = ++ticket.current;
				setBusy(true);
				setFailure(void 0);
				try {
					const payload = await api(`/usage?brand=${brand.id}${fresh ? "&fresh=1" : ""}`, { timeout: 45e3 });
					if (mine !== ticket.current) return;
					if (payload?.cliMissing === true) {
						clearCache(brand.id, "usage");
						setSnapshot(void 0);
						setMissing(true);
						setFailure(String(payload.error ?? t("usageCliMissing")));
						return;
					}
					if (payload?.usage === void 0 && payload?.error !== void 0) {
						setMissing(false);
						setFailure(String(payload.error));
						return;
					}
					setMissing(false);
					setSnapshot(payload);
					writeCache(brand.id, "usage", payload);
				} catch (error) {
					if (mine !== ticket.current) return;
					setFailure(String(error?.message ?? error));
				} finally {
					if (mine === ticket.current) setBusy(false);
				}
			}, [brand.id, t]);
			(0, react.useEffect)(() => {
				load(refreshSignal > 0);
			}, [load, refreshSignal]);
			/**
			* Re-read the account: the page's action when it has one, otherwise this
			* card's own quota read.
			*
			* Both buttons use it. A quota failure is how a not-yet-signed-in CLI shows
			* up here, so retrying only the quota would leave the model list — the thing
			* the user is about to look for — exactly as stale as before.
			*/
			const requestRefresh = (0, react.useCallback)(() => {
				if (onRefresh === void 0) {
					load(true);
					return;
				}
				onRefresh();
			}, [load, onRefresh]);
			const usage = snapshot?.usage;
			const account = snapshot?.account;
			const error = failure ?? (snapshot?.usage === void 0 && snapshot?.error !== void 0 ? String(snapshot.error) : void 0);
			const plan = account?.subscriptionType ?? usage?.userType ?? t("usageUnknownPlan");
			const identity = account?.name ?? account?.email ?? usage?.userId;
			const exceeded = usage?.isQuotaExceeded === true;
			const head = /* @__PURE__ */ react.createElement("div", { style: css.usageHead }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t("usageTitle")), identity === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: {
				...css.note,
				opacity: .78
			} }, t("usageAccount"), " ", identity), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: {
					...css.btn,
					marginLeft: "auto"
				},
				disabled: busy,
				onClick: requestRefresh
			}, busy ? t("refreshing") : t("usageRefresh")));
			if (snapshot === void 0 || usage === void 0) return /* @__PURE__ */ react.createElement("div", { style: css.usageCard }, head, missing ? /* @__PURE__ */ react.createElement("div", { style: css.note }, error ?? t("usageCliMissing")) : error === void 0 ? /* @__PURE__ */ react.createElement(LiveStatus, null, t("usageLoading")) : /* @__PURE__ */ react.createElement(LiveAlert, null, `${t("usageUnavailable")}：${error}`), error === void 0 ? null : /* @__PURE__ */ react.createElement("div", { style: css.bar }, /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				disabled: busy,
				onClick: requestRefresh
			}, t("usageRetry"))));
			const expiry = usage.expiresAt;
			const buckets = [
				[t("usagePlanQuota"), usage.userQuota],
				[t("usageAddOn"), usage.addOnQuota],
				[t("usageOrgPackage"), usage.orgResourcePackage]
			];
			const meters = buckets.some(([, bucket]) => creditReading(bucket) !== void 0) ? buckets.map(([label, bucket]) => /* @__PURE__ */ react.createElement(CreditMeter, {
				key: label,
				t,
				label,
				bucket,
				danger: exceeded
			})) : percentOf(usage.totalUsagePercentage) === void 0 ? null : /* @__PURE__ */ react.createElement(CreditMeter, {
				t,
				label: t("usagePlanQuota"),
				bucket: { percentage: usage.totalUsagePercentage },
				danger: exceeded
			});
			return /* @__PURE__ */ react.createElement("div", { style: css.usageCard }, head, /* @__PURE__ */ react.createElement("div", { style: css.usageLine }, /* @__PURE__ */ react.createElement("span", { style: css.usageLabel }, t("usagePlan")), /* @__PURE__ */ react.createElement("span", { style: css.usageValue }, plan), exceeded ? /* @__PURE__ */ react.createElement("span", { style: {
				...css.err,
				fontWeight: 600
			} }, t("usageExceeded")) : null), /* @__PURE__ */ react.createElement("div", { style: css.creditStack }, meters), /* @__PURE__ */ react.createElement("div", { style: css.usageFoot }, /* @__PURE__ */ react.createElement("span", null, t("usageExpires"), " ", expiry === void 0 || neverExpires(expiry) ? t("usageNever") : dateLabel(expiry)), snapshot.at === void 0 ? null : /* @__PURE__ */ react.createElement("span", null, t("usageUpdated"), " ", timeLabel(snapshot.at)), typeof usage.addOnQuota?.detailUrl === "string" ? /* @__PURE__ */ react.createElement(ExternalLink, { href: usage.addOnQuota.detailUrl }, t("usageDetail")) : null, typeof usage.upgradeUrl === "string" && usage.upgradeUrl !== "" ? /* @__PURE__ */ react.createElement(ExternalLink, { href: usage.upgradeUrl }, t("usageUpgrade")) : null, failure === void 0 ? null : /* @__PURE__ */ react.createElement("span", { style: css.err }, t("usageStale"), "：", failure)));
		}
		//#endregion
		//#region src/client/components/settings-page.tsx
		/**
		* The model table, which every settings section renders.
		*
		* Each change posts through the host's revision-fenced config form and then
		* adopts the host's returned list, so the page shows what the adapter will
		* actually do rather than what the click hoped. A per-request ticket keeps a
		* slow earlier answer from overwriting a newer one when the user clicks
		* quickly, and a write whose result the re-read never confirms is reported as
		* not applied instead of as saved.
		*
		* @module dsh-agent-sdk-bridge/client/components/settings-page
		*/
		/**
		* Re-read until the list reflects what was just written, or give up.
		*
		* The host commits a volatile config edit into the running plugin before it
		* answers the write, so the first read after `set()` normally already shows the
		* change and this returns immediately. The retries exist for the cases where it
		* does not: a reload that briefly unpublished the route, or a host that answered
		* ahead of its own commit.
		*/
		async function readUntil(fetchModels, verify, adopt, currentKind, requestedKind) {
			let rows;
			for (let attempt = 0; attempt < 5; attempt++) {
				const read = await fetchModels();
				if (currentKind() !== requestedKind) return void 0;
				rows = read.rows;
				adopt(read.rows, read.notice, read.signedIn);
				if (verify === void 0 || verify(rows)) return rows;
				await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 120));
			}
			return rows;
		}
		/** One settings section: the account card, the model list and the advanced block. */
		function SettingsPage({ ctx, t, brand }) {
			const form = ctx.configForms.get("llm-qoder-cn");
			/** CodeBuddy has two login regions and its own catalog per region. */
			const regional = brand.id === "codebuddy";
			const initialRegion = (form.getSnapshot()?.value ?? {}).codebuddyRegion === "cn" ? "cn" : "global";
			const snapshotFor = (target) => codeBuddySnapshot(target);
			const [region, setRegion] = (0, react.useState)(initialRegion);
			const modelsKind = regional ? `models:${region}` : "models";
			const [models, setModels] = (0, react.useState)(() => {
				const cached = readCache(brand.id, modelsKind);
				return Array.isArray(cached?.rows) ? cached.rows : void 0;
			});
			const [catalogNotice, setCatalogNotice] = (0, react.useState)(() => {
				const cached = readCache(brand.id, modelsKind);
				return typeof cached?.notice === "string" ? cached.notice : void 0;
			});
			const [signedIn, setSignedIn] = (0, react.useState)(() => {
				if (!regional) return void 0;
				const cached = readCache(brand.id, modelsKind);
				const authSignedIn = snapshotFor(initialRegion)?.auth?.signedIn === true;
				return cached?.signedIn === true || authSignedIn;
			});
			const [error, setError] = (0, react.useState)(void 0);
			const [status, setStatus] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			/**
			* Whether a catalog read is in flight.
			*
			* Kept apart from `busy`, which belongs to config writes: a refresh is a
			* read that can take as long as a CLI cold start, and it used to give no
			* feedback at all — the list silently changed shape seconds after the click.
			* The refresh action is also the account refresh, so this is what tells the
			* user that the quota card and the model table are being re-read together.
			*/
			const [reading, setReading] = (0, react.useState)(false);
			const [query, setQuery] = useUrlText("q", "");
			const [onlyEnabled, setOnlyEnabled] = useUrlFlag("only", false);
			const [showAdvanced, setShowAdvanced] = useUrlFlag("advanced", false);
			const [usageTick, setUsageTick] = (0, react.useState)(0);
			const ticket = (0, react.useRef)(0);
			/** Separate from `ticket`: `load()` bumps that one, so sharing it would make
			*  every write look stale the moment its own refresh landed. */
			const writeTicket = (0, react.useRef)(0);
			const modelSearchId = useInstanceId("dssb-model-search");
			const subscribe = (0, react.useCallback)((listener) => form.subscribe(listener), [form]);
			const read = (0, react.useCallback)(() => form.getSnapshot(), [form]);
			const snapshot = (0, react.useSyncExternalStore)(subscribe, read, read);
			const configuredRegion = snapshot?.value?.codebuddyRegion === "cn" ? "cn" : "global";
			/**
			* The region the user just picked, until the config write lands.
			*
			* Without this, a snapshot that still carries the old value would pull the
			* selection back mid-switch.
			*/
			const pendingRegion = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!regional) return;
				if (pendingRegion.current !== null) {
					if (pendingRegion.current === configuredRegion) pendingRegion.current = null;
					return;
				}
				setRegion((current) => current === configuredRegion ? current : configuredRegion);
			}, [regional, configuredRegion]);
			const selectRegion = (0, react.useCallback)((next) => {
				pendingRegion.current = next;
				setRegion(next);
			}, []);
			const fields = brand.id === "codebuddy" ? {
				disabled: region === "cn" ? "codebuddyCnDisabledModels" : "codebuddyGlobalDisabledModels",
				windows: region === "cn" ? "codebuddyCnModelContextWindows" : "codebuddyGlobalModelContextWindows"
			} : brand.fields;
			const describeFace = ctx.configForms.describe();
			const describeSubscribe = (0, react.useCallback)((listener) => describeFace.subscribe(listener), [describeFace]);
			const describeRead = (0, react.useCallback)(() => describeFace.getSnapshot(), [describeFace]);
			const describeSnapshot = (0, react.useSyncExternalStore)(describeSubscribe, describeRead, describeRead);
			(0, react.useEffect)(() => {
				describeFace.ensure().catch(() => void 0);
			}, [describeFace]);
			const fetchModels = (0, react.useCallback)(async (fresh = false) => {
				const regionQuery = regional ? `&region=${region}` : "";
				const payload = await api(`/models?brand=${brand.id}${regionQuery}${fresh ? "&fresh=1" : ""}`);
				if (regional && typeof payload?.region === "string" && payload.region !== region) throw new Error(t("codebuddyRegionMismatch"));
				return {
					rows: Array.isArray(payload?.models) ? payload.models : [],
					notice: typeof payload?.notice === "string" ? payload.notice : void 0,
					signedIn: regional ? payload?.signedIn === true : void 0
				};
			}, [
				brand.id,
				regional,
				region,
				t
			]);
			/** Adopt one read and remember it for the next visit to this region. */
			const adopt = (0, react.useCallback)((rows, notice, nextSignedIn) => {
				setModels(rows);
				setCatalogNotice(notice);
				setSignedIn(nextSignedIn);
				writeCache(brand.id, modelsKind, {
					rows,
					notice,
					signedIn: nextSignedIn,
					at: Date.now()
				});
			}, [brand.id, modelsKind]);
			/** Latest values for callbacks the account card holds across renders. */
			const kindRef = (0, react.useRef)(modelsKind);
			kindRef.current = modelsKind;
			/** Read the list. `fresh` asks the host to drop its catalog cache first. */
			const load = (0, react.useCallback)(async (fresh = false) => {
				const requestedKind = modelsKind;
				setError(void 0);
				setReading(true);
				const mine = ++ticket.current;
				try {
					const read = await fetchModels(fresh);
					if (mine !== ticket.current || kindRef.current !== requestedKind) return;
					adopt(read.rows, read.notice, read.signedIn);
				} catch (caught) {
					if (mine !== ticket.current || kindRef.current !== requestedKind) return;
					setError(String(caught?.message ?? caught));
					setModels((previous) => previous ?? []);
				} finally {
					if (mine === ticket.current) setReading(false);
				}
			}, [
				adopt,
				fetchModels,
				modelsKind
			]);
			const loadRef = (0, react.useRef)(load);
			loadRef.current = load;
			/** The region of the last model read; a change forces a fresh read. */
			const lastLoaded = (0, react.useRef)(void 0);
			const refresh = (0, react.useCallback)(() => {
				loadRef.current();
			}, []);
			/**
			* Re-read the whole account: the model list and the quota card together.
			*
			* They come from two routes, and the quota is the fast one — a single control
			* call — while the catalog is a cold-start round trip that an account just
			* logged in may wait on for seconds. Refreshing only one of them showed the
			* new quota beside the previous account's model list, which reads as "the
			* models are not there yet" even though nothing had asked for them. One
			* action starts both, so the page converges instead of half-updating.
			*/
			const refreshAccount = (0, react.useCallback)(() => {
				setUsageTick((value) => value + 1);
				loadRef.current(true);
			}, []);
			/**
			* On a region switch, paint that region's remembered table first and then
			* verify it with the host. The read carries the region explicitly, so it
			* stays correct even before the config write commits.
			*/
			(0, react.useEffect)(() => {
				if (regional) {
					const saved = readCache(brand.id, modelsKind);
					const codeBuddyAccount = brand.id === "codebuddy" ? codeBuddySnapshot(region) : void 0;
					setModels(Array.isArray(saved?.rows) ? saved.rows : void 0);
					setCatalogNotice(typeof saved?.notice === "string" ? saved.notice : void 0);
					setSignedIn(saved?.signedIn === true || codeBuddyAccount?.auth?.signedIn === true);
					setError(void 0);
				}
				const switched = regional && lastLoaded.current !== void 0 && lastLoaded.current !== region;
				lastLoaded.current = region;
				load(switched);
			}, [
				brand.id,
				regional,
				modelsKind,
				region,
				load,
				t
			]);
			/** Login/logout flips which catalog the page is allowed to show. */
			const handleAuthChange = (0, react.useCallback)((next) => {
				if (!regional) return;
				setSignedIn(next);
				if (next) {
					refresh();
					return;
				}
				setModels([]);
				setCatalogNotice(void 0);
				writeCache(brand.id, kindRef.current, {
					rows: [],
					notice: void 0,
					signedIn: false,
					at: Date.now()
				});
			}, [
				brand.id,
				regional,
				refresh
			]);
			/**
			* Apply one change through the shared config form, then re-read until the
			* list reflects it.
			*
			* `busy` is owned by the newest write alone, and is always cleared in
			* `finally`. It must NOT be gated on the read generation: the read bumps that
			* counter, so gating there would leave `busy` set forever and every control
			* disabled.
			*/
			const write = (0, react.useCallback)(async (key, next, verify) => {
				const mine = ++writeTicket.current;
				setBusy(true);
				setStatus(t("saving"));
				setError(void 0);
				try {
					if (await withDeadline(next === void 0 ? form.unset(key) : form.set(key, next), 2e4, t("timeout")) === false) throw new Error(t("saveFailed"));
					const rows = await readUntil(fetchModels, verify, adopt, () => kindRef.current, kindRef.current);
					if (rows !== void 0 && verify !== void 0 && !verify(rows)) throw new Error(t("notApplied"));
					if (mine === writeTicket.current) setStatus(t("saved"));
				} catch (caught) {
					if (mine !== writeTicket.current) return;
					setError(`${t("saveFailed")}：${String(caught?.message ?? caught)}`);
					setStatus(void 0);
					await load();
				} finally {
					if (mine === writeTicket.current) setBusy(false);
				}
			}, [
				adopt,
				fetchModels,
				form,
				load,
				t
			]);
			/**
			* Write the whole disabled-model list, derived from the rows the user just
			* changed, so rapid toggles cannot lose each other's edits.
			*
			* The row is updated locally first: the host commits the value before it
			* answers, so the re-read confirms this instead of correcting it, and the
			* switch never appears to snap back to where it was.
			*/
			const writeDisabled = (0, react.useCallback)((rows, id, enabled) => {
				const next = new Set(rows.filter((model) => !model.enabled).map((model) => model.id));
				if (enabled) next.delete(id);
				else next.add(id);
				setModels((current) => current?.map((model) => model.id === id ? {
					...model,
					enabled
				} : model));
				return write(fields.disabled, [...next], (list) => list.some((model) => model.id === id && model.enabled === enabled));
			}, [fields.disabled, write]);
			/** Write the whole per-model window map, again showing the choice at once. */
			const writeWindow = (0, react.useCallback)((rows, id, window) => {
				const next = {};
				for (const model of rows) if (model.override !== void 0) next[model.id] = model.override;
				if (window === void 0) delete next[id];
				else next[id] = window;
				setModels((current) => current?.map((model) => model.id === id ? {
					...model,
					override: window,
					contextWindow: window ?? model.defaultContextWindow
				} : model));
				return write(fields.windows, next, (list) => list.some((model) => model.id === id && (window === void 0 ? model.override === void 0 : model.override === window)));
			}, [fields.windows, write]);
			/**
			* Flip every model at once.
			*
			* Enabling all writes an empty deny-list rather than every id, so a model the
			* account publishes later still defaults to on.
			*/
			const writeAll = (0, react.useCallback)((enabled) => {
				const ids = (models ?? []).map((model) => model.id);
				setModels((current) => current?.map((model) => ({
					...model,
					enabled
				})));
				return write(fields.disabled, enabled ? [] : ids, (list) => list.every((model) => model.enabled === enabled));
			}, [
				fields.disabled,
				models,
				write
			]);
			const all = models ?? [];
			const enabledTotal = all.filter((model) => model.enabled).length;
			const shown = (0, react.useMemo)(() => {
				const needle = query.trim().toLowerCase();
				return all.filter((model) => {
					if (onlyEnabled && !model.enabled) return false;
					if (needle === "") return true;
					return String(model.name).toLowerCase().includes(needle) || String(model.id).toLowerCase().includes(needle);
				});
			}, [
				all,
				query,
				onlyEnabled
			]);
			const regionalLocked = regional && signedIn !== true;
			const authCard = brand.kind === "codebuddy" ? /* @__PURE__ */ react.createElement(CodeBuddyCard, {
				t,
				ctx,
				brand,
				refreshSignal: usageTick,
				onSignedIn: () => {
					refresh();
					setUsageTick((value) => value + 1);
				},
				onAuthChange: handleAuthChange,
				onRegionChange: selectRegion
			}) : null;
			/**
			* Red guidance for "no models".
			*
			* An empty list is almost always the machine, not the account: the CLI is
			* missing or signed out, so the catalog has nothing to return. This page
			* says what the machine is missing; running the installer is not its job.
			*/
			const guide = /* @__PURE__ */ react.createElement("div", { style: css.guide }, /* @__PURE__ */ react.createElement("div", { style: css.guideText }, t(brand.noModelsKey)));
			if (regionalLocked) return /* @__PURE__ */ react.createElement("div", {
				className: CLASS.page,
				style: css.page
			}, /* @__PURE__ */ react.createElement("h2", { style: css.h2 }, t(brand.titleKey)), /* @__PURE__ */ react.createElement("p", { style: css.intro }, t(brand.introKey)), authCard, /* @__PURE__ */ react.createElement("div", { style: css.guide }, /* @__PURE__ */ react.createElement("div", { style: css.guideText }, t("codebuddyModelsHint"))), /* @__PURE__ */ react.createElement(LiveAlert, null, error));
			if (models === void 0) return /* @__PURE__ */ react.createElement("div", {
				className: CLASS.page,
				style: css.page
			}, /* @__PURE__ */ react.createElement("h2", { style: css.h2 }, t(brand.titleKey)), /* @__PURE__ */ react.createElement("p", { style: css.intro }, t(brand.introKey)), regional ? authCard : null, error === void 0 ? /* @__PURE__ */ react.createElement(LiveStatus, null, t("loading")) : /* @__PURE__ */ react.createElement("div", null, /* @__PURE__ */ react.createElement(LiveAlert, null, `${t("loadFailed")}：${error}`), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: {
					...css.btn,
					marginTop: "8px"
				},
				disabled: reading,
				onClick: refreshAccount
			}, reading ? t("refreshing") : t("retry")), /* @__PURE__ */ react.createElement("div", { style: { marginTop: "10px" } }, guide)));
			const rows = shown.map((model, index) => {
				const choices = Array.isArray(model.contextWindows) ? model.contextWindows : [];
				const fixedWindow = model.contextWindowSelectable === false || choices.length === 0;
				const offered = choices.filter((size) => size !== model.defaultContextWindow || size === model.override).map((size) => ({
					value: String(size),
					label: windowLabel(size)
				}));
				const checkboxId = `dssb-model-${brand.id}-${index}`;
				return /* @__PURE__ */ react.createElement("div", {
					key: model.id,
					className: CLASS.row,
					style: {
						...css.row,
						...index === 0 ? css.rowFirst : {},
						...model.enabled ? {} : css.rowOff
					}
				}, /* @__PURE__ */ react.createElement("input", {
					id: checkboxId,
					type: "checkbox",
					className: CLASS.check,
					style: css.switch,
					checked: model.enabled === true,
					disabled: busy,
					onChange: (event) => {
						writeDisabled(all, model.id, event.target.checked);
					}
				}), /* @__PURE__ */ react.createElement("div", { style: css.name }, /* @__PURE__ */ react.createElement("label", {
					htmlFor: checkboxId,
					className: CLASS.hit,
					style: {
						display: "flex",
						alignItems: "baseline",
						minWidth: 0
					}
				}, /* @__PURE__ */ react.createElement("span", {
					style: css.nameText,
					title: model.name,
					translate: "no"
				}, model.name), model.vision === true ? /* @__PURE__ */ react.createElement("span", { style: {
					...css.tag,
					marginLeft: "6px"
				} }, t("vision")) : null, priceSuffix(t, model.priceFactor) !== "" ? /* @__PURE__ */ react.createElement("span", { style: css.price }, ` · ${priceSuffix(t, model.priceFactor)}`) : null), /* @__PURE__ */ react.createElement("div", {
					style: css.id,
					translate: "no"
				}, model.id)), fixedWindow ? /* @__PURE__ */ react.createElement("span", {
					style: {
						...css.note,
						minWidth: "104px",
						textAlign: "right"
					},
					title: t("windowFixedHint")
				}, `${windowLabel(model.contextWindow ?? model.defaultContextWindow)} · ${t("windowFixed")}`) : /* @__PURE__ */ react.createElement("select", {
					className: CLASS.select,
					style: css.select,
					value: model.override === void 0 ? "" : String(model.override),
					disabled: busy,
					title: t("windowDefaultHint"),
					"aria-label": `${model.name} ${t("windowSelectLabel")}`,
					onChange: (event) => {
						const next = event.target.value;
						writeWindow(all, model.id, next === "" ? void 0 : Number(next));
					}
				}, /* @__PURE__ */ react.createElement("option", { value: "" }, `${t("windowDefault")} · ${windowLabel(model.defaultContextWindow)}`), offered.map((choice) => /* @__PURE__ */ react.createElement("option", {
					key: choice.value,
					value: choice.value
				}, choice.label))));
			});
			const advanced = /* @__PURE__ */ react.createElement(AdvancedBlock, {
				t,
				form,
				snapshot,
				fields: ADVANCED[brand.id],
				namespace: describeSnapshot?.view?.namespaces?.find((namespace) => namespace.ns === "llm-qoder-cn"),
				show: showAdvanced,
				onToggle: () => setShowAdvanced(!showAdvanced)
			});
			return /* @__PURE__ */ react.createElement("div", {
				className: CLASS.page,
				style: css.page
			}, /* @__PURE__ */ react.createElement("h2", { style: css.h2 }, t(brand.titleKey)), /* @__PURE__ */ react.createElement("p", { style: css.intro }, t(brand.introKey)), regional ? authCard : /* @__PURE__ */ react.createElement(UsageCard, {
				t,
				brand,
				refreshSignal: usageTick,
				onRefresh: refreshAccount
			}), /* @__PURE__ */ react.createElement("div", { style: css.bar }, /* @__PURE__ */ react.createElement("label", {
				htmlFor: modelSearchId,
				className: CLASS.visuallyHidden
			}, t("searchLabel")), /* @__PURE__ */ react.createElement("input", {
				id: modelSearchId,
				name: "dsh-agent-sdk-bridge-model-search",
				type: "search",
				className: CLASS.input,
				style: {
					...css.input,
					...css.search
				},
				placeholder: t("search"),
				value: query,
				autoComplete: "off",
				spellCheck: false,
				onChange: (event) => setQuery(event.target.value)
			}), /* @__PURE__ */ react.createElement("label", { style: {
				...css.note,
				display: "flex",
				alignItems: "center",
				gap: "6px",
				whiteSpace: "nowrap",
				cursor: "pointer"
			} }, /* @__PURE__ */ react.createElement("input", {
				type: "checkbox",
				className: CLASS.check,
				style: {
					...css.switch,
					width: "15px",
					height: "15px"
				},
				checked: onlyEnabled,
				onChange: (event) => setOnlyEnabled(event.target.checked)
			}), t("onlyEnabled"))), /* @__PURE__ */ react.createElement("div", { style: css.actions }, /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				disabled: busy || reading,
				onClick: refreshAccount
			}, reading ? t("refreshing") : t("refresh")), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				disabled: busy || all.every((model) => model.enabled),
				onClick: () => void writeAll(true)
			}, t("selectAll")), /* @__PURE__ */ react.createElement("button", {
				type: "button",
				className: CLASS.button,
				style: css.btn,
				disabled: busy || enabledTotal === 0,
				onClick: () => void writeAll(false)
			}, t("selectNone")), /* @__PURE__ */ react.createElement("span", {
				className: CLASS.tabular,
				style: css.count
			}, `${t("enabledCount")} ${enabledTotal} / ${all.length}`)), all.length === 0 ? guide : /* @__PURE__ */ react.createElement("div", {
				style: css.list,
				role: "group",
				"aria-label": t("modelListLabel")
			}, rows.length > 0 ? rows : /* @__PURE__ */ react.createElement("div", { style: {
				...css.note,
				padding: "12px 14px"
			} }, t("noMatch"))), catalogNotice === void 0 ? null : /* @__PURE__ */ react.createElement("div", { style: css.note }, catalogNotice), all.length > 0 ? /* @__PURE__ */ react.createElement("div", { style: css.note }, t("windowWarn")) : null, /* @__PURE__ */ react.createElement(LiveAlert, null, error), /* @__PURE__ */ react.createElement(LiveStatus, null, error === void 0 ? status : void 0), brand.cliGroupKey === void 0 || brand.cliHintKey === void 0 ? null : /* @__PURE__ */ react.createElement("div", { style: css.group }, /* @__PURE__ */ react.createElement("h3", { style: css.h3 }, t(brand.cliGroupKey)), /* @__PURE__ */ react.createElement("div", { style: css.note }, t(brand.cliHintKey))), advanced);
		}
		//#endregion
		//#region src/client/copy.ts
		/**
		* Copy for the settings pages, in the two languages the shell offers.
		*
		* One flat dictionary per language, and `en` is typed against `zh`'s key set:
		* a string added to one side is a type error on the other, which is the only
		* thing that keeps two hand-maintained dictionaries in step. `advancedFields`
		* is the one nested table — the advanced block renders it by field name.
		*
		* The page reads copy through the host's bound translator; only the advanced
		* block needs the nested table, and it reaches it through the same call because
		* the host's `t` returns whatever the dictionary holds.
		*
		* @module dsh-agent-sdk-bridge/client/copy
		*/
		/** Chinese copy; also the source of the key set every language must carry. */
		const zh = {
			nav: "Qoder CN",
			title: "Qoder CN",
			intro: "勾选要启用的模型，并为需要的模型指定上下文窗口。改动即时生效，无需重启。",
			loading: "正在读取模型列表…",
			loadFailed: "读取模型列表失败",
			retry: "重试",
			refresh: "刷新列表",
			refreshing: "刷新中…",
			saveFailed: "保存失败",
			notApplied: "服务器未报告这次改动，可能被其他窗口覆盖了，请刷新后重试",
			timeout: "保存超时，请重试",
			saved: "已保存",
			saving: "保存中…",
			enabledCount: "已启用",
			noModels: "账号没有返回任何模型：一般是本机 qoderclicn 还没装好，或者还没登录。",
			search: "搜索模型…",
			searchLabel: "搜索模型",
			noMatch: "没有匹配的模型；试试清空搜索。",
			onlyEnabled: "只看已启用",
			selectAll: "全部启用",
			selectNone: "全部关闭",
			colEnabled: "启用",
			modelListLabel: "模型列表",
			windowDefault: "默认",
			windowDefaultHint: "跟随上游声明的窗口",
			windowSelectLabel: "上下文窗口",
			windowFixed: "上游固定",
			windowFixedHint: "该模型在上游只提供这一个上下文窗口，选择其它值会被上游拒绝，因此这里不提供下拉选择。",
			vision: "读图",
			free: "免费",
			advanced: "高级设置",
			advancedHint: "以下为细节参数，通常无需改动。",
			show: "展开",
			hide: "收起",
			reset: "恢复默认",
			confirmYes: "确认",
			confirmCancel: "取消",
			advancedInvalid: "这一项不是有效的 JSON，已恢复为上次保存的值。",
			windowWarn: "窗口越大，DSH 的自动压缩触发得越晚。若对话经常超限，请选较小的窗口。",
			cliGroup: "Qoder CN CLI",
			cliHint: "插件复用本机 qoderclicn 的登录态。CLI 的安装、登录与退出都请按 Qoder 官方文档自行完成。",
			intlNav: "Qoder 国际版",
			intlTitle: "Qoder 国际版",
			intlIntro: "国际版账户（qoder.com）的模型与额度。勾选要启用的模型，并为需要的模型指定上下文窗口。改动即时生效，无需重启。",
			intlNoModels: "国际版账号没有返回任何模型：一般是本机 qodercli 还没装好，或者还没登录。",
			intlCliGroup: "Qoder 国际版 CLI",
			intlCliHint: "插件复用本机 qodercli 的登录态。CLI 的安装、登录与退出都请按 Qoder 官方文档自行完成。",
			usageTitle: "额度",
			usageLoading: "正在读取额度…",
			usageRefresh: "刷新额度",
			usageUnavailable: "无法读取额度",
			usageRetry: "重试",
			usageAccount: "账号",
			usagePlan: "套餐",
			usageUsed: "已用",
			usageRemaining: "剩余",
			usageCredits: "积分",
			usagePlanQuota: "套餐额度",
			usageAddOn: "加量包",
			usageOrgPackage: "组织资源包",
			usageExpires: "到期",
			usageNever: "长期有效",
			usageDetail: "用量明细",
			usageUpgrade: "升级套餐",
			usageExceeded: "额度已用完",
			usageUpdated: "更新于",
			usageUnknownPlan: "未知套餐",
			usageStale: "显示上次读数，刷新失败",
			usageCliMissing: "未检测到本机 CLI，安装并登录后才会显示额度。",
			pluginOptionsTitle: "启用的版本",
			pluginOptionsHint: "关闭后，对应设置页、模型列表与模型分组都会移除；已保存的模型选择保留，重新打开即可恢复。",
			pluginOptionsOn: "显示中",
			pluginOptionsOff: "已关闭",
			pluginOptionsReadOnly: "当前配置不可写",
			pluginOptionsRejected: "宿主拒绝了这次改动；若刚更新过插件，请重启 DSH 后再试",
			codebuddyNav: "CodeBuddy",
			codebuddyTitle: "CodeBuddy",
			codebuddyIntro: "腾讯 CodeBuddy 账户的模型。请先在下方选择登录区域并登录，再勾选要启用的模型。",
			codebuddyNoModels: "CodeBuddy 账号没有返回任何模型：请确认已选择登录区域并完成登录。",
			codebuddyAuthTitle: "登录",
			codebuddyAuthHint: "CodeBuddy 分国际版与国内版，两边账号与模型目录独立。企业域名登录不在本插件支持范围内。",
			codebuddyRegionGlobal: "国际版（codebuddy.ai）",
			codebuddyRegionCn: "国内版（copilot.tencent.com）",
			codebuddyRegionLabel: "登录区域",
			codebuddyLogin: "登录",
			codebuddyLogout: "退出登录",
			codebuddyLoggingIn: "请在浏览器中完成登录…",
			codebuddyLoginPrompt: "登录后这里会显示账号与额度信息。",
			codebuddyModelsHint: "请先登录 CodeBuddy，登录后才会读取并显示可用模型。",
			codebuddyRegionMismatch: "宿主返回的模型列表不属于当前区域，请刷新页面后重试。",
			codebuddyLoginStarted: "已打开浏览器，完成登录后这里会自动更新。",
			codebuddyLoginFailed: "登录失败",
			codebuddyOpenUrl: "手动打开登录页",
			codebuddyLoggedOut: "已退出登录",
			codebuddyNotLoggedIn: "未登录",
			codebuddySignedIn: "已登录",
			codebuddyAccountUnknown: "账号信息暂不可用",
			codebuddyNoQuota: "暂时无法读取额度。",
			codebuddyQuotaFailed: "额度读取失败",
			codebuddyQuotaTitle: "积分额度",
			codebuddyQuotaPackages: "积分包",
			codebuddyQuotaExpires: "最近到期",
			codebuddyQuotaPackUsage: "已用 / 总额",
			codebuddyQuotaPackDetail: "详细信息",
			codebuddyQuotaPackCollapse: "收起",
			codebuddyConfirmLogout: "确定要退出当前区域的 CodeBuddy 登录吗？",
			advancedFields: {
				displayName: "分组名称",
				maxSessions: "并发会话数",
				modelCacheTtlSeconds: "模型列表缓存（秒）",
				defaultReasoningEffort: "默认思考档位",
				defaultMaxTokens: "默认输出上限",
				toolResultTimeoutSeconds: "工具结果等待（秒）",
				catalogFetchTimeoutSeconds: "模型列表超时（秒）",
				abortGraceSeconds: "中断宽限（秒）",
				coldMaxTurns: "旁路请求轮次",
				modelAliases: "模型别名",
				intlDisplayName: "国际版分组名称",
				intlModelAliases: "国际版模型别名",
				codebuddyDisplayName: "CodeBuddy 分组名称",
				codebuddyModelAliases: "CodeBuddy 模型别名"
			}
		};
		/** English copy. Typed against {@link CopyTable}, so a missing key fails the build. */
		const en = {
			nav: "Qoder CN",
			title: "Qoder CN",
			intro: "Tick the models you want available and set a context window where needed. Changes apply immediately.",
			loading: "Loading models…",
			loadFailed: "Could not load the model list",
			retry: "Retry",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			saveFailed: "Save failed",
			notApplied: "The host did not report this change; another window may have overwritten it. Refresh and retry.",
			timeout: "Save timed out; please retry",
			saved: "Saved",
			saving: "Saving…",
			enabledCount: "enabled",
			noModels: "The account returned no models — usually qoderclicn is not installed on this machine, or not signed in.",
			search: "Search models…",
			searchLabel: "Search models",
			noMatch: "No models match — try clearing the search field.",
			onlyEnabled: "Enabled only",
			selectAll: "Enable all",
			selectNone: "Disable all",
			colEnabled: "On",
			modelListLabel: "Model list",
			windowDefault: "Default",
			windowDefaultHint: "Follow upstream's declared window",
			windowSelectLabel: "Context window",
			windowFixed: "fixed upstream",
			windowFixedHint: "This model offers exactly one context window upstream; any other value is rejected, so there is no selector here.",
			vision: "Vision",
			free: "Free",
			advanced: "Advanced",
			advancedHint: "Detail parameters; rarely changed.",
			show: "Show",
			hide: "Hide",
			reset: "Reset",
			confirmYes: "Confirm",
			confirmCancel: "Cancel",
			advancedInvalid: "This value is not valid JSON; the last saved value is back in place.",
			windowWarn: "A larger window delays DSH’s auto-compaction. Pick a smaller one if conversations overflow.",
			cliGroup: "Qoder CN CLI",
			cliHint: "The plugin reuses this machine’s qoderclicn sign-in. Install, sign in and sign out through Qoder’s own documentation.",
			intlNav: "Qoder International",
			intlTitle: "Qoder International",
			intlIntro: "Models and quota for the international account (qoder.com). Tick the models you want available and set a context window where needed. Changes apply immediately.",
			intlNoModels: "The international account returned no models — usually qodercli is not installed on this machine, or not signed in.",
			intlCliGroup: "Qoder International CLI",
			intlCliHint: "The plugin reuses this machine’s qodercli sign-in. Install, sign in and sign out through Qoder’s own documentation.",
			usageTitle: "Quota",
			usageLoading: "Reading quota…",
			usageRefresh: "Refresh quota",
			usageUnavailable: "Could not read the quota",
			usageRetry: "Retry",
			usageAccount: "Account",
			usagePlan: "Plan",
			usageUsed: "Used",
			usageRemaining: "Remaining",
			usageCredits: "credits",
			usagePlanQuota: "Plan quota",
			usageAddOn: "Add-on package",
			usageOrgPackage: "Organization package",
			usageExpires: "Expires",
			usageNever: "No expiry",
			usageDetail: "Usage details",
			usageUpgrade: "Upgrade",
			usageExceeded: "Quota exhausted",
			usageUpdated: "Updated",
			usageUnknownPlan: "Unknown plan",
			usageStale: "Showing the last reading; refresh failed",
			usageCliMissing: "This machine has no CLI for this edition; quota appears after it is installed and signed in.",
			pluginOptionsTitle: "Enabled editions",
			pluginOptionsHint: "Turning one off removes its settings page, model list, and model group. Saved model choices are kept, so turning it back on restores them.",
			pluginOptionsOn: "Shown",
			pluginOptionsOff: "Off",
			pluginOptionsReadOnly: "This configuration is read-only",
			pluginOptionsRejected: "The host rejected this change; if you just updated the plugin, restart DSH and retry",
			codebuddyNav: "CodeBuddy",
			codebuddyTitle: "CodeBuddy",
			codebuddyIntro: "Models for your Tencent CodeBuddy account. Choose a login region below and sign in before enabling models.",
			codebuddyNoModels: "The CodeBuddy account returned no models: make sure a region is selected and the browser login completed.",
			codebuddyAuthTitle: "Sign in",
			codebuddyAuthHint: "CodeBuddy has independent international and mainland accounts with their own model catalogs. Enterprise-domain login is out of scope for this plugin.",
			codebuddyRegionGlobal: "International (codebuddy.ai)",
			codebuddyRegionCn: "Mainland (copilot.tencent.com)",
			codebuddyRegionLabel: "Login region",
			codebuddyLogin: "Sign in",
			codebuddyLogout: "Sign out",
			codebuddyLoggingIn: "Finish the sign-in in your browser…",
			codebuddyLoginPrompt: "Sign in to see the account and quota here.",
			codebuddyModelsHint: "Sign in to CodeBuddy first; the model catalog is read only after sign-in.",
			codebuddyRegionMismatch: "The host answered with the other region’s models; reload the page and try again.",
			codebuddyLoginStarted: "Browser opened; this card updates when the login completes.",
			codebuddyLoginFailed: "Sign-in failed",
			codebuddyOpenUrl: "Open the sign-in page",
			codebuddyLoggedOut: "Signed out",
			codebuddyNotLoggedIn: "Not signed in",
			codebuddySignedIn: "Signed in",
			codebuddyAccountUnknown: "Account details are unavailable",
			codebuddyNoQuota: "The quota is temporarily unavailable.",
			codebuddyQuotaFailed: "Could not read the quota",
			codebuddyQuotaTitle: "Credits",
			codebuddyQuotaPackages: "Credit packages",
			codebuddyQuotaExpires: "Earliest expiry",
			codebuddyQuotaPackUsage: "used / total",
			codebuddyQuotaPackDetail: "Details",
			codebuddyQuotaPackCollapse: "Collapse",
			codebuddyConfirmLogout: "Sign out of CodeBuddy for the selected region?",
			advancedFields: {
				displayName: "Group name",
				maxSessions: "Concurrent sessions",
				modelCacheTtlSeconds: "Catalog cache (s)",
				defaultReasoningEffort: "Default reasoning effort",
				defaultMaxTokens: "Default output cap",
				toolResultTimeoutSeconds: "Tool result wait (s)",
				catalogFetchTimeoutSeconds: "Catalog timeout (s)",
				abortGraceSeconds: "Abort grace (s)",
				coldMaxTurns: "Side-channel turns",
				modelAliases: "Model aliases",
				intlDisplayName: "International group name",
				intlModelAliases: "International model aliases",
				codebuddyDisplayName: "CodeBuddy group name",
				codebuddyModelAliases: "CodeBuddy model aliases"
			}
		};
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-agent-sdk-bridge — browser half.
		*
		* Contributes one top-level settings section per enabled provider (`qoder-cn`,
		* `qoder-intl`, `codebuddy`), each showing its account card and then
		* the model list: every model the account exposes, with an on/off switch and a
		* context-window choice, plus a collapsed "advanced" area holding the scalars
		* worth reaching without editing YAML. The plugin manager's page for this
		* bundle carries the switches that decide which of those sections exist.
		*
		* The model list cannot come from the config form: it is fetched live from the
		* provider. So the page reads `GET <prefix>/models`, which joins that live
		* catalog with the user's stored choices, while every change goes back through
		* the host's own config form. The host owns the catalog, so the page never
		* derives state the adapter does not share.
		*
		* The page can also start the CLI helper shipped with this package
		* (`POST <prefix>/setup`, then `GET <prefix>/setup` for its output): installing
		* and signing into a CLI is a local action a browser cannot perform.
		*
		* @module dsh-agent-sdk-bridge/client
		*/
		/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
		const name = "dsh-agent-sdk-bridge";
		/** Everything this half needs from the shell before it can render. */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/** The plugin's config namespace — must equal the profile row id. */
		const NS = "llm-qoder-cn";
		/**
		* Register the sections that are currently switched on, and keep that set in
		* step with the edition switches.
		*
		* A section exists only while its edition does: the plugin page's switches
		* decide whether the settings page, its models and its fields are offered at
		* all. They cannot be registered unconditionally and hidden, because a
		* registered `settings.section` is exactly what puts an entry in the nav.
		*/
		function apply(ctx) {
			installStyles();
			if (ctx.locale === void 0 || ctx.slots === void 0 || ctx.configForms === void 0) return;
			const locale = ctx.locale;
			const slots = ctx.slots;
			const configForms = ctx.configForms;
			const t = locale.bind(NS);
			ctx.effect(() => locale.register(NS, {
				zh,
				en
			}), "llm-qoder-cn: dictionaries");
			ctx.effect(() => slots.inject("plugins.bundle.config", () => slots.register({
				name: "plugins.bundle.config",
				key: "dsh-agent-sdk-bridge",
				locale: NS
			}, (props) => /* @__PURE__ */ react.createElement(BundleSettings, {
				...props,
				ctx,
				t
			}))), "llm-qoder-cn: bundle options");
			ctx.effect(() => configForms.whileServed([NS], () => {
				const form = configForms.get(NS);
				const live = /* @__PURE__ */ new Map();
				const sync = () => {
					const snapshot = form.getSnapshot();
					if (snapshot?.status !== "ready") return;
					const value = snapshot.value ?? {};
					for (const brand of BRANDS) {
						const enabled = value[brand.fields.enabled] !== false;
						const current = live.get(brand.id);
						if (enabled && current === void 0) live.set(brand.id, slots.inject("settings.section", () => slots.register({
							name: "settings.section",
							id: brand.settingsId,
							order: brand.order,
							label: () => locale.bind(NS)(brand.navKey),
							locale: NS
						}, (props) => /* @__PURE__ */ react.createElement(SettingsPage, {
							...props,
							ctx,
							t,
							brand
						}))));
						else if (!enabled && current !== void 0) {
							current();
							live.delete(brand.id);
						}
					}
				};
				const unsubscribe = form.subscribe(sync);
				sync();
				return () => {
					unsubscribe();
					for (const off of live.values()) off();
					live.clear();
				};
			}), "llm-qoder-cn: pages");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
