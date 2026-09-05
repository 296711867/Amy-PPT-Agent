import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron-log/main.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../src/main/io/thumbnails/html-thumbnail-service', () => ({
  enqueueHtmlThumbnail: vi.fn(),
  waitForHtmlThumbnailTask: vi.fn()
}))

const fakeInvoke = vi.fn()

vi.mock('../../../src/main/agent-runtime/model', () => ({
  resolveModel: vi.fn(() => ({ invoke: fakeInvoke })),
  // 测试内联实现：剥掉代码围栏后原样返回，供 parseVisualReviewVerdicts 使用。
  extractJsonBlock: (text: string) =>
    String(text || '')
      .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
}))

import {
  buildVisualReviewRubricPrompt,
  parseVisualReviewVerdicts,
  partitionVisualReviewBatches,
  runVisualDeckReview,
  sampleVisualReviewPages,
  supportsVisualReviewInput
} from '../../../src/main/generation/visual-review'
import type { GenerateChunkEvent } from '../../../src/shared/generation'

const pages = [
  { pageId: 'page-a', pageNumber: 1, title: '封面', htmlPath: '/tmp/page-a.html' },
  { pageId: 'page-b', pageNumber: 2, title: '增长飞轮', htmlPath: '/tmp/page-b.html' }
]

describe('visual review rubric prompt', () => {
  it('embeds hard/soft rules, the roster, and a strict JSON contract', () => {
    const prompt = buildVisualReviewRubricPrompt(pages)

    expect(prompt).toContain('Hard rules')
    expect(prompt).toContain('H1 text-clipping')
    expect(prompt).toContain('H5 broken-visual')
    expect(prompt).toContain('Soft rules')
    expect(prompt).toContain('S1 unbalanced-composition')
    expect(prompt).toContain('S4 icon-misuse')
    expect(prompt).toContain('pageId page-a')
    expect(prompt).toContain('"verdict":"pass|soft|hard"')
    expect(prompt).toContain('exactly one object per roster entry')
  })
})

describe('visual review batching and sampling', () => {
  it('skips known text-only Coding endpoints before rendering screenshots', () => {
    expect(
      supportsVisualReviewInput('https://open.bigmodel.cn/api/coding/paas/v4')
    ).toBe(false)
    expect(supportsVisualReviewInput('https://api.openai.com/v1')).toBe(true)
  })

  it('partitions pages into batches of three with a remainder batch', () => {
    const items = [1, 2, 3, 4, 5, 6, 7]
    expect(partitionVisualReviewBatches(items)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(partitionVisualReviewBatches([], 3)).toEqual([])
  })

  it('samples evenly beyond the cap while keeping the first and last slide', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ pageNumber: index + 1 }))
    const sampled = sampleVisualReviewPages(many)
    expect(sampled.length).toBeLessThanOrEqual(30)
    expect(sampled[0]?.pageNumber).toBe(1)
    expect(sampled[sampled.length - 1]?.pageNumber).toBe(80)
    expect(sampleVisualReviewPages(many.slice(0, 10))).toHaveLength(10)
  })
})

describe('visual review verdict parsing', () => {
  it('maps verdicts onto expected pages and normalizes issues', () => {
    const response = JSON.stringify([
      { pageNumber: 1, pageId: 'page-a', verdict: 'pass', issues: [] },
      {
        pageNumber: 2,
        pageId: 'page-b',
        verdict: 'hard',
        issues: [{ rule: 'h1', detail: '标题与正文重叠' }, { rule: '', detail: 'x' }]
      }
    ])
    const results = parseVisualReviewVerdicts(response, pages)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ pageId: 'page-a', verdict: 'pass' })
    expect(results[1]).toMatchObject({ pageId: 'page-b', verdict: 'hard' })
    expect(results[1]?.issues).toEqual([{ rule: 'H1', detail: '标题与正文重叠' }])
  })

  it('ignores unknown page ids and coerces invalid verdicts to pass', () => {
    const response = JSON.stringify([
      { pageNumber: 9, pageId: 'page-unknown', verdict: 'hard', issues: [] },
      { pageNumber: 2, pageId: 'page-b', verdict: 'weird', issues: [] }
    ])
    const results = parseVisualReviewVerdicts(response, pages)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ pageId: 'page-b', verdict: 'pass' })
  })

  it('throws on non-array JSON so the batch can degrade', () => {
    expect(() => parseVisualReviewVerdicts('{"verdict":"pass"}', pages)).toThrow()
  })
})

