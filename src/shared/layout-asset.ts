/**
 * 版式资产合同（Layout Asset Contract）
 *
 * 一个版式 = 一份预先渲染验证过的页面骨架（HTML）+ 内容槽契约。
 * 生成时"锁定模式"按契约把 canonical 内容确定性填入槽位，
 * 不再让模型现场写页面结构 —— 质量由版式预建时保证。
 *
 * 版式与风格解耦：骨架 HTML 只描述几何与层级，配色/字体由 deck 的
 * design contract 提供；同一版式可服务全部风格。
 */

export type LayoutAssetSource = 'template' | 'mined' | 'authored'

/** 内容槽类型；kind 决定填充器如何写入内容。 */
export type LayoutAssetSlotKind = 'title' | 'body' | 'label' | 'metric' | 'list' | 'media'

export type LayoutAssetTextSlot = {
  kind: 'title' | 'body' | 'label' | 'metric'
  /** 槽位 id，等于骨架 HTML 中 data-block-id 的值。 */
  slotId: string
  /** 建议字符预算（按原文本长度估算）。 */
  maxChars: number
  /** 原文本（导入时的示例内容，填充时整体替换）。 */
  sample: string
}

export type LayoutAssetListSlot = {
  kind: 'list'
  slotId: string
  /** 重复项块 id：第一项作为克隆模板，其余项按等距偏移克隆。 */
  itemSlotIds: string[]
  minItems: number
  maxItems: number
  perItemMaxChars: number
  sample: string[]
}

export type LayoutAssetMediaSlot = {
  kind: 'media'
  slotId: string
  aspect: 'landscape' | 'portrait' | 'square' | 'wide'
  widthPx: number
  heightPx: number
}

export type LayoutAssetSlot = LayoutAssetTextSlot | LayoutAssetListSlot | LayoutAssetMediaSlot

export type LayoutAssetCapacity = {
  titleMaxChars: number
  /** 内容模块容量区间（列表槽的 min/max 汇总）。 */
  moduleMin: number
  moduleMax: number
  mediaSlots: number
  hasChart: boolean
}

export type LayoutAsset = {
  id: string
  version: 1
  source: LayoutAssetSource
  /** 语义页面角色（cover / content / ending / ...），来自模板页角色分类。 */
  roles: string[]
  slideSizeId: string
  title: string
  /** 骨架 HTML 的存储相对路径（库内）。 */
  skeletonPath: string
  slots: LayoutAssetSlot[]
  capacity: LayoutAssetCapacity
  /** 结构指纹：同一模板重复导入时去重。 */
  structureFingerprint: string
  origin: {
    sessionId?: string
    pageId?: string
    importedAt?: number
  }
}

export type LayoutAssetManifest = {
  version: 1
  assets: LayoutAsset[]
}

export type LayoutAssetQueryRequest = {
  roles?: string[]
  /** 计划模块数（OutlineItem.moduleCount）；落在 [moduleMin, moduleMax] 内视为匹配。 */
  moduleCount?: number
  mediaSlots?: number
  slideSizeId?: string
  /** 本 deck 已使用的版式 id，结果中排除。 */
  excludeIds?: string[]
  limit?: number
  /** 稳定随机种子：同 seed 同查询得到同一排序，保证可复现。 */
  seed?: string
}

const LAYOUT_ASSET_SOURCES: readonly LayoutAssetSource[] = ['template', 'mined', 'authored']
const SLOT_KINDS: readonly LayoutAssetSlotKind[] = [
  'title',
  'body',
  'label',
  'metric',
  'list',
  'media'
]

export const isLayoutAssetSlotKind = (value: unknown): value is LayoutAssetSlotKind =>
  SLOT_KINDS.includes(value as LayoutAssetSlotKind)

const asPositiveInt = (value: unknown): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

