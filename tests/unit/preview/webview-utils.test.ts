import { describe, expect, it } from 'vitest'
import {
  applyPreviewUrlParams,
  buildSafeVoidScript,
  resolvePageHtmlPath,
  toPreviewFileUrl
} from '../../../src/renderer/src/components/presentation-webview/webview-utils'

describe('presentation webview utilities', () => {
  it('resolves a concrete page file from a deck index path', () => {
    expect(resolvePageHtmlPath('C:\\deck\\index.html', 'page-2')).toBe(
      'C:\\deck\\page-2.html'
    )
    expect(resolvePageHtmlPath('/deck/index.htm', 'page-3')).toBe('/deck/page-3.html')
    expect(resolvePageHtmlPath('/deck/custom.html', 'page-3')).toBe('/deck/custom.html')
    expect(resolvePageHtmlPath('/deck/index.html')).toBeUndefined()
  })

  it('encodes file paths and applies static preview parameters', () => {
    const url = new URL(
      toPreviewFileUrl('C:\\My Deck\\page 1.html', {
        thumbnail: true,
        pageId: 'page 1'
      })
    )

    expect(url.protocol).toBe('file:')
    expect(decodeURIComponent(url.pathname)).toBe('/C:/My Deck/page 1.html')
    expect(url.searchParams.get('fit')).toBe('off')
    expect(url.searchParams.get('print')).toBe('1')
    expect(url.searchParams.get('pptPlayback')).toBe('0')
    expect(url.searchParams.get('thumbnail')).toBe('1')
    expect(url.searchParams.get('pageId')).toBe('page 1')
  })

  it('preserves existing URL parameters while replacing preview controls', () => {
    const url = new URL(applyPreviewUrlParams('https://example.test/page?fit=on&custom=1'))

    expect(url.searchParams.get('fit')).toBe('off')
    expect(url.searchParams.get('custom')).toBe('1')
  })

  it('builds a source-specific error label without leaving interpolation text behind', () => {
    const script = buildSafeVoidScript('PreviewIframe', 'inspect', 'throw new Error("boom")')

    expect(script).toContain('console.error("[PreviewIframe:inspect]"')
    expect(script).not.toContain('${label}')
    expect(script).toContain('throw new Error("boom")')
  })
})
