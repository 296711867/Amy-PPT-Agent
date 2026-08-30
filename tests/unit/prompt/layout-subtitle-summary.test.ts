import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_RULES,
  buildLayoutRulesPrompt,
  normalizeLayoutRules
} from '../../../src/shared/layout-rules'

describe('subtitle and takeaway-line controls', () => {
  it('defaults to no takeaway line and no subtitles on content slides', () => {
    expect(DEFAULT_LAYOUT_RULES.summaryLineMode).toBe('off')
    expect(DEFAULT_LAYOUT_RULES.subtitleMode).toBe('content-off')
  })

  it('normalizes the subtitle mode with a fallback for invalid values', () => {
    expect(normalizeLayoutRules({ subtitleMode: 'off' }).subtitleMode).toBe('off')
    expect(normalizeLayoutRules({ subtitleMode: 'content-off' }).subtitleMode).toBe('content-off')
    expect(normalizeLayoutRules({ subtitleMode: 'nonsense' }).subtitleMode).toBe(
      DEFAULT_LAYOUT_RULES.subtitleMode
    )
    expect(normalizeLayoutRules({}).subtitleMode).toBe(DEFAULT_LAYOUT_RULES.subtitleMode)
  })

  it('keeps legacy profiles valid by filling the new fields', () => {
    const legacy = { schemaVersion: 3, preset: 'keynote', summaryLineMode: 'always' }
    const rules = normalizeLayoutRules(legacy)
    expect(rules.preset).toBe('keynote')
    expect(rules.summaryLineMode).toBe('always')
    expect(rules.subtitleMode).toBe(DEFAULT_LAYOUT_RULES.subtitleMode)
  })

  it('injects the subtitle rule for each mode', () => {
    expect(buildLayoutRulesPrompt({ subtitleMode: 'on' })).toContain('- Slide subtitle: ')
    expect(buildLayoutRulesPrompt({ subtitleMode: 'on' })).toContain(
      'Slide-level subtitles are allowed'
    )
    expect(buildLayoutRulesPrompt({ subtitleMode: 'content-off' })).toContain(
      'Do not add a slide-level subtitle or whole-page lead line on normal content slides'
    )
    expect(buildLayoutRulesPrompt({ subtitleMode: 'off' })).toContain(
      'Do not add a slide-level subtitle or whole-page lead line on any page'
    )
  })

  it('drops the subtitle type tier when subtitles are fully off', () => {
    const prompt = buildLayoutRulesPrompt({ subtitleMode: 'off' })
    expect(prompt).not.toContain('slide subtitle or whole-page lead about')
    expect(prompt).not.toContain('A slide subtitle belongs to the whole page')
    expect(prompt).not.toContain('副标题按正文下限')

    const kept = buildLayoutRulesPrompt({ subtitleMode: 'content-off' })
    expect(kept).toContain('slide subtitle or whole-page lead about')
    expect(kept).toContain('副标题按正文下限')
  })

  it('switches the takeaway-line rule text per mode', () => {
    expect(buildLayoutRulesPrompt({ summaryLineMode: 'off' })).toContain(
      '- Takeaway line: Do not add a separate takeaway line'
    )
    expect(buildLayoutRulesPrompt({ summaryLineMode: 'always' })).toContain(
      'Add one concise takeaway line below the title or near the bottom on normal content slides'
    )
    expect(buildLayoutRulesPrompt({ summaryLineMode: 'contextual' })).toContain(
      'Add one concise takeaway line on data, comparison, recommendation, or teaching slides'
    )
  })
})
