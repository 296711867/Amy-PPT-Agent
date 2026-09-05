import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeckGenerationArgs } from '../../../src/main/generation/deck-generation-types'

const mocks = vi.hoisted(() => ({
  generateSinglePage: vi.fn(),
  generateSinglePageWithRetry: vi.fn()
}))

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../src/main/session/master-service', () => ({
  readSessionLayoutLibrary: vi.fn(async () => ({ library: {} }))
}))

vi.mock('../../../src/main/generation/page-refs', () => ({
  resolveDeckPageRefs: ({ pageTasks }: { pageTasks: Array<Record<string, unknown>> }) =>
    pageTasks.map((page) => ({ ...page, outline: page.contentOutline || '', layoutId: '' }))
}))

vi.mock('../../../src/main/generation/reference-document-retrieval', () => ({
  createReferenceDocumentRetriever: vi.fn()
}))

vi.mock('../../../src/main/generation/single-page-generator', () => ({
  createSinglePageGenerator: vi.fn(() => mocks)
}))

vi.mock('../../../src/main/generation/deck-review-repair', () => ({
  runDeckReviewAndRepair: vi.fn(async () => ({
    deckQualityWarnings: [],
    deckNarrativeWarnings: []
  }))
}))

vi.mock('../../../src/main/generation/planning/page-planner', () => ({ planNewPage: vi.fn() }))
vi.mock('../../../src/main/generation/planning/deck-planner', () => ({ planDeckWithLLM: vi.fn() }))
vi.mock('../../../src/main/generation/planning/design-contract-builder', () => ({
  buildDesignContractWithLLM: vi.fn()
}))
vi.mock('../../../src/main/generation/deck-edit-runner', () => ({
  runDeepAgentEdit: vi.fn(),
  runDeepAgentDeckAllPageEdit: vi.fn()
}))

import { runDeepAgentDeckGeneration } from '../../../src/main/generation/agent-runner'

describe('runDeepAgentDeckGeneration circuit outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records every circuit-skipped page as failed and leaves no pending outcome', async () => {
    mocks.generateSinglePageWithRetry.mockRejectedValue(
      new Error('The operation was aborted due to timeout')
    )
    const onPageFailed = vi.fn(async () => undefined)
    const pageTasks = Array.from({ length: 4 }, (_, index) => ({
      pageNumber: index + 1,
      pageId: `page-${index + 1}`,
      title: `Page ${index + 1}`,
      contentOutline: `Outline ${index + 1}`
    }))

    const result = await runDeepAgentDeckGeneration({
      sessionId: 'session-1',
      provider: 'zhipu',
      apiKey: 'test-key',
      model: 'GLM-5.2',
      baseUrl: 'https://example.test',
      styleId: null,
      styleSkillPrompt: '',
      layoutRulesPrompt: '',
      slideSize: '16:9',
      topic: 'Topic',
      deckTitle: 'Deck',
      userMessage: 'Generate',
      outlineTitles: pageTasks.map((page) => page.title),
      outlineItems: [],
      pageTasks,
      pageConcurrency: 'serial',
      projectDir: 'C:\\workspace',
      indexPath: 'C:\\workspace\\index.html',
      pageFileMap: Object.fromEntries(
        pageTasks.map((page) => [page.pageId, `C:\\workspace\\${page.pageId}.html`])
      ),
      agentManager: {} as DeckGenerationArgs['agentManager'],
      onPageFailed
    })

    expect(mocks.generateSinglePageWithRetry).toHaveBeenCalledTimes(2)
    expect(result.failedPages.map((page) => page.pageId)).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4'
    ])
    expect(result.pendingPages).toEqual([])
    expect(onPageFailed).toHaveBeenCalledTimes(4)
    expect(onPageFailed.mock.calls.slice(2).map(([page]) => page.reason)).toEqual([
      '生成被熔断跳过',
      '生成被熔断跳过'
    ])
  })
})
