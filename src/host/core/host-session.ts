/**
 * The session plumbing every provider shares: the MCP server name host tools are
 * exposed under, the content/result shapes that cross that boundary, and the
 * three pieces that make host tool calls work at all — the registry that keeps
 * the MCP tool set equal to the host's live set, the queue a turn's chunks flow
 * through, and the pairing that hands each tool call its result.
 *
 * Nothing here knows about a specific CLI: each backend feeds these the same
 * way, which is why they live in `core` rather than in one provider.
 *
 * @module dsh-agent-sdk-bridge/core/host-session
 */

import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { jsonSchemaToShape } from './jsonschema.ts'

/** MCP server name every adapter exposes host tools under. */
export const MCP_SERVER_NAME = 'dsh-host'

/**
 * One user-turn content block on the streaming-input channel. Text is the
 * historical shape; image blocks use the SDK's Claude-compatible base64
 * vision shape (`ImageContentBlock`).
 */
export type ChannelContent =
  | { type: 'text', text: string }
  | { type: 'image', source: { type: 'base64', media_type: string, data: string } }

/** One MCP tool-result content block: text, or the MCP image shape. */
export type McpContent =
  | { type: 'text', text: string }
  | { type: 'image', data: string, mimeType: string }

/** A host tool result delivered to a parked or buffered MCP handler. */
export interface ToolResultPayload {
  content: McpContent[]
  isError: boolean
}

/**
 * Request-image bytes resolved by the adapter, keyed by attachment id. An id
 * missing from the map degrades to handle text instead of failing the turn.
 */
export type ResolvedImages = ReadonlyMap<string, { data: string, mediaType: string }>

/** The handle the MCP SDK returns from (and exposes on) `registerTool`. */
export interface RegisteredToolHandle {
  /**
   * Replace this tool's definition in place.
   *
   * The SDK also toggles `enabled`, which is what lets a tool the host withdrew
   * actually disappear from `tools/list` instead of only stopping its handler.
   */
  update(updates: { description?: string, paramsSchema?: Record<string, unknown>, enabled?: boolean }): void
  /** Unregister this tool, so the next `registerTool` on the name succeeds. */
  remove(): void
}

/** What this module needs from the SDK's MCP server instance. */
export interface ToolRegistryHost {
  registerTool(
    name: string,
    config: { description: string, inputSchema: Record<string, unknown> },
    handler: (args: unknown) => Promise<{ content: McpContent[], isError?: boolean }>,
  ): RegisteredToolHandle
  /** `markdown|json` — the tool list changed, so a client must re-read it. */
  sendToolListChanged?(): void
  /**
   * Declare the tools capability now, before any transport is connected.
   *
   * The MCP SDK (`McpServer`) only installs its `tools/list` + `tools/call`
   * request handlers — and only registers the `tools` capability, with
   * `listChanged` — the first time a tool is registered. A server created with
   * an empty tool list therefore connects with **no tools capability at all**,
   * and every later `registerTool` throws `Cannot register capabilities after
   * connecting to transport`. The client then answers `tools/list` with
   * `Method not found (-32601)`.
   *
   * That is exactly this bridge's first turn: `ensureTools()` runs when the host
   * has not published its tools yet, so the server connects empty. The next turn
   * brings `ops_bash` and friends, the registration throws, the tool never
   * appears in `tools/list`, and the model — which the host's own prompt and
   * `tool-addition` blocks say does have those tools — calls one anyway and is
   * told `Tool "…" does not exist in the current tool set.` Calling this before
   * `connect()` fixes it: the capability is declared up front, so tools can be
   * added and removed for the life of the session.
   */
  setToolRequestHandlers?(): void
}

