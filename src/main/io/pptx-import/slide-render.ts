import path from 'path'
import * as cheerio from 'cheerio'
import type { Element, OoxmlShape, Slide } from '@arcsin1/pptx2json'
import {
  normalizePptxShapeName,
  type ImportedElementAnimation,
  type SlideAnimationPlan
} from './animation-import'
import type { PptxXmlShapeMetadata } from './xml-shape-metadata'
import { buildPageScaffoldHtml } from '../../session/template-builder'
import { validatePersistedPageHtml } from '../../presentation/html/html-utils'
import { escapeHtml } from '../../presentation/html/escape'
import { PAGE_WIDTH, PAGE_HEIGHT, PPTX_IMPORT_SLIDE_SIZE } from './constants'
import type { SlideSizePreset } from '@shared/slide-size'
import {
  buildChartBlock,
  buildChartFrameStyle,
  buildChartHtmlFromConfig,
  chartCanvasId,
  unsupportedChartWarning
} from './chart-renderer'
import { buildAnimationAttrs, buildBlockStyle, clampNumber } from './render-shared'
import { stripHtml } from './sanitize'
import { compareElementsForRender, flattenElements, normalizeGroupChildren } from './element-model'
import { fillToCss } from './style-css'
import { buildImageBlock, buildShapeBlock, buildTableBlock, buildTextBlock } from './block-builders'
import type { PptxTextValidator } from './text-validator'
import type {
  ImageRegistry,
  ImportWarning,
  PptxChartRewriteHandler,
  SlideAnimationContext,
  ZIndexCounter
} from './types'

const isLowValueTitleText = (text: string): boolean => {
  const normalized = text.toLowerCase()
  if (!normalized) return true
  if (/https?:\/\//i.test(text) || /www\./i.test(text)) return true
  if (normalized.includes('ppt模板') || normalized.includes('1ppt.com')) return true
  if (text.includes('单击此处输入') || text.includes('请输入')) return true
  if (normalized.includes('thank you for your attention')) return true
  return false
}

const hasCjkText = (text: string): boolean => /[\u3400-\u9fff]/.test(text)

const hasDeckTitleKeyword = (text: string): boolean =>
  /(总结|汇报|报告|计划|规划|方案|复盘|目录|概述|情况|不足|introduction|overview|summary|agenda|conclusion|plan|report|review)/i.test(text)

const xmlShapeFromParserOoxml = (
  element: Record<string, unknown>
): PptxXmlShapeMetadata | undefined => {
  const ooxml = element.ooxml as OoxmlShape | undefined
  if (!ooxml || typeof ooxml !== 'object') return undefined
  const preset = typeof ooxml.preset === 'string' ? ooxml.preset : ''
  const metadata: PptxXmlShapeMetadata = {
    id: '',
    name: typeof element.name === 'string' ? element.name : '',
    preset,
    adjustments: ooxml.adjustments,
    textInsets: ooxml.textInsets,
    textAnchor: ooxml.textAnchor,
    headEnd: ooxml.lineHeadEnd,
    tailEnd: ooxml.lineTailEnd
  }
  return preset ||
    metadata.adjustments ||
    metadata.textInsets ||
    metadata.textAnchor ||
    metadata.headEnd ||
    metadata.tailEnd
    ? metadata
    : undefined
}

/**
 * OOXML 占位符类型 → 语义角色。导入时输出 data-ph-role，让模板页的结构
 * （标题区/正文区/图片区）对后续 Agent 可见，而不只是绝对定位块。
 */
const PH_TYPE_TO_ROLE: Record<string, string> = {
  title: 'title',
  ctrTitle: 'title',
  subTitle: 'subtitle',
  body: 'body',
  pic: 'picture',
  chart: 'chart',
  tbl: 'table',
  dt: 'date',
  ftr: 'footer',
  sldNum: 'slide-number'
}

const resolvePlaceholderRole = (
  elementName: unknown,
  placeholdersByName: Map<string, PptxXmlShapeMetadata> | undefined
): string | undefined => {
  if (!placeholdersByName || typeof elementName !== 'string') return undefined
  const phType = placeholdersByName.get(elementName)?.placeholderType
  if (!phType) return undefined
  return PH_TYPE_TO_ROLE[phType] || 'body'
}

export const resolveSlideFit = (
  size: { width: number; height: number },
  canvas: { width: number; height: number } = { width: PAGE_WIDTH, height: PAGE_HEIGHT }
): {
  scale: number
  offsetX: number
  offsetY: number
} => {
  const sourceWidth = Math.max(1, size.width)
  const sourceHeight = Math.max(1, size.height)
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight)
  return {
    scale,
    offsetX: Math.max(0, (canvas.width - sourceWidth * scale) / 2),
    offsetY: Math.max(0, (canvas.height - sourceHeight * scale) / 2)
  }
}

