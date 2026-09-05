import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import { nanoid } from 'nanoid'
import { progressText } from '@shared/progress'
import { normalizeLayoutIntent } from '@shared/layout-intent'
import { normalizeUniversalLayoutId } from '@shared/universal-layouts'
import {
  MAX_SELECTED_PAGES,
  MAX_STYLE_SWITCH_PAGES,
  normalizeVisualFormat,
  type DesignContract,
  type GeneratedPagePayload
} from '@shared/generation'
import type { GenerationContext } from './context'
import type { EditContext, EmitAssistantFn } from './types'
import {
  buildEditNoChangeRetryMessage,
  buildEditToolSchemaRetryMessage,
  buildEditValidationRetryMessage,
  isEditToolSchemaRetryableError,
  isEditValidationRetryableError,
  resolvePageHtmlPath,
  uiText,
  validateChangedPages
} from './generation-utils'
import {
  executeDeckEditBatchFlow,
  type DeckEditBatchResult,
  type DeckEditCompletedBatch,
  type DeckEditFailedBatch
} from './edit-deck-batch-flow'
import { runDeepAgentDeckAllPageEdit } from './agent-runner'
import { resolveRemainingFailedPageInfo } from './edit-deck-failure-state'
import { buildLocalSuccessfulEditSummary, emitSuccessfulEditSummary } from './edit-summary'
import {
  formatDeckQualityFeedback,
  inspectPresentationDeckQuality
} from '../presentation/html/deck-quality-validator'
import {
  findNewNarrativeHardViolations,
  formatDeckNarrativeFeedback,
  inspectPresentationDeckNarrative
} from '../presentation/html/deck-narrative-validator'

export function filterPageRefsBySelectedPageIds<T extends { pageId: string }>(
  pageRefs: T[],
  selectPageIds: string[]
): T[] {
  if (selectPageIds.length === 0) return pageRefs
  const requestedPageIdSet = new Set(selectPageIds)
  return pageRefs.filter((ref) => requestedPageIdSet.has(ref.pageId))
}

export const isDeckEditRateLimitRetryableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return /\b429\b|too many requests|rate.?limit|resource exhausted/i.test(message)
}

