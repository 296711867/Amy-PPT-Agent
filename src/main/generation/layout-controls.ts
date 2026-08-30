/**
 * 版式控件 IPC：读取页面的可调参数、调整后免 AI 重渲染。
 * 只对锁定版式生成的页面有效（有 pageLayoutBindings 记录）。
 *
 * 控件：模块数滑杆、配色切换、重点切换、布局切换。
 * 全部走确定性填充，零 LLM 调用。
 */
import fs from 'fs'
import path from 'path'
import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { parseJsonObject } from '../ipc/utils'
import type { GenerationDbPort } from './context'
import {
  readLayoutManifest,
  readLayoutSkeleton
} from '../layout-assets/library'
import { fillLayoutAsset, blankMetricSlots, ensurePageShell } from '../layout-assets/fill'
import {
  normalizeLayoutAsset
} from '@shared/layout-asset'

type PageLayoutBinding = {
  layoutAssetId: string
  contentPackage: { title: string; body: string; listItems: string[]; metrics?: string[] }
  moduleRange?: { min: number; max: number }
  palette?: string
}

const readBindings = async (
  db: LayoutControlContext['db'],
  sessionId: string
): Promise<Record<string, PageLayoutBinding>> => {
  const session = await db.getSession(sessionId)
  if (!session) return {}
  const record = session as unknown as Record<string, unknown>
  const metadata = parseJsonObject(
    String(record.metadata ?? record.metadata_json ?? '{}')
  )
  const bindings = metadata.pageLayoutBindings
  return bindings && typeof bindings === 'object' ? (bindings as Record<string, PageLayoutBinding>) : {}
}

// ── 配色预设 ─────────────────────────────────────────────────

export const LAYOUT_PALETTE_PRESETS: Record<string, { label: string; colors: Record<string, string> }> = {
  blue: {
    label: '蓝',
    colors: {
      '#2F6BFF': '#2F6BFF',
      '#7FA4FF': '#7FA4FF',
      '#24409E': '#24409E',
      '#1F2430': '#1F2430',
      '#1E2430': '#1E2430',
      '#F7F5F0': '#F7F5F0',
      '#F3F6FB': '#F3F6FB',
      '#F7F9FC': '#F7F9FC',
      '#D8DCE3': '#D8DCE3',
      '#5A6472': '#5A6472',
      '#9AA1AC': '#9AA1AC'
    }
  },
  warm: {
    label: '暖',
    colors: {
      '#2F6BFF': '#E67E22',
      '#7FA4FF': '#F0A860',
      '#24409E': '#B45309',
      '#1F2430': '#292018',
      '#1E2430': '#292018',
      '#F7F5F0': '#FAF6EF',
      '#F3F6FB': '#FDF3E7',
      '#F7F9FC': '#FDF6EE',
      '#D8DCE3': '#E8DDD0',
      '#5A6472': '#8A7264',
      '#9AA1AC': '#B8A898'
    }
  },
  dark: {
    label: '深',
    colors: {
      '#2F6BFF': '#60A5FA',
      '#7FA4FF': '#93C5FD',
      '#24409E': '#1E3A8A',
      '#1F2430': '#F1F5F9',
      '#1E2430': '#F1F5F9',
      '#F7F5F0': '#0F172A',
      '#F3F6FB': '#1E293B',
      '#F7F9FC': '#1E293B',
      '#D8DCE3': '#334155',
      '#5A6472': '#94A3B8',
      '#9AA1AC': '#64748B'
    }
  },
  green: {
    label: '绿',
    colors: {
      '#2F6BFF': '#10B981',
      '#7FA4FF': '#6EE7B7',
      '#24409E': '#065F46',
      '#1F2430': '#1A2E25',
      '#1E2430': '#1A2E25',
      '#F7F5F0': '#F5F9F6',
      '#F3F6FB': '#ECFDF5',
      '#F7F9FC': '#F0FDF4',
      '#D8DCE3': '#D1E7DD',
      '#5A6472': '#5F7A6E',
      '#9AA1AC': '#8FA89B'
    }
  }
}

const applyPalette = (html: string, paletteId: string): string => {
  const preset = LAYOUT_PALETTE_PRESETS[paletteId]
  if (!preset) return html
  let result = html
  for (const [from, to] of Object.entries(preset.colors)) {
    // 不区分大小写的 hex 替换
    result = result.replace(new RegExp(from.replace('#', '#'), 'gi'), to)
  }
  return result
}