describe('runVisualDeckReview orchestration', () => {
  const slideSize = { id: 'wide-16-9', label: '宽屏 16:9', width: 1600, height: 900 } as const

  const runReview = async (overrides: Record<string, unknown> = {}) => {
    const chunks: GenerateChunkEvent[] = []
    await runVisualDeckReview({
      sessionId: 'session-1',
      runId: 'run-1',
      slideSize,
      pages,
      model: { provider: 'openai', apiKey: 'k', model: 'gpt-x', baseUrl: '' },
      appLocale: 'zh',
      emit: (chunk) => chunks.push(chunk),
      capturePageImage: async () => 'aGk=',
      ...overrides
    } as Parameters<typeof runVisualDeckReview>[0])
    return chunks
  }

  beforeEach(() => {
    fakeInvoke.mockReset()
  })

  it('emits per-issue and summary statuses for reviewed slides', async () => {
    fakeInvoke.mockResolvedValue({
      content: JSON.stringify([
        { pageNumber: 1, pageId: 'page-a', verdict: 'pass', issues: [] },
        {
          pageNumber: 2,
          pageId: 'page-b',
          verdict: 'soft',
          issues: [{ rule: 'S1', detail: '右下半大面积空置' }]
        }
      ])
    })

    const chunks = await runReview()
    const details = chunks.map((chunk) => chunk.payload.detail).filter(Boolean) as string[]

    expect(details.join('\n')).toContain('视觉自检：正在评审 2 页')
    expect(details.join('\n')).toContain('第 2 页视觉自检有优化建议：S1: 右下半大面积空置')
    expect(details.join('\n')).toContain('视觉自检完成：1 页通过，1 页有优化建议')
  })

  it('never throws when the model rejects image input, and degrades with one notice', async () => {
    fakeInvoke.mockRejectedValue(new Error('image input not supported'))

    const chunks = await runReview()
    const details = chunks.map((chunk) => chunk.payload.detail).filter(Boolean) as string[]

    expect(details.join('\n')).toContain('视觉自检已跳过')
    expect(details.filter((detail) => detail.includes('视觉自检已跳过'))).toHaveLength(1)
  })

  it('does not report completion when no page screenshot is available', async () => {
    fakeInvoke.mockResolvedValue({
      content: JSON.stringify([{ pageNumber: 1, pageId: 'page-a', verdict: 'pass', issues: [] }])
    })

    const chunks = await runReview({ capturePageImage: async () => null })
    const details = chunks.map((chunk) => chunk.payload.detail).filter(Boolean) as string[]

    expect(details.join('\n')).toContain('视觉自检已跳过')
    expect(details.join('\n')).not.toContain('视觉自检完成')
    expect(fakeInvoke).not.toHaveBeenCalled()
  })

  it('reports an incomplete review when only part of the sampled deck is rendered', async () => {
    fakeInvoke.mockResolvedValue({
      content: JSON.stringify([{ pageNumber: 1, pageId: 'page-a', verdict: 'pass', issues: [] }])
    })

    const chunks = await runReview({
      capturePageImage: async (page) => (page.pageId === 'page-a' ? 'aGk=' : null)
    })
    const details = chunks.map((chunk) => chunk.payload.detail).filter(Boolean) as string[]

    expect(details.join('\n')).toContain('视觉自检未完成：仅获得 1/2 页评审结果')
    expect(details.join('\n')).not.toContain('视觉自检完成')
  })

  it('stays silent when disabled or aborted', async () => {
    const disabledChunks = await runReview({ isEnabled: async () => false })
    expect(disabledChunks).toHaveLength(0)
    expect(fakeInvoke).not.toHaveBeenCalled()

    const abortedChunks = await runReview({ signal: AbortSignal.abort() as AbortSignal })
    expect(abortedChunks).toHaveLength(0)
    expect(fakeInvoke).not.toHaveBeenCalled()
  })

  it('does not capture screenshots for a known text-only Coding endpoint', async () => {
    const capturePageImage = vi.fn(async () => 'aGk=')
    const chunks = await runReview({
      model: {
        provider: 'zhipu',
        apiKey: 'k',
        model: 'GLM-5.2',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4'
      },
      capturePageImage
    })
    const details = chunks.map((chunk) => chunk.payload.detail).filter(Boolean) as string[]

    expect(details.join('\n')).toContain('当前 Coding 接口仅接受文本输入')
    expect(capturePageImage).not.toHaveBeenCalled()
    expect(fakeInvoke).not.toHaveBeenCalled()
  })
})
