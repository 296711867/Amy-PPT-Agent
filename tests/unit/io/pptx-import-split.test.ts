import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {},
  session: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { resolveSlideFit, titleFromSlide } from '../../../src/main/io/pptx-import/slide-render'
import { buildTableBlock } from '../../../src/main/io/pptx-import/block-builders'
import { sanitizeContentHtml } from '../../../src/main/io/pptx-import/sanitize'
import type { Element, Slide } from '@arcsin1/pptx2json'

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')

const splitModules = [
  'src/main/io/pptx-import/element-model.ts',
  'src/main/io/pptx-import/sanitize.ts',
  'src/main/io/pptx-import/image-registry.ts',
  'src/main/io/pptx-import/style-css.ts',
  'src/main/io/pptx-import/block-builders.ts',
  'src/main/io/pptx-import/slide-render.ts'
]

describe('pptx-import layered split', () => {
  it('keeps every split module present and the entry as pure orchestration', () => {
    expect(splitModules.filter((filePath) => !fs.existsSync(filePath))).toEqual([])

    const entry = readSource('src/main/io/pptx-import/index.ts')
    expect(entry).toContain('importPptxToEditableHtml')
    // 块构建/渲染内部实现不再留在入口，入口只做编排与类型导出。
    expect(entry).not.toContain('const buildShapeBlock')
    expect(entry).not.toContain('const renderElement')
    expect(entry).not.toContain('sanitizeContentHtml')
    expect(entry).not.toContain('__pptxImporterTestUtils')
  })

  it('layers dependencies one-way without import cycles back up', () => {
    const layering: Array<[string, string[]]> = [
      ['src/main/io/pptx-import/sanitize.ts', ['block-builders', 'slide-render', 'style-css']],
      ['src/main/io/pptx-import/element-model.ts', ['style-css', 'block-builders', 'slide-render']],
      ['src/main/io/pptx-import/image-registry.ts', ['style-css', 'block-builders', 'slide-render']],
      ['src/main/io/pptx-import/style-css.ts', ['block-builders', 'slide-render']],
      ['src/main/io/pptx-import/block-builders.ts', ['slide-render']]
    ]
    for (const [filePath, forbidden] of layering) {
      const source = readSource(filePath)
      for (const module of forbidden) {
        expect(source, `${filePath} -> ${module}`).not.toContain(`from './${module}'`)
      }
    }
  })

  it('keeps imported text HTML sanitized through the split modules', () => {
    const html = `<p onclick="steal()" style="font-size:12pt;color:#111111">正文<script>alert(1)</script><img src="x.png" /></p>`
    const sanitized = sanitizeContentHtml(html, 2)

    expect(sanitized).toContain('正文')
    expect(sanitized).toContain('font-size:24.0px')
    expect(sanitized).not.toContain('onclick')
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('<img')
  })

  it('centers a 4:3 slide on the 16:9 import canvas', () => {
    const fit = resolveSlideFit({ width: 1200, height: 900 })

    expect(fit.scale).toBeCloseTo(1)
    expect(fit.offsetX).toBeCloseTo(200)
    expect(fit.offsetY).toBeCloseTo(0)
  })

  it('renders table blocks with merged-cell skipping and colspan', () => {
    const html = buildTableBlock({
      element: {
        left: 0,
        top: 0,
        width: 600,
        height: 200,
        data: [
          [
            { text: 'Header A', colSpan: 2, borders: undefined },
            { text: '', hMerge: 1, borders: undefined }
          ],
          [
            { text: 'Cell 1', borders: undefined },
            { text: 'Cell 2', borders: undefined }
          ]
        ]
      },
      blockId: 'table-1',
      scaleX: 1,
      scaleY: 1,
      textScale: 1,
      zIndex: 2,
      offsetX: 0,
      offsetY: 0
    })

    expect(html).toContain('data-block-id="table-1"')
    expect(html).toContain('data-pptx-import-mode="editable"')
    expect(html).toContain('colspan="2"')
    expect(html).toContain('Header A')
    expect(html).toContain('Cell 2')
    // hMerge 延续单元格不产生额外 <td>：3 个内容单元格 + 1 个跳过 = 3 个 td。
    expect(html.match(/<td\b/g)).toHaveLength(3)
  })

  it('prefers keyword-rich CJK titles over low-value boilerplate', () => {
    const textElement = (text: string, top: number, height: number): Element =>
      ({
        type: 'text',
        top,
        left: 100,
        width: 900,
        height,
        content: `<p>${text}</p>`
      }) as unknown as Element
    const slide = {
      elements: [
        textElement('单击此处输入标题文字', 40, 200),
        textElement('2026 年度工作总结汇报', 60, 120),
        textElement('thank you for your attention', 700, 80)
      ]
    } as unknown as Slide

    expect(titleFromSlide(slide, 1)).toBe('2026 年度工作总结汇报')
  })
})