// ── 共享的重填充辅助 ─────────────────────────────────────────

/** 版式控件所需的数据库访问能力（窄接口，不依赖 IPC facade）。 */
type LayoutControlContext = {
  db: Pick<GenerationDbPort, 'listSessionPages' | 'getSession' | 'updateSessionMetadata'>
}

const refillAndWrite = async (
  ctx: LayoutControlContext,
  sessionId: string,
  pageId: string,
  binding: PageLayoutBinding,
  overrides: {
    listItems?: string[]
    layoutAssetId?: string
    palette?: string
  } = {}
): Promise<{ htmlPath: string }> => {
  const manifest = await readLayoutManifest()
  const assetId = overrides.layoutAssetId || binding.layoutAssetId
  const assetRecord = manifest.assets.find((a) => a.id === assetId)
  if (!assetRecord) throw new Error(`版式资产不存在: ${assetId}`)
  const asset = normalizeLayoutAsset(assetRecord)
  if (!asset) throw new Error('版式资产格式不合法')
  const skeleton = ensurePageShell(await readLayoutSkeleton(asset))

  const listItems = overrides.listItems ?? binding.contentPackage.listItems
  const palette = overrides.palette ?? binding.palette

  let filled = blankMetricSlots(
    asset,
    fillLayoutAsset(asset, skeleton, {
      title: binding.contentPackage.title,
      body: binding.contentPackage.body,
      listItems,
      ...(binding.contentPackage.metrics ? { metrics: binding.contentPackage.metrics } : {})
    })
  )
  if (palette && palette !== 'blue') {
    filled = applyPalette(filled, palette)
  }

  // 写入页面
  const pages = await ctx.db.listSessionPages(sessionId)
  const page = pages.find((p) => p.file_slug === pageId || p.legacy_page_id === pageId)
  if (!page?.html_path) throw new Error('页面文件不存在')
  const htmlPath = path.isAbsolute(page.html_path) ? page.html_path : page.html_path
  await fs.promises.writeFile(htmlPath, filled, 'utf-8')

  // 更新绑定
  const session = await ctx.db.getSession(sessionId)
  if (session) {
    const record = session as unknown as Record<string, unknown>
    const metadata = parseJsonObject(String(record.metadata ?? record.metadata_json ?? '{}'))
    const existingBindings = (metadata.pageLayoutBindings || {}) as Record<string, PageLayoutBinding>
    existingBindings[pageId] = {
      ...binding,
      layoutAssetId: assetId,
      palette,
      contentPackage: { ...binding.contentPackage, listItems }
    }
    metadata.pageLayoutBindings = existingBindings
    await ctx.db.updateSessionMetadata(sessionId, metadata)
  }

  return { htmlPath: page.html_path }
}

// ── IPC 处理器 ───────────────────────────────────────────────

