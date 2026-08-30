import { describe, expect, it } from 'vitest'
import { resolveIncompleteDeckRenderPages } from '../../../src/main/generation/deck-render-gate'

describe('deck render completion gate', () => {
  it('keeps a fully rendered deck out of the retry queue', () => {
    expect(
      resolveIncompleteDeckRenderPages({ available: true, unavailablePages: [] })
    ).toEqual([])
  })

  it('returns only concrete unavailable pages when deck validation is incomplete', () => {
    expect(
      resolveIncompleteDeckRenderPages({
        available: false,
        unavailablePages: [
          { pageId: 'page-1', reason: 'render timeout' },
          { pageId: '', reason: 'invalid diagnostic' },
          { pageId: 'page-3', reason: 'master stylesheet failed' }
        ]
      })
    ).toEqual([
      { pageId: 'page-1', reason: 'render timeout' },
      { pageId: 'page-3', reason: 'master stylesheet failed' }
    ])
  })

  it('does not retry statically valid pages when the local validation renderer is blocked', () => {
    expect(
      resolveIncompleteDeckRenderPages({
        available: false,
        unavailablePages: [
          {
            pageId: 'page-1',
            reason: "ERR_BLOCKED_BY_CLIENT (-20) loading 'file:///project/page-1.html'"
          },
          { pageId: 'page-2', reason: 'rendered deck metrics missing' }
        ]
      })
    ).toEqual([{ pageId: 'page-2', reason: 'rendered deck metrics missing' }])
  })

  it('treats render validation timeouts as environmental and keeps the pages', () => {
    // 复现：高负载机器上整套页面 25s 渲染验收全部超时，此前 6/6 页被误判为
    // 生成失败，实际 HTML 已落盘且可用。timeout 属基础设施抖动，应降级为
    // 非阻断警告而不是把页面打进重试队列。
    expect(
      resolveIncompleteDeckRenderPages({
        available: false,
        unavailablePages: [
          { pageId: 'page-1', reason: 'render validation timeout (25000ms)' },
          { pageId: 'page-2', reason: 'render validation timeout (25000ms)' }
        ]
      })
    ).toEqual([])
  })
})
