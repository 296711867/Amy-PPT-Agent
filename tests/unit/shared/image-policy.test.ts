import { describe, expect, it } from 'vitest'
import { normalizeImagePolicy } from '../../../src/shared/generation'

describe('image policy normalization', () => {
  it('keeps the three supported policies and falls back to placeholder', () => {
    expect(normalizeImagePolicy('placeholder')).toBe('placeholder')
    expect(normalizeImagePolicy('ai')).toBe('ai')
    // 模板链路默认：沿用页面基底视觉，不额外配图
    expect(normalizeImagePolicy('none')).toBe('none')
    // 历史会话/未知值保持旧行为
    expect(normalizeImagePolicy(undefined)).toBe('placeholder')
    expect(normalizeImagePolicy('bogus')).toBe('placeholder')
  })
})