const normalizeSlot = (value: unknown): LayoutAssetSlot | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = record.kind
  const slotId = typeof record.slotId === 'string' ? record.slotId.trim() : ''
  if (!slotId || !isLayoutAssetSlotKind(kind)) return null

  if (kind === 'media') {
    const widthPx = asPositiveInt(record.widthPx) || 0
    const heightPx = asPositiveInt(record.heightPx) || 0
    const aspectRaw = String(record.aspect || '')
    const aspect: LayoutAssetMediaSlot['aspect'] =
      aspectRaw === 'portrait' || aspectRaw === 'square' || aspectRaw === 'wide'
        ? aspectRaw
        : 'landscape'
    return { kind, slotId, aspect, widthPx, heightPx }
  }

  if (kind === 'list') {
    const itemSlotIds = Array.isArray(record.itemSlotIds)
      ? record.itemSlotIds.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    if (itemSlotIds.length < 2) return null
    const minItems = Math.max(1, asPositiveInt(record.minItems) || itemSlotIds.length)
    const maxItems = Math.max(minItems, asPositiveInt(record.maxItems) || itemSlotIds.length)
    const sample = Array.isArray(record.sample)
      ? record.sample.map((item) => String(item || '')).filter(Boolean)
      : []
    return {
      kind,
      slotId,
      itemSlotIds,
      minItems,
      maxItems,
      perItemMaxChars: Math.max(2, asPositiveInt(record.perItemMaxChars) || 12),
      sample
    }
  }

  const maxChars = Math.max(1, asPositiveInt(record.maxChars) || 12)
  const sample = typeof record.sample === 'string' ? record.sample : ''
  return { kind, slotId, maxChars, sample }
}

/** 校验并归一化外部（磁盘/IPC）传来的版式资产；不合法返回 null。 */
export function normalizeLayoutAsset(value: unknown): LayoutAsset | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const skeletonPath = typeof record.skeletonPath === 'string' ? record.skeletonPath.trim() : ''
  if (!id || !title || !skeletonPath) return null

  const source = LAYOUT_ASOURCES_HAS(record.source)
  const roles = Array.isArray(record.roles)
    ? record.roles.map((role) => String(role || '').trim()).filter(Boolean)
    : []
  if (roles.length === 0) return null

  const slots = (Array.isArray(record.slots) ? record.slots : [])
    .map(normalizeSlot)
    .filter((slot): slot is LayoutAssetSlot => slot !== null)

  const capacityRaw = (record.capacity && typeof record.capacity === 'object'
    ? record.capacity
    : {}) as Record<string, unknown>
  const capacity: LayoutAssetCapacity = {
    titleMaxChars: Math.max(1, asPositiveInt(capacityRaw.titleMaxChars) || 24),
    moduleMin: Math.max(0, asPositiveInt(capacityRaw.moduleMin) || 0),
    moduleMax: Math.max(
      Math.max(0, asPositiveInt(capacityRaw.moduleMin) || 0),
      asPositiveInt(capacityRaw.moduleMax) || 0
    ),
    mediaSlots: Math.max(0, asPositiveInt(capacityRaw.mediaSlots) || 0),
    hasChart: capacityRaw.hasChart === true
  }

  const originRaw = (record.origin && typeof record.origin === 'object'
    ? record.origin
    : {}) as Record<string, unknown>

  return {
    id,
    version: 1,
    source,
    roles,
    slideSizeId: typeof record.slideSizeId === 'string' ? record.slideSizeId : 'wide-16-9',
    title,
    skeletonPath,
    slots,
    capacity,
    structureFingerprint:
      typeof record.structureFingerprint === 'string' ? record.structureFingerprint : '',
    origin: {
      sessionId:
        typeof originRaw.sessionId === 'string' && originRaw.sessionId
          ? originRaw.sessionId
          : undefined,
      pageId: typeof originRaw.pageId === 'string' && originRaw.pageId ? originRaw.pageId : undefined,
      importedAt: asPositiveInt(originRaw.importedAt) || undefined
    }
  }
}

const LAYOUT_ASOURCES_HAS = (value: unknown): LayoutAssetSource =>
  LAYOUT_ASSET_SOURCES.includes(value as LayoutAssetSource)
    ? (value as LayoutAssetSource)
    : 'template'