const overlapArea = (
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number }
): number => {
  const x = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
  const y = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y))
  return x * y
}

const centerInside = (
  inner: { x: number; y: number; w: number; h: number },
  outer: { x: number; y: number; w: number; h: number }
): boolean => {
  const cx = inner.x + inner.w / 2
  const cy = inner.y + inner.h / 2
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h
}

const resolveElementAnimation = (
  context: SlideAnimationContext | undefined,
  element: Record<string, unknown>,
  offsetX: number,
  offsetY: number
): ImportedElementAnimation | undefined => {
  const plan = context?.plan
  if (!plan || plan.animations.length === 0) return undefined
  const name = normalizePptxShapeName(element.name)
  if (name) {
    const byName = plan.byName.get(name)
    const match = byName?.find((animation) => !context.usedAnimationIds.has(animation.id))
    if (match) {
      context.usedAnimationIds.add(match.id)
      return match
    }
  }

  const box = {
    x: clampNumber(element.left) + offsetX,
    y: clampNumber(element.top) + offsetY,
    w: Math.max(1, clampNumber(element.width)),
    h: Math.max(1, clampNumber(element.height))
  }
  const boxArea = Math.max(0.0001, box.w * box.h)
  const candidates = plan.animations
    .filter(
      (animation) =>
        !context.usedAnimationIds.has(animation.id) &&
        animation.x !== undefined &&
        animation.y !== undefined &&
        animation.w !== undefined &&
        animation.h !== undefined
    )
    .map((animation) => {
      const animBox = {
        x: animation.x || 0,
        y: animation.y || 0,
        w: Math.max(1, animation.w || 1),
        h: Math.max(1, animation.h || 1)
      }
      const overlap = overlapArea(box, animBox)
      const animArea = Math.max(0.0001, animBox.w * animBox.h)
      const eligible =
        overlap > 0 &&
        (centerInside(box, animBox) || overlap / boxArea >= 0.45 || overlap / animArea >= 0.25)
      return { animation, overlap, eligible }
    })
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => b.overlap - a.overlap || a.animation.id - b.animation.id)
  const match = candidates[0]?.animation
  if (match) context.usedAnimationIds.add(match.id)
  return match
}

export const titleFromSlide = (slide: Slide, pageNumber: number): string => {
  const candidates = flattenElements([...(slide.layoutElements || []), ...(slide.elements || [])])
    .filter((item) => (item.element.type === 'text' || item.element.type === 'shape') && item.text.length > 0)
    .map((item) => {
      const area = item.width * item.height
      const textLength = Array.from(item.text).length
      const isShortFragment = textLength <= 1
      const isPrimaryBand = item.top < 180
      const score =
        area +
        (isPrimaryBand ? 8000 : 0) +
        (hasCjkText(item.text) ? 5000 : 0) +
        (hasDeckTitleKeyword(item.text) ? 28000 : 0) +
        (textLength >= 2 && textLength <= 28 ? 6000 : 0) -
        (isShortFragment ? 16000 : 0) -
        (isLowValueTitleText(item.text) ? 50000 : 0)
      return { ...item, area, score }
    })
    .sort((a, b) => b.score - a.score || a.top - b.top)
  const title = candidates.find((item) => !isLowValueTitleText(item.text))?.text || candidates[0]?.text
  return title?.slice(0, 80) || `第 ${pageNumber} 页`
}

