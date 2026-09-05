/** Generation orchestration: LLM planning + DeepAgent execution. */
import pLimit from 'p-limit'
import log from 'electron-log/main.js'
import { sleep } from '../ipc/utils'
import { progressText } from '@shared/progress'
import { createRuntimeConcurrencyGate } from './concurrency-gate'
import {
  normalizePageConcurrencyPreference,
  resolvePageWorkerCount
} from '@shared/page-concurrency'
import { classifyGenerationError } from '@shared/generation-error'
import { createGenerationCircuitBreaker } from '@shared/generation-circuit-breaker'
import { readSessionLayoutLibrary } from '../session/master-service'
import { createReferenceDocumentRetriever } from './reference-document-retrieval'
import { resolveDeckPageRefs } from './page-refs'
import { createPageProgressTracker } from './page-progress-tracker'
import { createSinglePageGenerator } from './single-page-generator'
import { runDeckReviewAndRepair, type DeckPageFailure } from './deck-review-repair'
import { uiText, withModelControl } from './runner-shared'
import type { DeckGenerationArgs, DeckGenerationResult } from './deck-generation-types'

export { planNewPage } from './planning/page-planner'
export { planDeckWithLLM } from './planning/deck-planner'
export { buildDesignContractWithLLM } from './planning/design-contract-builder'
export { runDeepAgentEdit, runDeepAgentDeckAllPageEdit } from './deck-edit-runner'

