import * as cheerio from 'cheerio'
import type { LayoutIntent } from '@shared/layout-intent'

export interface TitleBandAnchor {
  pageId: string
  pageNumber: number
  bandHtml: string
}

export interface TitleBandAnchorCandidate {
  pageId: string
  pageNumber: number
  layoutIntent?: LayoutIntent
  htmlPath?: string
  /** 已读取的页面 HTML（例如重试页落盘前的旧版本），提供后不再读盘。 */
  pageHtml?: string
}

// 与 deck-quality-validator 的 isSpecialComposition 豁免口径对齐：
// 封面/金句/全图页不携带常规标题带，不能当锚点。
const EXEMPT_TITLE_BAND_INTENTS = new Set<LayoutIntent>(['cover', 'quote', 'image-focus'])

// 标题带是短标记；异常超长说明抓到的不是常规标题带，放弃当锚点。
const MAX_BAND_HTML_LENGTH = 2000

export const isTitleBandAnchorExemptIntent = (intent: unknown): boolean =>
  typeof intent === 'string' && EXEMPT_TITLE_BAND_INTENTS.has(intent as LayoutIntent)

/**
 * 从已落盘页面 HTML 中提取标题带（[data-role="title"]，退化到
 * [data-block-id="title"]）的外层标记。空白归一化后返回，失败返回 null。
 */
export function extractTitleBandHtml(pageHtml: string): string | null {
  if (!pageHtml) return null
  try {
    const $ = cheerio.load(pageHtml, { scriptingEnabled: false })
    // 落盘页文件只含单页外壳，标题带全文档唯一；优先 data-role，退化到 data-block-id。
    let band = $('[data-role="title"]').first()
    if (!band.length) band = $('[data-block-id="title"]').first()
    if (!band.length) return null
    const bandHtml = $.html(band)
    const normalized = bandHtml.replace(/\s+/g, ' ').trim()
    if (!normalized || normalized.length > MAX_BAND_HTML_LENGTH) return null
    return normalized
  } catch {
    return null
  }
}

/**
 * 按候选顺序（调用方决定优先级：其它常规页按页码升序，重试页自身旧版兜底）
 * 找第一个能抽出标题带的页面作为整套 deck 的标题带锚点。
 */
export async function resolveTitleBandAnchor(args: {
  candidates: TitleBandAnchorCandidate[]
  readPageHtml: (htmlPath: string) => Promise<string | null>
}): Promise<TitleBandAnchor | null> {
  const eligible = args.candidates.filter(
    (candidate) =>
      !isTitleBandAnchorExemptIntent(candidate.layoutIntent) &&
      (typeof candidate.pageHtml === 'string' || typeof candidate.htmlPath === 'string')
  )
  for (const candidate of eligible) {
    let html: string | null | undefined = candidate.pageHtml
    if (typeof html !== 'string' && candidate.htmlPath) {
      try {
        html = await args.readPageHtml(candidate.htmlPath)
      } catch {
        // 并行生成时目标文件可能正被其它 worker 写入，读失败就跳过该候选。
        continue
      }
    }
    if (!html) continue
    const bandHtml = extractTitleBandHtml(html)
    if (bandHtml) {
      return { pageId: candidate.pageId, pageNumber: candidate.pageNumber, bandHtml }
    }
  }
  return null
}
