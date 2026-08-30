import fs from 'fs'
import * as cheerio from 'cheerio'
import type { DesignContract } from '@shared/generation'
import type { LayoutIntent } from '@shared/layout-intent'
import type { SlideSizePreset } from '@shared/slide-size'
import {
  inspectRenderedPresentationPage,
  type RenderedPageMetrics
} from './rendered-page-validator'

export type DeckQualitySeverity = 'error' | 'warn'

export type DeckQualityViolation = {
  code: string
  severity: DeckQualitySeverity
  pageIds: string[]
  detail: string
  fix: string
}

export type DeckPageQualityObservation = {
  pageId: string
  pageNumber: number
  title: string
  layoutIntent?: LayoutIntent
  declaredSlideSizeId?: string
  declaredWidth?: number
  declaredHeight?: number
  metrics: RenderedPageMetrics
}

export type DeckQualityReport = {
  available: boolean
  pages: DeckPageQualityObservation[]
  violations: DeckQualityViolation[]
  unavailablePages: Array<{ pageId: string; reason: string }>
}

export type InspectPresentationDeckQualityArgs = {
  pages: Array<{
    pageId: string
    pageNumber: number
    title: string
    htmlPath: string
    layoutIntent?: LayoutIntent
  }>
  slideSize: SlideSizePreset
  designContract?: DesignContract
  preserveTemplate?: boolean
}

const firstFontFamily = (value: string | undefined): string =>
  String(value || '')
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()

const finiteNumber = (value: string | undefined): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const unique = <T>(values: T[]): T[] => Array.from(new Set(values))

type RgbColor = { red: number; green: number; blue: number }

const parseColor = (value: string): RgbColor | null => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  const hex = normalized.match(/^#([a-f\d]{3}|[a-f\d]{6})$/i)
  if (hex) {
    const expanded =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((char) => `${char}${char}`)
            .join('')
        : hex[1]
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16)
    }
  }
  const rgb = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!rgb) return null
  return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]) }
}

const colorDistance = (left: RgbColor, right: RgbColor): number =>
  Math.sqrt(
    (left.red - right.red) ** 2 + (left.green - right.green) ** 2 + (left.blue - right.blue) ** 2
  )

const colorSaturation = (color: RgbColor): number => {
  const max = Math.max(color.red, color.green, color.blue)
  const min = Math.min(color.red, color.green, color.blue)
  return max === 0 ? 0 : (max - min) / max
}

const isSpecialComposition = (page: DeckPageQualityObservation): boolean =>
  page.layoutIntent === 'cover' ||
  page.layoutIntent === 'quote' ||
  page.layoutIntent === 'image-focus'

const bodyDensityScore = (metrics: RenderedPageMetrics): number =>
  metrics.textCharacters + metrics.elementCount * 2 + metrics.cardCount * 18

const formatPageList = (pageIds: string[]): string => pageIds.slice(0, 8).join(', ')

