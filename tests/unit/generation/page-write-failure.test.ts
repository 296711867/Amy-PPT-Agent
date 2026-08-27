import { describe, expect, it } from 'vitest'
import {
  buildPageNotWrittenMessage,
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

  it('recognizes every write validation failure label kind', () => {
    for (const label of [
      '验证失败 page-1',
      '落盘校验失败 page-1',
      '模板骨架校验失败 page-1',
      '外链资源校验失败 page-1',
      '渲染质量校验失败 page-1',
      'Deck 一致性校验失败 page-1'
    ]) {
      expect(extractWriteValidationFailure({ label, detail: 'boom' }), label).toBe(
        `${label}: boom`
      )
    }
  })

  it('ignores non-validation statuses and failures without detail', () => {
    expect(extractWriteValidationFailure({ label: '页面内容已写入', detail: 'page-1' })).toBeNull()
    expect(extractWriteValidationFailure({ label: '生成页面', detail: 'page-1' })).toBeNull()
    expect(extractWriteValidationFailure({ label: '验证失败 page-1', detail: '' })).toBeNull()
    expect(extractWriteValidationFailure({})).toBeNull()
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