export const runDeepAgentDeckGeneration = async (
  args: DeckGenerationArgs
): Promise<DeckGenerationResult> => {
  const layoutLibrary = (await readSessionLayoutLibrary(args.projectDir)).library
  const pageRefs = resolveDeckPageRefs({
    pageTasks: args.pageTasks,
    pageFileMap: args.pageFileMap,
    outlineTitles: args.outlineTitles,
    outlineItems: args.outlineItems,
    layoutLibrary
  })
  const totalPages = pageRefs.length
  const pageSummaryMap = new Map<number, string>()
  const pageConcurrencyPreference = normalizePageConcurrencyPreference(args.pageConcurrency)
  const initialWorkerCount = resolvePageWorkerCount(pageConcurrencyPreference, totalPages)
  // 限流时把闸门降到 1（只降不升），未开始的页面自动改为逐页生成。
  const pageConcurrencyGate = createRuntimeConcurrencyGate(initialWorkerCount)
  const useDualWorkerQueue = initialWorkerCount === 2
  const progress = createPageProgressTracker({
    runId: args.runId,
    totalPages,
    pageRefs,
    provider: args.provider,
    model: args.model,
    emit: args.emit
  })
  const renderingLabel = args.renderingLabel || progressText(args.appLocale, 'generating')

  progress.emitRenderingStatus({
    label: renderingLabel,
    progress: 12,
    detail: uiText(args.appLocale, `共 ${totalPages} 页`, `${totalPages} pages`)
  })

  log.info('[deepagent] invoke deck generation', {
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    temperature: args.temperature ?? null,
    styleId: args.styleId || '',
    projectDir: args.projectDir,
    indexPath: args.indexPath,
    totalPages,
    fixedConcurrency: useDualWorkerQueue ? 2 : 1,
    pageConcurrency: pageConcurrencyPreference,
    designContract: args.designContract
      ? {
          theme: args.designContract.theme,
          background: args.designContract.background,
          palette: args.designContract.palette,
          titleStyle: args.designContract.titleStyle
        }
      : null
  })

  const referenceDocumentRetriever = args.sourceDocumentPaths?.length
    ? await createReferenceDocumentRetriever({
        sessionId: args.sessionId,
        projectDir: args.projectDir,
        sourceDocumentPaths: args.sourceDocumentPaths
      })
    : null

  const { generateSinglePage, generateSinglePageWithRetry } = createSinglePageGenerator({
    args,
    pageRefs,
    totalPages,
    renderingLabel,
    progress,
    referenceDocumentRetriever,
    concurrencyGate: pageConcurrencyGate,
    pageConcurrencyPreference
  })

  const workerCount = useDualWorkerQueue ? 2 : 1
  const PAGE_GENERATION_STAGGER_MS = 500
  if (useDualWorkerQueue) {
    progress.emitRenderingStatus({
      label: renderingLabel,
      progress: 14,
      detail: uiText(args.appLocale, '创意即将正式生成..', 'Generation is about to begin.')
    })
  }
  const limit = pLimit(workerCount)
  const circuitBreaker = createGenerationCircuitBreaker()
  const dispatchedPageIds = new Set<string>()
  const settled = await Promise.allSettled(
    pageRefs.map((page, index) =>
      limit(async () => {
        if (circuitBreaker.getState().paused) return
        if (args.signal?.aborted)
          throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
        const workerLabel = useDualWorkerQueue ? 'limit-worker' : 'single-worker'
        const launchDelayMs = useDualWorkerQueue
          ? (index % workerCount) * PAGE_GENERATION_STAGGER_MS
          : 0
        if (launchDelayMs > 0) {
          log.info('[deepagent] queue stagger delay', {
            sessionId: args.sessionId,
            worker: workerLabel,
            styleId: args.styleId || '',
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            delayMs: launchDelayMs
          })
          await sleep(launchDelayMs, args.signal)
        }
        if (circuitBreaker.getState().paused) return
        if (args.signal?.aborted)
          throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
        // 闸门在 pLimit 之上再做一层并发控制：限流降级后，排队中的页面
        // 会在这里等到前面的页面完全结束才启动。
        await pageConcurrencyGate.acquire()
        try {
          if (circuitBreaker.getState().paused) return
          log.info('[deepagent] queue dispatch', {
            sessionId: args.sessionId,
            worker: workerLabel,
            styleId: args.styleId || '',
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            title: page.title
          })
          dispatchedPageIds.add(page.pageId)
          try {
            const summary = await withModelControl(args.modelControl, () =>
              generateSinglePageWithRetry(page, workerLabel)
            )
            if (summary) {
              pageSummaryMap.set(
                page.pageNumber,
                uiText(
                  args.appLocale,
                  `第 ${page.pageNumber} 页：${summary}`,
                  `Page ${page.pageNumber}: ${summary}`
                )
              )
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            const failure = classifyGenerationError(error)
            if (failure.scope === 'system') {
              const circuitState = circuitBreaker.registerFailure(failure)
              const circuitLog = {
                sessionId: args.sessionId,
                provider: args.provider,
                model: args.model,
                pageId: page.pageId,
                code: failure.code,
                fingerprint: failure.fingerprint,
                occurrences: circuitState.occurrences
              }
              if (circuitState.paused) {
                log.error('[deepagent] system failure opened page generation circuit', circuitLog)
              } else {
                log.warn('[deepagent] transient system failure registered', circuitLog)
              }
            }
            args.emit?.({
              type: 'page_failed',
              payload: {
                runId: args.runId || '',
                stage: 'rendering',
                label: progressText(args.appLocale, 'failed'),
                progress: progress.getOverallRenderProgress(),
                currentPage: page.pageNumber,
                totalPages,
                pageNumber: page.pageNumber,
                pageId: page.pageId,
                title: page.title,
                htmlPath: args.pageFileMap[page.pageId] || '',
                error: reason
              }
            })
            await args.onPageFailed?.({
              pageNumber: page.pageNumber,
              pageId: page.pageId,
              title: page.title,
              contentOutline: page.outline,
              layoutIntent: page.layoutIntent,
              visualFormat: page.visualFormat,
              audienceMove: page.audienceMove,
              layoutId: page.layoutId,
              imageAssetPath: page.imageAssetPath,
              imageAssetPaths: page.imageAssetPaths,
              htmlPath: args.pageFileMap[page.pageId] || '',
              reason
            })
            throw error
          }
        } finally {
          pageConcurrencyGate.release()
        }
      })
    )
  )
  const failedPages: DeckPageFailure[] = []
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      const page = pageRefs[index]
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      failedPages.push({
        pageId: page.pageId,
        title: page.title,
        reason
      })
      log.warn('[deepagent] page generation failed', {
        sessionId: args.sessionId,
        styleId: args.styleId || '',
        pageId: page.pageId,
        reason
      })
    }
  })
  const circuitState = circuitBreaker.getState()
  const circuitSkippedPages = circuitState.paused
    ? pageRefs.filter((page) => !dispatchedPageIds.has(page.pageId))
    : []
  for (const page of circuitSkippedPages) {
    const reason = uiText(
      args.appLocale,
      '生成被熔断跳过',
      'Generation skipped because the circuit breaker opened'
    )
    failedPages.push({ pageId: page.pageId, title: page.title, reason })
    args.emit?.({
      type: 'page_failed',
      payload: {
        runId: args.runId || '',
        stage: 'rendering',
        label: progressText(args.appLocale, 'failed'),
        progress: progress.getOverallRenderProgress(),
        currentPage: page.pageNumber,
        totalPages,
        pageNumber: page.pageNumber,
        pageId: page.pageId,
        title: page.title,
        htmlPath: args.pageFileMap[page.pageId] || '',
        error: reason
      }
    })
    await args.onPageFailed?.({
      pageNumber: page.pageNumber,
      pageId: page.pageId,
      title: page.title,
      contentOutline: page.outline,
      layoutIntent: page.layoutIntent,
      visualFormat: page.visualFormat,
      audienceMove: page.audienceMove,
      layoutId: page.layoutId,
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      htmlPath: args.pageFileMap[page.pageId] || '',
      reason
    })
  }
  const { deckQualityWarnings, deckNarrativeWarnings } = await runDeckReviewAndRepair({
    args,
    pageRefs,
    failedPages,
    generateSinglePage,
    progress,
    circuitPaused: circuitBreaker.getState().paused
  })
  const pendingPages = pageRefs
    .filter(
      (page) =>
        !dispatchedPageIds.has(page.pageId) &&
        !failedPages.some((failure) => failure.pageId === page.pageId)
    )
    .map((page) => ({ pageId: page.pageId, title: page.title }))
  const finalAssistantText = pageRefs
    .map((page) => pageSummaryMap.get(page.pageNumber))
    .filter((item): item is string => Boolean(item))
    .join('\n')
  const deckQualitySummary =
    deckQualityWarnings.length > 0
      ? uiText(
          args.appLocale,
          `整套质量建议：${deckQualityWarnings.map((item) => `[${item.code}] ${item.detail}`).join('；')}`,
          `Deck quality advisories: ${deckQualityWarnings.map((item) => `[${item.code}] ${item.detail}`).join('; ')}`
        )
      : ''
  const deckNarrativeSummary =
    deckNarrativeWarnings.length > 0
      ? uiText(
          args.appLocale,
          `内容与叙事建议：${deckNarrativeWarnings.map((item) => `[${item.code}] ${item.detail}`).join('；')}`,
          `Narrative advisories: ${deckNarrativeWarnings.map((item) => `[${item.code}] ${item.detail}`).join('; ')}`
        )
      : ''
  const finalSummary = [finalAssistantText, deckQualitySummary, deckNarrativeSummary]
    .filter(Boolean)
    .join('\n')
  log.info('[deepagent] host worker queue generation completed', {
    sessionId: args.sessionId,
    styleId: args.styleId || '',
    totalPages,
    workerCount,
    finalAssistantPreview: finalSummary.slice(0, 200)
  })
  return {
    summary: finalSummary,
    failedPages,
    pendingPages,
    pause:
      circuitState.paused && circuitState.failure
        ? { failure: circuitState.failure, occurrences: circuitState.occurrences }
        : null
  }
}
