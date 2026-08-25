import { BrowserWindow } from 'electron'
import type { PPTDatabase } from '../db/database'
import type { AgentManager } from '../agent-runtime/agent'
import { createIpcContext } from './context'
import { registerSessionHandlers } from '../session/handlers'
import { registerSessionImportHandlers } from '../session/import-handlers'
import { registerSessionSaveAsNewHandler } from '../session/save-as-new'
import { registerAssetHandlers, registerLocalAssetProtocol } from '../io/assets-handlers'
import { registerThumbnailHandlers } from '../io/thumbnails/handlers'
import { registerGenerationHandlers } from '../generation/handlers'
import { createGenerationContext } from '../generation/context'
import { registerExportHandlers } from '../io/export-handlers'
import { registerStyleHandlers } from '../styles/handlers'
import { registerStylePreviewHandlers } from '../styles/preview/handlers'
import { registerFontHandlers } from '../presentation/fonts/handlers'
import { registerSettingsHandlers } from '../config/settings-handlers'
import { registerImageModelHandlers } from '../config/image-model-handlers'
import { registerPreviewHandlers } from '../session/preview-handlers'
import { registerPageManagementHandlers } from '../session/page-management-handlers'
import { registerPageMergeHandlers } from '../session/page-merge-handlers'
import { registerFileHandlers } from '../io/file-handlers'
import { registerChartDataImportHandlers, registerEditorHandlers } from '../element-editor'
import { registerDocumentParseHandlers } from '../io/document-parse-handlers'
import { registerPptxImportHandlers } from '../io/pptx-import/handlers'
import { registerHistoryHandlers } from '../history/handlers'
import { registerPresentationHandlers } from '../session/presentation-handlers'
import { registerSpeechHandlers } from '../speech/handlers'
import { registerThinkingHandlers } from './thinking/thinking-handlers'
import { registerTemplateHandlers } from '../templates/template-handlers'
import { registerImageGenerationHandlers } from '../image-generation/handlers'
import { registerImageGenerationHistoryHandlers } from '../image-generation/handlers-history'
import { registerHtmlEditorHandlers } from '../html-editor/html-editor-handlers'
import { registerHtmlEditorAiHandlers } from '../html-editor/html-editor-ai-handlers'
import { JobCoordinator, TypedEventBus } from '../agent-runtime'
import { RuntimeEventBridge } from './runtime/event-bridge'
import { translateLegacyRuntimeEvent } from './runtime/event-contract'
import { DbModelUsageRecorder } from './runtime/model-usage-recorder'
import { registerDeckEditJobHandlers } from '../edit-jobs/deck-edit-job-service'
import { registerPageEditJobHandlers } from '../edit-jobs/page-edit-job-service'
import { registerPageBeautifyJobHandlers } from '../edit-jobs/page-beautify-job-service'
import { registerStyleSwitchJobHandlers } from '../edit-jobs/style-switch-job-service'
import { registerMasterHandlers } from '../session/master-handlers'
import { registerLayoutAssetHandlers } from '../layout-assets/handlers'
import { registerLayoutControlHandlers } from '../generation/layout-controls'
import { registerSessionEventHandlers } from '../generation/session-event-handlers'

export { registerLocalAssetProtocol }

export function setupIPC(
  mainWindow: BrowserWindow,
  db: PPTDatabase,
  agentManager: AgentManager
): void {
  const runtimeEvents = new TypedEventBus({
    onListenerError: (error, event) => {
      console.warn('[runtime:event] listener failed', {
        type: event.type,
        jobId: event.jobId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
  const runtimeEventBridge = new RuntimeEventBridge(runtimeEvents)
  runtimeEventBridge.registerWindowBroadcast({
    subscriberId: 'legacy-generate-chunk-broadcast',
    windows: () => BrowserWindow.getAllWindows(),
    translate: translateLegacyRuntimeEvent,
    onSendError: ({ windowId, error }) => {
      console.warn('[generate:chunk] send failed', {
        windowId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
  const context = createIpcContext(mainWindow, db, agentManager, runtimeEvents, {
    recorder: new DbModelUsageRecorder(db)
  })
  const jobCoordinator = new JobCoordinator()
  const generationContext = createGenerationContext(context)

  registerSessionHandlers(context, {
    suspendSessionWork: (sessionId) =>
      jobCoordinator.suspendOwners([
        { kind: 'session', id: sessionId },
        { kind: 'image-history', id: sessionId }
      ])
  })
  registerSessionSaveAsNewHandler(context)
  registerSessionImportHandlers(context)
  registerMasterHandlers(context)
  registerPageManagementHandlers(context, jobCoordinator)
  registerPageMergeHandlers(context)
  registerAssetHandlers(context)
  registerThumbnailHandlers(context)
  const pageEditJobs = registerPageEditJobHandlers(context, jobCoordinator)
  registerPageBeautifyJobHandlers(context, jobCoordinator)
  const deckEditJobs = registerDeckEditJobHandlers(context, jobCoordinator)
  const styleSwitchJobs = registerStyleSwitchJobHandlers(context, jobCoordinator)
  registerGenerationHandlers(
    generationContext,
    jobCoordinator,
    styleSwitchJobs,
    pageEditJobs,
    deckEditJobs
  )
  registerExportHandlers(context)
  registerStyleHandlers(context)
  registerStylePreviewHandlers(context)
  registerFontHandlers()
  registerSettingsHandlers(context)
  registerImageModelHandlers(context)
  registerPreviewHandlers(context)
  registerFileHandlers(context)
  registerEditorHandlers(context)
  registerChartDataImportHandlers(context)
  registerDocumentParseHandlers(context)
  registerPptxImportHandlers(context)
  registerLayoutAssetHandlers(context)
  registerLayoutControlHandlers(context)
  registerSessionEventHandlers(context)
  registerHistoryHandlers(context)
  registerPresentationHandlers(context)
  registerSpeechHandlers(context)
  registerThinkingHandlers(context)
  registerTemplateHandlers(context)
  registerImageGenerationHandlers(context, jobCoordinator, runtimeEvents)
  registerImageGenerationHistoryHandlers(context)
  registerHtmlEditorHandlers(context)
  registerHtmlEditorAiHandlers(context)
}
