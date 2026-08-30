/**
 * I-5：sourcePlan 路径绕过大纲规划器时，用户图片需求（imagePolicy）会丢失——
 * 占位/AI 配图只认 layoutId 自带的图片槽。这里做确定性兜底：
 * 当 imagePolicy 存在且内容页没有任何图槽 layoutId 时，为内容页轮换分配
 * 1/2/3 图槽布局。纯函数，在 diversifyUniversalLayoutSequence 之前应用，
 * 生成与模板两条 flow 共用。
 */
import type { ImagePolicy } from '@shared/generation'
import type { LayoutIntent } from '@shared/layout-intent'
import { getUniversalLayoutImageCount, type UniversalLayoutId } from '@shared/universal-layouts'

const IMAGE_SLOT_ROTATION: UniversalLayoutId[] = [
  'image-left-two-cards',
  'two-images-caption',
  'three-images-row'
]

// LayoutIntent 没有 ending/agenda 枚举；结尾页通常落在 summary/cover 上，
// 因此额外按位置排除首尾页（用户惯例：封面与结尾不加内容配图）。
const NON_CONTENT_INTENTS = new Set<LayoutIntent>(['cover', 'quote'])

type ImageSlotCandidate = {
  layoutId?: unknown
  layoutIntent?: LayoutIntent
  moduleCount?: number
}

const isContentPage = (item: ImageSlotCandidate, index: number, total: number): boolean =>
  index > 0 && index < total - 1 && !(item.layoutIntent && NON_CONTENT_INTENTS.has(item.layoutIntent))

const carriesImageSlot = (item: ImageSlotCandidate): boolean =>
  getUniversalLayoutImageCount(item.layoutId as UniversalLayoutId | undefined) > 0

type WithAssignedLayout<T> = T & { layoutId?: UniversalLayoutId; moduleCount?: number }

export function ensureImageSlotLayouts<T extends ImageSlotCandidate>(
  items: readonly T[],
  imagePolicy?: ImagePolicy
): Array<WithAssignedLayout<T>> {
  const unchanged = (): Array<WithAssignedLayout<T>> => items as Array<WithAssignedLayout<T>>
  if (imagePolicy !== 'placeholder' && imagePolicy !== 'ai') return unchanged()
  if (items.length <= 2) return unchanged()
  const contentIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => isContentPage(item, index, items.length))
  if (contentIndexes.length === 0) return unchanged()
  // 已有任一内容页带图槽视为规划生效，不做覆盖（尊重 LLM 的版式选择）
  if (contentIndexes.some(({ item }) => carriesImageSlot(item))) return unchanged()

  const next = [...items]
  let cursor = 0
  for (const { index } of contentIndexes) {
    const layoutId = IMAGE_SLOT_ROTATION[cursor % IMAGE_SLOT_ROTATION.length]
    cursor += 1
    next[index] = {
      ...next[index],
      layoutId,
      // 图槽布局自带模块数；原 moduleCount 属于文字布局，沿用会破坏槽位契约
      moduleCount: undefined
    } as WithAssignedLayout<T>
  }
  return next as Array<WithAssignedLayout<T>>
}
