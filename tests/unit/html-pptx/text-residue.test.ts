import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {}
}))

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { hasTextResidueInCapture } from '../../../src/main/io/html-pptx/renderer'

const layout = {
  captureWidthPx: 180,
  captureHeightPx: 100,
  slideWidthIn: 13.5,
  slideHeightIn: 7.5
}

const text = {
  text: 'Visible text',
  x: 0,
  y: 0,
  w: 13.5,
  h: 7.5,
  fontSize: 24,
  color: 'FFFFFF'
}

const image = (bitmap: Buffer) =>
  ({
    getSize: () => ({ width: 180, height: 100 }),
    toBitmap: () => bitmap
  }) as never

describe('PPTX background text residue detection', () => {
  it('does not mistake a uniform matching fill for text residue', () => {
    const bitmap = Buffer.alloc(180 * 100 * 4, 255)

    expect(hasTextResidueInCapture(image(bitmap), [text] as never, layout)).toMatchObject({
      suspicious: false,
      maxRatio: 1
    })
  })

  it('still detects sparse glyph-colored pixels', () => {
    const bitmap = Buffer.alloc(180 * 100 * 4, 0)
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 18; column += 1) {
        if ((row + column) % 5 !== 0) continue
        const x = Math.floor(((column + 0.5) * 179) / 18)
        const y = Math.floor(((row + 0.5) * 99) / 10)
        const pixel = y * 180 + x
        bitmap[pixel * 4] = 255
        bitmap[pixel * 4 + 1] = 255
        bitmap[pixel * 4 + 2] = 255
      }
    }

    expect(hasTextResidueInCapture(image(bitmap), [text] as never, layout).suspicious).toBe(true)
  })
})
