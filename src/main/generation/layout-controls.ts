/**
 * 版式控件 IPC：读取页面的可调参数、调整后免 AI 重渲染。
 * 只对锁定版式生成的页面有效（有 pageLayoutBindings 记录）。
 */
import fs from 'fs'
import path from 'path'
import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import type { IpcContext } from '../ipc/context'
import { parseJsonObject } from '../ipc/utils'
import {
  readLayoutManifest,
  readLayoutSkeleton
} from '../layout-assets/library'
import { fillLayoutAsset, blankMetricSlots } from '../layout-assets/fill'
import { normalizeLayoutAsset } from '@shared/layout-asset'

type PageLayoutBinding = {
  layoutAssetId: string
  contentPackage: { title: string; body: string; listItems: string[]; metrics?: string[] }
  moduleRange?: { min: number; max: number }
}

const readBindings = async (
  db: IpcContext['db'],
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

export function registerLayoutControlHandlers(ctx: IpcContext): void {
  /** 获取某页的可调参数（是否有版式绑定、模块数范围）。 */
  ipcMain.handle(
    'pages:getLayoutControls',
    async (_event, payload: { sessionId?: unknown; pageId?: unknown }) => {
      const sessionId = String(payload?.sessionId || '').trim()
      const pageId = String(payload?.pageId || '').trim()
      if (!sessionId || !pageId) return null

      const bindings = await readBindings(ctx.db, sessionId)
      const binding = bindings[pageId]
      if (!binding) return null

      return {
        layoutAssetId: binding.layoutAssetId,
        moduleRange: binding.moduleRange || null,
        currentModuleCount: binding.contentPackage.listItems.length,
        canAdjust: Boolean(binding.moduleRange)
      }
    }
  )

  /** 调整模块数并重渲染（免 AI，确定性填充）。 */
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
      if (!binding) throw new Error('该页面不是锁定版式生成，无法使用控件调节')

      const range = binding.moduleRange
      if (!range) throw new Error('该版式不支持模块数调节')
      const clamped = Math.max(range.min, Math.min(range.max, Math.floor(moduleCount)))

      // 读取版式骨架
      const manifest = await readLayoutManifest()
      const assetRecord = manifest.assets.find((a) => a.id === binding.layoutAssetId)
      if (!assetRecord) throw new Error(`版式资产不存在: ${binding.layoutAssetId}`)
      const asset = normalizeLayoutAsset(assetRecord)
      if (!asset) throw new Error('版式资产格式不合法')
      const skeleton = await readLayoutSkeleton(asset)

      // 调整内容包：截取或循环补充 listItems 到目标数量
      const allLabels = binding.contentPackage.listItems
      const adjustedLabels = Array.from({ length: clamped }, (_unused, i) =>
        allLabels[i % allLabels.length]
      )

      // 重新填充
      const filled = blankMetricSlots(
        asset,
        fillLayoutAsset(asset, skeleton, {
          title: binding.contentPackage.title,
          body: binding.contentPackage.body,
          listItems: adjustedLabels,
          ...(binding.contentPackage.metrics ? { metrics: binding.contentPackage.metrics } : {})
        })
      )

      // 写入页面文件
      const pages = await ctx.db.listSessionPages(sessionId)
      const page = pages.find((p) => p.file_slug === pageId || p.legacy_page_id === pageId)
      if (!page?.html_path) throw new Error('页面文件不存在')
      const htmlPath = path.isAbsolute(page.html_path)
        ? page.html_path
        : path.join(path.dirname(page.html_path), page.html_path)
      await fs.promises.writeFile(htmlPath, filled, 'utf-8')

      // 更新绑定中的 listItems
      const session = await ctx.db.getSession(sessionId)
      if (session) {
        const record = session as unknown as Record<string, unknown>
        const metadata = parseJsonObject(String(record.metadata ?? record.metadata_json ?? '{}'))
        const existingBindings = (metadata.pageLayoutBindings || {}) as Record<string, PageLayoutBinding>
        existingBindings[pageId] = {
          ...binding,
          contentPackage: { ...binding.contentPackage, listItems: adjustedLabels }
        }
        metadata.pageLayoutBindings = existingBindings
        await ctx.db.updateSessionMetadata(sessionId, metadata)
      }

      log.info('[layout-controls] module count adjusted', {
        sessionId,
        pageId,
        moduleCount: clamped
      })

      return { success: true, moduleCount: clamped, htmlPath: page.html_path }
    }
  )

  log.info('[layout-controls] handlers registered')
}