export function registerLayoutControlHandlers(ctx: LayoutControlContext): void {
  /** 获取某页的可调参数（是否有版式绑定、模块数范围、可用版式列表）。 */
  ipcMain.handle(
    'pages:getLayoutControls',
    async (_event, payload: { sessionId?: unknown; pageId?: unknown }) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      if (!sessionId || !pageId) return null

      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) return null

      // 查询同角色的可用版式列表（排除当前版式）
      const manifest = await readLayoutManifest()
      const currentAsset = manifest.assets.find((a) => a.id === binding.layoutAssetId)
      const roles = currentAsset?.roles || ['content']
      const alternatives = manifest.assets
        .filter((a) => a.id !== binding.layoutAssetId && a.roles.some((r) => roles.includes(r)))
        .map((a) => ({ id: a.id, title: a.title, roles: a.roles }))

      return {
        layoutAssetId: binding.layoutAssetId,
        moduleRange: binding.moduleRange || null,
        currentModuleCount: binding.contentPackage.listItems.length,
        canAdjust: Boolean(binding.moduleRange),
        currentPalette: binding.palette || 'blue',
        palettes: Object.entries(LAYOUT_PALETTE_PRESETS).map(([id, preset]) => ({
          id,
          label: preset.label
        })),
        listItems: binding.contentPackage.listItems,
        alternativeLayouts: alternatives
      }
    }
  )

  /** 调整模块数并重渲染。 */
  ipcMain.handle(
    'pages:adjustModuleCount',
    async (
      _event,
      payload: { sessionId?: unknown; pageId?: unknown; moduleCount?: unknown }
    ) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      const moduleCount = Number(payload?.moduleCount)
      if (!sessionId || !pageId || !Number.isFinite(moduleCount)) {
        throw new Error('参数不完整')
      }
      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) throw new Error('该页面不是锁定版式生成')
      const range = binding.moduleRange
      if (!range) throw new Error('该版式不支持模块数调节')
      const clamped = Math.max(range.min, Math.min(range.max, Math.floor(moduleCount)))

      const allLabels = binding.contentPackage.listItems
      const adjustedLabels = Array.from({ length: clamped }, (_unused, i) =>
        allLabels[i % allLabels.length]
      )
      const result = await refillAndWrite(ctx, sessionId, pageId, binding, { listItems: adjustedLabels })
      return { success: true, moduleCount: clamped, ...result }
    }
  )

  /** 切换配色（颜色映射替换，零 LLM）。 */
  ipcMain.handle(
    'pages:switchPalette',
    async (
      _event,
      payload: { sessionId?: unknown; pageId?: unknown; palette?: unknown }
    ) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      const palette = String(payload?.palette || '').trim()
      if (!sessionId || !pageId || !palette) throw new Error('参数不完整')
      if (!LAYOUT_PALETTE_PRESETS[palette]) throw new Error(`未知配色: ${palette}`)

      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) throw new Error('该页面不是锁定版式生成')

      const result = await refillAndWrite(ctx, sessionId, pageId, binding, { palette })
      log.info('[layout-controls] palette switched', { sessionId, pageId, palette })
      return { success: true, palette, ...result }
    }
  )

  /** 切换页面重点（重排条目顺序）。 */
  ipcMain.handle(
    'pages:reorderFocus',
    async (
      _event,
      payload: { sessionId?: unknown; pageId?: unknown; focusIndex?: unknown }
    ) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      const focusIndex = Number(payload?.focusIndex)
      if (!sessionId || !pageId || !Number.isFinite(focusIndex)) {
        throw new Error('参数不完整')
      }

      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) throw new Error('该页面不是锁定版式生成')

      const items = binding.contentPackage.listItems
      if (focusIndex < 0 || focusIndex >= items.length) throw new Error('重点索引越界')

      // 把选中的条目移到第一位（视觉焦点位）
      const reordered = [
        items[focusIndex],
        ...items.slice(0, focusIndex),
        ...items.slice(focusIndex + 1)
      ]

      const result = await refillAndWrite(ctx, sessionId, pageId, binding, { listItems: reordered })
      log.info('[layout-controls] focus reordered', { sessionId, pageId, focusIndex })
      return { success: true, focusIndex, ...result }
    }
  )

  /** 切换布局（同一内容换不同版式）。 */
  ipcMain.handle(
    'pages:switchLayout',
    async (
      _event,
      payload: { sessionId?: unknown; pageId?: unknown; layoutAssetId?: unknown }
    ) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      const layoutAssetId = String(payload?.layoutAssetId || '').trim()
      if (!sessionId || !pageId || !layoutAssetId) throw new Error('参数不完整')

      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) throw new Error('该页面不是锁定版式生成')

      // 验证目标版式存在且容量匹配
      const manifest = await readLayoutManifest()
      const targetAsset = normalizeLayoutAsset(
        manifest.assets.find((a) => a.id === layoutAssetId)
      )
      if (!targetAsset) throw new Error(`目标版式不存在: ${layoutAssetId}`)

      const itemCount = binding.contentPackage.listItems.length
      const listSlots = targetAsset.slots.filter((s) => s.kind === 'list') as Array<{ minItems: number; maxItems: number }>
      if (listSlots.length > 0) {
        const slot = listSlots[0]
        const clampedCount = Math.max(slot.minItems, Math.min(slot.maxItems, itemCount))
        const adjusted = binding.contentPackage.listItems.slice(0, clampedCount)
        const result = await refillAndWrite(ctx, sessionId, pageId, binding, {
          layoutAssetId,
          listItems: adjusted
        })
        log.info('[layout-controls] layout switched', { sessionId, pageId, layoutAssetId })
        return { success: true, layoutAssetId, ...result }
      }

      const result = await refillAndWrite(ctx, sessionId, pageId, binding, { layoutAssetId })
      log.info('[layout-controls] layout switched', { sessionId, pageId, layoutAssetId })
      return { success: true, layoutAssetId, ...result }
    }
  )

  log.info('[layout-controls] handlers registered')
}
