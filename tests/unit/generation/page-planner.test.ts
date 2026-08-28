import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, resolveModel } = vi.hoisted(() => {
  const invoke = vi.fn()
  return {
    invoke,
    resolveModel: vi.fn(() => ({ invoke }))
  }
})

vi.mock('../../../src/main/agent-runtime/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/agent-runtime/model')>()
  return {
    ...actual,
    resolveModel,
    runWithModelTemperatureControl: (_control: unknown, task: () => unknown) => task()
  }
})

import { planNewPage } from '../../../src/main/generation/planning/page-planner'

describe('page planner', () => {
  beforeEach(() => {
    invoke.mockReset()
    resolveModel.mockClear()
  })

  it('builds a grounded prompt and normalizes the planned page', async () => {
    invoke.mockResolvedValue({
      content: JSON.stringify({
        title: 'Customer evidence',
        keyPoints: ['Retention improved', 'Support volume declined'],
        layoutIntent: 'data-focus',
        contentStructure: 'metric-grid',
        moduleCount: 99,
        visualAspect: 'landscape',
        contentDensity: 'balanced',
        layoutId: null
      })
    })

    const result = await planNewPage({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      topic: 'Quarterly review',
      userDescription: 'Add a slide about customer outcomes',
      existingTitles: ['Overview'],
      sourceDocumentPaths: ['evidence.md']
    })

    expect(result.title).toBe('Customer evidence')
    expect(result.contentOutline).toContain('Retention improved')
    expect(result.moduleCount).toBe(6)
    const messages = invoke.mock.calls[0][0] as Array<{ content: string }>
    expect(messages[0].content).toContain('Source document context:')
    expect(messages[0].content).toContain('evidence.md')
    expect(messages[1].content).toContain('Overview')
  })

  it('rejects a response without a title', async () => {
    invoke.mockResolvedValue({ content: '{"keyPoints":["A"]}' })

    await expect(
      planNewPage({
        provider: 'openai',
        apiKey: 'test-key',
        model: 'test-model',
        baseUrl: 'https://example.test',
        userDescription: 'Add one slide'
      })
    ).rejects.toThrow('missing title')
  })
})