/**
 * Keeps one in-process MCP server's tool set equal to the host's live set.
 *
 * The host's tool list is not fixed for a session's lifetime: `dsh-ops` adds
 * and withdraws tools as a session's mode changes and as `ops_discover_tools`
 * pulls a deferred capability in, and DSH republishes that change to the model
 * as `tool-addition` / `tool-removal` blocks. The MCP SDK, however, refuses a
 * second `registerTool` for a name it already holds ("Tool X is already
 * registered") and offers no unregister of its own, so a naive replay leaves a
 * changed schema at its old definition and can never take a withdrawn tool back
 * out. The model then calls a name the server does not have, and CodeBuddy
 * answers it with `Tool "…" does not exist in the current tool set.` instead of
 * a host result — the "tool went missing mid-conversation" symptom.
 *
 * This wrapper therefore reconciles by name: register what is new, `update()`
 * what changed, and `remove()` what the host withdrew. The call handler is built
 * per registered tool and answers through the session's tool-result pairing, so
 * a tool re-registered after a mode change still collects its own result.
 */
export class HostToolRegistry {
  /** What this registry has actually installed, by tool name, with its schema hash. */
  private readonly installed = new Map<string, { hash: string, handle: RegisteredToolHandle }>()

  constructor(
    /** The MCP server the tools are installed into. */
    private readonly host: ToolRegistryHost,
    /**
     * The call handler handed to the SDK for one tool.
     *
     * Built per registered tool and given the tool's name; the session's pairing
     * answers on the tool-use id it announced, not on the name.
     */
    private readonly handlerFor: (name: string) => ((args: unknown) => Promise<{ content: McpContent[], isError?: boolean }>),
    /** Receives anything the SDK refuses, so a silent gap never reaches the model. */
    private readonly onProblem: (message: string) => void = () => {},
  ) {}

  /**
   * Declare the tools capability before the transport connects.
   *
   * Must run before `connect()`, because the SDK refuses a capability change
   * afterwards. Without it a session whose first turn published no host tools
   * connects with no tools capability, and every tool the host offers later can
   * only throw — see {@link ToolRegistryHost.setToolRequestHandlers}.
   */
  prepare(): void {
    try {
      this.host.setToolRequestHandlers?.()
    } catch (error) {
      // A host whose SDK has no such hook (or that is already connected) still
      // works for a fixed tool set; only the mid-session add/remove is lost.
      this.onProblem(`MCP tools 能力未能在连接前声明：${errorText(error)}`)
    }
  }

  /**
   * Make the installed tool set match `tools` exactly.
   *
   * @param tools - the host's live tool schemas, in the order the host published them.
   * @returns whether anything was added, changed or removed.
   */
  reconcile(tools: readonly { name: string, description: string, parameters?: unknown }[]): boolean {
    const wanted = new Map<string, { hash: string, schema: { name: string, description: string, parameters?: unknown } }>()
    for (const schema of tools) {
      // Last write wins: the host never publishes a duplicate name, but a
      // duplicate must not leave the earlier definition installed. The
      // description is part of the signature: it is what tells the model *when*
      // to call the tool, so a reworded one is a definition change, not a no-op.
      const hash = JSON.stringify([schema.description, schema.parameters ?? {}])
      wanted.set(schema.name, { hash, schema })
    }

    let changed = false
    // Withdraw first: a name that changed incompatibly is safer to re-add than
    // to leave in place, and the host's own set is the contract.
    for (const [name, entry] of [...this.installed.entries()]) {
      if (wanted.has(name)) continue
      try {
        entry.handle.remove()
      } catch (error) {
        this.onProblem(`工具 ${name} 无法从 MCP 注销：${errorText(error)}`)
      }
      this.installed.delete(name)
      changed = true
    }

    for (const [name, { hash, schema }] of wanted) {
      const existing = this.installed.get(name)
      if (existing !== undefined && existing.hash === hash) continue
      const description = schema.description.length > 0 ? schema.description : name
      const inputSchema = jsonSchemaToShape((schema.parameters ?? {}) as Record<string, unknown>)
      if (existing !== undefined) {
        // The schema changed while the session stayed alive. Updating in place
        // keeps the tool listed with no gap for the model to notice.
        try {
          existing.handle.update({ description, paramsSchema: inputSchema })
          this.installed.set(name, { hash, handle: existing.handle })
          changed = true
          continue
        } catch (error) {
          this.onProblem(`工具 ${name} 的 schema 更新失败，改为重新注册：${errorText(error)}`)
          try {
            existing.handle.remove()
          } catch {
            // A handle that cannot update or remove is reported once, below,
            // when the fresh registration reports the same reason.
          }
          this.installed.delete(name)
        }
      }
      try {
        const handle = this.host.registerTool(name, { description, inputSchema }, this.handlerFor(name))
        this.installed.set(name, { hash, handle })
        changed = true
      } catch (error) {
        // Loud, and never silent: this is the one failure that removes a tool
        // from the model's world while the host still believes it is offered.
        this.onProblem(`宿主工具 ${name} 未能注册进 MCP server：${errorText(error)}`)
      }
    }

    if (changed) {
      try {
        this.host.sendToolListChanged?.()
      } catch {
        // Not connected yet, so no client is listening; the connect-time
        // `tools/list` still reports the reconciled set.
      }
    }
    return changed
  }

