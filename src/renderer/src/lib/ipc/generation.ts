/** 生成与改写域 IPC：deck/单页生成、整页/美化/deck 编辑、风格切换、重试、历史。 */
import { getIpc } from "./core"
import type { GenerateRunStateSnapshot, StyleSwitchJobSnapshot } from "./types"
import type {
  GenerateAddPagePayload,
  GenerateRetryFailedPayload,
  GenerateRetrySinglePagePayload,
  GenerateStartPayload,
  RetryDeckEditPayload,
  RetrySessionStylePayload,
  SessionPageEditAssessment,
  SwitchSessionStylePayload
} from "@shared/generation.js"
import type { HistoryVersion, RollbackHistoryResult } from "@shared/history.js"
export const generationIpc = {
  startGenerate: (payload: GenerateStartPayload) =>
    getIpc().invoke('generate:start', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      queued?: boolean
    }>,
  assessPageEdit: (payload: GenerateStartPayload) =>
    getIpc().invoke('page-edit:assess', payload) as Promise<
      SessionPageEditAssessment & {
        reply: string
        targetPageId: string
        targetPageNumber?: number
      }
    >,
  startPageEdit: (payload: GenerateStartPayload) =>
    getIpc().invoke('page-edit:start', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
    }>,
  getPageEditState: (sessionId: string) =>
    getIpc().invoke('page-edit:state', sessionId) as Promise<GenerateRunStateSnapshot>,
  listActivePageEditRuns: () =>
    getIpc().invoke('page-edit:listActive') as Promise<GenerateRunStateSnapshot[]>,
  cancelPageEdit: (sessionId: string) =>
    getIpc().invoke('page-edit:cancel', sessionId) as Promise<{ success: boolean }>,
  startPageBeautify: (payload: {
    sessionId: string
    selectedPageId: string
    modelConfigId?: string
    layoutAudit?: string
  }) =>
    getIpc().invoke('page-beautify:start', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
    }>,
  getPageBeautifyState: (sessionId: string) =>
    getIpc().invoke('page-beautify:state', sessionId) as Promise<GenerateRunStateSnapshot>,
  listActivePageBeautifyRuns: () =>
    getIpc().invoke('page-beautify:listActive') as Promise<GenerateRunStateSnapshot[]>,
  cancelPageBeautify: (sessionId: string) =>
    getIpc().invoke('page-beautify:cancel', sessionId) as Promise<{ success: boolean }>,
  startDeckEdit: (payload: GenerateStartPayload) =>
    getIpc().invoke('deck-edit:start', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
    }>,
  getDeckEditState: (sessionId: string) =>
    getIpc().invoke('deck-edit:state', sessionId) as Promise<GenerateRunStateSnapshot>,
  listActiveDeckEditRuns: () =>
    getIpc().invoke('deck-edit:listActive') as Promise<GenerateRunStateSnapshot[]>,
  cancelDeckEdit: (sessionId: string) =>
    getIpc().invoke('deck-edit:cancel', sessionId) as Promise<{ success: boolean }>,
  startStyleSwitch: (payload: SwitchSessionStylePayload) =>
    getIpc().invoke('style-switch:start', payload) as Promise<{
      success: boolean
      runId?: string
      styleId: string
      unchanged?: boolean
      alreadyRunning?: boolean
    }>,
  retryStyleSwitchPage: (payload: {
    sessionId: string
    failedRunId?: string
    pageId: string
    modelConfigId?: string
  }) =>
    getIpc().invoke('style-switch:retryPage', payload) as Promise<{
      success: boolean
      runId?: string
      styleId: string
      alreadyRunning?: boolean
    }>,
  retryFailedStyleSwitchPages: (payload: RetrySessionStylePayload) =>
    getIpc().invoke('style-switch:retryFailed', payload) as Promise<{
      success: boolean
      runId?: string
      styleId: string
      alreadyRunning?: boolean
      failedPageCount: number
    }>,
  getStyleSwitchState: (sessionId: string) =>
    getIpc().invoke('style-switch:state', sessionId) as Promise<StyleSwitchJobSnapshot>,
  listActiveStyleSwitchRuns: () =>
    getIpc().invoke('style-switch:listActive') as Promise<StyleSwitchJobSnapshot[]>,
  cancelStyleSwitch: (sessionId: string) =>
    getIpc().invoke('style-switch:cancel', sessionId) as Promise<{ success: boolean }>,
  switchSessionStyle: (payload: SwitchSessionStylePayload) =>
    getIpc().invoke('style-switch:start', payload) as Promise<{
      success: boolean
      runId?: string
      styleId: string
      unchanged?: boolean
      alreadyRunning?: boolean
      failedPageCount?: number
    }>,
  retrySessionStyle: (payload: RetrySessionStylePayload) =>
    getIpc().invoke('style-switch:retryFailed', payload) as Promise<{
      success: boolean
      runId?: string
      styleId: string
      alreadyRunning?: boolean
      failedPageCount: number
    }>,
  retryDeckEdit: (payload: RetryDeckEditPayload) =>
    getIpc().invoke('generate:retryDeckEdit', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      failedPageCount: number
    }>,
  startTemplateGenerate: (payload: GenerateStartPayload & { retry?: boolean }) =>
    getIpc().invoke('generate:startTemplate', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      queued?: boolean
    }>,
  retryFailedPages: (payload: GenerateRetryFailedPayload) =>
    getIpc().invoke('generate:retryFailedPages', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      queued?: boolean
    }>,
  addPage: (payload: GenerateAddPagePayload) =>
    getIpc().invoke('generate:addPage', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      queued?: boolean
    }>,
  retrySinglePage: (payload: GenerateRetrySinglePagePayload) =>
    getIpc().invoke('generate:retrySinglePage', payload) as Promise<{
      success: boolean
      runId?: string
      alreadyRunning?: boolean
      queued?: boolean
    }>,
  getGenerateState: (sessionId: string) =>
    getIpc().invoke('generate:state', sessionId) as Promise<GenerateRunStateSnapshot>,
  listActiveGenerateRuns: () =>
    getIpc().invoke('generate:listActive') as Promise<GenerateRunStateSnapshot[]>,
  cancelGenerate: (sessionId: string) =>
    getIpc().invoke('generate:cancel', sessionId) as Promise<{ success: boolean }>,
  listHistoryVersions: (payload: { sessionId: string; limit?: number }) =>
    getIpc().invoke('history:listVersions', payload) as Promise<HistoryVersion[]>,
  rollbackToHistoryVersion: (payload: { sessionId: string; versionId: string }) =>
    getIpc().invoke('history:rollbackToVersion', payload) as Promise<RollbackHistoryResult>,
  recordHistorySnapshot: (payload: {
    sessionId: string
    type?: 'generate' | 'edit' | 'addPage' | 'retry' | 'import' | 'rollback' | 'reorder' | 'delete'
    scope?: 'session' | 'deck' | 'page' | 'selector' | 'shell'
    prompt?: string
    metadata?: Record<string, unknown>
  }) => getIpc().invoke('history:recordSnapshot', payload) as Promise<unknown>,
}
