import log from 'electron-log/main.js'
import { progressText } from '@shared/progress'
import path from 'path'
import fs from 'fs'
import { nanoid } from 'nanoid'
import { validatePersistedPageHtml } from '../presentation/html/html-utils'
import {
  createGenerationPageCallbacks,
  generatePagesWithRetry,
  resolvePageHtmlPath,
  uiText
} from './generation-utils'
import {
  resolveCommonContext,
  resolveSourceDocuments,
  type GenerationContext,
  type RuntimeJobExecutionContext
} from './context'
import type { GenerationModelControl } from './context'
import type { DesignContract } from '@shared/generation'
import type { ModelTimeoutProfile } from '@shared/model-timeout'
import { normalizeLayoutIntent, type LayoutIntent } from '@shared/layout-intent'
import { normalizeUniversalLayoutId, type UniversalLayoutId } from '@shared/universal-layouts'
import { CHART_SKILL_NAME, formatSkillUsageRequirement } from '../product-skills/contract'

// ── Independent RetrySinglePage context ──

export type RetrySinglePageContext = {
  sessionId: string
  runId: string
  pageId: string
  pageNumber: number
  title: string
  contentOutline: string
  layoutIntent: LayoutIntent
  layoutId?: UniversalLayoutId
  imageAssetPath?: string
  imageAssetPaths?: string[]
  htmlPath: string
  provider: string
  apiKey: string
  model: string
  modelConfigId?: string
  modelConfigName?: string
  modelControl: GenerationModelControl
  runModel?: string
  providerBaseUrl: string
  modelTimeouts: Record<ModelTimeoutProfile, number>
  projectDir: string
  abortSignal: AbortSignal
  styleId: string
  styleSkillPrompt: string
  layoutRulesPrompt: string
  styleKey: string
  styleName: string
  styleVersion: string
  slideSize: import('@shared/slide-size').SlideSizePreset
  topic: string
  deckTitle: string
  appLocale: 'zh' | 'en'
  sessionRecord: Record<string, unknown>
  previousSessionStatus: string
  messageScope: 'main' | 'page'
  messagePageId: string
  projectId: string
  effectiveMode: 'retrySinglePage'
  sourceDocumentPaths: string[]
}

export async function resolveRetrySinglePageContext(
  ctx: GenerationContext,
  sessionId: string,
  pageId: string,
  modelConfigId?: string,
  execution?: RuntimeJobExecutionContext
): Promise<RetrySinglePageContext> {
  const { db } = ctx

  log.info('[generate:retrySinglePage] resolving context', { sessionId, pageId })
  const common = await resolveCommonContext(ctx, sessionId, modelConfigId, execution)
  const { sessionRecord } = common
  const sourceDocumentPaths = await resolveSourceDocuments(ctx, {
    sessionId,
    projectDir: common.projectDir,
    // Single-page retry should reproduce the saved deck context, not consume transient edit attachments.
    rawDocPaths: [],
    mode: 'retrySinglePage',
    sessionRecord
  })

  const sessionPages = await db.listSessionPages(sessionId)
  const sessionPage = sessionPages.find((page) => page.file_slug === pageId || page.id === pageId)
  if (!sessionPage) {
    throw new Error(`Page ${pageId} not found in session_pages`)
  }
  const fileSlug = sessionPage.file_slug

  // Read failed page metadata from DB
  const pageSnapshots = await db.listLatestGenerationPageSnapshot(sessionId)
  const pageSnapshot = pageSnapshots.find((p) => p.page_id === fileSlug)

  const pageNumber = sessionPage.page_number
  const title = sessionPage.title || pageSnapshot?.title || `Page ${pageNumber}`
  const contentOutline = pageSnapshot?.content_outline || title
  const layoutIntent = normalizeLayoutIntent(pageSnapshot?.layout_intent)
  const layoutId = normalizeUniversalLayoutId(pageSnapshot?.layout_id)
  const imageAssetPath = pageSnapshot?.image_asset_path || undefined
  const imageAssetPaths = pageSnapshot?.image_asset_paths || undefined
  const htmlPath = resolvePageHtmlPath({
    projectDir: common.projectDir,
    fileSlug,
    candidates: [sessionPage.html_path, pageSnapshot?.html_path]
  })

  log.info('[generate:retrySinglePage] context resolved', {
    sessionId,
    pageId: fileSlug,
    pageNumber,
    projectDir: common.projectDir,
    sourceDocumentCount: sourceDocumentPaths.length
  })

  return {
    ...common,
    sessionId,
    pageId: fileSlug,
    pageNumber,
    title,
    contentOutline,
    layoutIntent,
    layoutId,
    imageAssetPath,
    imageAssetPaths,
    htmlPath,
    sessionRecord,
    messageScope: 'page' as const,
    messagePageId: sessionPage.id,
    effectiveMode: 'retrySinglePage' as const,
    sourceDocumentPaths
  }
}

// ── Execute single page retry ──