const renderElement = async (args: {
  element: Element
  pageId: string
  blockCounters: Record<string, number>
  animationContext?: SlideAnimationContext
  inheritedAnimation?: ImportedElementAnimation
  imagesDir: string
  registry: ImageRegistry
  scaleX: number
  scaleY: number
  textScale: number
  zIndexCounter: ZIndexCounter
  offsetX: number
  offsetY: number
  canvasHeight?: number
  titleAssigned: boolean
  pageNumber?: number
  warnings?: ImportWarning[]
  textValidator?: PptxTextValidator
  chartRewrite?: PptxChartRewriteHandler
  placeholdersByName?: Map<string, PptxXmlShapeMetadata>
}): Promise<{ html: string; titleAssigned: boolean }> => {
  const nextBlockId = (prefix: string): string => {
    args.blockCounters[prefix] = (args.blockCounters[prefix] || 0) + 1
    return `${prefix}-${args.blockCounters[prefix]}`
  }
  const record = args.element as unknown as Record<string, unknown>
  const xmlShape = xmlShapeFromParserOoxml(record)
  const placeholderRole = resolvePlaceholderRole(record.name, args.placeholdersByName)
  const elementAnimation =
    resolveElementAnimation(args.animationContext, record, args.offsetX, args.offsetY) ||
    args.inheritedAnimation
  if (args.element.type === 'group') {
    const children = Array.isArray(args.element.elements)
      ? normalizeGroupChildren(args.element, args.element.elements).sort(compareElementsForRender)
      : []
    const rendered: string[] = []
    let titleAssigned = args.titleAssigned
    const groupOffsetX = args.offsetX + clampNumber(record.left)
    const groupOffsetY = args.offsetY + clampNumber(record.top)
    for (const child of children) {
      const result = await renderElement({
        ...args,
        element: child,
        offsetX: groupOffsetX,
        offsetY: groupOffsetY,
        inheritedAnimation: elementAnimation,
        titleAssigned
      })
      rendered.push(result.html)
      titleAssigned = result.titleAssigned
    }
    return { html: rendered.join('\n'), titleAssigned }
  }
  if (args.element.type === 'image') {
    return {
      html: await buildImageBlock({
        element: record,
        blockId: nextBlockId('image'),
        placeholderRole,
        animation: elementAnimation,
        imagesDir: args.imagesDir,
        registry: args.registry,
        scaleX: args.scaleX,
        scaleY: args.scaleY,
        offsetX: args.offsetX,
        offsetY: args.offsetY,
        zIndex: args.zIndexCounter.value++
      }),
      titleAssigned: args.titleAssigned
    }
  }
  if (args.element.type === 'table') {
    return {
      html: buildTableBlock({
        element: record,
        blockId: nextBlockId('table'),
        animation: elementAnimation,
        scaleX: args.scaleX,
        scaleY: args.scaleY,
        textScale: args.textScale,
        offsetX: args.offsetX,
        offsetY: args.offsetY,
        zIndex: args.zIndexCounter.value++
      }),
      titleAssigned: args.titleAssigned
    }
  }
  if (args.element.type === 'chart') {
    const chartIndex = (args.blockCounters.chart || 0) + 1
    args.blockCounters.chart = chartIndex
    const blockId = `chart-${chartIndex}`
    const canvasId = chartCanvasId(args.pageId, chartIndex)
    const animationAttrs = buildAnimationAttrs(elementAnimation)
    const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
    const zIndex = args.zIndexCounter.value++
    const frameStyle = buildChartFrameStyle({
      element: args.element,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      zIndex,
      offsetX: args.offsetX,
      offsetY: args.offsetY
    })
    let html = buildChartBlock({
      element: args.element,
      blockId,
      animation: elementAnimation,
      pageId: args.pageId,
      chartIndex,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
      zIndex,
      pageNumber: args.pageNumber,
      warnings: args.warnings,
      suppressUnsupportedWarning: true
    })
    if (html.includes('data-pptx-import-mode="placeholder"') && args.chartRewrite) {
      const rewritten = await args.chartRewrite({
        element: args.element,
        blockId,
        pageId: args.pageId,
        chartIndex,
        canvasId,
        frameStyle,
        animationAttrs,
        pageNumber: args.pageNumber
      })
      if (rewritten?.config) {
        html = buildChartHtmlFromConfig({
          element: args.element,
          blockId,
          canvasId,
          frameStyle,
          animationAttrText,
          config: rewritten.config
        })
        if (rewritten.warnings?.length) {
          args.warnings?.push(
            ...rewritten.warnings.map((message) => ({ pageNumber: args.pageNumber, message }))
          )
        }
      }
    }
    if (html.includes('data-pptx-import-mode="placeholder"')) {
      args.warnings?.push({
        pageNumber: args.pageNumber,
        message: unsupportedChartWarning(blockId, args.element.chartType)
      })
    }
    return {
      html,
      titleAssigned: args.titleAssigned
    }
  }
  if (args.element.type === 'text') {
    const text = stripHtml(String(record.content || ''))
    const shouldBeTitle = !args.titleAssigned && text.length > 0 && clampNumber(record.top) < 120
    return {
      html: await buildTextBlock({
        element: record,
        blockId: shouldBeTitle ? 'title' : nextBlockId('text'),
        role: shouldBeTitle ? 'title' : undefined,
        placeholderRole,
        animation: elementAnimation,
        imagesDir: args.imagesDir,
        registry: args.registry,
        scaleX: args.scaleX,
        scaleY: args.scaleY,
        textScale: args.textScale,
        offsetX: args.offsetX,
        offsetY: args.offsetY,
        canvasHeight: args.canvasHeight,
        zIndex: args.zIndexCounter.value++,
        pageNumber: args.pageNumber,
        warnings: args.warnings,
        textValidator: args.textValidator,
        xmlShape
      }),
      titleAssigned: args.titleAssigned || shouldBeTitle
    }
  }
  if (args.element.type === 'shape') {
    const text = stripHtml(String(record.content || ''))
    const shouldBeTitle = !args.titleAssigned && text.length > 0 && clampNumber(record.top) < 120
    return {
      html: await buildShapeBlock({
        element: record,
        blockId: shouldBeTitle ? 'title' : nextBlockId(text ? 'text' : 'shape'),
        role: shouldBeTitle ? 'title' : undefined,
        placeholderRole,
        animation: elementAnimation,
        imagesDir: args.imagesDir,
        registry: args.registry,
        scaleX: args.scaleX,
        scaleY: args.scaleY,
        textScale: args.textScale,
        offsetX: args.offsetX,
        offsetY: args.offsetY,
        canvasHeight: args.canvasHeight,
        zIndex: args.zIndexCounter.value++,
        xmlShape,
        pageNumber: args.pageNumber,
        warnings: args.warnings,
        textValidator: args.textValidator
      }),
      titleAssigned: args.titleAssigned || shouldBeTitle
    }
  }
  if (args.element.type === 'diagram' && Array.isArray(args.element.elements)) {
    const text = args.element.textList?.join(' / ') || 'SmartArt'
    const css = buildBlockStyle({
      element: record,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      zIndex: args.zIndexCounter.value++,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
      extra: ['background:#f8fafc', 'border:1px dashed #cbd5e1', 'padding:12px', 'color:#475569']
    })
    const animationAttrs = buildAnimationAttrs(elementAnimation)
    const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
    return {
      html: `<section data-block-id="${nextBlockId('diagram')}"${animationAttrText} style="${css}">${escapeHtml(text)}</section>`,
      titleAssigned: args.titleAssigned
    }
  }
  if (args.element.type === 'math') {
    const text = String(record.latex || record.text || 'Formula')
    const css = buildBlockStyle({
      element: record,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      zIndex: args.zIndexCounter.value++,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
      extra: [
        'background:#ffffff',
        'border:1px dashed #cbd5e1',
        'padding:10px',
        'color:#334155',
        'font-family:Georgia,serif',
        'font-size:18px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'text-align:center'
      ]
    })
    const animationAttrs = buildAnimationAttrs(elementAnimation)
    const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
    return {
      html: `<section data-block-id="${nextBlockId('math')}" data-pptx-kind="math"${animationAttrText} style="${css}">${escapeHtml(text)}</section>`,
      titleAssigned: args.titleAssigned
    }
  }
  return { html: '', titleAssigned: args.titleAssigned }
}

