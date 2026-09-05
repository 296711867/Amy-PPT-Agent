// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {},
  session: {}
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: false
  }
}))
import {
  buildBasePageStyleTag,
  buildFitScript,
  preprocessPageHtml
} from '../../../src/main/presentation/html/page-writer-core'
import {
  buildPageScaffoldHtml,
  buildProjectIndexHtml
} from '../../../src/main/session/template-builder'
import { SLIDE_SIZE_PRESETS, requireSlideSizePreset } from '../../../src/shared/slide-size'

describe('page writer slide size', () => {
  const portrait = requireSlideSizePreset('vertical-9-16')

  it('injects dynamic guard styles, fit dimensions and root metadata', () => {
    expect(buildBasePageStyleTag(portrait)).toContain('--ppt-slide-width: 900px')
    expect(buildBasePageStyleTag(portrait)).toContain('--ppt-slide-height: 1600px')
    expect(buildFitScript(portrait)).toContain('const WIDTH = 900')
    expect(buildFitScript(portrait)).toContain('const HEIGHT = 1600')

    const html = buildPageScaffoldHtml(
      { pageNumber: 1, pageId: 'page-1', title: 'Portrait' },
      portrait
    )
    expect(html).toContain('data-ppt-slide-size-id="vertical-9-16"')
    expect(html).toContain('data-ppt-width="900"')
    expect(html).toContain('data-ppt-height="1600"')
  })

  it('writes deck metadata for the standalone index shell', () => {
    const html = buildProjectIndexHtml(
      'Deck',
      [{ pageNumber: 1, pageId: 'page-1', title: 'One', htmlPath: 'page-1.html' }],
      portrait
    )
    expect(html).toContain('--ppt-slide-width: 900px')
    expect(html).toContain('"slideSizeId":"vertical-9-16"')
    expect(html).toContain('"height":1600')
  })

  it.each(SLIDE_SIZE_PRESETS)('strips fixed canvas classes for %s', (preset) => {
    const slideSize = requireSlideSizePreset(preset.id)
    const aspect =
      slideSize.id === 'wide-16-9'
        ? '16/9'
        : slideSize.id === 'vertical-9-16'
          ? '9/16'
          : slideSize.id === 'standard-4-3'
            ? '4/3'
            : slideSize.id === 'square-1-1'
              ? '1/1'
              : '3/4'
    const html = preprocessPageHtml(
      `<div class="w-[${slideSize.width}px] h-[${slideSize.height}px] aspect-[${aspect}] size-[${slideSize.width}px]" style="width: ${slideSize.width}px; height: ${slideSize.height}px"><p>Content</p></div>`
    )
    expect(html).not.toContain(`w-[${slideSize.width}px]`)
    expect(html).not.toContain(`h-[${slideSize.height}px]`)
    expect(html).not.toContain(`aspect-[${aspect}]`)
    expect(html).not.toContain(`size-[${slideSize.width}px]`)
    expect(html).not.toContain(`width: ${slideSize.width}px`)
    expect(html).not.toContain(`height: ${slideSize.height}px`)
  })

  it('normalizes the common fade-in alias before generated HTML validation', () => {
    const html = preprocessPageHtml('<div data-anim="fade-in">Content</div>')

    expect(html).toContain('data-anim="fade"')
    expect(html).not.toContain('data-anim="fade-in"')
  })
})
