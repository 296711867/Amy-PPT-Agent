/**
 * 共享的 Outline 归一化层。
 * 从 parsePlanningItems / planNewPage 的重复代码中提取，
 * 同时支持 string[] 和 OutlineItemData[] 两种 keyPoints 形态。
 */
import type {
  OutlineItemData,
  OutlineItemEntry,
  OutlineItemPriority
} from '@shared/generation'

export const MAX_KEY_POINTS_PER_SLIDE = 10
export const MAX_OUTLINE_TEXT_CHUNKS = 10
export const MAX_OUTLINE_TEXT_LENGTH = 260
export const MAX_KEY_POINT_LENGTH = 32
export const MAX_ITEM_DETAIL_LENGTH = 60

export const normalizeOutlineText = (raw: string): string => {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const chunks = text
    .split(/[；;。.!?\n、,，|/]/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const compact = (
    chunks.length > 0 ? chunks.slice(0, MAX_OUTLINE_TEXT_CHUNKS).join('；') : text
  ).trim()
  if (compact.length <= MAX_OUTLINE_TEXT_LENGTH) return compact
  return `${compact.slice(0, MAX_OUTLINE_TEXT_LENGTH).trimEnd()}…`
}

/** Normalize the planned "before → after" audience transition for one slide. */
export const normalizeAudienceMove = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length < 3) return undefined
  return normalized.slice(0, 160)
}

// ── 结构化条目归一化 ──────────────────────────────────────────

const isOutlineItemData = (value: unknown): value is Partial<OutlineItemData> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizePriority = (value: unknown): OutlineItemPriority | undefined =>
  value === 'primary' || value === 'supporting' || value === 'detail' ? value : undefined

let itemIdCounter = 0
const nextItemId = (): string => {
  itemIdCounter += 1
  return `item-${itemIdCounter}`
}

/** 把任意形态（字符串 / 对象 / 混合）的 keyPoints 归一化为结构化条目。 */
export const normalizeOutlineEntries = (value: unknown): OutlineItemData[] => {
  if (!Array.isArray(value)) return []

  return value
    .map<OutlineItemData | null>((entry): OutlineItemData | null => {
      if (typeof entry === 'string') {
        const label = entry.trim()
        if (!label) return null
        return {
          id: nextItemId(),
          label: label.length > MAX_KEY_POINT_LENGTH
            ? `${label.slice(0, MAX_KEY_POINT_LENGTH).trimEnd()}…`
            : label
        }
      }
      if (isOutlineItemData(entry)) {
        const label = String(entry.label ?? '').trim()
        if (!label) return null
        const detail = typeof entry.detail === 'string' ? entry.detail.trim() : undefined
        const displayValue = typeof entry.displayValue === 'string' ? entry.displayValue.trim() : undefined
        const value = entry.value
        const unit = typeof entry.unit === 'string' ? entry.unit.trim() : undefined
        const priority = normalizePriority(entry.priority)
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : nextItemId()
        return {
          id,
          label: label.length > MAX_KEY_POINT_LENGTH
            ? `${label.slice(0, MAX_KEY_POINT_LENGTH).trimEnd()}…`
            : label,
          ...(value !== undefined && value !== null && value !== '' ? { value } : {}),
          ...(unit ? { unit } : {}),
          ...(displayValue ? { displayValue } : {}),
          ...(detail
            ? { detail: detail.length > MAX_ITEM_DETAIL_LENGTH
              ? `${detail.slice(0, MAX_ITEM_DETAIL_LENGTH).trimEnd()}…`
              : detail }
            : {}),
          ...(priority ? { priority } : {})
        }
      }
      return null
    })
    .filter((entry): entry is OutlineItemData => entry !== null)
    .slice(0, MAX_KEY_POINTS_PER_SLIDE)
}

/** 兼容旧调用方：返回纯文本标签数组。 */
export const normalizeKeyPoints = (value: unknown): string[] =>
  normalizeOutlineEntries(value).map((entry) => entry.label)

/** 从结构化条目提取展示文本（指标条目优先 displayValue/value）。 */
export const outlineEntryToText = (entry: OutlineItemEntry): string => {
  if (typeof entry === 'string') return entry
  if (entry.displayValue) return entry.displayValue
  if (entry.value !== undefined && entry.value !== null) {
    const unitText = entry.unit || ''
    return `${entry.value}${unitText}`
  }
  return entry.label
}

export const outlineEntriesToTexts = (entries: OutlineItemEntry[]): string[] =>
  entries.map(outlineEntryToText)