export async function executeRetrySinglePageGeneration(
  ctx: GenerationContext,
  context: RetrySinglePageContext
): Promise<void> {
  const {
    db,
    agentManager,
    sessionProject: { getPageSourceUrl },
    runtimeEmitters: { createDeckProgressEmitter },
    tuning: { pageGenerationTemperature: PAGE_GENERATION_TEMPERATURE }
  } = ctx

  if (!context.apiKey) {
    throw new Error(`当前 provider "${context.provider}" 缺少 API Key，请先到设置页配置。`)
  }

  const emitChunk = createDeckProgressEmitter(context.sessionId, context.appLocale)
  const indexPath = path.join(context.projectDir, 'index.html')
  await ctx.history.ensureBaseline(context.sessionId, context.projectDir)

  // Read designContract
  const sessionRecord = context.sessionRecord
  let designContract: DesignContract | undefined
  if (
    typeof sessionRecord.designContract === 'string' &&
    sessionRecord.designContract.trim().length > 0
  ) {
    try {
      designContract = JSON.parse(sessionRecord.designContract) as DesignContract
    } catch {
      // ignore
    }
  }
  if (!designContract) {
    throw new Error('当前会话缺少设计契约，无法重试。')
  }

  // Emit progress
  emitChunk({
    type: 'stage_started',
    payload: {
      runId: context.runId,
      stage: 'rendering',
      label: uiText(
        context.appLocale,
        `正在重新生成第 ${context.pageNumber} 页`,
        `Regenerating page ${context.pageNumber}`
      ),
      progress: 10,
      totalPages: 1
    }
  })

  // Write scaffold before generation
  await fs.promises.writeFile(
    context.htmlPath,
    `<section data-page-scaffold="${context.pageId}" data-page-number="${context.pageNumber}">
<main data-role="content"><p>Regenerating...</p></main>
</section>`,
    'utf-8'
  )

  // Create run + page records
  await db.createGenerationRun({
    id: context.runId,
    sessionId: context.sessionId,
    mode: 'retrySinglePage',
    totalPages: 1,
    modelConfigId: context.modelConfigId,
    metadata: {
      retrySinglePage: true,
      pageId: context.pageId,
      modelConfigId: context.modelConfigId,
      modelConfigName: context.modelConfigName,
      provider: context.provider,
      model: context.model
    }
  })
  await db.upsertGenerationPage({
    runId: context.runId,
    sessionId: context.sessionId,
    pageId: context.pageId,
    pageNumber: context.pageNumber,
    title: context.title,
    contentOutline: context.contentOutline,
    layoutIntent: context.layoutIntent,
    layoutId: context.layoutId,
    imageAssetPath: context.imageAssetPath,
    imageAssetPaths: context.imageAssetPaths,
    htmlPath: context.htmlPath,
    status: 'pending'
  })

  const pageFileMap: Record<string, string> = { [context.pageId]: context.htmlPath }
  const pageNumbers: Record<string, number> = { [context.pageId]: context.pageNumber }
  const pageCallbacks = createGenerationPageCallbacks({
    db,
    runId: context.runId,
    sessionId: context.sessionId
  })
  const generationResult = await generatePagesWithRetry({
    runArgs: {
      appendSessionEvent: (data) =>
        db.appendSessionEvent({ sessionId: context.sessionId, runId: context.runId, ...data }),
      sessionId: context.sessionId,
      provider: context.provider,
      apiKey: context.apiKey,
      model: context.model,
      baseUrl: context.providerBaseUrl,
      modelControl: context.modelControl,
      modelTimeoutMs: context.modelTimeouts.agent,
      temperature: PAGE_GENERATION_TEMPERATURE,
      styleId: context.styleId,
      styleSkillPrompt: context.styleSkillPrompt,
      layoutRulesPrompt: context.layoutRulesPrompt,
      styleKey: context.styleKey,
      styleName: context.styleName,
      styleVersion: context.styleVersion,
      slideSize: context.slideSize,
      appLocale: context.appLocale,
      topic: context.topic,
      deckTitle: context.deckTitle,
      userMessage: `重新生成第 ${context.pageNumber} 页「${context.title}」`,
      outlineTitles: [context.title],
      outlineItems: [
        {
          title: context.title,
          contentOutline: context.contentOutline,
          layoutIntent: context.layoutIntent,
          layoutId: context.layoutId,
          imageAssetPath: context.imageAssetPath,
          imageAssetPaths: context.imageAssetPaths
        }
      ],
      sourceDocumentPaths: context.sourceDocumentPaths,
      generationMode: 'generate',
      renderingLabel: uiText(
        context.appLocale,
        `正在重新生成第 ${context.pageNumber} 页`,
        `Regenerating page ${context.pageNumber}`
      ),
      pageTasks: [
        {
          pageNumber: context.pageNumber,
          pageId: context.pageId,
          title: context.title,
          contentOutline: context.contentOutline,
          layoutIntent: context.layoutIntent,
          layoutId: context.layoutId,
          imageAssetPath: context.imageAssetPath,
          imageAssetPaths: context.imageAssetPaths
        }
      ],
      designContract,
      projectDir: context.projectDir,
      indexPath,
      pageFileMap,
      pageNumbers,
      agentManager,
      emit: (chunk) => emitChunk(chunk),
      ...pageCallbacks,
      runId: context.runId,
      signal: context.abortSignal
    },
    emitChunk,
    appLocale: context.appLocale,
    runId: context.runId,
    totalPages: 1,
    beforeRetry: async () => {
      await fs.promises.writeFile(
        context.htmlPath,
        `<section data-page-scaffold="${context.pageId}" data-page-number="${context.pageNumber}">
<main data-role="content"><p>Retrying...</p></main>
</section>`,
        'utf-8'
      )
    },
    buildRetryRunArgs: (runArgs) => ({
      ...runArgs,
      userMessage: `重新生成第 ${context.pageNumber} 页「${context.title}」。如果需要图表，先 ${formatSkillUsageRequirement(CHART_SKILL_NAME)}`
    })
  })

  // Validate generated page
  if (!fs.existsSync(context.htmlPath)) {
    throw new Error(`${context.pageId}.html 缺失`)
  }
  const newHtml = await fs.promises.readFile(context.htmlPath, 'utf-8')
  const validation = validatePersistedPageHtml(newHtml, context.pageId)
  if (!validation.valid) {
    throw new Error(`重试页面 HTML 验证失败: ${validation.errors.join('; ')}`)
  }

  // Read actual generated title from DB (LLM may change it during retry)
  const runPages = await db.listGenerationPages(context.runId)
  const latestPageRecord = runPages.find((p) => p.page_id === context.pageId)
  const actualTitle = latestPageRecord?.title || context.title
  const existingSessionPages = await db.listSessionPages(context.sessionId, {
    includeDeleted: true
  })
  const existingBySlug = new Map(existingSessionPages.map((sp) => [sp.file_slug, sp]))
  const currentSessionPage = existingBySlug.get(context.pageId)
  await db.upsertSessionPage({
    id: currentSessionPage?.id || nanoid(),
    sessionId: context.sessionId,
    legacyPageId:
      currentSessionPage?.legacy_page_id ||
      (context.pageId.match(/^page-\d+$/) ? context.pageId : null),
    fileSlug: context.pageId,
    pageNumber: context.pageNumber,
    title: actualTitle,
    htmlPath: context.htmlPath,
    status: 'completed',
    error: null
  })
  const updatedSessionPages = existingSessionPages
    .filter((page) => !page.deleted_at)
    .map((page) =>
      page.file_slug === context.pageId
        ? {
            ...page,
            title: actualTitle,
            html_path: context.htmlPath,
            status: 'completed',
            error: null
          }
        : page
    )
    .sort((a, b) => a.page_number - b.page_number)

  // Emit page_updated event
  emitChunk({
    type: 'page_updated',
    payload: {
      runId: context.runId,
      stage: 'rendering',
      label: progressText(context.appLocale, 'completed'),
      progress: 95,
      currentPage: context.pageNumber,
      totalPages: updatedSessionPages.length,
      id: context.messagePageId,
      pageNumber: context.pageNumber,
      title: actualTitle,
      pageId: context.pageId,
      htmlPath: context.htmlPath,
      html: newHtml,
      sourceUrl: getPageSourceUrl(context.htmlPath)
    }
  })

  const assistantContent =
    generationResult.summary.trim() ||
    uiText(
      context.appLocale,
      `第 ${context.pageNumber} 页已重新生成。`,
      `Page ${context.pageNumber} has been regenerated.`
    )
  const assistantMessageId = await db.addMessage(context.sessionId, {
    role: 'assistant',
    content: assistantContent,
    type: 'text',
    chat_scope: context.messageScope,
    page_id: context.messagePageId,
    run_model: context.runModel
  })
  emitChunk({
    type: 'assistant_message',
    payload: {
      id: assistantMessageId,
      runId: context.runId,
      content: assistantContent,
      chatType: context.messageScope,
      pageId: context.messagePageId
    }
  })

  // Finalize — update metadata and project status, but only mark session 'completed'
  // if there are no remaining failed pages.
  await db.updateSessionMetadata(context.sessionId, {
    lastRunId: context.runId,
    entryMode: 'multi_page',
    indexPath,
    projectId: context.projectId
  })
  await db.updateProjectStatus(context.projectId, 'draft')

  // Check if there are still failed pages in the session
  const remainingSessionPages = await db.listSessionPages(context.sessionId)
  const hasFailedPages = remainingSessionPages.some((page) => page.status !== 'completed')
  // If other pages are still failed, session must NOT be 'completed'
  const targetStatus = hasFailedPages ? 'failed' : 'completed'

  await db.updateSessionStatus(context.sessionId, targetStatus)
  await ctx.history.recordOperation({
    sessionId: context.sessionId,
    projectDir: context.projectDir,
    type: 'retry',
    scope: 'page',
    prompt: `重新生成第 ${context.pageNumber} 页「${context.title}」`,
    metadata: {
      runId: context.runId,
      pageId: context.pageId
    }
  })

  log.info('[generate:retrySinglePage] completed', {
    sessionId: context.sessionId,
    pageId: context.pageId,
    hasFailedPages,
    targetStatus
  })

  emitChunk({
    type: 'run_completed',
    payload: {
      runId: context.runId,
      totalPages: updatedSessionPages.length
    }
  })
}
