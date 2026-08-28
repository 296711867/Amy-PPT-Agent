import { describe, expect, it } from 'vitest'
import {
  buildPageNotWrittenMessage,
  extractHtmlFragmentCandidate,
  extractWriteValidationFailure
} from '../../../src/main/generation/page-write-failure'

describe('extractWriteValidationFailure', () => {
  it('captures the latest write-tool validation failure with label and detail', () => {
    expect(
      extractWriteValidationFailure({
        label: '验证失败 page-1',
        detail: 'font-below-floor: <span class="text-[14px]"> 显式字号 14px，低于当前画布正文下限 18px'
      })
    ).toBe(
      '验证失败 page-1: font-below-floor: <span class="text-[14px]"> 显式字号 14px，低于当前画布正文下限 18px'
    )
  })

  it('recognizes progressLabel-normalized failure statuses', () => {
    // 工具状态发出前 label 会被归一化：「验证失败 page-x」→「已失败」/「Failed」
    expect(
      extractWriteValidationFailure({
        label: '已失败',
        detail: 'font-below-floor: <p class="mt-5 text-[22px]"> 显式字号 22px，低于当前画布标题下限 24px'
      })
    ).toContain('font-below-floor')
    expect(
      extractWriteValidationFailure({
        label: 'Failed',
        detail: 'rendered page overflow；已恢复写入前页面'
      })
    ).toContain('已恢复写入前页面')
  })

  it('recognizes every write validation failure label kind', () => {
    for (const label of [
      '验证失败 page-1',
      '落盘校验失败 page-1',
      '模板骨架校验失败 page-1',
      '外链资源校验失败 page-1',
      '渲染质量校验失败 page-1',
      'Deck 一致性校验失败 page-1'
    ]) {
      expect(extractWriteValidationFailure({ label, detail: '质量校验未通过：内容低于画布下限' }), label).toContain(
        '质量校验未通过：内容低于画布下限'
      )
    }
  })

  it('ignores non-write failures, unlabeled detail, and failures without detail', () => {
    expect(
      extractWriteValidationFailure({ label: '已失败', detail: '切换动画配置失败：参数不合法' })
    ).toBeNull()
    expect(extractWriteValidationFailure({ label: '页面内容已写入', detail: 'page-1' })).toBeNull()
    expect(extractWriteValidationFailure({ label: '生成页面', detail: 'page-1' })).toBeNull()
    expect(extractWriteValidationFailure({ label: '验证失败 page-1', detail: '' })).toBeNull()
    expect(extractWriteValidationFailure({})).toBeNull()
  })
})

describe('extractHtmlFragmentCandidate', () => {
  const fragment = (): string =>
    `<div class="px-24 pt-12 flex flex-col gap-6"><header data-role="title"><h1 class="text-5xl font-semibold">总结与展望</h1></header><p class="text-lg leading-relaxed">正文内容保持投影可读，包含足够的结构信息用于落盘。</p><ul class="text-lg"><li class="text-lg">要点一</li><li class="text-lg">要点二</li></ul></div>`

  it('extracts an html fragment from a fenced code block in the final response', () => {
    const text = `好的，这一页的内容如下：\n\n\`\`\`html\n${fragment()}\n\`\`\`\n\n以上就是本页的完整结构。`
    expect(extractHtmlFragmentCandidate(text)).toBe(fragment())
  })

  it('extracts an html fragment embedded directly in prose', () => {
    const text = `我认为本页应该这样布局：${fragment()} 这样就能满足版式要求。`
    const candidate = extractHtmlFragmentCandidate(text)
    expect(candidate).toContain('<h1 class="text-5xl font-semibold">总结与展望</h1>')
    expect(candidate?.startsWith('<div')).toBe(true)
  })

  it('uses the body content when the model replied with a full html document', () => {
    const text = `<!DOCTYPE html><html><head><title>page</title></head><body>${fragment()}<script>console.log(1)</script></body></html>`
    const candidate = extractHtmlFragmentCandidate(text)
    expect(candidate).toContain('总结与展望')
    expect(candidate).not.toContain('<script')
    expect(candidate).not.toContain('<body')
  })

  it('returns null for plain text without usable html', () => {
    expect(extractHtmlFragmentCandidate('这一页我已经完成，内容都写好了。')).toBeNull()
    expect(extractHtmlFragmentCandidate('<div>太短</div>')).toBeNull()
    expect(extractHtmlFragmentCandidate('')).toBeNull()
  })
})

describe('buildPageNotWrittenMessage', () => {
  it('keeps the plain not-written message when no validation failure was recorded', () => {
    const message = buildPageNotWrittenMessage({
      pageId: 'page-1',
      writeToolName: 'update_single_page_file',
      lastWriteValidationFailure: ''
    })
    expect(message).toContain('页面未写入 (page-1)')
    expect(message).toContain('update_single_page_file')
    expect(message).not.toContain('质量校验拒绝')
  })

  it('appends the last write validation failure so retries keep the violation context', () => {
    const message = buildPageNotWrittenMessage({
      pageId: 'page-1',
      writeToolName: 'update_single_page_file',
      lastWriteValidationFailure:
        '验证失败 page-1: font-below-floor: <span class="text-[14px]"> 显式字号 14px，低于当前画布正文下限 18px'
    })
    expect(message).toContain('页面未写入 (page-1)')
    expect(message).toContain('font-below-floor')
    expect(message).toContain('显式字号 14px')
    expect(message).toContain('必须修正下列问题后重新调用写盘工具')
  })
})
