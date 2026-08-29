import fs from 'fs'
import path from 'path'
import { parse, type ParseIssue } from '@arcsin1/pptx2json'
import { buildProjectIndexHtml, type DeckPageFile } from '../../session/template-builder'
import { readPptxAnimationPlans } from './animation-import'
import { parsePptxXmlDeckMetadata } from './xml-shape-metadata'
import { PptxTextValidator } from './text-validator'
import { requireSlideSizePreset, type SlideSizePreset } from '@shared/slide-size'
import { buildSlideHtml, titleFromSlide } from './slide-render'
import type {
  ImageRegistry,
  ImportedPptxDeck,
  ImportedPptxPage,
  ImportProgress,
  ImportWarning,
  PptxChartRewriteHandler
} from './types'

export type {
  ImportedPptxDeck,
  ImportedPptxPage,
  PptxChartRewriteHandler,
  PptxChartRewriteRequest,
  PptxChartRewriteResult,
  PptxImportProgressPayload
} from './types'

const warningFromParseIssue = (issue: ParseIssue): ImportWarning => {
  const location = [
    issue.scope,
    issue.file ? `文件 ${issue.file}` : '',
    issue.elementOrder !== undefined ? `元素 ${issue.elementOrder}` : ''
  ].filter(Boolean).join(' / ')
  return {
    pageNumber: issue.slideIndex !== undefined ? issue.slideIndex + 1 : undefined,
    message: `${location ? `${location}: ` : ''}${issue.message}`
  }
}

/**
 * 等距抽样：从 slides 中均匀选取 count 页，保证首尾都包含，中间按等距取。
 */
type SelectedSlide<T> = { slide: T; originalIndex: number }

function selectSlidesEvenly<T>(slides: T[], count: number): SelectedSlide<T>[] {
  const entries = slides.map((slide, originalIndex) => ({ slide, originalIndex }))
  if (count >= slides.length) return entries
  if (count <= 2) return [entries[0], entries[entries.length - 1]]
  const result: SelectedSlide<T>[] = [entries[0]]
  const middle = slides.slice(1, -1)
  const middleCount = count - 2
  for (let i = 0; i < middleCount; i++) {
    const idx = Math.floor((i + 0.5) * middle.length / middleCount)
    result.push(entries[idx + 1])
  }
  result.push(entries[entries.length - 1])
  return result
}

/**
 * 从 PPTX 演示文稿的实际画幅推断导入画布。当前导入渲染与 PPTX 导出仅支持
 * 16:9 与 4:3 两种比例，因此按宽高比就近映射；异常尺寸回退 16:9。
 */
const resolveImportSlideSize = (size: unknown): SlideSizePreset => {
  const record = size && typeof size === 'object' ? (size as Record<string, unknown>) : {}
  const width = Number(record.width)
  const height = Number(record.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return requireSlideSizePreset('wide-16-9')
  }
  const ratio = width / height
  return requireSlideSizePreset(
    Math.abs(ratio - 4 / 3) < Math.abs(ratio - 16 / 9) ? 'standard-4-3' : 'wide-16-9'
  )
}

