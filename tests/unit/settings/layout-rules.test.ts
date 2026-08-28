import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_RULES,
  buildLayoutRulesPrompt,
  normalizeLayoutRules
} from '../../../src/shared/layout-rules'

describe('layout rules profile', () => {
  it('uses presentation-native defaults', () => {
    expect(normalizeLayoutRules(undefined)).toEqual(DEFAULT_LAYOUT_RULES)

    const prompt = buildLayoutRulesPrompt(undefined)
    expect(prompt).toContain('## User PPT Composition Profile')
    expect(prompt).toContain('presentation-native composition')
    expect(prompt).toContain('dashboard shells')
    expect(prompt).toContain('### Web-layout failure check')
    expect(prompt).toContain('at most 3 primary content blocks')
    expect(prompt).toContain('10% left/right and 14% top/bottom')
    expect(prompt).toContain('slide subtitle or whole-page lead about 28px')
    expect(prompt).toContain('module second-level title about 28px')
    expect(prompt).toContain('64px while preserving usable width')
    expect(prompt).toContain('data-role="image-placeholder"')
    expect(prompt).toContain('## 专业 PPT 构图原则')
    expect(prompt).toContain('staircase-strips')
  })

  it('normalizes unknown values and clamps numeric controls', () => {
    const rules = normalizeLayoutRules({
      enabled: 'yes',
      preset: 'unknown',
      density: 'invalid',
      compositionMode: 'invalid',
      contentModuleStyle: 'invalid',
      enabledPatterns: ['staircase-strips', 'not-a-pattern'],
      maxContentBlocks: 99,
      heroMinPercent: 5,
      safeAreaHorizontalPercent: 99,
      safeAreaVerticalPercent: 1,
      bodySize: 4,
      cardGap: 100,
      slideSubtitleSize: 99,
      moduleTitleSize: 1,
      staircaseOffset: 999
    })

    expect(rules).toMatchObject({
      enabled: true,
      preset: 'professional',
      density: 'balanced',
      schemaVersion: 3,
      compositionMode: 'native-ppt',
      contentModuleStyle: 'adaptive',
      enabledPatterns: ['staircase-strips'],
      maxContentBlocks: 6,
      heroMinPercent: 30,
      safeAreaHorizontalPercent: 14,
      safeAreaVerticalPercent: 10,
      bodySize: 18,
      cardGap: 40,
      slideSubtitleSize: 36,
      moduleTitleSize: 20,
      staircaseOffset: 96
    })
  })

  it('converts proportional safe areas and type targets for the current canvas', () => {
    const widePrompt = buildLayoutRulesPrompt(undefined, {
      label: '16:9',
      width: 1600,
      height: 900
    })
    const standardPrompt = buildLayoutRulesPrompt(undefined, {
      label: '4:3',
      width: 1600,
      height: 1200
    })

    expect(widePrompt).toContain('160px left/right and 126px top/bottom')
    expect(widePrompt).toContain('slide title about 48px')
    expect(standardPrompt).toContain('160px left/right and 168px top/bottom')
    expect(standardPrompt).toContain('slide title about 64px')
  })

  it('upgrades legacy fields and preserves an intentionally empty v3 editor', () => {
    expect(normalizeLayoutRules({ expertMarkdown: '' }).expertMarkdown).toContain(
      '## 专业 PPT 构图原则'
    )
    expect(
      normalizeLayoutRules({ schemaVersion: 2, cardTitleSize: 31, expertMarkdown: '# Legacy' })
    ).toMatchObject({
      schemaVersion: 3,
      moduleTitleSize: 31,
      expertMarkdown: '# Legacy'
    })
    expect(normalizeLayoutRules({ schemaVersion: 3, expertMarkdown: '' }).expertMarkdown).toBe('')
  })

  it('normalizes expert Markdown and limits its prompt size', () => {
    const expertMarkdown = `\0## Team rules\r\n${'x'.repeat(13_000)}`
    const rules = normalizeLayoutRules({ expertMarkdown })

    expect(rules.expertMarkdown).not.toContain('\0')
    expect(rules.expertMarkdown).not.toContain('\r')
    expect(rules.expertMarkdown.length).toBe(12_000)
    expect(buildLayoutRulesPrompt(rules)).toContain('### Expert Markdown Overrides')
    expect(buildLayoutRulesPrompt(rules)).toContain('## Team rules')
  })

  it('does not emit a prompt when the profile is disabled', () => {
    expect(buildLayoutRulesPrompt({ enabled: false, expertMarkdown: '# ignored' })).toBe('')
  })

  it('emits deck-level structural consistency hard contract for alignment, cards and icons', () => {
    const prompt = buildLayoutRulesPrompt(undefined)

    // 改动 E：新增 Deck-level structural consistency 硬契约段
    expect(prompt).toContain('### Deck-level structural consistency')
    expect(prompt).toContain('硬契约')
    // 留白/卡片/图标基准引用了 profile 数值（默认 safeArea 10/14、cardPadding 32、cardGap 24、iconBoxSize 64）
    expect(prompt).toContain('10% 安全区')
    expect(prompt).toContain('14% 安全区')
    expect(prompt).toContain('约 32px 内边距')
    expect(prompt).toContain('24px 间距')
    expect(prompt).toContain('约 64px 的圆形')
    // 形态同构 + 对齐基准
    expect(prompt).toContain('形态同构')
    expect(prompt).toContain('异构形态')
    expect(prompt).toContain('justify-start')
    expect(prompt).toContain('justify-center')
    expect(prompt).toContain('items-stretch')
    expect(prompt).toContain('flex-1')

    // 改动 A：修正“避免重复”反噬（可变的是叙事结构，统一基准不能换）
    expect(prompt).toContain('叙事结构')
    expect(prompt).toContain('不得为了“避免重复”')

    // 改动 D：同组图标要么全有要么全无
    expect(prompt).toContain('要么每张都有、要么都没有')
  })
})