  /** Names currently installed, for diagnostics and tests. */
  names(): string[] {
    return [...this.installed.keys()]
  }
}

/** One error's message, for the diagnostics above. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One unit of a turn's output: a stream chunk, or the end marker. */
export type QueueItem =
  | { kind: 'chunk', chunk: StreamChunk }
  | { kind: 'turn-end', reason: FinishReason, usage?: TokenUsage }

/**
 * Unbounded FIFO the consumer pushes into and the active turn pumps out.
 *
 * Both backends drain it as an `AsyncIterable` (Qoder and CodeBuddy pump it with
 * `for await`). Closing it releases a parked reader, so a session that is torn
 * down mid-turn never leaves one waiting.
 */
export class TurnQueue<T = QueueItem> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private resolve: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  push(item: T): void {
    if (this.closed) return
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: (): Promise<IteratorResult<T>> => this.pump() }
  }

  /** Whether the turn already ended; late pushes are dropped. */
  get isClosed(): boolean {
    return this.closed
  }

  private pump(): Promise<IteratorResult<T>> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise(settle => { this.resolve = settle })
  }
}

interface ParkedResolver { (result: ToolResultPayload): void }

/** Message the inner model reads when a host turn superseded a parked call. */
const SUPERSEDED_CALL_TEXT = '[宿主取消了这次工具执行]'

/** Payload for a call the host request that followed it did not answer. */
function unansweredCall(toolUseId: string): ToolResultPayload {
  return {
    content: [{
      type: 'text',
      text: `宿主未返回这次工具调用的结果（toolUseId=${toolUseId}），本次工具调用已取消`,
    }],
    isError: true,
  }
}

