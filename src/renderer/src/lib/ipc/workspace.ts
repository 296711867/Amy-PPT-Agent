/** 工作台域 IPC：素材、参考文档，PPTX 导入，版式库，页面版式控制，会话事件，导出。 */
import { getIpc } from "./core"
import type { ExportDeckResult, UploadAssetsPayload } from "./types"
import type {
  ParseDocumentPlanPayload,
  ParseImageReferencePayload,
  ParsedDocumentPlanResult,
  PrepareReferenceDocumentPayload,
  PreparedReferenceDocumentResult,
  PptxImportPayload,
  PptxImportResult,
  UploadedAsset
} from "@shared/generation.js"
import type { ExportCapabilities } from "@shared/export-capabilities.js"
import type { ExportProgressPayload } from "@shared/export-progress.js"
export const workspaceIpc = {
  uploadAssets: (payload: UploadAssetsPayload) =>
    getIpc().invoke('assets:upload', payload) as Promise<{ assets: UploadedAsset[] }>,
  prepareReferenceDocument: (payload: PrepareReferenceDocumentPayload) =>
    getIpc().invoke(
      'documents:prepareReference',
      payload
    ) as Promise<PreparedReferenceDocumentResult>,
  parseImageReferenceDocument: (payload: ParseImageReferencePayload) =>
    getIpc().invoke(
      'documents:parseImageReference',
      payload
    ) as Promise<PreparedReferenceDocumentResult>,
  parseDocumentPlan: (payload: ParseDocumentPlanPayload) =>
    getIpc().invoke('documents:parsePlan', payload) as Promise<ParsedDocumentPlanResult>,
  importPptx: (payload: PptxImportPayload) =>
    getIpc().invoke('pptx:import', payload) as Promise<PptxImportResult>,
  layoutAssetsList: () =>
    getIpc().invoke('layoutAssets:list') as Promise<{
      libraryPath: string
      assets: Array<{
        id: string
        title: string
        roles: string[]
        source: 'template' | 'mined' | 'authored'
        slideSizeId: string
        slotSummary: { title: boolean; lists: number; media: number; texts: number }
        capacity: {
          titleMaxChars: number
          moduleMin: number
          moduleMax: number
          mediaSlots: number
          hasChart: boolean
        }
        origin: { sessionId?: string; pageId?: string; importedAt?: number }
      }>
    }>,
  layoutAssetsImportFromSession: (sessionId: string) =>
    getIpc().invoke('layoutAssets:importFromSession', { sessionId }) as Promise<{
      imported: number
      skipped: number
      duplicated: number
      reason?: string
    }>,
  layoutAssetsDelete: (id: string) =>
    getIpc().invoke('layoutAssets:delete', { id }) as Promise<{ success: boolean }>,
  getLayoutControls: (sessionId: string, pageId: string) =>
    getIpc().invoke('pages:getLayoutControls', { sessionId, pageId }) as Promise<{
      layoutAssetId: string
      moduleRange: { min: number; max: number } | null
      currentModuleCount: number
      canAdjust: boolean
      currentPalette: string
      palettes: Array<{ id: string; label: string }>
      listItems: string[]
      alternativeLayouts: Array<{ id: string; title: string; roles: string[] }>
    } | null>,
  adjustModuleCount: (sessionId: string, pageId: string, moduleCount: number) =>
    getIpc().invoke('pages:adjustModuleCount', { sessionId, pageId, moduleCount }) as Promise<{
      success: boolean
      moduleCount: number
      htmlPath: string
    }>,
  switchPalette: (sessionId: string, pageId: string, palette: string) =>
    getIpc().invoke('pages:switchPalette', { sessionId, pageId, palette }) as Promise<{
      success: boolean
      palette: string
      htmlPath: string
    }>,
  reorderFocus: (sessionId: string, pageId: string, focusIndex: number) =>
    getIpc().invoke('pages:reorderFocus', { sessionId, pageId, focusIndex }) as Promise<{
      success: boolean
      focusIndex: number
      htmlPath: string
    }>,
  switchLayout: (sessionId: string, pageId: string, layoutAssetId: string) =>
    getIpc().invoke('pages:switchLayout', { sessionId, pageId, layoutAssetId }) as Promise<{
      success: boolean
      layoutAssetId: string
      htmlPath: string
    }>,
  listSessionEvents: (sessionId: string, options?: { eventType?: string; limit?: number }) =>
    getIpc().invoke('session:listEvents', { sessionId, ...options }) as Promise<{
      events: Array<{
        id: number
        sessionId: string
        runId: string | null
        sequence: number
        eventType: string
        payload: Record<string, unknown>
        actor: string
        createdAt: number
      }>
    }>,
  getSessionEventSummary: (sessionId: string) =>
    getIpc().invoke('session:getEventSummary', { sessionId }) as Promise<{
      totalRuns: number
      totalGenerations: number
      totalAdjustments: number
      totalEdits: number
      totalFailures: number
      lastEventType: string | null
      timeline: Array<{
        sequence: number
        eventType: string
        actor: string
        summary: string
        createdAt: number
      }>
    }>,
  getProfile: () =>
    getIpc().invoke('app:getProfile') as Promise<{
      profilePath: string
      exists: boolean
      profile: Record<string, unknown>
      template: string
    }>,
  chooseAndUploadAssets: (sessionId: string, assetType: 'image' | 'video' = 'image') =>
    getIpc().invoke('assets:chooseAndUpload', { sessionId, assetType }) as Promise<{
      assets: UploadedAsset[]
      cancelled?: boolean
    }>,
  listAssets: (sessionId: string, assetType: 'image' | 'video') =>
    getIpc().invoke('assets:list', { sessionId, assetType }) as Promise<{
      assets: Array<{ fileName: string; relativePath: string; absolutePath: string }>
    }>,
  exportPdf: (sessionId: string) =>
    getIpc().invoke('export:pdf', { sessionId }) as Promise<ExportDeckResult>,
  exportPng: (sessionId: string) =>
    getIpc().invoke('export:png', { sessionId }) as Promise<ExportDeckResult>,
  exportLongImage: (sessionId: string) =>
    getIpc().invoke('export:longImage', { sessionId }) as Promise<ExportDeckResult>,
  getExportCapabilities: () =>
    getIpc().invoke('export:capabilities') as Promise<ExportCapabilities>,
  exportVideo: (sessionId: string, options?: { pageId?: string }) =>
    getIpc().invoke('export:video', { sessionId, ...options }) as Promise<ExportDeckResult>,
  exportPptx: (
    sessionId: string,
    options?: {
      imageOnly?: boolean
      embedFonts?: boolean | 'auto' | 'always' | 'never'
      pageId?: string
    }
  ) => getIpc().invoke('export:pptx', { sessionId, ...options }) as Promise<ExportDeckResult>,
  exportSlidePack: (sessionId: string) =>
    getIpc().invoke('export:slidePack', { sessionId }) as Promise<ExportDeckResult>,
  exportSessionZip: (sessionId: string) =>
    getIpc().invoke('export:sessionZip', { sessionId }) as Promise<ExportDeckResult>,
  exportOutlinesMarkdown: (sessionId: string) =>
    getIpc().invoke('export:outlinesMarkdown', { sessionId }) as Promise<ExportDeckResult>,
  onExportProgress: (callback: (payload: ExportProgressPayload) => void): (() => void) => {
    const channel = 'export:progress'
    const handler = (_event: unknown, payload: unknown): void =>
      callback(payload as ExportProgressPayload)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
}
