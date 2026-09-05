import { describe, expect, it } from 'vitest'
import {
  normalizeOutlineEntries,
  normalizeKeyPoints,
  outlineEntryToPromptText,
  outlineEntryToText,
  MAX_KEY_POINT_LENGTH
} from '../../../src/main/generation/outline-normalizer'
import { contentPackageToFill } from '../../../src/main/layout-assets/fill'

describe('normalizeOutlineEntries', () => {
  it('normalizes plain string arrays into structured entries', () => {
    const entries = normalizeOutlineEntries(['第一点', '第二点', '第三点'])
    expect(entries).toHaveLength(3)
    expect(entries[0].label).toBe('第一点')
    expect(entries[0].id).toBeTruthy()
    expect(entries[0].value).toBeUndefined()
  })

  it('normalizes structured objects preserving value/unit/priority', () => {
    const entries = normalizeOutlineEntries([
      { label: '增长率', value: 42.7, unit: '%', priority: 'primary' },
      { label: '市场规模', value: '1.2', unit: '万亿', displayValue: '1.2万亿' },
      { label: '竞品', detail: '三家主要竞品对比', priority: 'supporting' }
    ])
    expect(entries).toHaveLength(3)
    expect(entries[0].value).toBe(42.7)
    expect(entries[0].unit).toBe('%')
    expect(entries[0].priority).toBe('primary')
    expect(entries[1].displayValue).toBe('1.2万亿')
    expect(entries[2].detail).toBe('三家主要竞品对比')
    expect(entries[2].priority).toBe('supporting')
  })

  it('handles mixed string and object entries', () => {
    const entries = normalizeOutlineEntries([
      '纯文本要点',
      { label: '结构化', value: 100, unit: '%' }
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0].label).toBe('纯文本要点')
    expect(entries[0].value).toBeUndefined()
    expect(entries[1].value).toBe(100)
  })

  it('truncates overlong labels and details', () => {
    const longLabel = 'A'.repeat(MAX_KEY_POINT_LENGTH + 10)
    const longDetail = 'D'.repeat(80)
    const entries = normalizeOutlineEntries([{ label: longLabel, detail: longDetail }])
    expect(entries[0].label.length).toBe(MAX_KEY_POINT_LENGTH + 1) // +1 for ellipsis
    expect(entries[0].label).toMatch(/…$/)
    expect(entries[0].detail!.length).toBeLessThanOrEqual(61) // 60 + ellipsis
  })

  it('filters empty entries and caps at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => `要点${i + 1}`)
    const entries = normalizeOutlineEntries([...many, '', '   '])
    expect(entries).toHaveLength(10)
  })

  it('normalizeKeyPoints returns plain labels for backward compat', () => {
    expect(normalizeKeyPoints(['a', { label: 'b', value: 1 }])).toEqual(['a', 'b'])
  })
})

describe('outlineEntryToText', () => {
  it('prefers displayValue, then value+unit, then label', () => {
    expect(outlineEntryToText('plain')).toBe('plain')
    expect(outlineEntryToText({ id: '1', label: 'L', displayValue: '42%' })).toBe('42%')
    expect(outlineEntryToText({ id: '1', label: 'L', value: 42.7, unit: '%' })).toBe('42.7%')
    expect(outlineEntryToText({ id: '1', label: 'OnlyLabel' })).toBe('OnlyLabel')
  })
})

describe('outlineEntryToPromptText', () => {
  it('keeps the claim, metric, and supporting detail together', () => {
    expect(
      outlineEntryToPromptText({
        id: '1',
        label: '续费率提升',
        displayValue: '+12%',
        detail: '主要来自新手引导优化'
      })
    ).toBe('续费率提升 — +12% — 主要来自新手引导优化')
  })
})

describe('contentPackageToFill', () => {
  it('splits structured entries into list labels and metric values', () => {
    const fill = contentPackageToFill([
      { id: '1', label: '增长率', value: 42.7, unit: '%' },
      { id: '2', label: '市场规模' },
      { id: '3', label: '用户数', value: '1200', unit: '万', displayValue: '1200万' }
    ])
    expect(fill.listItems).toEqual(['增长率', '市场规模', '用户数'])
    expect(fill.metrics).toEqual(['42.7%', '1200万'])
  })

  it('returns no metrics when entries have no values', () => {
    const fill = contentPackageToFill(['a', 'b'])
    expect(fill.listItems).toEqual(['a', 'b'])
    expect(fill.metrics).toBeUndefined()
  })

  it('handles plain string arrays', () => {
    const fill = contentPackageToFill(['one', 'two'])
    expect(fill.listItems).toEqual(['one', 'two'])
  })
})
