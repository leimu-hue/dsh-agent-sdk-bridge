/**
 * When the CLI refuses a turn's image bytes, and that is not the user's fault.
 *
 * The CLI decodes every attached image before the model sees the turn; its
 * failure text is what tells a libvips/ABI problem apart from a genuinely
 * broken file, so the adapter can answer with the real cause instead of
 * repeating `error_during_execution`.
 */
import { describe, expect, it } from 'vitest'
import { isImageAttachFailure } from '../../../src/providers/qoder/session.ts'

describe('image attach failure', () => {
  it('recognizes the CLI refusing image bytes', () => {
    // The sentence the CLI shows, its reason code, and the libvips line under it.
    expect(isImageAttachFailure(
      'error_during_execution ["Unable to attach image because it could not be decoded completely or read from its source.'
      + ' Export the original image as a new JPEG or PNG file and try again. Image processing error:'
      + ' Invalid or unsupported image data: colourspace: parameter space not set"]',
    )).toBe(true)
    expect(isImageAttachFailure('error_during_execution image_processing_failed')).toBe(true)
    expect(isImageAttachFailure('Invalid or unsupported image data')).toBe(true)
  })

  it('leaves every other turn failure alone', () => {
    const others = [
      '',
      'error_during_execution []',
      'error_max_turns',
      'Prompt is too long',
      'Rate limit exceeded',
      'Unable to attach file because it does not exist',
    ]
    for (const detail of others) expect(isImageAttachFailure(detail)).toBe(false)
  })
})
