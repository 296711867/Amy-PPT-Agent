import { describe, expect, it } from 'vitest'
import {
  isPptxStaticBackgroundShape,
  resolvePptxCaptureRect,
  resolvePptxExportLayout
} from '../../../src/main/io/html-pptx/static-background'
import { resolveSlideSize } from '../../../src/shared/slide-size'

describe('PPTX static background shape classification', () => {
  it('keeps full-page and full-height column fills in the screenshot base', () => {
    expect(isPptxStaticBackgroundShape({ x: 0, y: 0, w: 13.333, h: 7.5 })).toBe(true)
    expect(isPptxStaticBackgroundShape({ x: 0, y: 0, w: 6.133, h: 7.5 })).toBe(true)
  })

  it('uses the same geometry rule for full-slide image backgrounds', () => {
    const image = { x: 0, y: 0, w: 13.333, h: 7.5, dataUri: 'data:image/png;base64,x' }

    expect(isPptxStaticBackgroundShape(image)).toBe(true)
  })

  it('keeps regular cards and centered large content shapes editable', () => {
    expect(isPptxStaticBackgroundShape({ x: 6.6, y: 4.3, w: 6.2, h: 0.8 })).toBe(false)
    expect(isPptxStaticBackgroundShape({ x: 1, y: 1, w: 10, h: 5 })).toBe(false)
  })

  it('does not classify near-full-width header bands as slide backgrounds', () => {
    expect(isPptxStaticBackgroundShape({ x: 0, y: 0, w: 13.3, h: 2.5 })).toBe(false)
  })

  it('uses 10 by 7.5in geometry for standard 4:3 slides', () => {
    const layout = resolvePptxExportLayout(resolveSlideSize({ id: 'standard-4-3' }))

    expect(layout).toMatchObject({
      captureWidthPx: 1600,
      captureHeightPx: 1200,
      slideWidthIn: 10,
      slideHeightIn: 7.5
    })
    expect(isPptxStaticBackgroundShape({ x: 0, y: 0, w: 10, h: 7.5 }, layout)).toBe(true)
    expect(isPptxStaticBackgroundShape({ x: 0, y: 0, w: 10, h: 2.5 }, layout)).toBe(false)
  })

  it('clips overlay captures to the remaining pixels at the right and bottom edges', () => {
    const layout = resolvePptxExportLayout(resolveSlideSize({ id: 'wide-16-9' }))

    expect(resolvePptxCaptureRect({ x: 1550, y: 860, w: 100, h: 100 }, layout, 2)).toEqual({
      x: 1548,
      y: 858,
      width: 52,
      height: 42
    })
    expect(resolvePptxCaptureRect({ x: 1605, y: 20, w: 30, h: 20 }, layout, 2)).toBeNull()
  })
})