/**
 * The tool-result bridge between an inner CLI and the host.
 *
 * The CLI announces a tool call twice, under two different identities:
 * `canUseTool` receives the CLI's own tool-use id *before* the call runs, while
 * the MCP `tools/call` handler that actually needs the host's result receives no
 * id at all. The two arrive in the same order, so a FIFO pairs them — and the
 * handler then parks under the exact id the host's result was filed under.
 *
 * ## Why that FIFO belongs to the session, not to a turn
 *
 * Measured against a live CLI, the handler can fire *after* the turn it belongs
 * to has already ended. The host answers a tool call as soon as it sees the
 * block, so the adapter's `deliverToolResults` files the result while nothing is
 * parked yet, and only then does the CLI get around to dispatching the MCP call:
 *
 * ```
 * 6198ms  [endTurn] kind=tool-calls
 * 6198ms  [host] no parked handler -> BUFFERED under key=call_80d292a7…
 * 6217ms  [mcp handler] ENTER | shifted toolUseId=undefined
 * 6217ms  [mcp handler] PARKING under key=anonymous-1
 * 14226ms [mcp handler] TIMED OUT after 8009ms
 * ```
 *
 * Clearing the announcements at the turn boundary therefore threw away the very
 * id the handler was about to claim. The handler fell through to a fallback key
 * nothing could resolve, parked for the whole tool-result timeout, and the turn
 * stalled — 120 s by default, which the user reads as "the model stopped
 * answering" and works around by stopping the conversation and resending. The
 * stall is probabilistic because a *slow* host tool (a shell command) parks its
 * handler before the turn ends and takes the other path, while a fast one
 * (`read`, `ask_user_question`) loses the race.
 *
 * ## Why a parked call must not have a wall-clock deadline
 *
 * A host result can only arrive on the next host request: the host runs every
 * tool of the round first, then sends one request carrying all their results.
 * A host tool is allowed to run for minutes (a build, a directory scan, a long
 * shell command), and one slow tool delays the results of its whole batch. A
 * fixed 120 s deadline therefore cancels calls whose real result is still on
 * its way:
 *
 * ```
 * 10:07:53  [mcp handler] PARK call_00_QFqbaum… (write — result ready at once)
 * 10:07:53  [host]         pwsh starts (its own timeout: 300 s)
 * 10:09:53  [mcp handler] TIMED OUT after 120s   <- write cancelled for nothing
 * 10:10:38  [host]         first request arrives with all three results
 * ```
 *
 * The request boundary is the real signal: the request that continues a tool
 * round carries a result for every call the host answered; a call it did not
 * answer in that request will never be answered. {@link beginHostRequest}
 * settles those, so a slow host never loses a result it was about to send.
 * Only a handler with no announced id — where no result can be matched at all
 * — keeps a bounded park as the last-resort recovery.
 *
 * ## Why the boundary alone is not enough
 *
 * The boundary settles what is *already* parked when it runs, and an
 * announcement that arrives after it is not touched by it. That leaves one
 * shape a wall clock used to break and nothing else could: the CLI dispatches
 * an MCP call whose tool-use block never reached the host. No result can be
 * filed for that id, and the boundary that would settle it needs the next host
 * request — which needs this turn to end first, and this turn is blocked on the
 * handler. The turn hangs until the user stops it. {@link claim} therefore
 * checks {@link ToolResultPairing.hostVisible} before parking: a call the host
 * was never shown fails at once, exactly as the boundary would have failed it.
 *
 * Announcements are dropped only where the CLI provably cancels its pending
 * dispatch — {@link forgetUnclaimed} on an aborted or failed turn, and
 * {@link clear} when the session dies.
 */
export class ToolResultPairing {
  /** Handlers parked under the tool-use id their host result will arrive as. */
  private readonly parked = new Map<string, ParkedResolver>()
  /** Results that arrived before their handler did, by tool-use id. */
  private readonly buffered = new Map<string, ToolResultPayload>()
  /** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
  private readonly announced: string[] = []
  /**
   * Announcements a host request has moved past without answering.
   *
   * A handler for one of these can still fire (the CLI decides when to dispatch
   * the MCP call), but no result will ever arrive for it; {@link claim} settles
   * it immediately instead of parking it for the fallback timeout.
   */
  private readonly abandoned: string[] = []
  /**
   * Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
   *
   * Keyed by a per-session nonce, so a stale entry can never be reached by a
   * later call and is safe to keep across turns; it is dropped with the session.
   */
  private readonly hostCallIds = new Map<string, string>()
  /**
   * Tool-use ids the host was actually shown, and has not answered yet.
   *
   * A host result is filed under a tool-use id only because the adapter emitted
   * that call's block to the host, so these — and only these — are calls the
   * host can still answer. {@link claim} refuses to park on any other id; see
   * the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
   * and is cleared everywhere that map is.
   */
  private readonly hostVisible = new Set<string>()
  /** Suffix for a handler that claimed no announcement, so keys stay distinct. */
  private anonymous = 0

  /** Record the tool-use id `canUseTool` allowed, in execution order. */
  announce(toolUseId: string): void {
    this.announced.push(toolUseId)
  }

  /** Record which tool-use id a model-emitted tool-call block belongs to. */
  mapHostCall(hostCallId: string, toolUseId: string): void {
    this.hostCallIds.set(hostCallId, toolUseId)
    this.hostVisible.add(toolUseId)
  }

