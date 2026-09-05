/** 会话与文档域 IPC：会话 CRUD/合并/母版/页面操作、HTML 编辑器、模板。 */
import { getIpc } from "./core"
import type {
  CreateSessionPayload,
  SaveSessionAsNewPayload,
  SaveSessionAsNewResult,
  MergeSourceSessionSummary,
  MergeTemplateSourceSummary,
  MergeSourcePageSummary,
  ImportSessionFileResult,
  HtmlEditorFileImportResult,
  HtmlEditorAiElementContext,
  HtmlEditorAiMessage,
  HtmlEditorAiPlan,
  HtmlEditorAiIntent,
  HtmlEditorAiHistoryMessage,
  TemplateListItem
} from "./types"
import type { SessionMasterConfig, SessionMasterStatus } from "@shared/master"
import type { SessionLayoutLibrary, SessionLayoutLibraryStatus } from "@shared/layout-master"
import type { IndexTransitionConfig, IndexTransitionType } from "@shared/index-transition.js"
import type { SourceDocumentPlan } from "@shared/generation.js"
export const sessionDocIpc = {
  createSession: (payload: CreateSessionPayload) =>
    getIpc().invoke('session:create', payload) as Promise<{ sessionId: string }>,
  listSessions: () => getIpc().invoke('session:list') as Promise<unknown[]>,
  listMergeSourceSessions: (payload: { targetSessionId: string }) =>
    getIpc().invoke('session:listMergeSources', payload) as Promise<MergeSourceSessionSummary[]>,
  listMergeSourcePages: (payload: { targetSessionId: string; sourceSessionId: string }) =>
    getIpc().invoke('session:listMergeSourcePages', payload) as Promise<MergeSourcePageSummary[]>,
  mergeSessionPages: (payload: {
    targetSessionId: string
    sourceSessionId: string
    sourcePageIds: string[]
  }) =>
    getIpc().invoke('session:mergePages', payload) as Promise<{
      ok: true
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath: string
        sourceUrl?: string
        status?: string
        error?: string | null
      }>
      insertedPageIds: string[]
      selectedPageId: string
    }>,
  listMergeSourceTemplates: (payload: { targetSessionId: string }) =>
    getIpc().invoke('session:listMergeSourceTemplates', payload) as Promise<
      MergeTemplateSourceSummary[]
    >,
  listMergeSourceTemplatePages: (payload: { targetSessionId: string; templateId: string }) =>
    getIpc().invoke('session:listMergeSourcePages', {
      targetSessionId: payload.targetSessionId,
      sourceType: 'template',
      templateId: payload.templateId
    }) as Promise<MergeSourcePageSummary[]>,
  mergeTemplatePages: (payload: {
    targetSessionId: string
    templateId: string
    sourcePageIds: string[]
  }) =>
    getIpc().invoke('session:mergePages', {
      targetSessionId: payload.targetSessionId,
      sourceType: 'template',
      templateId: payload.templateId,
      sourcePageIds: payload.sourcePageIds
    }) as Promise<{
      ok: true
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath: string
        sourceUrl?: string
        status?: string
        error?: string | null
      }>
      insertedPageIds: string[]
      selectedPageId: string
    }>,
  saveSessionAsNew: (payload: SaveSessionAsNewPayload): Promise<SaveSessionAsNewResult> =>
    getIpc().invoke('session:saveAsNew', payload) as Promise<SaveSessionAsNewResult>,
  getSessionMaster: (payload: { sessionId: string }): Promise<SessionMasterStatus> =>
    getIpc().invoke('session:getMaster', payload) as Promise<SessionMasterStatus>,
  saveSessionMaster: (payload: {
    sessionId: string
    config: SessionMasterConfig
  }): Promise<SessionMasterStatus> =>
    getIpc().invoke('session:saveMaster', payload) as Promise<SessionMasterStatus>,
  setSessionMasterPageOverride: (payload: {
    sessionId: string
    pageId: string
    disabled: boolean
  }): Promise<{ disabled: boolean }> =>
    getIpc().invoke('session:setMasterPageOverride', payload) as Promise<{ disabled: boolean }>,
  getSessionLayoutLibrary: (payload: { sessionId: string }): Promise<SessionLayoutLibraryStatus> =>
    getIpc().invoke('session:getLayoutLibrary', payload) as Promise<SessionLayoutLibraryStatus>,
  saveSessionLayoutLibrary: (payload: {
    sessionId: string
    library: SessionLayoutLibrary
  }): Promise<SessionLayoutLibraryStatus> =>
    getIpc().invoke('session:saveLayoutLibrary', payload) as Promise<SessionLayoutLibraryStatus>,
  getSession: (sessionId: string) =>
    getIpc().invoke('session:get', sessionId) as Promise<{
      session: unknown
      messages: unknown[]
      generatedPages: Array<{
        id: string
        pageNumber: number
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        pageId?: string
        sourceUrl?: string
        status?: string
        error?: string | null
      }>
    }>,
  getIndexTransition: (sessionId: string) =>
    getIpc().invoke('session:getIndexTransition', { sessionId }) as Promise<IndexTransitionConfig>,
  setIndexTransition: (payload: {
    sessionId: string
    type: IndexTransitionType
    durationMs?: number
  }) =>
    getIpc().invoke('session:setIndexTransition', payload) as Promise<{
      ok: boolean
      transition: IndexTransitionConfig
    }>,
  migratePageOutlinesToSourceSkeletons: (payload: { sessionId: string }) =>
    getIpc().invoke('session:migratePageOutlinesToSourceSkeletons', payload) as Promise<{
      migrated: boolean
      migratedCount: number
      existingCount: number
    }>,
  reorderSessionPages: (payload: {
    sessionId: string
    orderedPageIds: string[]
    selectedPageId?: string
  }) =>
    getIpc().invoke('session:reorderPages', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  deleteSessionPages: (payload: {
    sessionId: string
    pageIds: string[]
    selectedPageId?: string
  }) =>
    getIpc().invoke('session:deletePages', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  createBlankSessionPage: (payload: { sessionId: string; sourcePageId: string }) =>
    getIpc().invoke('session:createBlankPage', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  duplicateSessionPage: (payload: { sessionId: string; sourcePageId: string }) =>
    getIpc().invoke('session:duplicatePage', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  updateSessionPageTitle: (payload: { sessionId: string; pageId: string; title: string }) =>
    getIpc().invoke('session:updatePageTitle', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  updateSessionPageOutline: (payload: {
    sessionId: string
    pageId: string
    contentOutline: string
  }) =>
    getIpc().invoke('session:updatePageOutline', payload) as Promise<{
      ok: boolean
      generatedPages: Array<{
        id: string
        pageNumber: number
        pageId: string
        title: string
        contentOutline?: string | null
        html: string
        htmlPath?: string
        status?: string
        error?: string | null
      }>
      selectedPageId: string | null
    }>,
  getSessionMessages: (payload: {
    sessionId: string
    chatType: 'main' | 'page'
    pageId?: string
  }) => getIpc().invoke('session:getMessages', payload) as Promise<unknown[]>,
  deleteSession: (sessionId: string) =>
    getIpc().invoke('session:delete', sessionId) as Promise<{ success: boolean }>,
  updateSessionTitle: (payload: { sessionId: string; title: string }) =>
    getIpc().invoke('session:updateTitle', payload) as Promise<{ ok: boolean }>,
  importSessionFile: () =>
    getIpc().invoke('session:importFile') as Promise<ImportSessionFileResult>,
  importHtmlFile: () =>
    getIpc().invoke('html-editor:import') as Promise<HtmlEditorFileImportResult>,
  listHtmlEditorMedia: (payload: { docId: string; mediaType: 'image' | 'video' }) =>
    getIpc().invoke('html-editor:listMedia', payload) as Promise<{
      assets: Array<{ fileName: string; filePath: string; relativePath: string; url: string }>
    }>,
  chooseAndImportHtmlMedia: (payload: { docId: string; mediaType: 'image' | 'video' }) =>
    getIpc().invoke('html-editor:chooseAndImportMedia', payload) as Promise<
      | { cancelled: true }
      | { cancelled: false; filePath: string; relativePath: string; url: string }
    >,
  ensureHtmlAnchor: (payload: {
    html: string
    pageId: string
    selector: string
    elementTag?: string
    formula?: { latex?: unknown; html?: unknown; displayMode?: unknown }
  }) =>
    getIpc().invoke('html-editor:ensureAnchor', payload) as Promise<{
      html: string
      selector: string
      blockId: string
      changed: boolean
    }>,
  applyHtmlEdits: (payload: {
    html: string
    pageId: string
    dragEdits?: unknown[]
    textEdits?: unknown[]
    propertyEdits?: unknown[]
    deletes?: unknown[]
    addElements?: unknown[]
  }) =>
    getIpc().invoke('html-editor:applyEdits', payload) as Promise<{
      html: string
      warnings: string[]
    }>,
  exportHtml: (payload: { html: string; suggestedName?: string }) =>
    getIpc().invoke('html-editor:export', payload) as Promise<
      { cancelled: true } | { cancelled: false; path: string }
    >,
  cleanupHtmlEditor: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:cleanup', payload) as Promise<{ ok: boolean }>,
  openHtmlInBrowser: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:openInBrowser', payload) as Promise<{ ok: boolean }>,
  revealHtmlFile: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:revealFile', payload) as Promise<{ ok: boolean }>,
  listHtmlVersions: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:listVersions', payload) as Promise<{
      versions: Array<{ id: string; commitSha: string; message: string; createdAt: number }>
    }>,
  restoreHtmlVersion: (payload: { docId: string; versionId: string }) =>
    getIpc().invoke('html-editor:restoreVersion', payload) as Promise<{ html: string }>,
  listHtmlDocuments: () =>
    getIpc().invoke('html-editor:listDocuments') as Promise<{
      documents: Array<{
        id: string
        title: string
        sourcePath: string | null
        htmlPath: string
        designWidth: number
        updatedAt: number
        thumbnailPath: string | null
      }>
    }>,
  openHtmlDocument: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:openDocument', payload) as Promise<HtmlEditorFileImportResult>,
  htmlEditorAiChat: (payload: {
    documentId: string
    documentTitle?: string
    pageHtml?: string
    selectedElement?: HtmlEditorAiElementContext
    recentMessages?: HtmlEditorAiMessage[]
    pendingPlan?: HtmlEditorAiPlan
    userMessage: string
    modelConfigId?: string
  }) =>
    getIpc().invoke('html-editor:aiChat', payload) as Promise<{
      reply: string
      model: string
      intent: HtmlEditorAiIntent
      plan: HtmlEditorAiPlan | null
      requiresConfirmation: boolean
      applied: boolean
      appliedHtml?: string
      warnings: string[]
    }>,
  listHtmlEditorMessages: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:listMessages', payload) as Promise<{
      messages: HtmlEditorAiHistoryMessage[]
    }>,
  clearHtmlEditorMessages: (payload: { docId: string }) =>
    getIpc().invoke('html-editor:clearMessages', payload) as Promise<{ ok: boolean }>,
  listTemplates: () => getIpc().invoke('templates:list') as Promise<{ items: TemplateListItem[] }>,
  createTemplateFromSession: (payload: {
    sessionId: string
    name?: string
    description?: string
    tags?: string[]
  }) =>
    getIpc().invoke('templates:createFromSession', payload) as Promise<{
      success: true
      id: string
    }>,
  createSessionFromTemplate: (payload: {
    templateId: string
    title?: string
    modelConfigId?: string
    pageCount?: number
    referenceDocumentPath?: string
    sourcePlan?: SourceDocumentPlan
    initialPrompt?: string
    imagePolicy?: import('@shared/generation').ImagePolicy
  }) =>
    getIpc().invoke('templates:createSession', payload) as Promise<{
      success: true
      sessionId: string
    }>,
  createEditableSessionFromTemplate: (payload: {
    templateId: string
    title?: string
    modelConfigId?: string
  }) =>
    getIpc().invoke('templates:createEditableSession', payload) as Promise<{
      success: true
      sessionId: string
    }>,
  importPptxAsTemplate: (payload: { filePath: string; name?: string; modelConfigId?: string }) =>
    getIpc().invoke('templates:importPptx', payload) as Promise<{
      success: true
      id: string
      pageCount: number
      warnings: string[]
    }>,
  updateTemplateMetadata: (payload: {
    templateId: string
    name: string
    description?: string
    tags?: string[]
  }) =>
    getIpc().invoke('templates:updateMetadata', payload) as Promise<{
      success: true
      item: TemplateListItem
    }>,
  deleteTemplate: (templateId: string) =>
    getIpc().invoke('templates:delete', templateId) as Promise<{
      success: true
      deleted: boolean
    }>,
}
