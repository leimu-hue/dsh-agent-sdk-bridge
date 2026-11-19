/**
 * Closing a session must not look like losing the connection.
 *
 * A plugin reload, a pool reclaim and a login switch all ask the session to
 * stop, and all of them used to kill the CLI mid-answer: the turn ended as
 * `STREAM_CLOSED`, which the harness can only present as a dropped connection.
 * Three things are pinned here — a turn that was already streaming finishes and
 * ends as `stop`; a turn that does NOT finish in time ends as `aborted` (never
 * as an error), because the provider never failed; and a session that already
 * closed refuses to be revived by a retry.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * A controlled stand-in for one CLI's message stream.
 *
 * Hoisted, because the SDK mock below replaces a module that is imported before
 * any module-level helper in this file could exist.
 */
const fake = vi.hoisted(() => {
  function makeChannel() {
    const queue: unknown[] = []
    let resolve: ((result: IteratorResult<unknown>) => void) | null = null
    let ended = false
    return {
      push(value: unknown): void {
        if (resolve !== null) {
          const settle = resolve
          resolve = null
          settle({ value, done: false })
        } else {
          queue.push(value)
        }
      },
      end(): void {
        ended = true
        if (resolve !== null) {
          const settle = resolve
          resolve = null
          settle({ value: undefined, done: true })
        }
      },
      iterator() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            const value = queue.shift()
            if (value !== undefined) return Promise.resolve({ value, done: false })
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise(settle => { resolve = settle })
          },
          [Symbol.asyncIterator]() { return this },
        }
      },
    }
  }

  const state = {
    /** The channel of the most recently created session. */
    channel: null as null | ReturnType<typeof makeChannel>,
    /** How many times a session asked its CLI to close. */
    closes: 0,
  }
  return { state, makeChannel }
})

vi.mock('../../../src/host/infra/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    createSdkMcpServer: () => ({ instance: { registerTool: () => {} } }),
    unstable_v2_createSession: () => {
      const channel = fake.makeChannel()
      fake.state.channel = channel
      return {
        connect: async () => {},
        setModel: async () => {},
        setConfig: async () => {},
        send: async () => {},
        interrupt: async () => {},
        close: () => {
          fake.state.closes += 1
          // The real transport's close also ends the message stream, which is
          // what releases the consumer.
          channel.end()
        },
        stream: () => channel.iterator(),
      }
    },
  }),
}))

// Set before importing the plugin: the state store resolves its path at load.
const root = mkdtempSync(join(tmpdir(), 'codebuddy-close-'))
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'state.json')
process.env.DSH_BRIDGE_LOG_PATH = join(root, 'bridge.log')

const { CodeBuddySession } = await import('../../../src/host/providers/codebuddy/session.ts')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** One text fragment, exactly as the CLI's partial-message stream frames it. */
const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
/** The frame that ends a normal turn. */
const result = () => ({ type: 'result' })

/** The finish chunk's reason, or undefined when the turn never finished. */
const finishOf = (chunks: any[]): any => chunks.find(chunk => chunk.type === 'finish')?.reason

interface Drivable {
  readonly busy: boolean
  readonly closing: unknown
  close(cause?: any): void
  stream(options: any, feed: any): AsyncIterable<unknown>
}

/** Start one turn and collect its chunks. */
async function startTurn(session: Drivable): Promise<{ chunks: any[], pump: Promise<void> }> {
  const chunks: any[] = []
  const pump = (async () => {
    for await (const chunk of session.stream({ messages: [], model: 'model' }, 'hi')) chunks.push(chunk)
  })()
  // Let the generator reach its queue before anything reacts to the turn.
  await vi.waitFor(() => { if (!session.busy) throw new Error('turn has not started') })
  return { chunks, pump }
}

describe('closing a session with a turn in flight', () => {
  it('lets the answer finish and reports a normal stop', async () => {
    const session = new CodeBuddySession('s-finish', 'model', { drainMs: 60_000 }) as unknown as Drivable
    const { chunks, pump } = await startTurn(session)

    session.close('dispose')
    expect(session.busy).toBe(true)
    // Still serving: this frame arrives after the close request and is the
    // second half of an answer the user is watching.
    fake.state.channel?.push(delta('still here'))
    fake.state.channel?.push(result())
    await pump

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'still here' })
    expect(finishOf(chunks)).toEqual({ kind: 'stop' })
    expect(session.closing).toBe('dispose')
  })

  it('ends the turn as aborted when the drain window expires', async () => {
    const session = new CodeBuddySession('s-drain', 'model', { drainMs: 20 }) as unknown as Drivable
    const { chunks, pump } = await startTurn(session)

    fake.state.channel?.push(delta('half an ans'))
    session.close('idle')
    await pump

    const reason = finishOf(chunks)
    expect(reason?.kind).toBe('aborted')
    // Never an error: the provider did not fail, the host reclaimed the slot.
    expect(reason?.failure.code).toBe('ABORTED')
    expect(reason?.failure.message).toContain('空闲')
  })

  it('refuses a new turn after the close, without a retryable code', async () => {
    const session = new CodeBuddySession('s-refuse', 'model', { drainMs: 60_000 }) as unknown as Drivable
    const { pump } = await startTurn(session)
    session.close('dispose')
    fake.state.channel?.end()
    await pump

    await expect(async () => {
      for await (const _chunk of session.stream({ messages: [], model: 'model' }, 'again')) { /* drain */ }
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('a stream that ends on its own', () => {
  it('is still reported as a stream failure, not a close', async () => {
    const session = new CodeBuddySession('s-ended', 'model', { drainMs: 60_000 }) as unknown as Drivable
    const { chunks, pump } = await startTurn(session)

    fake.state.channel?.push(delta('partial'))
    // No result frame and no close request: this is the real disconnect.
    fake.state.channel?.end()
    await pump

    const reason = finishOf(chunks)
    expect(reason?.kind).toBe('error')
    expect(reason?.failure.code).toBe('STREAM_CLOSED')
  })
})