export async function executeDeckAllPageEditGeneration(
  ctx: GenerationContext,
  emitAssistant: EmitAssistantFn,
  context: EditContext
): Promise<void> {
  const {
    db,
    agentManager,
    sessionProject: { getPageSourceUrl },
    runtimeEmitters: { createDeckProgressEmitter },
    tuning: { pageEditDefaultTemperature: PAGE_EDIT_DEFAULT_TEMPERATURE }
  } = ctx

  if (!context.apiKey) {
    throw new Error(`当前 provider "${context.provider}" 缺少 API Key，请先到设置页配置。`)
  }
  if (context.messageScope !== 'main') {
    throw new Error('deck 全页编辑只接受主会话消息。')
  }

  const projectDir = context.projectDir
  const indexPath = path.join(projectDir, 'index.html')
  let outlineTitles: string[] = context.userProvidedOutlineTitles
  let pageRefs: Array<{
    id: string
    pageNumber: number
    title: string
    pageId: string
    htmlPath: string
  }> = []
  let savedDesignContract: DesignContract | undefined = context.designContract

  const sessionPages = await db.listSessionPages(context.sessionId)
  if (sessionPages.length === 0) {
    throw new Error('session_pages is empty after migration; cannot edit this session')
  }
  pageRefs = sessionPages.map((page) => ({
    id: page.id,
    pageNumber: page.page_number,
    title: page.title || `第${page.page_number}页`,
    pageId: page.file_slug,
    htmlPath: resolvePageHtmlPath({
      projectDir,
      fileSlug: page.file_slug,
      candidates: [page.html_path]
    })
  }))
  if (outlineTitles.length === 0) {
    outlineTitles = pageRefs.map((page) => page.title)
  }

  const latestPageSnapshot = await db.listLatestGenerationPageSnapshot(context.sessionId)
  const failedPageInfoById = new Map<string, { title: string; reason: string }>()
  for (const page of sessionPages) {
    if (page.status !== 'failed') continue
    failedPageInfoById.set(page.file_slug, {
      title: page.title || page.file_slug,
      reason: page.error || '页面仍需修复'
    })
  }

  const sessionRecord = (context.session || {}) as Record<string, unknown>
  if (
    !savedDesignContract &&
    !context.resetVisualStyle &&
    typeof sessionRecord.designContract === 'string' &&
    sessionRecord.designContract.trim().length > 0
  ) {
    try {
      savedDesignContract = JSON.parse(sessionRecord.designContract) as DesignContract
    } catch {
      /* ignore invalid persisted design contract */
    }
  }

  pageRefs.sort((a, b) => a.pageNumber - b.pageNumber)
  const requestedPageIdSet = new Set(context.selectPageIds || [])
  const selectedPageRefs = filterPageRefsBySelectedPageIds(pageRefs, context.selectPageIds || [])
  if (requestedPageIdSet.size > 0 && selectedPageRefs.length === 0) {
    throw new Error(
      `Selected pages not found in session_pages: ${Array.from(requestedPageIdSet).join(', ')}`
    )
  }
  const pageLimit = context.resetVisualStyle ? MAX_STYLE_SWITCH_PAGES : MAX_SELECTED_PAGES
  if (selectedPageRefs.length > pageLimit) {
    throw new Error(
      uiText(
        context.appLocale,
        `一次最多编辑 ${pageLimit} 页，请先选择更小的页面范围。`,
        `You can edit at most ${pageLimit} pages at a time. Select a smaller page range.`
      )
    )
  }
  if (outlineTitles.length !== pageRefs.length) {
    outlineTitles = pageRefs.map((ref) => ref.title)
  }

  const outlineByPageId = new Map(
    latestPageSnapshot.map((page) => [page.page_id, page.content_outline || ''])
  )
  const layoutIntentByPageId = new Map(
    latestPageSnapshot.map((page) => [
      page.page_id,
      !context.resetVisualStyle && page.layout_intent
        ? normalizeLayoutIntent(page.layout_intent)
        : undefined
    ])
  )
  const layoutIdByPageId = new Map(
    latestPageSnapshot.map((page) => [
      page.page_id,
      !context.resetVisualStyle ? normalizeUniversalLayoutId(page.layout_id) : undefined
    ])
  )
  const visualFormatByPageId = new Map(
    latestPageSnapshot.map((page) => [page.page_id, normalizeVisualFormat(page.visual_format)])
  )
  const audienceMoveByPageId = new Map(
    latestPageSnapshot.map((page) => [page.page_id, page.audience_move || undefined])
  )
  const imageAssetPathByPageId = new Map(
    latestPageSnapshot.map((page) => [page.page_id, page.image_asset_path || undefined])
  )
  const imageAssetPathsByPageId = new Map(
    latestPageSnapshot.map((page) => [page.page_id, page.image_asset_paths || undefined])
  )
  const outlineItems = pageRefs.map((ref) => ({
    title: ref.title,
    contentOutline: outlineByPageId.get(ref.pageId) || '',
    layoutIntent: layoutIntentByPageId.get(ref.pageId),
    visualFormat: visualFormatByPageId.get(ref.pageId),
    audienceMove: audienceMoveByPageId.get(ref.pageId),
    layoutId: layoutIdByPageId.get(ref.pageId),
    imageAssetPath: imageAssetPathByPageId.get(ref.pageId),
    imageAssetPaths: imageAssetPathsByPageId.get(ref.pageId)
  }))
  const pageFileMap = Object.fromEntries(pageRefs.map((p) => [p.pageId, p.htmlPath]))
  const pageNumbers = Object.fromEntries(pageRefs.map((p) => [p.pageId, p.pageNumber]))
  const selectedPageIds = selectedPageRefs.map((p) => p.pageId)
  const existingPageIdsBeforeRun: string[] = []
  const beforeReads = await Promise.all(
    pageRefs.map(async (ref) => {
      if (!fs.existsSync(ref.htmlPath)) return null
      const html = await fs.promises.readFile(ref.htmlPath, 'utf-8')
      return { pageId: ref.pageId, html }
    })
  )
  for (const item of beforeReads) {
    if (!item) continue
    existingPageIdsBeforeRun.push(item.pageId)
  }

  if (!context.skipGenerationRunCreation) {
    await db.createGenerationRun({
      id: context.runId,
      sessionId: context.sessionId,
      mode: 'edit',
      totalPages: selectedPageRefs.length,
      modelConfigId: context.modelConfigId,
      metadata: {
        editScope: 'deck',
        selectedPageId: null,
        selectPageIds: selectedPageIds,
        selector: null,
        modelConfigId: context.modelConfigId,
        modelConfigName: context.modelConfigName,
        provider: context.provider,
        model: context.model
      }
    })
  }

  const emitEditChunk = createDeckProgressEmitter(context.sessionId, context.appLocale)
  emitEditChunk({
    type: 'stage_started',
    payload: {
      runId: context.runId,
      stage: 'editing',
      label: uiText(context.appLocale, '正在准备批量编辑', 'Preparing batch edit'),
      progress: 10,
      totalPages: selectedPageRefs.length
    }
  })

  await ctx.history.ensureBaseline(context.sessionId, projectDir)

  const editRunArgs = {
    sessionId: context.sessionId,
    provider: context.provider,
    apiKey: context.apiKey,
    model: context.model,
    baseUrl: context.providerBaseUrl,
    maxTokens: context.maxTokens,
    modelControl: context.modelControl,
    modelTimeoutMs: context.modelTimeouts.agent,
    temperature: PAGE_EDIT_DEFAULT_TEMPERATURE,
    styleId: context.styleId,
    styleSkillPrompt: context.styleSkill.prompt,
    layoutRulesPrompt: context.layoutRulesPrompt,
    styleKey: context.styleKey,
    styleName: context.styleName,
    styleVersion: context.styleVersion,
    slideSize: context.slideSize,
    appLocale: context.appLocale,
    topic: context.topic,
    deckTitle: context.deckTitle,
    userMessage: context.userMessage,
    outlineTitles,
    outlineItems,
    sourceDocumentPaths: context.sourceDocumentPaths,
    projectDir,
    indexPath,
    pageFileMap,
    pageNumbers,
    designContract: savedDesignContract,
    existingPageIds: existingPageIdsBeforeRun,
    agentManager,
    runId: context.runId,
    signal: context.abortSignal
  } satisfies Omit<Parameters<typeof runDeepAgentDeckAllPageEdit>[0], 'selectPageIds' | 'emit'>

  const outlineItemByPageId = new Map(
    pageRefs.map((page, index) => [page.pageId, outlineItems[index]])
  )
  const existingSessionPages = await db.listSessionPages(context.sessionId, {
    includeDeleted: true
  })
  const existingBySlug = new Map(existingSessionPages.map((sp) => [sp.file_slug, sp]))
  let batchResults: DeckEditBatchResult[]
  try {
    context.onDeckEditStarted?.()
    const inspectDeckQuality = (): ReturnType<typeof inspectPresentationDeckQuality> =>
      inspectPresentationDeckQuality({
        pages: pageRefs.map((page, index) => ({
          pageId: page.pageId,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: page.htmlPath,
          layoutIntent: outlineItems[index]?.layoutIntent
        })),
        slideSize: context.slideSize,
        designContract: savedDesignContract
      })
    const inspectDeckNarrative = (): ReturnType<typeof inspectPresentationDeckNarrative> =>
      inspectPresentationDeckNarrative({
        pages: pageRefs.map((page, index) => ({
          pageId: page.pageId,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: page.htmlPath,
          layoutIntent: outlineItems[index]?.layoutIntent
        }))
      })
    const beforeDeckQuality = await inspectDeckQuality()
    const beforeDeckNarrative = await inspectDeckNarrative()
    const baselineHardIssues = new Set(
      beforeDeckQuality.violations
        .filter((violation) => violation.severity === 'error')
        .flatMap((violation) => violation.pageIds.map((pageId) => `${violation.code}:${pageId}`))
    )
    batchResults = await executeDeckEditBatchFlow({
      pageRefs: selectedPageRefs,
      indexPath,
      originalUserMessage: context.userMessage,
      runId: context.runId,
      appLocale: context.appLocale,
      signal: context.abortSignal,
      emit: emitEditChunk,
      validateChangedPages,
      validateFinalResults: async (completedResults) => {
        if (completedResults.length === 0) return []
        emitEditChunk({
          type: 'llm_status',
          payload: {
            runId: context.runId,
            stage: 'editing',
            label: uiText(context.appLocale, '检查整套一致性', 'Checking deck consistency'),
            progress: 92,
            totalPages: selectedPageRefs.length,
            detail: uiText(
              context.appLocale,
              '正在确认本次编辑没有破坏跨页画布与核心字体契约',
              'Checking that this edit preserves cross-slide canvas and core font contracts'
            )
          }
        })
        const [afterDeckQuality, afterDeckNarrative] = await Promise.all([
          inspectDeckQuality(),
          inspectDeckNarrative()
        ])
        const completedPageIds = new Set(completedResults.map((result) => result.pageId))
        const newQualityViolations = afterDeckQuality.violations.filter(
          (violation) =>
            violation.severity === 'error' &&
            violation.pageIds.some(
              (pageId) =>
                completedPageIds.has(pageId) &&
                !baselineHardIssues.has(`${violation.code}:${pageId}`)
            )
        )
        const newNarrativeViolations = findNewNarrativeHardViolations({
          before: beforeDeckNarrative,
          after: afterDeckNarrative,
          pageIds: Array.from(completedPageIds)
        })
        log.info('[deck-edit:batch] deck quality diff completed', {
          sessionId: context.sessionId,
          runId: context.runId,
          newHardViolations: newQualityViolations.map((violation) => ({
            code: violation.code,
            pageIds: violation.pageIds
          })),
          newNarrativeViolations: newNarrativeViolations.map((violation) => ({
            code: violation.code,
            pageIds: violation.pageIds
          })),
          advisories: afterDeckQuality.violations
            .filter((violation) => violation.severity === 'warn')
            .map((violation) => ({ code: violation.code, pageIds: violation.pageIds }))
        })
        return Array.from(completedPageIds)
          .map((pageId) => ({
            pageId,
            qualityViolations: newQualityViolations.filter((violation) =>
              violation.pageIds.includes(pageId)
            ),
            narrativeViolations: newNarrativeViolations.filter((violation) =>
              violation.pageIds.includes(pageId)
            )
          }))
          .filter(
            (entry) => entry.qualityViolations.length > 0 || entry.narrativeViolations.length > 0
          )
          .map((entry) => ({
            pageId: entry.pageId,
            reason: [
              formatDeckQualityFeedback(entry.qualityViolations, entry.pageId),
              formatDeckNarrativeFeedback(entry.narrativeViolations, entry.pageId)
            ]
              .filter(Boolean)
              .join('\n')
          }))
      },
      buildRetryMessage: ({ baseMessage, error, kind }) => {
        const detail = error instanceof Error ? error.message : String(error || '')
        if (kind === 'no_change') {
          return buildEditNoChangeRetryMessage({
            originalMessage: baseMessage,
            allowedTool: 'update_page_file',
            selectedPageId: null
          })
        }
        if (kind === 'validation' || isEditValidationRetryableError(error)) {
          return buildEditValidationRetryMessage(baseMessage, detail)
        }
        if (isEditToolSchemaRetryableError(error)) {
          return buildEditToolSchemaRetryMessage({
            originalMessage: baseMessage,
            detail,
            allowedTool: 'update_page_file',
            selectedPageId: null
          })
        }
        if (isDeckEditRateLimitRetryableError(error)) {
          return [
            baseMessage,
            '',
            'Retry requirement:',
            `- The previous page request was rate limited: ${detail}`,
            '- Retry this page once after the configured stagger delay.',
            '- Edit only the current page and do not modify index.html.'
          ].join('\n')
        }
        return null
      },
      runPageAttempt: async ({ pageId, userMessage, isRetry, emit }) => {
        if (isRetry) {
          const retryPage = selectedPageRefs.find((page) => page.pageId === pageId)
          const currentPage = Math.max(
            1,
            selectedPageRefs.findIndex((page) => page.pageId === pageId) + 1
          )
          emit({
            type: 'llm_status',
            payload: {
              runId: context.runId,
              stage: 'editing',
              label: uiText(
                context.appLocale,
                `正在重试 P${retryPage?.pageNumber ?? currentPage}`,
                `Retrying P${retryPage?.pageNumber ?? currentPage}`
              ),
              progress: 0,
              currentPage,
              totalPages: selectedPageRefs.length,
              detail: uiText(
                context.appLocale,
                `正在重试页面：${pageId}`,
                `Retrying page: ${pageId}`
              )
            }
          })
        }
        return runDeepAgentDeckAllPageEdit({
          ...editRunArgs,
          userMessage,
          selectPageIds: [pageId],
          emit
        })
      },
      onPageCompleted: async (result) => {
        const pageRef = selectedPageRefs.find((p) => p.pageId === result.pageId)
        if (!pageRef) return
        const outlineItem = outlineItemByPageId.get(result.pageId)
        await db.upsertGenerationPage({
          runId: context.runId,
          sessionId: context.sessionId,
          pageId: result.pageId,
          pageNumber: pageRef.pageNumber,
          title: pageRef.title,
          contentOutline: outlineItem?.contentOutline || '',
          layoutIntent: outlineItem?.layoutIntent,
          visualFormat: outlineItem?.visualFormat,
          audienceMove: outlineItem?.audienceMove,
          layoutId: outlineItem?.layoutId,
          imageAssetPath: outlineItem?.imageAssetPath,
          imageAssetPaths: outlineItem?.imageAssetPaths,
          htmlPath: pageRef.htmlPath,
          status: 'completed',
          retryCount: result.retryCount
        })
        const existing = existingBySlug.get(result.pageId)
        await db.upsertSessionPage({
          id: existing?.id || nanoid(),
          sessionId: context.sessionId,
          legacyPageId:
            existing?.legacy_page_id || (result.pageId.match(/^page-\d+$/) ? result.pageId : null),
          fileSlug: result.pageId,
          pageNumber: pageRef.pageNumber,
          title: pageRef.title,
          htmlPath: pageRef.htmlPath,
          status: 'completed',
          error: null
        })
        for (const page of result.changedPages) {
          const isExisting = existingPageIdsBeforeRun.includes(page.pageId)
          const payload: GeneratedPagePayload = {
            id: page.id,
            focusPage: false,
            pageNumber: page.pageNumber,
            title: page.title,
            html: page.html,
            pageId: page.pageId,
            htmlPath: page.htmlPath,
            sourceUrl: getPageSourceUrl(page.htmlPath)
          }
          emitEditChunk({
            type: isExisting ? 'page_updated' : 'page_generated',
            payload: {
              runId: context.runId,
              stage: 'editing',
              label: uiText(
                context.appLocale,
                `P${page.pageNumber} 修改结果已保存`,
                `P${page.pageNumber} edit saved`
              ),
              progress: 90,
              currentPage: page.pageNumber,
              totalPages: selectedPageRefs.length,
              ...payload
            }
          })
        }
      },
      onPageFailed: async (result) => {
        const pageRef = selectedPageRefs.find((p) => p.pageId === result.pageId)
        if (!pageRef) return
        const outlineItem = outlineItemByPageId.get(result.pageId)
        await db.upsertGenerationPage({
          runId: context.runId,
          sessionId: context.sessionId,
          pageId: result.pageId,
          pageNumber: pageRef.pageNumber,
          title: pageRef.title,
          contentOutline: outlineItem?.contentOutline || '',
          layoutIntent: outlineItem?.layoutIntent,
          visualFormat: outlineItem?.visualFormat,
          audienceMove: outlineItem?.audienceMove,
          layoutId: outlineItem?.layoutId,
          imageAssetPath: outlineItem?.imageAssetPath,
          imageAssetPaths: outlineItem?.imageAssetPaths,
          htmlPath: pageRef.htmlPath,
          status: 'failed',
          error: result.reason,
          retryCount: result.retryCount
        })
        const existing = existingBySlug.get(result.pageId)
        await db.upsertSessionPage({
          id: existing?.id || pageRef.id || nanoid(),
          sessionId: context.sessionId,
          legacyPageId:
            existing?.legacy_page_id || (result.pageId.match(/^page-\d+$/) ? result.pageId : null),
          fileSlug: result.pageId,
          pageNumber: pageRef.pageNumber,
          title: pageRef.title,
          htmlPath: pageRef.htmlPath,
          status: existing?.status || 'failed',
          error: existing?.error || null
        })
        emitEditChunk({
          type: 'page_failed',
          payload: {
            runId: context.runId,
            stage: 'editing',
            label: progressText(context.appLocale, 'failed'),
            progress: 90,
            currentPage: pageRef.pageNumber,
            totalPages: selectedPageRefs.length,
            pageNumber: pageRef.pageNumber,
            pageId: pageRef.pageId,
            title: pageRef.title,
            htmlPath: pageRef.htmlPath,
            error: result.reason
          }
        })
      }
    })
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : 'Deck edit failed'
    log.error('[generate:start] deck edit batch flow aborted', {
      sessionId: context.sessionId,
      runId: context.runId,
      message
    })
    await db.updateGenerationRunStatus(context.runId, 'failed', message)
    throw error
  }

  const completedBatchResults = batchResults.filter(
    (result): result is DeckEditCompletedBatch => result.status === 'completed'
  )
  const failedBatchResults = batchResults.filter(
    (result): result is DeckEditFailedBatch => result.status === 'failed'
  )
  const changedPageIdSet = new Set(
    completedBatchResults.flatMap((r) => r.changedPages.map((p) => p.pageId))
  )

  const remainingFailedPageInfoById = resolveRemainingFailedPageInfo({
    previousFailures: failedPageInfoById,
    failedResults: failedBatchResults,
    completedPageIds: changedPageIdSet,
    pageRefs
  })
  const changedPages = completedBatchResults.flatMap((r) => r.changedPages)
  const failedPageLabels = failedBatchResults.map((item) => {
    const page = pageRefs.find((ref) => ref.pageId === item.pageId)
    return uiText(
      context.appLocale,
      `第${page?.pageNumber || item.pageId}页`,
      page?.pageNumber ? `page ${page.pageNumber}` : item.pageId
    )
  })
  const summaryArgs = {
    context,
    changedPages,
    editScope: 'deck' as const,
    failedPageLabels
  }
  const fallbackEditSummary = buildLocalSuccessfulEditSummary(summaryArgs)

  await db.updateSessionMetadata(context.sessionId, {
    lastRunId: context.runId,
    entryMode: 'multi_page',
    indexPath,
    projectId: context.projectId
  })
  await db.updateProjectStatus(context.projectId, 'draft')
  await db.updateSessionStatus(
    context.sessionId,
    remainingFailedPageInfoById.size > 0 ? 'failed' : 'completed'
  )
  const runStatus =
    failedBatchResults.length === 0
      ? 'completed'
      : completedBatchResults.length > 0
        ? 'partial'
        : 'failed'
  const failedDetails = failedBatchResults
    .map((page) => `${page.pageId}：${page.reason}`)
    .join('；')
  await db.updateGenerationRunStatus(
    context.runId,
    runStatus,
    failedBatchResults.length > 0 ? failedDetails : null
  )
  if (changedPageIdSet.size > 0) {
    await ctx.history.recordOperation({
      sessionId: context.sessionId,
      projectDir,
      type: 'edit',
      scope: 'deck',
      prompt: context.userMessage,
      metadata: {
        runId: context.runId,
        changedPageIds: Array.from(changedPageIdSet),
        selectPageIds: selectedPageIds,
        failedPageIds: failedBatchResults.map((page) => page.pageId),
        failedPageReasons: Object.fromEntries(
          failedBatchResults.map((page) => [page.pageId, page.reason])
        )
      }
    })
  }
  await emitSuccessfulEditSummary(context, fallbackEditSummary, emitAssistant)
  log.info('[generate:start] deck all-page edit completed', {
    sessionId: context.sessionId,
    styleId: context.styleId,
    changedPages: Array.from(changedPageIdSet),
    failedPages: failedBatchResults.map((page) => page.pageId),
    remainingFailedPages: Array.from(remainingFailedPageInfoById.keys()),
    batchCount: batchResults.length
  })
  if (runStatus === 'failed') {
    emitEditChunk({
      type: 'run_error',
      payload: {
        runId: context.runId,
        message: failedDetails || fallbackEditSummary,
        completedPageCount: 0,
        failedPageCount: failedBatchResults.length
      }
    })
  } else {
    emitEditChunk({
      type: 'run_completed',
      payload: {
        runId: context.runId,
        totalPages: selectedPageRefs.length,
        completedPageCount: changedPageIdSet.size,
        failedPageCount: failedBatchResults.length
      }
    })
  }
}
