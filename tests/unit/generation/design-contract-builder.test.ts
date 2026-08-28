import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, resolveModel, assertFontFamilyAvailable, buildAvailableFontsForPrompt } =
  vi.hoisted(() => {
    const invoke = vi.fn()
    return {
      invoke,
      resolveModel: vi.fn(() => ({ invoke })),
      assertFontFamilyAvailable: vi.fn(async () => undefined),
      buildAvailableFontsForPrompt: vi.fn(async () => [
        {
          id: 'inter',
          family: 'Inter',
          source: 'system',
          category: 'sans-serif',
          role: ['title', 'subtitle', 'body'],
          scripts: ['latin']
        }
      ])
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

vi.mock('../../../src/main/presentation/fonts/font-registry', () => ({
  assertFontFamilyAvailable,
  buildAvailableFontsForPrompt
}))

import { buildDesignContractWithLLM } from '../../../src/main/generation/planning/design-contract-builder'

const validContract = {
  theme: 'Editorial',
  background: 'Warm white',
  palette: ['#111111', '#ffffff', '#ff6600'],
  titleStyle: 'text-5xl bold',
  layoutMotif: 'Grid',
  chartStyle: 'Minimal',
  shapeLanguage: 'Soft rectangles',
  titleFont: 'Inter',
  subtitleFont: 'Inter',
  bodyFont: 'Inter'
}

describe('design contract builder', () => {
  beforeEach(() => {
    invoke.mockReset()
    resolveModel.mockClear()
    assertFontFamilyAvailable.mockClear()
    buildAvailableFontsForPrompt.mockClear()
  })

  it('retries an invalid response and returns a validated contract', async () => {
    invoke
      .mockResolvedValueOnce({ content: '{"theme":"incomplete"}' })
      .mockResolvedValueOnce({ content: JSON.stringify(validContract) })
    const emit = vi.fn()

    const result = await buildDesignContractWithLLM({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      styleId: null,
      styleSkillPrompt: 'Use an editorial visual system',
      totalPages: 5,
      slideSize: { id: 'wide-16-9', width: 1600, height: 900, label: '宽屏 16:9' },
      emit
    })

    expect(result).toEqual(validContract)
    expect(invoke).toHaveBeenCalledTimes(2)
    const retryMessages = invoke.mock.calls[1][0] as Array<{ content: string }>
    expect(retryMessages[1].content).toContain('Design contract retry requirement:')
    expect(assertFontFamilyAvailable).toHaveBeenCalledWith('Inter', 'titleFont')
    expect(assertFontFamilyAvailable).toHaveBeenCalledWith('Inter', 'bodyFont')
    expect(emit).toHaveBeenCalled()
  })

  it('enforces an explicitly selected font pair', async () => {
    invoke.mockResolvedValue({ content: JSON.stringify(validContract) })

    await buildDesignContractWithLLM({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.test',
      styleId: null,
      styleSkillPrompt: 'Editorial',
      totalPages: 1,
      slideSize: { id: 'wide-16-9', width: 1600, height: 900, label: '宽屏 16:9' },
      fontSelection: {
        mode: 'pair',
        title: { family: 'Inter' },
        subtitle: { family: 'Inter' },
        body: { family: 'Inter' }
      }
    })

    expect(assertFontFamilyAvailable).toHaveBeenCalledWith('Inter', 'subtitleFont')
  })
})
