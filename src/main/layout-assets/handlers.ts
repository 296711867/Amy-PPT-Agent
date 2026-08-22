import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import type { IpcContext } from '../ipc/context'
import {
  deleteLayoutAsset,
  ensureLayoutLibrary,
  importLayoutAssetsFromSession,
  readLayoutManifest,
  resolveLayoutLibraryPath
} from './library'

/** 版式库 IPC：列表 / 从会话导入 / 删除。 */
export function registerLayoutAssetHandlers(ctx: IpcContext): void {
  ipcMain.handle('layoutAssets:list', async () => {
    await ensureLayoutLibrary()
    const manifest = await readLayoutManifest()
    return {
      libraryPath: resolveLayoutLibraryPath(),
      assets: manifest.assets.map((asset) => ({
        id: asset.id,
        title: asset.title,
        roles: asset.roles,
        source: asset.source,
        slideSizeId: asset.slideSizeId,
        slotSummary: {
          title: asset.slots.some((slot) => slot.kind === 'title'),
          lists: asset.slots.filter((slot) => slot.kind === 'list').length,
          media: asset.slots.filter((slot) => slot.kind === 'media').length,
          texts: asset.slots.filter((slot) =>
            ['body', 'label', 'metric'].includes(slot.kind)
          ).length
        },
        capacity: asset.capacity,
        origin: asset.origin
      }))
    }
  })

  ipcMain.handle(
    'layoutAssets:importFromSession',
    async (_event, payload: { sessionId?: unknown }) => {
      const sessionId = String(payload?.sessionId || '').trim()
      if (!sessionId) throw new Error('sessionId 不能为空')
      const session = await ctx.db.getSession(sessionId)
      if (!session) throw new Error('会话不存在')
      const pages = await ctx.db.listSessionPages(sessionId)
      const usable = pages
        .filter((page) => page.html_path)
        .sort((a, b) => a.page_number - b.page_number)
        .map((page) => ({
          pageId: page.file_slug || page.id,
          pageNumber: page.page_number,
          title: page.title || `第 ${page.page_number} 页`,
          htmlPath: page.html_path as string
        }))
      if (usable.length === 0) {
        return { imported: 0, skipped: 0, duplicated: 0, reason: '会话没有可用页面' }
      }
      const projectDir = await ctx.sessionProject.resolveSessionProjectDir(sessionId)
      const roles = (pageNumber: number, total: number): string[] => {
        if (pageNumber <= 1) return ['cover']
        if (pageNumber >= total && total > 1) return ['ending']
        return ['content']
      }
      return importLayoutAssetsFromSession({ sessionId, pages: usable, projectDir, roles })
    }
  )

  ipcMain.handle('layoutAssets:delete', async (_event, payload: { id?: unknown }) => {
    const id = String(payload?.id || '').trim()
    if (!id) throw new Error('id 不能为空')
    const removed = await deleteLayoutAsset(id)
    if (!removed) throw new Error('版式不存在')
    log.info('[layout-assets] asset deleted', { id })
    return { success: true }
  })

  log.info('[layout-assets] handlers registered')
}
