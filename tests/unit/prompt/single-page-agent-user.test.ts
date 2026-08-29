import { describe, expect, it } from 'vitest'
import {
  buildSinglePageAgentUserPrompt,
  measurePromptText
} from '../../../src/main/agent-runtime/prompt'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const baseArgs = {
  topic: 'Quarterly report',
  deckTitle: 'Quarterly report',
  slideSize: resolveSlideSize({ id: 'wide-16-9' }),
  page: {
    pageId: 'page-1',
    pageNumber: 1,
    title: 'Overview',
    outline: 'Summarize the quarter.',
    layoutId: 'data-chart-side',
    layoutPrompt: 'Selected layout master: Chart with takeaway (data-chart-side).'
  }
}

describe('single-page agent user prompt composer', () => {
  it('places run addenda before page data and drops empty addenda', () => {
    const prompt = buildSinglePageAgentUserPrompt({
      ...baseArgs,
      singlePagePromptAddendum: '  Run-level guidance.  ',
      pagePromptAddendum: ''
    })

    expect(prompt.indexOf('Run-level guidance.')).toBeLessThan(prompt.indexOf('Target page: page-1'))
    expect(prompt).toContain(`Required action: call update_single_page_file(pageId="page-1"`)
  })

  it('injects targeted repair instructions on retries and keeps them above the page data', () => {
    const prompt = buildSinglePageAgentUserPrompt({
      ...baseArgs,
      generationMode: 'retry',
      retryContext: { attempt: 2, maxRetries: 3, previousError: 'font-below-floor' }
    })

    expect(prompt).toContain('Targeted repair instructions (this is a retry):')
    expect(prompt).toContain('5. Previous error: font-below-floor')
    expect(prompt.indexOf('Targeted repair instructions')).toBeLessThan(
      prompt.indexOf('Target page: page-1')
    )
  })

  it('requires template inspection and the template write tool for template runs', () => {
    const prompt = buildSinglePageAgentUserPrompt({
      ...baseArgs,
      requireTemplatePageRead: true,
      page: { ...baseArgs.page, templatePageRole: 'cover' }
    })

    expect(prompt).toContain('Template inspection is mandatory before writing.')
    expect(prompt).toContain('read_file(path="/page-1.html", offset=0, limit=1200)')
    expect(prompt).toContain(
      `Required action: call update_template_page_file(pageId="page-1"`
    )
    expect(prompt).toContain('classified as a cover')
  })

  it('keeps the composed prompt measurable with the log-safe metrics helper', () => {
    const prompt = buildSinglePageAgentUserPrompt({ ...baseArgs })
    const metrics = measurePromptText(prompt)

    expect(metrics.characterCount).toBe(prompt.length)
    expect(metrics.estimatedTokens).toBeGreaterThan(0)
    expect(JSON.stringify(metrics)).not.toContain('Quarterly report')
  })
})
