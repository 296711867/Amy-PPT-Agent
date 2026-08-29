/** 系统与事件域 IPC：全局事件监听、应用信息、演示放映、演讲稿、Thinking 工作台。 */
import { getIpc } from "./core"
import type {
  GenerateChunkEvent,
  PptxImportProgressPayload
} from "@shared/generation.js"
import type { UpdateAvailablePayload } from "@shared/app-update.js"
import type { SpeechConfig } from "@shared/speech"
import type {
  ThinkingChatMessage,
  ThinkingChatResult,
  ThinkingPrepareGenerationResult,
  ThinkingStage,
  ThinkingWorkspace,
  ThinkingWorkspaceListItem
} from "@shared/thinking.js"
export const systemIpc = {
  onGenerateChunk: (callback: (chunk: GenerateChunkEvent) => void): (() => void) => {
    const channel = 'generate:chunk'
    const handler = (_event: unknown, chunk: unknown): void => callback(chunk as GenerateChunkEvent)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  onPptxImportProgress: (callback: (payload: PptxImportProgressPayload) => void): (() => void) => {
    const channel = 'pptx:import:progress'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(payload as PptxImportProgressPayload)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  onTemplatePptxImportProgress: (
    callback: (payload: PptxImportProgressPayload) => void
  ): (() => void) => {
    const channel = 'templates:importPptx:progress'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(payload as PptxImportProgressPayload)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  onUpdateAvailable: (callback: (payload: UpdateAvailablePayload) => void): (() => void) => {
    const channel = 'app:update-available'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(payload as UpdateAvailablePayload)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  getAppVersion: () =>
    getIpc().invoke('app:getVersion') as Promise<{
      version: string
    }>,
  reportElectronSmokeReady: () =>
    getIpc().invoke('app:smokeReady') as Promise<{ accepted: boolean }>,
  openPresentation: (payload: { sessionId: string; startIndex?: number }) =>
    getIpc().invoke('presentation:open', payload) as Promise<{ success: boolean }>,
  generateSpeechScript: (sessionId: string, config: SpeechConfig & { currentPageId?: string }) =>
    getIpc().invoke('speech:generateScript', { sessionId, ...config }) as Promise<{
      success: boolean
    }>,
  getSpeechScript: (sessionId: string) =>
    getIpc().invoke('speech:getScript', { sessionId }) as Promise<{
      success: boolean
      script: string | null
    }>,
  openSpeechScriptFile: (sessionId: string) =>
    getIpc().invoke('speech:openScriptFile', { sessionId }) as Promise<{
      success: boolean
      path: string
    }>,
  clearSpeechScript: (sessionId: string) =>
    getIpc().invoke('speech:clearScript', { sessionId }) as Promise<{ success: boolean }>,
  onSpeechProgress: (
    callback: (payload: { sessionId: string; current: number; total: number }) => void
  ): (() => void) => {
    const channel = 'speech:progress'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(payload as { sessionId: string; current: number; total: number })
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },

  thinkingCreateWorkspace: () =>
    getIpc().invoke('thinking:createWorkspace') as Promise<ThinkingWorkspace>,
  thinkingGetWorkspace: (thinkingId: string) =>
    getIpc().invoke('thinking:getWorkspace', thinkingId) as Promise<ThinkingWorkspace>,
  thinkingGetLatestWorkspace: () =>
    getIpc().invoke('thinking:getLatestWorkspace') as Promise<ThinkingWorkspace | null>,
  thinkingListWorkspaces: (payload?: { limit?: number }) =>
    getIpc().invoke('thinking:listWorkspaces', payload || {}) as Promise<
      ThinkingWorkspaceListItem[]
    >,
  thinkingDeleteWorkspace: (thinkingId: string) =>
    getIpc().invoke('thinking:deleteWorkspace', thinkingId) as Promise<{ success: boolean }>,
  thinkingRevealWorkspace: (thinkingId: string) =>
    getIpc().invoke('thinking:revealWorkspace', thinkingId) as Promise<{ success: boolean }>,
  thinkingUpdatePageOutline: (payload: {
    thinkingId: string
    page: import('@shared/thinking').ThinkingPageOutlineUpdate
  }) =>
    getIpc().invoke('thinking:updatePageOutline', payload) as Promise<{
      success: boolean
      thinkingMd: string
    }>,
  thinkingUploadSources: (payload: {
    thinkingId: string
    files: Array<{ path: string; name?: string }>
  }) =>
    getIpc().invoke('thinking:uploadSources', payload) as Promise<{
      sources: Array<{ id: string; name: string; kind: string }>
    }>,
  thinkingRemoveSource: (payload: { thinkingId: string; sourceId: string }) =>
    getIpc().invoke('thinking:removeSource', payload) as Promise<{
      success: boolean
      removed: boolean
    }>,
  thinkingChat: (payload: {
    thinkingId: string
    modelConfigId?: string
    userMessage: string
    recentMessages?: ThinkingChatMessage[]
    attachments?: ThinkingChatMessage['attachments']
  }) => getIpc().invoke('thinking:chat', payload) as Promise<ThinkingChatResult>,
  thinkingPrepareGeneration: (payload: { thinkingId: string }) =>
    getIpc().invoke(
      'thinking:prepareGeneration',
      payload
    ) as Promise<ThinkingPrepareGenerationResult>,
  onThinkingStreamThinking: (
    callback: (payload: {
      thinkingId: string
      id?: string
      type: string
      toolName: string
      summary: string
    }) => void
  ): (() => void) => {
    const channel = 'thinking:stream:thinking'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(
        payload as {
          thinkingId: string
          id?: string
          type: string
          toolName: string
          summary: string
        }
      )
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  onThinkingStreamEnd: (
    callback: (payload: {
      thinkingId: string
      reply: string
      thinkingMd: string
      contextMd: string
      stage: ThinkingStage
    }) => void
  ): (() => void) => {
    const channel = 'thinking:stream:end'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(
        payload as {
          thinkingId: string
          reply: string
          thinkingMd: string
          contextMd: string
          stage: ThinkingStage
        }
      )
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  }
}
