import { describe, expect, it } from 'vitest'
import { applyContractPalette } from '../../../src/main/layout-assets/palette'

const BLUE_SKELETON_SNIPPET = `<main class="ppt-page-root">
  <div style="background:#2F6BFF"></div>
  <section style="color:#1F2430;background:#F7F5F0">标题</section>
  <section style="color:#5A6472;border-bottom:1px solid #D8DCE3">正文</section>
</main>`

describe('applyContractPalette', () => {
  it('maps skeleton colors onto the contract palette rank by luminance (I-8)', () => {
    const palette = ['#a855f7', '#7c3aed', '#ec4899', '#111827', '#1d4ed8', '#faf7ff']
    const result = applyContractPalette(BLUE_SKELETON_SNIPPET, palette)
    // 蓝色骨架色全部消失，替换为契约色板成员
    for (const hex of ['#2f6bff', '#1f2430', '#f7f5f0', '#5a6472', '#d8dce3']) {
      expect(result.toLowerCase()).not.toContain(hex)
    }
    // 明暗次序保持：最亮背景 → 色板最亮色；最暗标题 → 色板最暗色
    expect(result.toLowerCase()).toContain('#faf7ff')
    expect(result.toLowerCase()).toContain('#111827')
  })

  it('replaces every occurrence, not just the first', () => {
    const result = applyContractPalette(
      '<div style="color:#2F6BFF"></div><span style="color:#2f6bff"></span>',
      ['#7c3aed', '#faf7ff']
    )
    expect(result.match(/#7c3aed/gi)?.length).toBe(2)
  })

  it('expands 3-digit hex colors', () => {
    const result = applyContractPalette('<p style="color:#fff;background:#000">x</p>', [
      '#123456',
      '#fedcba'
    ])
    expect(result.toLowerCase()).not.toContain('#fff')
    expect(result.toLowerCase()).not.toContain('#000')
  })

  it('does not chain replacements when a palette color is also a source color', () => {
    // #faf7ff 既是源色也在色板里：单遍替换，不会被二次映射
    const result = applyContractPalette(
      '<p style="color:#faf7ff;background:#2F6BFF">x</p>',
      ['#7c3aed', '#faf7ff']
    )
    expect(result.toLowerCase()).toContain('#faf7ff')
  })

  it('is a no-op for missing or too-small palettes', () => {
    expect(applyContractPalette(BLUE_SKELETON_SNIPPET, [])).toBe(BLUE_SKELETON_SNIPPET)
    expect(applyContractPalette(BLUE_SKELETON_SNIPPET, ['#7c3aed'])).toBe(BLUE_SKELETON_SNIPPET)
    expect(applyContractPalette(BLUE_SKELETON_SNIPPET, ['not-a-color', 'also bad'])).toBe(
      BLUE_SKELETON_SNIPPET
    )
  })
})