export async function importPptxToEditableHtml(args: {
  filePath: string
  projectDir: string
  title?: string
  maxPages?: number
  onProgress?: ImportProgress
  chartRewrite?: PptxChartRewriteHandler
}): Promise<ImportedPptxDeck> {
  const fileName = path.basename(args.filePath)
  const title = (args.title || path.basename(fileName, path.extname(fileName)) || '导入的 PPTX').trim()
  const indexPath = path.join(args.projectDir, 'index.html')
  const imagesDir = path.join(args.projectDir, 'images')
  await fs.promises.mkdir(imagesDir, { recursive: true })
  args.onProgress?.({ stage: 'reading', progress: 5, label: '正在读取 PPTX 文件' })
  const buffer = await fs.promises.readFile(args.filePath)
  args.onProgress?.({ stage: 'parsing', progress: 14, label: '正在解析 PPTX 结构' })
  const parsed = await parse(buffer, {
    imageMode: 'base64',
    videoMode: 'none',
    audioMode: 'none'
  })
  const slides = parsed.slides || []
  if (slides.length === 0) {
    throw new Error('PPTX 中没有可导入的幻灯片')
  }
  const slideSize = resolveImportSlideSize(parsed.size)
  const rawMaxPages = typeof args.maxPages === 'number' ? Math.floor(args.maxPages) : null
  const maxPages = rawMaxPages && rawMaxPages > 0 ? rawMaxPages : null
  const effectiveSlides = maxPages && maxPages < slides.length
    ? selectSlidesEvenly(slides, maxPages)
    : slides.map((slide, originalIndex) => ({ slide, originalIndex }))
  const animationPlans = readPptxAnimationPlans(
    buffer,
    effectiveSlides.map(({ originalIndex }) => originalIndex),
    parsed.size
  )
  // 占位符语义标注：读取每页 OOXML 的 <p:ph type>（按形状名匹配），
  // 让导入块携带 data-ph-role（title/subtitle/body/picture/...）。
  const placeholderMetadata = parsePptxXmlDeckMetadata(buffer)
  args.onProgress?.({
    stage: 'media',
    progress: 24,
    label: '正在整理图片和页面元素',
    totalPages: effectiveSlides.length
  })
  const registry: ImageRegistry = { index: 0, byKey: new Map() }
  const pages: ImportedPptxPage[] = []
  const allWarnings: ImportWarning[] = (parsed.diagnostics || []).map(warningFromParseIssue)
  const textValidator = new PptxTextValidator()
  try {
    for (let i = 0; i < effectiveSlides.length; i += 1) {
      const pageNumber = i + 1
      const pageId = `page-${pageNumber}`
      const selectedSlide = effectiveSlides[i]
      const pageTitle = titleFromSlide(selectedSlide.slide, pageNumber)
      args.onProgress?.({
        stage: 'pages',
        progress: 25 + Math.round((pageNumber / effectiveSlides.length) * 58),
        label: `正在导入并校验第 ${pageNumber} / ${effectiveSlides.length} 页`,
        pageNumber,
        totalPages: effectiveSlides.length
      })
      const htmlPath = path.join(args.projectDir, `${pageId}.html`)
      const rendered = await buildSlideHtml({
        slide: selectedSlide.slide,
        pageNumber,
        pageId,
        title: pageTitle,
        size: parsed.size,
        slideSize,
        animationPlan: animationPlans[i],
        placeholdersByName: placeholderMetadata.slides.get(selectedSlide.originalIndex + 1)
          ?.byName,
        projectDir: args.projectDir,
        registry,
        textValidator,
        chartRewrite: args.chartRewrite
      })
      await fs.promises.writeFile(htmlPath, rendered.html, 'utf-8')
      pages.push({
        pageNumber,
        pageId,
        title: pageTitle,
        htmlPath,
        html: rendered.html,
        contentOutline: rendered.contentOutline
      })
      allWarnings.push(...rendered.warnings)
    }
  } finally {
    textValidator.close()
  }
  args.onProgress?.({ stage: 'index', progress: 90, label: '正在生成演示总览' })
  await fs.promises.writeFile(
    indexPath,
    buildProjectIndexHtml(
      title,
      pages.map(
        (page): DeckPageFile => ({
          pageNumber: page.pageNumber,
          pageId: page.pageId,
          title: page.title,
          htmlPath: path.basename(page.htmlPath)
        })
      ),
      slideSize
    ),
    'utf-8'
  )
  return {
    title: title.slice(0, 120) || '导入的 PPTX',
    pageCount: pages.length,
    indexPath,
    pages,
    slideSize,
    warnings: allWarnings.map((warning) =>
      warning.pageNumber ? `第 ${warning.pageNumber} 页：${warning.message}` : warning.message
    )
  }
}
