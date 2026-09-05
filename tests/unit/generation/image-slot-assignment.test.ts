import { describe, expect, it } from 'vitest'
import { ensureImageSlotLayouts } from '../../../src/main/generation/image-slot-assignment'
import { getUniversalLayoutImageCount } from '@shared/universal-layouts'

const textDeck = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    title: `第 ${index + 1} 页`,
    layoutId: 'three-cards-row',
    layoutIntent: index === 0 ? ('cover' as const) : ('concept' as const)
  }))

describe('ensureImageSlotLayouts', () => {
  it('does nothing without an image policy', () => {
    const items = textDeck(6)
    expect(ensureImageSlotLayouts(items, undefined)).toEqual(items)
    expect(ensureImageSlotLayouts(items)).toEqual(items)
  })

  it("keeps text layouts under the 'none' policy (template decks keep their own visuals)", () => {
    const items = textDeck(6)
    expect(ensureImageSlotLayouts(items, 'none')).toEqual(items)
  })

  it('keeps the deck unchanged when any content page already carries an image slot', () => {
    const items = textDeck(6)
    items[2] = { ...items[2], layoutId: 'image-left-two-cards' }
    const result = ensureImageSlotLayouts(items, 'placeholder')
    expect(result).toEqual(items)
  })

  it('assigns rotating image-slot layouts to content pages only (I-5)', () => {
    const result = ensureImageSlotLayouts(textDeck(6), 'placeholder')
    // 首页（cover）与末页不加配图
    expect(result[0].layoutId).toBe('three-cards-row')
    expect(result[5].layoutId).toBe('three-cards-row')
    // 中间内容页全部换成带图槽布局，且轮换 1/2/3 图
    for (const index of [1, 2, 3, 4]) {
      expect(getUniversalLayoutImageCount(result[index].layoutId)).toBeGreaterThan(0)
    }
    expect(result[1].layoutId).toBe('image-left-two-cards')
    expect(result[2].layoutId).toBe('two-images-caption')
    expect(result[3].layoutId).toBe('three-images-row')
    expect(result[4].layoutId).toBe('image-left-two-cards')
    // 文字布局的 moduleCount 不带入图槽布局
    expect(result[1].moduleCount).toBeUndefined()
  })

  it('skips cover/quote intents inside the deck', () => {
    const items = [
      { layoutIntent: 'cover' as const },
      { layoutIntent: 'quote' as const },
      { layoutIntent: 'concept' as const },
      { layoutIntent: 'concept' as const }
    ]
    const result = ensureImageSlotLayouts(items, 'ai')
    expect(getUniversalLayoutImageCount(result[0].layoutId)).toBe(0)
    expect(getUniversalLayoutImageCount(result[1].layoutId)).toBe(0)
    expect(getUniversalLayoutImageCount(result[2].layoutId)).toBeGreaterThan(0)
  })

  it('leaves tiny decks alone (cover/ending only)', () => {
    const items = textDeck(2)
    expect(ensureImageSlotLayouts(items, 'placeholder')).toEqual(items)
  })
})