  /**
   * Hand one MCP handler the result the host already delivered, or park it until
   * the host delivers one.
   *
   * A paired call is NOT timed out. The host can only answer on its next
   * request, and a host tool may legitimately run for minutes; the next request
   * settles it instead — see {@link beginHostRequest}. `timeoutMs` is therefore
   * reached only by a handler the CLI never announced, where no id exists to
   * match a result against and a bounded park remains the last resort.
   *
   * Parking forever is safe only for a call the host was shown; an announced id
   * the host never received fails at once rather than hanging the turn. See the
   * measurement in the body.
   *
   * @param timeoutMs - how long an *unpaired* handler waits before failing.
   * @returns the host's result, a cancellation, or a timeout payload.
   */
  async claim(timeoutMs: number): Promise<ToolResultPayload> {
    const toolUseId = this.announced.shift()
    if (toolUseId !== undefined) {
      const ready = this.buffered.get(toolUseId)
      if (ready !== undefined) {
        this.buffered.delete(toolUseId)
        return ready
      }
      // An announcement says only that the CLI allowed a call; it does not prove
      // the host ever saw it. A block that arrives while no host request is open
      // is dropped by the session, yet the CLI still dispatches its MCP message
      // — measured on a turn whose model asked for a host tool by its bare name,
      // was refused by the CLI's own scheduler, and retried 105 s later with the
      // qualified name: that retry's block landed 26 ms before the next host
      // request opened, so nothing was emitted to the host, and parking on it
      // hung the turn for 572 s until the user stopped it.
      //
      // Nothing can end that wait: a result arrives only on a host request, the
      // next host request cannot be sent until this turn finishes, and this turn
      // cannot finish while the handler is parked. So a call the host was never
      // shown fails now, with the same cancellation the request boundary would
      // have produced one round later.
      if (!this.hostVisible.has(toolUseId)) return unansweredCall(toolUseId)
      return await this.park(toolUseId)
    }
    const abandoned = this.abandoned.shift()
    if (abandoned !== undefined) return unansweredCall(abandoned)
    // No announcement: the CLI dispatched a call whose permission ask never
    // reached this pairing. With nothing else parked, a single unclaimed
    // result is the only unambiguous match; anything else falls through to the
    // bounded anonymous park.
    if (this.parked.size === 0 && this.buffered.size === 1) {
      const only = this.buffered.entries().next()
      if (only.done !== true) {
        this.buffered.delete(only.value[0])
        return only.value[1]
      }
    }
    return await this.park(`anonymous-${++this.anonymous}`, timeoutMs)
  }

