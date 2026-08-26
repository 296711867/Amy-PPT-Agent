/**
 * 槽参数化引擎：把导入模板产出的页面 HTML 解析为 版式骨架 + 内容槽契约。
 *
 * 输入约定（P1 范围）：pptx-import 管线产出的扁平块结构 ——
 *   文本块  <section data-block-id="..." style="position:absolute;...">
 *   图片块  <figure data-block-id="..." style="..."><img ... /></figure>
 *   矢量块  <figure data-pptx-kind="vector-shape" ...>（装饰，不参数化）
 * 我们完全掌控产出形状，因此用针对性解析而不是通用 DOM。
 *
 * 分类启发式（保守优先，识别不了的一律当作装饰保留原样）：
 *   - 含 <img>                → media 槽（几何取宽高）
 *   - 纯数字/短数字+单位       → metric 槽
 *   - ≥2 个同横带、同尺寸量级的兄弟块 → list 槽组（首块为克隆模板）
 *   - 最大字号且最靠上         → title 槽
 *   - 长文本（>40 字符）       → body 槽
 *   - 其余短文本               → label 槽
 */
import type {
  LayoutAsset,
  LayoutAssetCapacity,
  LayoutAssetListSlot,
  LayoutAssetMediaSlot,
  LayoutAssetSlot,
  LayoutAssetTextSlot
} from '@shared/layout-asset'

type BlockNode = {
  slotId: string
  tag: 'section' | 'figure'
  style: string
  inner: string
  text: string
  rect: { left: number; top: number; width: number; height: number }
  fontSize: number
  hasImage: boolean
  kind: 'vector-shape' | 'table' | 'text' | 'image'
}