/** 稳定字符串散列（FNV-1a），用于可复现洗牌。 */
const stableHash = (value: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const matchesCapacity = (asset: LayoutAsset, request: LayoutAssetQueryRequest): boolean => {
  if (request.slideSizeId && asset.slideSizeId !== request.slideSizeId) return false
  if (request.roles && request.roles.length > 0) {
    const wanted = new Set(request.roles)
    if (!asset.roles.some((role) => wanted.has(role))) return false
  }
  if (typeof request.moduleCount === 'number' && Number.isFinite(request.moduleCount)) {
    const count = Math.floor(request.moduleCount)
    const listSlots = asset.slots.filter((slot) => slot.kind === 'list') as LayoutAssetListSlot[]
    if (listSlots.length === 0) {
      if (count > asset.capacity.moduleMax && asset.capacity.moduleMax > 0) return false
    } else {
      const fits = listSlots.some(
        (slot) => count >= slot.minItems && count <= slot.maxItems
      )
      const withinDeck = count >= asset.capacity.moduleMin && count <= asset.capacity.moduleMax
      if (!fits && !withinDeck) return false
    }
  }
  if (typeof request.mediaSlots === 'number' && request.mediaSlots > 0) {
    if (asset.capacity.mediaSlots < request.mediaSlots) return false
  }
  return true
}

/**
 * 按内容容量查询版式。纯函数：同 seed 同输入得到同一顺序，
 * excludeIds 支持整 deck 不重复分配。
 */
export function queryLayoutAssets(
  assets: readonly LayoutAsset[],
  request: LayoutAssetQueryRequest = {}
): LayoutAsset[] {
  const excluded = new Set(request.excludeIds || [])
  const matched = assets.filter(
    (asset) => !excluded.has(asset.id) && matchesCapacity(asset, request)
  )
  const limit = Math.max(1, Math.min(50, Math.floor(request.limit || 12)))
  if (matched.length <= limit) return matched

  const seed = request.seed ? stableHash(request.seed) : stableHash(matched.map((a) => a.id).join('|'))
  // 可复现的部分 Fisher-Yates 洗牌：种子决定顺序，取前 limit 个。
  const pool = [...matched]
  for (let index = pool.length - 1; index > 0 && pool.length - index < limit * 3; index -= 1) {
    const next = seed % (index + 1)
    const swap = (seed >>> 8) % (index + 1)
    const target = (next + swap) % (index + 1)
    const holder = pool[index]
    pool[index] = pool[target]
    pool[target] = holder
  }
  return pool.slice(0, limit)
}

export type OutlineLayoutInput = {
  moduleCount?: number
  items?: string[]
}

/**
 * 整 deck 版式分配：按页位定角色（首页 cover、末页 ending、正文 content），
 * 按 moduleCount/要点数匹配容量，整 deck 不重复。
 * 列表槽版式要求要点数 ≥ minItems；配不上的页返回 null（回退自由创作）。
 */
export function assignLayoutAssetsToOutline(
  outline: readonly OutlineLayoutInput[],
  assets: readonly LayoutAsset[],
  options: { slideSizeId?: string; seed?: string } = {}
): Array<LayoutAsset | null> {
  const used = new Set<string>()
  const result: Array<LayoutAsset | null> = []
  const itemCount = (item: OutlineLayoutInput): number =>
    Array.isArray(item.items) ? item.items.filter((value) => value.trim()).length : 0

  outline.forEach((item, index) => {
    const roles =
      index === 0
        ? ['cover']
        : index === outline.length - 1 && outline.length > 1
          ? ['ending']
          : ['content']
    const itemTotal = itemCount(item)

    const pickFrom = (candidateRoles: string[]): LayoutAsset | null => {
      const candidates = queryLayoutAssets(assets, {
        roles: candidateRoles,
        moduleCount: item.moduleCount,
        slideSizeId: options.slideSizeId,
        excludeIds: Array.from(used),
        limit: 8,
        seed: options.seed ? `${options.seed}:${index}` : undefined
      })
      for (const asset of candidates) {
        const listSlots = asset.slots.filter((slot) => slot.kind === 'list') as LayoutAssetListSlot[]
        const needsItems = listSlots.some((slot) => slot.minItems > itemTotal)
        if (needsItems) continue
        used.add(asset.id)
        return asset
      }
      return null
    }

    // cover/ending 候选不足时回退 content 版式，尽量让每页都能锁定
    const assigned = pickFrom(roles) ?? (roles[0] !== 'content' ? pickFrom(['content']) : null)
    result.push(assigned)
  })
  return result
}