  /**
   * Park one handler under `key` until the host answers, the request boundary
   * settles it, or — for an unpaired key only — the fallback timeout expires.
   */
  private async park(key: string, timeoutMs?: number): Promise<ToolResultPayload> {
    return await new Promise<ToolResultPayload>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs !== undefined) {
        // An id the host never answers must not leave the inner process waiting
        // forever, or qodercli's loop deadlocks instead of recovering.
        timer = setTimeout(() => {
          this.parked.delete(key)
          resolve({
            content: [{
              type: 'text',
              text: `宿主在 ${timeoutMs / 1000}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`,
            }],
            isError: true,
          })
        }, timeoutMs)
      }
      this.parked.set(key, payload => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  /**
   * File one host tool result against the call it answers.
   *
   * Resolves the handler already parked under that tool-use id, or buffers the
   * result for the handler that has not fired yet — which is the ordinary case
   * for a host tool that returns quickly.
   *
   * @param hostCallId - the host-facing call id from the tool-result message.
   * @param payload - the rendered result.
   * @returns the tool-use id the result was filed under, for the request
   *   boundary that settles the rest of the round.
   */
  deliver(hostCallId: string, payload: ToolResultPayload): string {
    // Without a mapping (a call the host never surfaced) the callId is used as
    // the key, so the entry still buffers for any handler that parked under it.
    const key = this.hostCallIds.get(hostCallId) ?? hostCallId
    // A host call id is answered once; keeping the mapping would only retain
    // one string per tool call for the life of the session.
    this.hostCallIds.delete(hostCallId)
    this.hostVisible.delete(key)
    const resolve = this.parked.get(key)
    if (resolve !== undefined) {
      this.parked.delete(key)
      resolve(payload)
      return key
    }
    this.buffered.set(key, payload)
    return key
  }

  /**
   * Settle the pairing against one arriving host request.
   *
   * The host runs every tool of a round before it sends the request that
   * continues the conversation, and that request carries a result for every
   * call it answered. A call it did not answer there will never be answered,
   * so this boundary — not a wall clock — decides that a handler is stranded:
   *
   *  - a handler parked under an unanswered id is released now;
   *  - an announcement whose handler has not fired yet is marked abandoned, so
   *    that handler settles as soon as it does arrive;
   *  - a buffered result from an earlier round whose handler never arrived is
   *    dropped, because no later request can produce that handler.
   *
   * A fresh user turn is handled by the same rules: the results the request
   * still carries are delivered, and the calls it left unanswered are
   * superseded. It differs only in the cancellation text the model reads.
   *
   * `delivered` is what protects the fast-handler race: a result can arrive
   * before the CLI dispatches the MCP handler, and a runtime-context snapshot
   * can make the same request look like a new user turn. Keeping everything
   * this request answered, in both cases, is what lets that handler collect
   * the real result instead of a cancellation.
   *
   * @param delivered - tool-use ids the host just delivered a result for.
   * @param freshUserTurn - whether the request carries a new user message.
   */
  beginHostRequest(delivered: ReadonlySet<string>, freshUserTurn: boolean): void {
    // Nothing is outstanding, so no handler can still arrive for an older
    // abandoned id; the next one must belong to the round this request starts.
    if (this.announced.length === 0 && this.parked.size === 0) this.abandoned.length = 0
    for (const [key, resolve] of [...this.parked.entries()]) {
      if (delivered.has(key)) continue
      this.parked.delete(key)
      resolve(freshUserTurn
        ? { content: [{ type: 'text', text: SUPERSEDED_CALL_TEXT }], isError: true }
        : unansweredCall(key))
    }
    const kept = this.announced.filter(id => delivered.has(id))
    for (const id of this.announced) {
      if (!delivered.has(id)) this.abandoned.push(id)
    }
    this.announced.length = 0
    this.announced.push(...kept)
    for (const key of [...this.buffered.keys()]) {
      if (!delivered.has(key)) this.buffered.delete(key)
    }
    this.hostCallIds.clear()
    this.hostVisible.clear()
  }

  /**
   * Release every parked handler: the host started a fresh user turn while their
   * calls were still outstanding, so those calls can never be answered.
   */
  cancelParked(): void {
    const stale = [...this.parked.entries()]
    this.parked.clear()
    for (const [, resolve] of stale) {
      resolve({ content: [{ type: 'text', text: SUPERSEDED_CALL_TEXT }], isError: true })
    }
  }

  /**
   * Drop announcements no handler can still claim, and release parked handlers.
   *
   * An aborted or failed turn is one where the CLI cancels its pending tool
   * dispatch, so an id it announced but never dispatched would otherwise shift
   * the pairing of the NEXT turn's handler by one slot and park it under a key
   * nothing resolves — reintroducing the very stall this class exists to fix.
   * A handler that was already dispatched still needs an answer, so parked
   * handlers settle here, and announcements move to the abandoned queue in case
   * their dispatch was already in flight when the turn died.
   */
  forgetUnclaimed(): void {
    this.abandoned.push(...this.announced)
    this.announced.length = 0
    this.cancelParked()
    this.buffered.clear()
    this.hostCallIds.clear()
    this.hostVisible.clear()
  }

  /** Drop all pairing state; the session is being torn down. */
  clear(): void {
    // Release before discarding, so a handler that is still parked settles
    // rather than holding a promise nothing can ever resolve.
    this.cancelParked()
    this.announced.length = 0
    this.abandoned.length = 0
    this.hostCallIds.clear()
    this.hostVisible.clear()
    this.buffered.clear()
  }

  /** How many handlers are waiting for a host result. */
  get parkedCount(): number {
    return this.parked.size
  }
}
