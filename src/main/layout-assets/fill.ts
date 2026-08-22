/**
 * 版式填充器：把 canonical 内容按槽契约确定性写入骨架 HTML。
 * 纯字符串操作，无 LLM —— "锁定模式"渲染的核心。
 */
import type { LayoutAsset, LayoutAssetListSlot, LayoutAssetTextSlot } from '@shared/layout-asset'
import { extractBlocks } from './parametrize'

export type LayoutFillContent = {
  title?: string
  body?: string
  labels?: string[]
  metrics?: string[]
  listItems?: string[]
  media?: Array<{ src: string }>
}

/** 无数据指标槽置为占位横线，避免残留模板示例数字。 */
export const blankMetricSlots = (asset: LayoutAsset, html: string): string => {
  let next = html
  for (const slot of asset.slots) {
    if (slot.kind === 'metric') next = replaceBlockInner(next, slot.slotId, '—')
  }
  return next
}

const escapeAttr = (value: string): string => value.replace(/"/g, '&quot;')

const blockOpenRe = (slotId: string): RegExp =>
  new RegExp(`(<(section|figure)\\b[^>]*\\bdata-block-id="${slotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)`, 'i')

/** 替换一个文本块的内部内容（保留块本身的样式与属性）。 */
export const replaceBlockInner = (html: string, slotId: string, nextInner: string): string => {
  const blockRe = new RegExp(
    `(<(section|figure)\\b[^>]*\\bdata-block-id="${slotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)([\\s\\S]*?)<\\/\\2>`,
    'i'
  )
  const match = html.match(blockRe)
  if (!match) return html
  return (
    html.slice(0, match.index) +
    match[1] +
    nextInner +
    `</${match[2]}>` +
    html.slice((match.index || 0) + match[0].length)
  )
}

/** media 槽换图：只替换 img 的 src，保留几何与 object-fit。 */
const replaceMediaSrc = (html: string, slotId: string, src: string): string => {
  const blockRe = new RegExp(
    `(<(section|figure)\\b[^>]*\\bdata-block-id="${slotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)([\\s\\S]*?)<\\/\\2>`,
    'i'
  )
  const match = html.match(blockRe)
  if (!match) return html
  const nextInner = match[3].replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/i, `$1${escapeAttr(src)}$3`)
  return html.slice(0, match.index) + match[1] + nextInner + `</${match[2]}>` + html.slice((match.index || 0) + match[0].length)
}

const listItemsFor = (slot: LayoutAssetListSlot, content: LayoutFillContent): string[] => {
  const items = (content.listItems || []).map((item) => item.trim()).filter(Boolean)
  if (items.length === 0) return slot.sample
  return items.slice(0, slot.maxItems)
}

/**
 * 确定性填充：文本槽整体替换；列表槽首块为模板，按需克隆/隐藏多余项；
 * 媒体槽换 src。未提供的槽保留原样（版式自带示例内容）。
 */
export function fillLayoutAsset(
  asset: LayoutAsset,
  skeletonHtml: string,
  content: LayoutFillContent
): string {
  let html = skeletonHtml
  const blocks = extractBlocks(skeletonHtml)
  const blockById = new Map(blocks.map((block) => [block.slotId, block]))

  const textAssignments = new Map<string, string>()
  const assign = (kind: LayoutAssetTextSlot['kind'], values: string[] | undefined): void => {
    if (!values || values.length === 0) return
    const targets = asset.slots.filter(
      (slot) => slot.kind === kind
    ) as LayoutAssetTextSlot[]
    targets.forEach((slot, index) => {
      const value = values[Math.min(index, values.length - 1)]
      if (value && value.trim()) textAssignments.set(slot.slotId, value.trim())
    })
  }
  if (content.title?.trim()) {
    const titleSlot = asset.slots.find((slot) => slot.kind === 'title') as LayoutAssetTextSlot | undefined
    if (titleSlot) textAssignments.set(titleSlot.slotId, content.title.trim())
  }
  assign('body', [content.body].filter(Boolean) as string[])
  assign('label', content.labels)
  assign('metric', content.metrics)
  for (const [slotId, value] of textAssignments) {
    html = replaceBlockInner(html, slotId, value)
  }

  // 列表槽：首块模板克隆，水平等距分布；不足的项隐藏
  for (const slot of asset.slots.filter((item) => item.kind === 'list') as LayoutAssetListSlot[]) {
    const items = listItemsFor(slot, content)
    const templateId = slot.itemSlotIds[0]
    const template = blockById.get(templateId)
    if (!template) continue
    const spacing = slot.itemSlotIds.length > 1
      ? Math.abs(
          (blockById.get(slot.itemSlotIds[1])?.rect.left || template.rect.left + template.rect.width + 24) -
            template.rect.left
        )
      : template.rect.width + 24

    // 先移除组内全部既有块，再按 items 数量重建
    for (const itemSlotId of slot.itemSlotIds) {
      const itemBlock = blockById.get(itemSlotId)
      if (!itemBlock) continue
      const removeRe = new RegExp(
        `<(section|figure)\\b[^>]*\\bdata-block-id="${itemSlotId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?<\\/\\1>\\s*`,
        'i'
      )
      html = html.replace(removeRe, '')
    }
    const openTagMatch = skeletonHtml.match(blockOpenRe(templateId))
    if (!openTagMatch) continue
    const clones: string[] = []
    items.forEach((item, index) => {
      const cloneTag = openTagMatch[1]
        .replace(/(data-block-id=")([^"]*)(")/i, `$1${templateId}-item-${index + 1}$3`)
        .replace(/((?:^|;)\s*left:\s*)([\d.]+)px/i, (_m, prefix: string, value: string) => {
          const left = Number(value) + index * spacing
          return `${prefix}${left.toFixed(2)}px`
        })
      clones.push(`${cloneTag}${item}</${openTagMatch[2]}>`)
    })
    // 克隆块插回模板块原位置（模板块已删除，插到其后的锚点：直接追加到 body 结束标签前）
    const bodyClose = html.lastIndexOf('</body>')
    const insertAt = bodyClose >= 0 ? bodyClose : html.length
    html = html.slice(0, insertAt) + clones.join('') + html.slice(insertAt)
  }

  // 媒体槽换图
  const mediaSlots = asset.slots.filter((slot) => slot.kind === 'media')
  mediaSlots.forEach((slot, index) => {
    const media = content.media?.[index]
    if (media?.src) html = replaceMediaSrc(html, slot.slotId, media.src)
  })

  return html
}