const buildFallbackTitle = (title: string): string =>
  `<header data-block-id="title" data-role="title" style="position:absolute;left:48px;top:36px;width:900px;height:56px;z-index:1;overflow:hidden;">
    <h1 style="margin:0;font-size:36px;line-height:1.2;color:#111827;">${escapeHtml(title)}</h1>
  </header>`

const buildImportedPptxMotionScript = (): string => `<script data-pptx-import-motion="1">
(function () {
  function runImportedPptxMotion() {
    var root = document.querySelector(".ppt-page-root");
    var pptApi = window.PPT;
    if (!root || !pptApi || typeof pptApi.scanDataAnim !== "function") return;
    var config = pptApi.scanDataAnim(root);
    if (!config || (!config.load.length && !config.click.length)) return;
    if (config.load.length && typeof pptApi.executeDataAnim === "function") {
      pptApi.executeDataAnim(config.load);
    }
    if (config.click.length && pptApi.clicks && typeof pptApi.clicks.on === "function") {
      var clickSteps = Array.isArray(config.clickSteps) && config.clickSteps.length > 0
        ? config.clickSteps
        : config.click.map(function (animDef) { return [animDef]; });
      clickSteps.forEach(function (stepDefs, index) {
        pptApi.clicks.on(index + 1, function () {
          if (typeof pptApi.executeDataAnim === "function") {
            pptApi.executeDataAnim(stepDefs);
          }
        });
      });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runImportedPptxMotion, { once: true });
  } else {
    runImportedPptxMotion();
  }
})();
</script>`

