import { describe, expect, it } from 'vitest'
import { classifyPageMethodSignal } from '../../../src/main/generation/method-signals'

describe('page method signal classification', () => {
  it('classifies harness quality violations with a proactive icon/padding fix', () => {
    const signal = classifyPageMethodSignal('质量校验未通过 (page-1): emoji-as-icon: 使用了 emoji 充当图标')
    expect(signal?.signalClass).toBe('harness-quality')
    expect(signal?.fix).toContain('data-icon')
    expect(signal?.fix).toContain('padding')
  })

  it('classifies font-below-floor rejections with a font floor fix', () => {
    const signal = classifyPageMethodSignal(
      '质量校验未通过 (page-9)：- [font-below-floor] <span class="text-[14px]"> 显式字号 14px，低于当前画布正文下限 18px'
    )
    expect(signal?.signalClass).toBe('harness-quality')
    expect(signal?.fix).toContain('18px')
    expect(signal?.fix).toContain('12px')
    expect(signal?.fix).toContain('data-ppt-text-role="auxiliary"')
  })

  it('prefers the harness-quality signal over page-not-written when the rejection reason is preserved', () => {
    const signal = classifyPageMethodSignal(
      '页面未写入 (page-1)：模型没有成功调用 update_single_page_file 写入目标 page 文件。 最近一次写盘被质量校验拒绝，必须修正下列问题后重新调用写盘工具：验证失败 page-1: font-below-floor: 显式字号 14px，低于当前画布正文下限 18px'
    )
    expect(signal?.signalClass).toBe('harness-quality')
  })

  it('classifies template skeleton drops, chart misuse, and missing writes', () => {
    expect(
      classifyPageMethodSignal('模板骨架资源丢失 (page-2)：bg-texture.png, decor-1.png')?.signalClass
    ).toBe('template-skeleton')
    expect(
      classifyPageMethodSignal('chart canvas is blank: PPT.createChart never ran')?.signalClass
    ).toBe('chart-usage')
    expect(
      classifyPageMethodSignal('页面未写入 (page-3)：模型没有成功调用 update_single_page_file')?.signalClass
    ).toBe('page-not-written')
  })

  it('classifies structural and overflow failures', () => {
    expect(classifyPageMethodSignal('HTML 验证失败 (page-4): 标签未闭合')?.signalClass).toBe(
      'html-structure'
    )
    expect(classifyPageMethodSignal('rendered page overflow: content exceeds canvas')?.signalClass).toBe(
      'overflow'
    )
    expect(
      classifyPageMethodSignal('PPT 背景图约束未通过 (page-5)')?.signalClass
    ).toBe('deck-background')
  })

  it('returns null for unclassifiable or empty errors', () => {
    expect(classifyPageMethodSignal('some model 429 quota issue')).toBeNull()
    expect(classifyPageMethodSignal('')).toBeNull()
  })

  it('keeps every rule fix actionable (non-empty, mentions the remedy)', () => {
    for (const message of [
      '质量校验未通过',
      '模板骨架资源丢失',
      'chart 未渲染',
      '页面未写入',
      'HTML 验证失败：未闭合',
      '内容溢出画布',
      'PPT 背景图约束未通过'
    ]) {
      const signal = classifyPageMethodSignal(message)
      expect(signal, message).toBeTruthy()
      expect(signal!.fix.length).toBeGreaterThan(40)
    }
  })
})
