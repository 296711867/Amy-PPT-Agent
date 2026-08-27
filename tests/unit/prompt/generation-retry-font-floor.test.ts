import { describe, expect, it } from 'vitest'
import { buildSinglePageGenerationPrompt } from '../../../src/main/agent-runtime/prompt'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const notWrittenWithFontFloor =
  '页面未写入 (page-1)：模型没有成功调用 update_single_page_file 写入目标 page 文件。必须调用 update_single_page_file(pageId="page-1", content=完整创意页面片段)，不要只在最终回复里描述 HTML。 最近一次写盘被质量校验拒绝，必须修正下列问题后重新调用写盘工具：验证失败 page-1: font-below-floor: <span class="text-[14px] text-[#64748b]"> 显式字号 14px，低于当前画布正文下限 18px'

const buildRetryPrompt = (previousError: string): string =>
  buildSinglePageGenerationPrompt({
    topic: '测试主题',
    deckTitle: '测试标题',
    pageId: 'page-1',
    pageNumber: 1,
    pageTitle: '第一页',
    pageOutline: '说明重点',
    slideSize: resolveSlideSize({ id: 'wide-16-9' }),
    retryContext: {
      attempt: 1,
      maxRetries: 2,
      previousError
    }
  })

describe('generation retry prompt font floor fix', () => {
  it('mentions both the write tool requirement and the font floor fix for not-written pages rejected by font-below-floor', () => {
    const prompt = buildRetryPrompt(notWrittenWithFontFloor)

    expect(prompt).toContain('必须调用 update_single_page_file')
    expect(prompt).toContain('font-below-floor')
    expect(prompt).toContain('显式字号不得低于当前画布下限')
    expect(prompt).toContain('正文 ≥18px')
    expect(prompt).toContain('data-ppt-text-role="auxiliary"')
  })

  it('mentions the font floor fix when the raw harness rejection is retried directly', () => {
    const prompt = buildRetryPrompt(
      '质量校验未通过 (page-1)：按下列每一条逐条修正后重新调用写盘工具，不要辩解、不要绕过。- [font-below-floor] <span class="text-[14px]"> 显式字号 14px，低于当前画布正文下限 18px → 提高字号或标记辅助文本'
    )

    expect(prompt).toContain('显式字号不得低于当前画布下限')
    expect(prompt).toContain('正文 ≥18px')
  })

  it('does not inject the harness fix for unrelated retries', () => {
    const prompt = buildRetryPrompt('model 429 quota exceeded')

    expect(prompt).not.toContain('显式字号不得低于当前画布下限')
  })
})
