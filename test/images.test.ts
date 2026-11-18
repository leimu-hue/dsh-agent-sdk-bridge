/**
 * A tool can return a picture: `read_image` hands back pixels beside its path
 * envelope. On these routes tool results reach the inner model through the
 * MCP/ACP result channel, not through the prompt feed, so the renderer for that
 * channel is the only place the image can survive.
 *
 * These cases pin both halves: a readable attachment becomes an image content
 * block, and one the host could not read keeps the harness handle text instead
 * of disappearing.
 */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CodeBuddyAdapter } from '../src/host/providers/codebuddy/adapter.ts'
import { renderCodeBuddyResult } from '../src/host/providers/codebuddy/session.ts'
import { QoderAdapter } from '../src/host/providers/qoder/adapter.ts'
import { feedToText, imageRefText, renderInitialFeed } from '../src/host/core/render.ts'
import { MinimaxAdapter } from '../src/host/providers/minimax/adapter.ts'
import { renderToolResult } from '../src/host/providers/minimax/session.ts'
import { resolveTurnImages } from '../src/host/core/adapter-kit.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:2b081468d33313d546912d12c2f5c6f2b352547ff871f3c939fc357dd096194a'),
  mediaType: 'image/png',
  bytes: 3,
  width: 2,
  height: 2,
}

const IMAGES = new Map([[String(REF.attachmentId), { data: 'QUJD', mediaType: 'image/png' }]])
const RESULT = [
  { type: 'text', text: '<path>C:/pictures/9.png</path>' },
  { type: 'image', attachment: REF },
]

describe('tool-result images', () => {
  it('forwards a CodeBuddy tool image as an MCP image block', () => {
    const content = renderCodeBuddyResult(RESULT, IMAGES)
    expect(content).toEqual([
      { type: 'text', text: '<path>C:/pictures/9.png</path>' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('keeps the handle text when a CodeBuddy tool image cannot be read', () => {
    const content = renderCodeBuddyResult([{ type: 'image', attachment: REF }], new Map())
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('image omitted') })
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('2b081468') })
  })

  it('forwards a MiniMax tool image as an MCP image block', () => {
    expect(renderToolResult(RESULT, IMAGES).content).toEqual([
      { type: 'text', text: '<path>C:/pictures/9.png</path>' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('keeps the handle text when a MiniMax tool image cannot be read', () => {
    const result = renderToolResult([{ type: 'image', attachment: REF }], new Map())
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('2b081468') })
  })

  it('resolves images from tool results in the not-yet-fed tail', async () => {
    const tail = [{ role: 'tool', toolCallId: 'c1', content: [{ type: 'image', attachment: REF }] }] as never
    const reader = async () => ({ bytes: Buffer.from('ABC'), mediaType: 'image/png' as const })

    // Every adapter feeds its own `readImage` option into this one helper, so
    // the tail rule only has to be pinned here.
    const images = await resolveTurnImages(tail, true, reader)
    expect(images.get(String(REF.attachmentId))).toEqual({ data: 'QUJD', mediaType: 'image/png' })

    // A route that cannot read images sends no pixels at all.
    expect(await resolveTurnImages(tail, false, reader)).toEqual(new Map())
    // So does a deployment with no attachment store.
    expect(await resolveTurnImages(tail, true, undefined)).toEqual(new Map())
  })
})

/**
 * An image reaches the model twice: as pixels it can look at, and as a handle
 * that names the file it can process.
 *
 * Pixels alone are enough to answer "what is in this picture?". A "invert it and
 * save" turn then went looking for a file that was never in the workspace: the
 * prompt carried no path to the durable attachment. The host's native adapter
 * avoids that by appending `requestImageHandleText`, whose read-only normalized
 * path (and the instruction to copy it to a writable `.png`) is what makes
 * editing work.
 */
const HANDLE_REF: ImageAttachmentRef = {
  attachmentId: 'sha256:2b081468d33313d546912d12c2f5c6f2b352547ff871f3c939fc357dd096194a',
  mediaType: 'image/png',
  bytes: 12362,
  width: 492,
  height: 150,
} as ImageAttachmentRef

const HANDLE_PATH = 'C:\\Users\\tester\\.dsh\\attachments\\v1\\objects\\2b\\2b081468.png'
/** The host quotes the path with JSON.stringify, so backslashes are doubled. */
const QUOTED_HANDLE_PATH = JSON.stringify(HANDLE_PATH)

describe('image handle text', () => {
  it('names the read-only copy and how to make it writable', () => {
    const text = imageRefText(HANDLE_REF, HANDLE_PATH)
    expect(text).toContain(QUOTED_HANDLE_PATH)
    expect(text).toContain('492x150px')
    expect(text).toContain('image/png')
    // The instruction that turns "I can see it" into "I can edit it".
    expect(text).toContain('Copy to a writable path ending in .png before editing')
  })

  it('does not claim a text-only route when only the path is missing', () => {
    // Pixels are still sent; the old fallback said "accepts text only", which
    // made a vision model hunt for a file instead of looking at the image.
    const text = imageRefText(HANDLE_REF, undefined)
    expect(text).toContain('2b081468')
    expect(text).not.toContain('text only')
  })

  it('keeps the path on a historical image across a rebuild', () => {
    const messages = [
      {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: HANDLE_REF }, { type: 'text', text: '这是原图' }],
      },
      { role: 'assistant', source: { kind: 'model', provider: 'qoder-cn', model: 'dfmodel' }, content: [{ type: 'text', text: '看到了' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把它反色保存' }] },
    ] as never

    const feed = renderInitialFeed(undefined, messages, () => HANDLE_PATH)
    const text = feedToText(feed)
    // The current turn has no pixels, so this is the only way the model can
    // find the file the user is asking it to change.
    expect(text).toContain(QUOTED_HANDLE_PATH)
  })

  it('puts the handle in front of a Qoder image block', async () => {
    const adapter = new QoderAdapter({ imagePath: () => HANDLE_PATH })
    const images = new Map([[String(HANDLE_REF.attachmentId), { data: 'QUJD', mediaType: 'image/png' }]])
    const content = await (adapter as any).buildFeed(
      [{ type: 'image', attachment: HANDLE_REF }, { type: 'text', text: '把它反色保存' }],
      true,
      images,
    )
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(QUOTED_HANDLE_PATH) })
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(content[2]).toEqual({ type: 'text', text: '把它反色保存' })
  })

  it('puts the handle in front of a CodeBuddy image block', async () => {
    const adapter = new CodeBuddyAdapter({
      imagePath: () => HANDLE_PATH,
      readImage: async () => ({ bytes: Buffer.from('ABC'), mediaType: 'image/png' }),
    })
    const content = await (adapter as any).buildFeed([{ type: 'image', attachment: HANDLE_REF }], true)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(QUOTED_HANDLE_PATH) })
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
  })
})

