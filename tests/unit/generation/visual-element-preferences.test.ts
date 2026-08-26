import { describe, expect, it } from 'vitest'
import {
  normalizeVisualElementPreferences,
  formatVisualElementGuidance,
  DEFAULT_VISUAL_ELEMENT_PREFERENCES,
  type VisualElementPreferences
} from '../../../src/shared/generation'

describe('normalizeVisualElementPreferences', () => {
  it('returns defaults for null/undefined/non-object', () => {
    expect(normalizeVisualElementPreferences(null)).toEqual(DEFAULT_VISUAL_ELEMENT_PREFERENCES)
    expect(normalizeVisualElementPreferences(undefined)).toEqual(DEFAULT_VISUAL_ELEMENT_PREFERENCES)
    expect(normalizeVisualElementPreferences('string')).toEqual(DEFAULT_VISUAL_ELEMENT_PREFERENCES)
    expect(normalizeVisualElementPreferences([])).toEqual(DEFAULT_VISUAL_ELEMENT_PREFERENCES)
  })

  it('normalizes valid levels', () => {
    const result = normalizeVisualElementPreferences({
      charts: 'moderate',
      images: 'few',
      tables: 'rich'
    })
    expect(result).toEqual({ charts: 'moderate', images: 'few', tables: 'rich' })
  })

  it('falls back to none for invalid levels', () => {
    const result = normalizeVisualElementPreferences({
      charts: 'invalid',
      images: 'few',
      tables: 42
    })
    expect(result.charts).toBe('none')
    expect(result.images).toBe('few')
    expect(result.tables).toBe('none')
  })
})

describe('formatVisualElementGuidance', () => {
  it('returns empty string when all levels are none', () => {
    expect(formatVisualElementGuidance(DEFAULT_VISUAL_ELEMENT_PREFERENCES)).toBe('')
  })

  it('includes chart guidance when charts are requested', () => {
    const prefs: VisualElementPreferences = { charts: 'moderate', images: 'none', tables: 'none' }
    const guidance = formatVisualElementGuidance(prefs)
    expect(guidance).toContain('3-5 chart page(s)')
    expect(guidance).toContain('visualFormat "chart"')
    expect(guidance).toContain('data trends, comparisons, or proportions')
    expect(guidance).not.toContain('visualFormat "image-focus"')
    expect(guidance).not.toContain('visualFormat "table"')
  })

  it('includes image and table guidance when requested', () => {
    const prefs: VisualElementPreferences = { charts: 'none', images: 'few', tables: 'rich' }
    const guidance = formatVisualElementGuidance(prefs)
    expect(guidance).toContain('1-2 image-focused page(s)')
    expect(guidance).toContain('visualFormat "image-focus"')
    expect(guidance).toContain('as many as suitable table page(s)')
    expect(guidance).toContain('visualFormat "table"')
  })

  it('includes all three when all are requested', () => {
    const prefs: VisualElementPreferences = { charts: 'few', images: 'moderate', tables: 'few' }
    const guidance = formatVisualElementGuidance(prefs)
    expect(guidance).toContain('1-2 chart page(s)')
    expect(guidance).toContain('3-5 image-focused page(s)')
    expect(guidance).toContain('1-2 table page(s)')
  })
})
