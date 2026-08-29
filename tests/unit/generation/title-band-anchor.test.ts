import { describe, expect, it, vi } from 'vitest'
import {
  extractTitleBandHtml,
  isTitleBandAnchorExemptIntent,
  resolveTitleBandAnchor
} from '../../../src/main/generation/title-band-anchor'

const persistedPage = (bandInner: string): string => `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8" /><title>page</title></head>
<body>
  <div class="ppt-page-root" data-ppt-guard-root="1">
    <div class="ppt-page-content">
      <section data-page-scaffold="1">
        <main data-block-id="content" data-role="content">
          ${bandInner}
          <div data-block-id="text-1" style="position:absolute;top:180px;left:96px;">正文模块</div>
        </main>
      </section>
    </div>
  </div>
</body>
</html>`

const conventionalBand = `<header data-role="title" style="position:absolute;top:36px;left:96px;width:1000px;">
  <div data-ppt-text-role="auxiliary" style="font-size:14px;letter-spacing:2px;color:#64748b;">CHAPTER 01 · GROWTH</div>
  <h1 style="margin:0;font-size:40px;color:#0f172a;">季度增长复盘</h1>
</header>`

describe('title band anchor extraction', () => {
  it('extracts and whitespace-normalizes the data-role title band', () => {
    const bandHtml = extractTitleBandHtml(persistedPage(conventionalBand))

    expect(bandHtml).toContain('<header data-role="title"')
    expect(bandHtml).toContain('CHAPTER 01 · GROWTH')
    expect(bandHtml).toContain('季度增长复盘')
    expect(bandHtml).not.toMatch(/\n/)
    expect(bandHtml?.startsWith('<header')).toBe(true)
    expect(bandHtml?.endsWith('</header>')).toBe(true)
  })

  it('falls back to data-block-id title when data-role is absent', () => {
    const bandHtml = extractTitleBandHtml(
      persistedPage('<header data-block-id="title"><h1>仅 block-id 标题</h1></header>')
    )

    expect(bandHtml).toContain('data-block-id="title"')
    expect(bandHtml).toContain('仅 block-id 标题')
  })

  it('returns null for pages without a title band or with an oversized band', () => {
    expect(extractTitleBandHtml(persistedPage('<div data-block-id="text-1">无标题页</div>'))).toBeNull()
    expect(extractTitleBandHtml('')).toBeNull()

    const huge = `<header data-role="title"><h1>${'很长的标题'.repeat(600)}</h1></header>`
    expect(extractTitleBandHtml(persistedPage(huge))).toBeNull()
  })

  it('flags cover, quote, and image-focus pages as anchor-exempt', () => {
    expect(isTitleBandAnchorExemptIntent('cover')).toBe(true)
    expect(isTitleBandAnchorExemptIntent('quote')).toBe(true)
    expect(isTitleBandAnchorExemptIntent('image-focus')).toBe(true)
    expect(isTitleBandAnchorExemptIntent('data-focus')).toBe(false)
    expect(isTitleBandAnchorExemptIntent(undefined)).toBe(false)
  })
})

describe('title band anchor resolution', () => {
  const candidates = [
    { pageId: 'pg-1', pageNumber: 1, layoutIntent: 'cover' as const, htmlPath: '/p/1.html' },
    { pageId: 'pg-2', pageNumber: 2, layoutIntent: 'data-focus' as const, htmlPath: '/p/2.html' },
    { pageId: 'pg-4', pageNumber: 4, layoutIntent: 'quote' as const, htmlPath: '/p/4.html' }
  ]

  it('picks the lowest-numbered conventional written page and skips exempt pages', async () => {
    const readPageHtml = vi.fn(async (filePath: string) =>
      filePath === '/p/2.html' ? persistedPage(conventionalBand) : persistedPage('<div>empty</div>')
    )
    const anchor = await resolveTitleBandAnchor({ candidates, readPageHtml })

    expect(anchor).toMatchObject({ pageId: 'pg-2', pageNumber: 2 })
    expect(anchor?.bandHtml).toContain('季度增长复盘')
    // 封面（pg-1）按豁免过滤，根本不读盘；quote 页因前面已命中也不读。
    expect(readPageHtml).toHaveBeenCalledTimes(1)
    expect(readPageHtml).toHaveBeenCalledWith('/p/2.html')
  })

  it('falls back to the retried page own previous version after neighbors', async () => {
    const ordered = [
      { pageId: 'pg-2', pageNumber: 2, layoutIntent: 'concept' as const, htmlPath: '/p/2.html' },
      { pageId: 'pg-3', pageNumber: 3, layoutIntent: 'process' as const, pageHtml: persistedPage(conventionalBand) }
    ]
    const readPageHtml = vi.fn(async () => persistedPage('<div>邻居无标题带</div>'))
    const anchor = await resolveTitleBandAnchor({ candidates: ordered, readPageHtml })

    // 邻居先读但没有带 → 用重试页自身旧版（预加载 pageHtml，未再读盘）。
    expect(anchor).toMatchObject({ pageId: 'pg-3', pageNumber: 3 })
    expect(readPageHtml).toHaveBeenCalledTimes(1)
  })

  it('returns null when nothing yields a band and tolerates read failures', async () => {
    const readPageHtml = vi.fn(async () => {
      throw new Error('file locked by a parallel writer')
    })

    expect(await resolveTitleBandAnchor({ candidates, readPageHtml: () => Promise.reject(new Error('boom')) })).toBeNull()
    expect(
      await resolveTitleBandAnchor({
        candidates: [{ pageId: 'pg-2', pageNumber: 2, htmlPath: '/p/2.html' }],
        readPageHtml
      })
    ).toBeNull()
  })
})