/** Cross-page rules are conservative: deterministic contract breaks block, aesthetics advise. */
export function evaluateDeckQuality(args: {
  pages: DeckPageQualityObservation[]
  slideSize: SlideSizePreset
  designContract?: DesignContract
  preserveTemplate?: boolean
}): DeckQualityViolation[] {
  const { pages, slideSize, designContract, preserveTemplate } = args
  const violations: DeckQualityViolation[] = []
  if (pages.length === 0) return violations

  const sizeMismatchPages = pages.filter(
    (page) =>
      page.declaredSlideSizeId !== slideSize.id ||
      page.declaredWidth !== slideSize.width ||
      page.declaredHeight !== slideSize.height
  )
  if (sizeMismatchPages.length > 0) {
    const pageIds = sizeMismatchPages.map((page) => page.pageId)
    violations.push({
      code: 'deck-slide-size-mismatch',
      severity: 'error',
      pageIds,
      detail: `${pageIds.length} 页声明的画布规格与整套 ${slideSize.id} (${slideSize.width}x${slideSize.height}) 不一致：${formatPageList(pageIds)}`,
      fix: '使用当前会话统一画布运行时重新生成这些页面，禁止在单页里覆盖画布宽高或比例'
    })
  }

  if (!preserveTemplate && designContract) {
    const expectedTitleFont = firstFontFamily(designContract.titleFont)
    const expectedBodyFont = firstFontFamily(designContract.bodyFont)
    const titleFontPages = pages.filter((page) => {
      const actual = firstFontFamily(page.metrics.title?.fontFamily)
      return actual && expectedTitleFont && actual !== expectedTitleFont
    })
    const bodyFontPages = pages.filter((page) => {
      const actual = firstFontFamily(page.metrics.bodyFontFamily)
      return actual && expectedBodyFont && actual !== expectedBodyFont
    })
    const fontDriftPageIds = unique([
      ...titleFontPages.map((page) => page.pageId),
      ...bodyFontPages.map((page) => page.pageId)
    ])
    if (fontDriftPageIds.length > 0) {
      violations.push({
        code: 'deck-font-system-drift',
        severity: 'error',
        pageIds: fontDriftPageIds,
        detail: `${fontDriftPageIds.length} 页绕过设计契约使用了其它核心字体：${formatPageList(fontDriftPageIds)}；标题应为 ${designContract.titleFont}，正文应为 ${designContract.bodyFont}`,
        fix: '删除局部 font-family 覆盖；标题使用 var(--ppt-title-font)，正文使用 var(--ppt-body-font)，特殊字体只能用于少量强调文字'
      })
    }

    const palette = designContract.palette
      .map(parseColor)
      .filter((color): color is RgbColor => Boolean(color))
    if (palette.length >= 3) {
      const paletteDriftPages = pages.filter((page) => {
        const chromaticColors = page.metrics.dominantColors
          .map(parseColor)
          .filter((color): color is RgbColor => Boolean(color))
          .filter((color) => colorSaturation(color) >= 0.16)
        if (chromaticColors.length < 2) return false
        const outliers = chromaticColors.filter(
          (color) => Math.min(...palette.map((candidate) => colorDistance(color, candidate))) > 78
        )
        return outliers.length >= 2 && outliers.length / chromaticColors.length >= 0.6
      })
      if (paletteDriftPages.length > 0) {
        const pageIds = paletteDriftPages.map((page) => page.pageId)
        violations.push({
          code: 'deck-palette-drift',
          severity: 'warn',
          pageIds,
          detail: `${pageIds.length} 页的主要彩色元素明显偏离设计契约配色：${formatPageList(pageIds)}`,
          fix: `优先使用设计契约色板 ${designContract.palette.join(', ')}；照片和数据语义色可例外，但装饰、标题和常规图形不要另起一套颜色`
        })
      }
    }
  }

  const wrappedTitlePages = pages.filter(
    (page) => !isSpecialComposition(page) && (page.metrics.title?.lineCount || 0) > 1
  )
  if (wrappedTitlePages.length > 0) {
    const pageIds = wrappedTitlePages.map((page) => page.pageId)
    violations.push({
      code: 'deck-title-wrapped',
      severity: 'warn',
      pageIds,
      detail: `${pageIds.length} 个常规页标题发生换行：${formatPageList(pageIds)}`,
      fix: '把标题改成一句更短、更明确的结论，或扩大标题区宽度；常规标题带不要被动换成两行'
    })
  }

  const titleSizeFloor = 35 * (slideSize.height / 900)
  const undersizedTitlePages = pages.filter(
    (page) =>
      !isSpecialComposition(page) &&
      page.metrics.title &&
      page.metrics.title.fontSize < titleSizeFloor
  )
  if (undersizedTitlePages.length > 0) {
    const pageIds = undersizedTitlePages.map((page) => page.pageId)
    violations.push({
      code: 'deck-title-size-rhythm',
      severity: 'warn',
      pageIds,
      detail: `${pageIds.length} 个常规页标题小于建议下限 ${Math.round(titleSizeFloor)}px：${formatPageList(pageIds)}`,
      fix: '恢复清晰的标题层级；优先缩短标题或重排内容，不要把页标题缩成正文级别'
    })
  }

  const conventionalPages = pages.filter(
    (page) => !isSpecialComposition(page) && page.metrics.title && page.metrics.textBounds
  )
  if (conventionalPages.length >= 3) {
    const titleXMedian = median(conventionalPages.map((page) => page.metrics.title?.rect.x || 0))
    const titleYMedian = median(conventionalPages.map((page) => page.metrics.title?.rect.y || 0))
    const titleSizeMedian = median(
      conventionalPages.map((page) => page.metrics.title?.fontSize || 0)
    )
    const titleOutliers = conventionalPages.filter((page) => {
      const title = page.metrics.title
      if (!title) return false
      return (
        Math.abs(title.rect.x - titleXMedian) > slideSize.width * 0.08 ||
        Math.abs(title.rect.y - titleYMedian) > slideSize.height * 0.07 ||
        (titleSizeMedian > 0 &&
          Math.abs(title.fontSize - titleSizeMedian) > titleSizeMedian * 0.15)
      )
    })
    if (titleOutliers.length > 0) {
      const pageIds = titleOutliers.map((page) => page.pageId)
      violations.push({
        code: 'deck-title-anchor-drift',
        severity: 'error',
        pageIds,
        detail: `${pageIds.length} 个常规内容页的标题带（位置或字号）偏离整套中位基准：${formatPageList(pageIds)}`,
        fix: '除封面、金句和全图页外，页标题必须回到整套统一的标题带：与相邻页相同的对齐、字号档位、kicker/装饰形态和标题-内容间距；不要逐页更换标题位置、对齐或装饰形态'
      })
    }
  }

  const marginOutliers = pages.filter((page) => {
    if (isSpecialComposition(page) || !page.metrics.textBounds) return false
    const bounds = page.metrics.textBounds
    const left = bounds.x
    const right = slideSize.width - (bounds.x + bounds.width)
    return (
      Math.min(left, right) < slideSize.width * 0.04 ||
      Math.abs(left - right) > slideSize.width * 0.12
    )
  })
  if (marginOutliers.length > 0) {
    const pageIds = marginOutliers.map((page) => page.pageId)
    violations.push({
      code: 'deck-text-margin-rhythm',
      severity: 'warn',
      pageIds,
      detail: `${pageIds.length} 页的文字边界贴边或左右留白节奏明显失衡：${formatPageList(pageIds)}`,
      fix: '优先保持左右安全区相等；全出血视觉可以贴边，但正文、标题和关键数字必须留在统一文字安全区内'
    })
  }

  const densityCandidates = pages.filter((page) => !isSpecialComposition(page))
  if (densityCandidates.length >= 3) {
    const densityMedian = median(densityCandidates.map((page) => bodyDensityScore(page.metrics)))
    const highDensityPages = densityCandidates.filter((page) => {
      const score = bodyDensityScore(page.metrics)
      return score > Math.max(720, densityMedian * 1.75)
    })
    const lowDensityPages = densityCandidates.filter((page) => {
      const score = bodyDensityScore(page.metrics)
      return densityMedian > 240 && score < densityMedian * 0.35 && page.metrics.visualCount === 0
    })
    if (highDensityPages.length > 0) {
      const pageIds = highDensityPages.map((page) => page.pageId)
      violations.push({
        code: 'deck-density-spike',
        severity: 'warn',
        pageIds,
        detail: `${pageIds.length} 页的信息密度显著高于整套节奏：${formatPageList(pageIds)}`,
        fix: '保留一个核心结论，压缩低价值文案并更换构图；不要通过缩小字体、增加卡片或徽章继续塞内容'
      })
    }
    if (lowDensityPages.length > 0) {
      const pageIds = lowDensityPages.map((page) => page.pageId)
      violations.push({
        code: 'deck-density-drop',
        severity: 'warn',
        pageIds,
        detail: `${pageIds.length} 个常规内容页明显比全套稀疏且没有视觉主体：${formatPageList(pageIds)}`,
        fix: '增加能支撑结论的图像、图表或一个主视觉证据区；不要靠零散小装饰填空'
      })
    }
  }

  const repeatedPageIds: string[] = []
  let runStart = 0
  while (runStart < pages.length) {
    let runEnd = runStart + 1
    while (
      runEnd < pages.length &&
      pages[runEnd].metrics.layoutSignature === pages[runStart].metrics.layoutSignature
    ) {
      runEnd += 1
    }
    if (runEnd - runStart >= 3 && pages[runStart].metrics.layoutSignature !== 'text-only') {
      repeatedPageIds.push(...pages.slice(runStart + 2, runEnd).map((page) => page.pageId))
    }
    runStart = runEnd
  }
  if (repeatedPageIds.length > 0) {
    violations.push({
      code: 'deck-repeated-silhouette',
      severity: 'warn',
      pageIds: repeatedPageIds,
      detail: `连续页面重复使用相同版式轮廓，整套容易呈现模板机械感：${formatPageList(repeatedPageIds)}`,
      fix: '保留视觉系统但改变相邻页轮廓，例如在主图、对比、数据、时间线和结论页之间形成节奏变化'
    })
  }

  const cardWallPages = pages.filter((page) => page.metrics.cardCount >= 6)
  if (cardWallPages.length >= Math.max(2, Math.ceil(pages.length * 0.4))) {
    const pageIds = cardWallPages.map((page) => page.pageId)
    violations.push({
      code: 'deck-web-ui-pattern',
      severity: 'warn',
      pageIds,
      detail: `${pageIds.length}/${pages.length} 页使用六个以上卡片式容器，整套呈现明显 Web dashboard 倾向：${formatPageList(pageIds)}`,
      fix: '把页面改为一个主构图和少量支撑信息，减少卡片网格、胶囊、按钮式标签和重复面板'
    })
  }

  return violations
}