const BLOCK_RE = /<(section|figure)\b([^>]*\bdata-block-id="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g

const styleNumber = (style: string, property: string): number => {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)px`, 'i'))
  const parsed = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()

const NUMERIC_TEXT_RE = /^[+\-¥$€£]?\s*\d[\d,.]*\s*(%|万|亿|k|K|M|B|元|人|天|次|个|分|秒|年|月|日)??$/

export type ParametrizeResult = {
  slots: LayoutAssetSlot[]
  capacity: LayoutAssetCapacity
  structureFingerprint: string
}

/** 提取页面中的扁平块（仅识别 data-block-id 块；其余内容视为装饰原样保留）。 */
export function extractBlocks(html: string): BlockNode[] {
  const blocks: BlockNode[] = []
  for (const match of html.matchAll(BLOCK_RE)) {
    const [, tag, attrs, slotId, inner] = match
    const styleMatch = attrs.match(/style="([^"]*)"/)
    const style = styleMatch ? styleMatch[1] : ''
    const kind = attrs.includes('data-pptx-kind="vector-shape"')
      ? 'vector-shape'
      : attrs.includes('data-pptx-kind="table"')
        ? 'table'
        : /<img\b/i.test(inner)
          ? 'image'
          : 'text'
    blocks.push({
      slotId,
      tag: tag as 'section' | 'figure',
      style,
      inner,
      text: kind === 'image' || kind === 'vector-shape' ? '' : stripTags(inner),
      rect: {
        left: styleNumber(style, 'left'),
        top: styleNumber(style, 'top'),
        width: styleNumber(style, 'width'),
        height: styleNumber(style, 'height')
      },
      fontSize: styleNumber(style, 'font-size') || 0,
      hasImage: kind === 'image',
      kind
    })
  }
  return blocks
}

const aspectOf = (width: number, height: number): LayoutAssetMediaSlot['aspect'] => {
  if (!width || !height) return 'landscape'
  const ratio = width / height
  if (ratio >= 2) return 'wide'
  if (ratio > 1.15) return 'landscape'
  if (ratio < 0.87) return 'portrait'
  return 'square'
}

const sameBand = (a: BlockNode, b: BlockNode): boolean =>
  Math.abs(a.rect.top - b.rect.top) <= Math.max(a.rect.height, b.rect.height) * 0.35

const similarSize = (a: BlockNode, b: BlockNode): boolean => {
  const widthGap = Math.abs(a.rect.width - b.rect.width)
  const heightGap = Math.abs(a.rect.height - b.rect.height)
  return (
    widthGap <= Math.max(a.rect.width, b.rect.width) * 0.25 &&
    heightGap <= Math.max(a.rect.height, b.rect.height) * 0.35
  )
}

/** 企业模板中的 logo/装饰图最小尺寸（更小的图视为品牌元素不可替换）。 */
const LOGO_MAX_DIM = 80
/** 页面边缘的 footer/header 判定阈值。 */
const EDGE_THRESHOLD = 60
/** footer/header 的字号上限（更小的字视为页眉页脚装饰）。 */
const HEADER_FOOTER_MAX_FONT = 14

/** 判断是否为企业模板的 logo/装饰图（小尺寸或边缘位置）。 */
const isDecorativeImage = (block: BlockNode): boolean =>
  block.rect.width <= LOGO_MAX_DIM ||
  block.rect.height <= LOGO_MAX_DIM ||
  block.rect.top < EDGE_THRESHOLD && block.rect.height <= 60

/** 判断是否为页眉/页脚装饰文本（小字+边缘位置）。 */
const isHeaderFooter = (block: BlockNode, canvasHeight: number): boolean => {
  if (block.fontSize > HEADER_FOOTER_MAX_FONT) return false
  if (block.fontSize === 0) return false
  const nearTop = block.rect.top < EDGE_THRESHOLD
  const nearBottom = block.rect.top + block.rect.height > canvasHeight - EDGE_THRESHOLD
  return nearTop || nearBottom
}

/** 把块分类为内容槽；保守策略：识别不了就不是槽。 */
export function classifyBlocks(
  blocks: BlockNode[],
  options: { canvasHeight?: number } = {}
): LayoutAssetSlot[] {
  const canvasHeight = options.canvasHeight || 900
  const textish = blocks.filter(
    (block) =>
      block.kind === 'text' &&
      block.text.length > 0 &&
      !isHeaderFooter(block, canvasHeight)
  )
  const media = blocks
    .filter((block) => block.kind === 'image' && !isDecorativeImage(block))
    .map<LayoutAssetMediaSlot>((block) => ({
      kind: 'media',
      slotId: block.slotId,
      aspect: aspectOf(block.rect.width, block.rect.height),
      widthPx: Math.round(block.rect.width),
      heightPx: Math.round(block.rect.height)
    }))

  // 1. 列表组：同横带 + 尺寸量级相近 + 文本形态相近，≥2 项成组
  const grouped = new Set<string>()
  const lists: LayoutAssetListSlot[] = []
  for (const anchor of textish) {
    if (grouped.has(anchor.slotId)) continue
    const peers = textish.filter(
      (peer) =>
        peer.slotId !== anchor.slotId &&
        !grouped.has(peer.slotId) &&
        sameBand(anchor, peer) &&
        similarSize(anchor, peer) &&
        Math.abs(anchor.text.length - peer.text.length) <= 24
    )
    const group = [anchor, ...peers]
    if (group.length >= 2) {
      group.forEach((item) => grouped.add(item.slotId))
      const sorted = group.sort((a, b) => a.rect.left - b.rect.left)
      lists.push({
        kind: 'list',
        slotId: `list-${anchor.slotId}`,
        itemSlotIds: sorted.map((item) => item.slotId),
        minItems: 2,
        maxItems: sorted.length,
        perItemMaxChars: Math.max(2, ...sorted.map((item) => item.text.length)),
        sample: sorted.map((item) => item.text)
      })
    }
  }

  const singles = textish.filter((block) => !grouped.has(block.slotId))
  // 2. 标题：最大字号（并列时取最靠上的）
  let titleBlock: BlockNode | undefined
  for (const block of singles) {
    if (!titleBlock) {
      titleBlock = block
      continue
    }
    const biggerFont = block.fontSize > titleBlock.fontSize
    const sameFontHigher = block.fontSize === titleBlock.fontSize && block.rect.top < titleBlock.rect.top
    if (biggerFont || sameFontHigher) titleBlock = block
  }

  const textSlots: LayoutAssetTextSlot[] = []
  for (const block of singles) {
    const isTitle = titleBlock && block.slotId === titleBlock.slotId
    const numeric = NUMERIC_TEXT_RE.test(block.text)
    const kind: LayoutAssetTextSlot['kind'] = isTitle
      ? 'title'
      : numeric && block.text.length <= 12
        ? 'metric'
        : block.text.length > 40
          ? 'body'
          : 'label'
    textSlots.push({
      kind,
      slotId: block.slotId,
      maxChars: Math.max(2, block.text.length),
      sample: block.text
    })
  }

  // 槽排序：title → body → label → metric → list → media，稳定可读
  const order: Record<string, number> = { title: 0, body: 1, label: 2, metric: 3, list: 4, media: 5 }
  return [...textSlots, ...lists, ...media].sort(
    (a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)
  )
}

const buildCapacity = (slots: LayoutAssetSlot[]): LayoutAssetCapacity => {
  const titleSlot = slots.find((slot) => slot.kind === 'title') as LayoutAssetTextSlot | undefined
  const listSlots = slots.filter((slot) => slot.kind === 'list') as LayoutAssetListSlot[]
  const moduleCounts = listSlots.length > 0 ? listSlots.map((slot) => slot.maxItems) : []
  return {
    titleMaxChars: titleSlot?.maxChars || 24,
    moduleMin: moduleCounts.length > 0 ? Math.min(...listSlots.map((slot) => slot.minItems)) : 0,
    moduleMax: moduleCounts.length > 0 ? Math.max(...moduleCounts) : 0,
    mediaSlots: slots.filter((slot) => slot.kind === 'media').length,
    hasChart: false
  }
}

const fingerprint = (blocks: BlockNode[]): string => {
  const signature = blocks
    .map(
      (block) =>
        `${block.kind}:${Math.round(block.rect.left / 8)}x${Math.round(block.rect.top / 8)}:${Math.round(
          block.rect.width / 16
        )}x${Math.round(block.rect.height / 16)}`
    )
    .sort()
    .join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `v1-${(hash >>> 0).toString(36)}`
}

/**
 * 页面 HTML → 版式契约。骨架即原 HTML（视觉零损失），
 * 契约记录可填块与填充方式；没有任何可识别槽时返回 null（该页不适合作版式）。
 */
export function parametrizePageHtml(html: string): ParametrizeResult | null {
  const blocks = extractBlocks(html)
  if (blocks.length === 0) return null
  // 从 HTML 中提取画布高度，用于页眉/页脚判定
  const canvasHeight = Number(html.match(/\bdata-ppt-height=["'](\d+)["']/i)?.[1]) || 900
  const slots = classifyBlocks(blocks, { canvasHeight })
  const textishSlots = slots.filter((slot) => slot.kind !== 'media')
  if (textishSlots.length === 0) return null
  return {
    slots,
    capacity: buildCapacity(slots),
    structureFingerprint: fingerprint(blocks)
  }
}

export function buildLayoutAssetFromPageHtml(args: {
  html: string
  id: string
  title: string
  roles: string[]
  slideSizeId: string
  source: LayoutAsset['source']
  skeletonPath: string
  sessionId?: string
  pageId?: string
}): LayoutAsset | null {
  const parametrized = parametrizePageHtml(args.html)
  if (!parametrized) return null
  return {
    id: args.id,
    version: 1,
    source: args.source,
    roles: args.roles.length > 0 ? args.roles : ['content'],
    slideSizeId: args.slideSizeId,
    title: args.title,
    skeletonPath: args.skeletonPath,
    slots: parametrized.slots,
    capacity: parametrized.capacity,
    structureFingerprint: parametrized.structureFingerprint,
    origin: {
      sessionId: args.sessionId,
      pageId: args.pageId,
      importedAt: Date.now()
    }
  }
}