export const buildSlideHtml = async (args: {
  slide: Slide
  pageNumber: number
  pageId: string
  title: string
  size: { width: number; height: number }
  slideSize?: SlideSizePreset
  animationPlan?: SlideAnimationPlan
  placeholdersByName?: Map<string, PptxXmlShapeMetadata>
  projectDir: string
  registry: ImageRegistry
  textValidator?: PptxTextValidator
  chartRewrite?: PptxChartRewriteHandler
}): Promise<{ html: string; contentOutline: string; warnings: ImportWarning[] }> => {
  const imagesDir = path.join(args.projectDir, 'images')
  const slideSize = args.slideSize ?? PPTX_IMPORT_SLIDE_SIZE
  const slideFit = resolveSlideFit(args.size, {
    width: slideSize.width,
    height: slideSize.height
  })
  const scaleX = slideFit.scale
  const scaleY = slideFit.scale
  const textScale = slideFit.scale
  const warnings: ImportWarning[] = []
  const backgroundCss = await fillToCss(args.slide.fill, imagesDir, args.registry)
  const blockCounters: Record<string, number> = {}
  const animationContext: SlideAnimationContext = {
    plan: args.animationPlan,
    usedAnimationIds: new Set<number>()
  }
  const elements = [...(args.slide.layoutElements || []), ...(args.slide.elements || [])].sort(
    compareElementsForRender
  )
  const rendered: string[] = []
  const zIndexCounter: ZIndexCounter = { value: 2 }
  let titleAssigned = false
  for (const [index, element] of elements.entries()) {
    try {
      const result = await renderElement({
        element,
        pageId: args.pageId,
        blockCounters,
        animationContext,
        imagesDir,
        registry: args.registry,
        scaleX,
        scaleY,
        textScale,
        zIndexCounter,
        offsetX: slideFit.offsetX,
        offsetY: slideFit.offsetY,
        canvasHeight: slideSize.height,
        titleAssigned,
        pageNumber: args.pageNumber,
        warnings,
        textValidator: args.textValidator,
        chartRewrite: args.chartRewrite,
        placeholdersByName: args.placeholdersByName
      })
      if (result.html) rendered.push(result.html)
      titleAssigned = result.titleAssigned
    } catch (error) {
      warnings.push({
        pageNumber: args.pageNumber,
        message: `元素 ${index + 1} 导入失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  if (!titleAssigned) {
    rendered.unshift(buildFallbackTitle(args.title))
  }
  const contentOutline = flattenElements(elements)
    .map(({ element, text }) => {
      if (text && !isLowValueTitleText(text)) return text
      if (element.type === 'table') return '表格'
      if (element.type === 'chart') return '图表'
      if (element.type === 'image') return '图片'
      return ''
    })
    .filter(Boolean)
    .slice(0, 8)
    .join('；')
  const sectionStyle = ['position:relative', 'width:100%', 'height:100%', 'overflow:hidden', ...backgroundCss].join(';')
  const hasImportedAnimations = rendered.some((html) => /\sdata-anim=/.test(html))
  const body = `<section data-page-scaffold="1" style="${sectionStyle}">
  <main data-block-id="content" data-role="content" style="position:absolute;inset:0;z-index:0;">
    ${rendered.join('\n')}
  </main>
</section>
${hasImportedAnimations ? buildImportedPptxMotionScript() : ''}`
  const scaffold = buildPageScaffoldHtml({
    pageNumber: args.pageNumber,
    pageId: args.pageId,
    title: args.title
  }, slideSize)
  const $ = cheerio.load(scaffold, { scriptingEnabled: false })
  $('.ppt-page-root').first().removeClass('p-2 p-8').attr('style', 'padding:0;')
  $('.ppt-page-content').first().html(body)
  const html = $.html()
  const validation = validatePersistedPageHtml(html, args.pageId)
  if (!validation.valid) {
    warnings.push(
      ...validation.errors.map((message) => ({
        pageNumber: args.pageNumber,
        message
      }))
    )
  }
  return {
    html,
    contentOutline: contentOutline || args.title,
    warnings
  }
}
