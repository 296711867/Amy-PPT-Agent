/**
 * 会话事件日志 + Profile IPC 处理器。
 */
import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import type { IpcContext } from '../ipc/context'
import { replaySessionSummary } from '../generation/session-event-log'
import { loadProfile, resolveProfilePath, createDefaultProfileTemplate } from '../config/profile'
import fs from 'fs'

export function registerSessionEventHandlers(ctx: IpcContext): void {
  /** 列出会话的事件流（审计/回放）。 */
  ipcMain.handle(
    'session:listEvents',
    async (_event, payload: { sessionId?: unknown; eventType?: unknown; limit?: unknown }) => {
      const sessionId = String(payload?.sessionId || '').trim()
      if (!sessionId) throw new Error('sessionId 不能为空')
      const limit = Math.min(200, Math.max(1, Number(payload?.limit) || 50))
      const events = await ctx.db.listSessionEvents(sessionId, {
        eventType: typeof payload?.eventType === 'string' ? payload.eventType : undefined,
        limit
      })
      return { events }
    }
  )

  /** 获取会话事件摘要（回放视图）。 */
  ipcMain.handle(
    'session:getEventSummary',
    async (_event, payload: { sessionId?: unknown }) => {
      const sessionId = String(payload?.sessionId || '').trim()
      if (!sessionId) throw new Error('sessionId 不能为空')
      const events = await ctx.db.listSessionEvents(sessionId, { limit: 500 })
      return replaySessionSummary(events)
    }
  )

  /** 获取当前 profile 配置。 */
  ipcMain.handle('app:getProfile', async () => {
    const profile = loadProfile()
    const profilePath = resolveProfilePath()
    const exists = fs.existsSync(profilePath)
    return {
      profilePath,
      exists,
      profile,
      template: exists ? '' : createDefaultProfileTemplate()
    }
  })

  log.info('[session-events] handlers registered')
}