export async function inspectPresentationDeckQuality(
  args: InspectPresentationDeckQualityArgs
): Promise<DeckQualityReport> {
  const pages: DeckPageQualityObservation[] = []
  const unavailablePages: Array<{ pageId: string; reason: string }> = []
  for (const page of [...args.pages].sort((left, right) => left.pageNumber - right.pageNumber)) {
    let html = ''
    try {
      html = await fs.promises.readFile(page.htmlPath, 'utf-8')
    } catch (error) {
      unavailablePages.push({
        pageId: page.pageId,
        reason: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    const $ = cheerio.load(html, { scriptingEnabled: false })
    const root = $('.ppt-page-root[data-ppt-guard-root="1"]').first()
    const inspection = await inspectRenderedPresentationPage({
      pageId: page.pageId,
      targetPath: page.htmlPath,
      slideSize: args.slideSize
    })
    if (!inspection.available || !inspection.snapshot.metrics) {
      unavailablePages.push({
        pageId: page.pageId,
        reason: inspection.available
          ? 'rendered deck metrics missing'
          : inspection.unavailableReason
      })
      continue
    }
    pages.push({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      layoutIntent: page.layoutIntent,
      declaredSlideSizeId: root.attr('data-ppt-slide-size-id'),
      declaredWidth: finiteNumber(root.attr('data-ppt-width')),
      declaredHeight: finiteNumber(root.attr('data-ppt-height')),
      metrics: inspection.snapshot.metrics
    })
  }

  const renderValidationComplete =
    args.pages.length > 0 && unavailablePages.length === 0 && pages.length === args.pages.length
  // 部分页面拿不到渲染结果时，仍对已渲染页执行跨页评估（各规则自带样本数下限），
  // 避免环境抖动把整套一致性检查整体跳过——否则标题带/字体/版式节奏问题无人兜底。
  const violations = evaluateDeckQuality({
    pages,
    slideSize: args.slideSize,
    designContract: args.designContract,
    preserveTemplate: args.preserveTemplate
  })
  if (unavailablePages.length > 0) {
    const unavailablePageIds = unavailablePages.map((page) => page.pageId)
    violations.push({
      code: 'deck-render-validation-unavailable',
      severity: 'warn',
      pageIds: unavailablePageIds,
      detail: `跨页质量校验未完成：${unavailablePageIds.length}/${args.pages.length} 页无法获得浏览器渲染结果${unavailablePageIds.length > 0 ? `（${formatPageList(unavailablePageIds)}）` : ''}`,
      fix: '暂不把跨页检查视为通过；待浏览器渲染恢复后重新运行整套质量校验。静态有效页面仍可保留。'
    })
  }

  return {
    available: renderValidationComplete,
    pages,
    violations,
    unavailablePages
  }
}

export function formatDeckQualityFeedback(
  violations: DeckQualityViolation[],
  pageId?: string
): string {
  const scoped = pageId
    ? violations.filter((violation) => violation.pageIds.includes(pageId))
    : violations
  if (scoped.length === 0) return ''
  return [
    pageId
      ? `Deck-level quality review found issues assigned to ${pageId}.`
      : 'Deck-level quality review:',
    ...scoped.map((violation) => `- [${violation.code}] ${violation.detail} -> ${violation.fix}`)
  ].join('\n')
}
