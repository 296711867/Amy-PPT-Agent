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

import { planDeckWithLLM } from '../../../src/main/generation/planning/deck-planner'

describe('deck planner', () => {
  beforeEach(() => {
    invoke.mockReset()
    resolveModel.mockClear()
  })

  it('retries invalid output and normalizes the requested page count', async () => {
    invoke
      .mockResolvedValueOnce({ content: '{"title":"not-an-array"}' })
      .mockResolvedValueOnce({
        content: JSON.stringify([
          {
            title: 'Market context',
            keyPoints: ['Demand', 'Competition'],
            layoutIntent: 'comparison',
            contentStructure: 'comparison',
            moduleCount: 20,
            visualAspect: 'landscape',
            contentDensity: 'balanced',
            layoutId: null
          },
          {
            title: 'Next steps',
            keyPoints: ['Pilot', 'Measure'],
            layoutIntent: 'process',
            contentStructure: 'flow',
            moduleCount: 2,
            visualAspect: 'mixed',
            contentDensity: 'balanced',
            layoutId: null
          }
        ])
      })
    const emit = vi.fn()

    const result = await planDeckWithLLM({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      styleId: null,
      totalPages: 2,
      topic: 'Product strategy',
      userMessage: 'Build a concise strategy deck',
      emit
    })

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Market context')
    expect(result[0].moduleCount).toBe(6)
    expect(invoke).toHaveBeenCalledTimes(2)
    const retryMessages = invoke.mock.calls[1][0] as Array<{ content: string }>
    expect(retryMessages[1].content).toContain('Planning retry requirement:')
    expect(retryMessages[1].content).toContain('return exactly 2 items')
    expect(emit).toHaveBeenCalled()
  })

  it('pads a short valid response to the requested page count', async () => {
    invoke.mockResolvedValue({
      content: JSON.stringify([
        {
          title: 'Only planned page',
          keyPoints: ['One point'],
          layoutIntent: 'concept',
          moduleCount: 1
        }
      ])
    })

    const result = await planDeckWithLLM({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      styleId: null,
      totalPages: 2,
      topic: 'Topic',
      userMessage: 'Create two pages',
      appLocale: 'en'
    })

    expect(result.map((item) => item.title)).toEqual(['Only planned page', 'Page 2'])
  })
})
