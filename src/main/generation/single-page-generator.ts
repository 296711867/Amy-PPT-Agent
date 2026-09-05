/** 单页生成 worker：页面上下文组装 → agent 执行 → 落盘校验 → 救援/重试/限流退避。 */
import log from 'electron-log/main.js'
import { createSessionDeckAgent } from '../agent-runtime/agent'
import { buildSinglePageAgentUserPrompt, measurePromptText } from '../agent-runtime/prompt'
import { isSectionAgendaOutline } from '@shared/generation'
import { progressLabel, progressText } from '@shared/progress'
import { sleep } from '../ipc/utils'
import {
  formatReferenceDocumentSnippets,
  type ReferenceDocumentRetriever
} from './reference-document-retrieval'
import { processAgentStreamCore } from './agent-stream-processor'
import { classifyPageMethodSignal } from './method-signals'
import { MAX_RATE_LIMIT_RETRIES, resolveRateLimitBackoff } from './rate-limit-backoff'
import type { RuntimeConcurrencyGate } from './concurrency-gate'
import type { PageConcurrencyPreference } from '@shared/page-concurrency'
import { buildLocalCompletedGenerationPageSummary } from './generation-summary'
import { classifyGenerationError } from '@shared/generation-error'
import { hasCommittedGeneratedPage } from './page-commit'
import {
  buildEmptyTurnContinuationMessage,
  buildPageNotWrittenMessage,
  extractHtmlFragmentCandidate,
  extractWriteValidationFailure,
  isModelEmptyTurn
} from './page-write-failure'
import { persistPageHtmlFromFragment } from '../presentation/html/page-writer-core'
import { validateAssignedDeckBackground } from './deck-backgrounds'
import { resolveTitleBandAnchor } from './title-band-anchor'
import { modelCallSignal, readPageHtmlIfExists, uiText, withModelControl } from './runner-shared'
import {
  resolvePageProgressFromCustomStatus,
  type PageProgressTracker
} from './page-progress-tracker'
import type { PageRef } from './page-refs'
import type { DeckGenerationArgs } from './deck-generation-types'

export type SinglePageRetryContext = {
  attempt: number
  maxRetries: number
  previousError: string
}

export type SinglePageGenerator = {
  generateSinglePage: (
    page: PageRef,
    workerLabel: string,
    retryContext?: SinglePageRetryContext,
    pagePromptAddendum?: string
  ) => Promise<string>
  generateSinglePageWithRetry: (page: PageRef, workerLabel: string) => Promise<string>
}

export const createSinglePageGenerator = (context: {
  args: DeckGenerationArgs
  pageRefs: PageRef[]
  totalPages: number
  renderingLabel: string
  progress: PageProgressTracker
  referenceDocumentRetriever: ReferenceDocumentRetriever | null
  concurrencyGate: RuntimeConcurrencyGate
  pageConcurrencyPreference: PageConcurrencyPreference
}): SinglePageGenerator => {
  const { args, progress } = context

  const generateSinglePage = async (
    page: PageRef,
    workerLabel: string,
    retryContext?: SinglePageRetryContext,
    pagePromptAddendum?: string
  ): Promise<string> => {
    if (args.signal?.aborted) {
      throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
    }
    const pageStartedAt = Date.now()
    const currentPagePath = args.pageFileMap[page.pageId]
    const writeToolName = args.requireTemplatePageRead
      ? 'update_template_page_file'
      : 'update_single_page_file'

    progress.emitPageStatus({
      pageId: page.pageId,
      label: context.renderingLabel,
      detail: `${page.pageId} · ${page.title}`,
      pageProgress: 5
    })
    args.emit?.({
      type: 'page_started',
      payload: {
        runId: args.runId || '',
        stage: 'rendering',
        label: context.renderingLabel,
        progress: progress.getOverallRenderProgress(),
        currentPage: page.pageNumber,
        totalPages: context.totalPages,
        pageNumber: page.pageNumber,
        pageId: page.pageId,
        title: page.title,
        htmlPath: currentPagePath
      }
    })

    if (!currentPagePath) {
      throw new Error(`pageFileMap 缺少 ${page.pageId} 对应文件路径`)
    }
    const beforePageHtml = await readPageHtmlIfExists(currentPagePath)
    log.info('[deepagent] page generation context', {
      sessionId: args.sessionId,
      worker: workerLabel,
      styleId: args.styleId || '',
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      pagePath: currentPagePath,
      outline: page.outline || '',
      outlineLength: (page.outline || '').length
    })

    const isSectionAgendaPage = isSectionAgendaOutline(page.outline || '')
    const pageSourceDocumentPaths = isSectionAgendaPage ? [] : args.sourceDocumentPaths
    const referenceDocumentSnippets =
      context.referenceDocumentRetriever && !isSectionAgendaPage
        ? formatReferenceDocumentSnippets(
            context.referenceDocumentRetriever.search({
              pageId: page.pageId,
              pageTitle: page.title,
              pageOutline: page.outline,
              userMessage: args.userMessage
            })
          )
        : ''
    log.info('[deepagent] reference document snippets prepared', {
      sessionId: args.sessionId,
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      hasSourceDocuments: Boolean(pageSourceDocumentPaths?.length),
      hasRetriever: Boolean(context.referenceDocumentRetriever),
      injected: referenceDocumentSnippets.trim().length > 0,
      injectedCharacterCount: referenceDocumentSnippets.length
    })

    const deepAgent = withModelControl(args.modelControl, () =>
      createSessionDeckAgent({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        baseUrl: args.baseUrl,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        modelRuntime: args.agentManager.getSession(args.sessionId)?.modelRuntime,
        styleId: args.styleId,
        systemPromptAddendum: args.systemPromptAddendum,
        context: {
          sessionId: args.sessionId,
          projectDir: args.projectDir,
          indexPath: args.indexPath,
          topic: args.topic,
          deckTitle: args.deckTitle,
          styleId: args.styleId,
          styleSkillPrompt: args.styleSkillPrompt,
          layoutRulesPrompt: args.layoutRulesPrompt,
          styleKey: args.styleKey,
          styleName: args.styleName,
          styleVersion: args.styleVersion,
          slideSize: args.slideSize,
          appLocale: args.appLocale,
          animationPreferences: args.animationPreferences,
          designContract: args.designContract,
          templatePageReadRequired: args.requireTemplatePageRead,
          userMessage: args.userMessage,
          outlineTitles: [page.title],
          outlineItems: [
            {
              title: page.title,
              contentOutline: page.outline,
              layoutIntent: page.layoutIntent,
              contentStructure: page.contentStructure,
              moduleCount: page.moduleCount,
              visualAspect: page.visualAspect,
              contentDensity: page.contentDensity,
              visualFormat: page.visualFormat,
              audienceMove: page.audienceMove,
              layoutId: page.layoutId,
              layoutPrompt: page.layoutPrompt,
              imageAssetPath: page.imageAssetPath,
              imageAssetPaths: page.imageAssetPaths
            }
          ],
          sourceDocumentPaths: args.sourceDocumentPaths,
          mode: args.generationMode ?? 'generate',
          pageFileMap: { [page.pageId]: currentPagePath },
          pageNumbers: { [page.pageId]: page.pageNumber },
          selectedPageId: page.pageId,
          selectedPageNumber: page.pageNumber,
          existingPageIds: [page.pageId],
          allowedPageIds: [page.pageId]
        }
      })
    )
    args.agentManager.setPageAgent(args.sessionId, page.pageId, deepAgent)

    try {
      const combinedSignal = modelCallSignal(args.modelTimeoutMs, 'agent', args.signal)
      // 标题带锚点：其它常规页按页码升序优先，重试页自身旧版兜底。
      // 模板导入流程有自身的骨架保留规则，不注入锚点以免互相冲突。
      const titleBandAnchor = args.requireTemplatePageRead
        ? null
        : await resolveTitleBandAnchor({
            candidates: [
              ...context.pageRefs
                .filter((ref) => ref.pageId !== page.pageId)
                .sort((a, b) => a.pageNumber - b.pageNumber)
                .map((ref) => ({
                  pageId: ref.pageId,
                  pageNumber: ref.pageNumber,
                  layoutIntent: ref.layoutIntent,
                  htmlPath: args.pageFileMap[ref.pageId]
                })),
              ...(retryContext && beforePageHtml
                ? [
                    {
                      pageId: page.pageId,
                      pageNumber: page.pageNumber,
                      layoutIntent: page.layoutIntent,
                      pageHtml: beforePageHtml
                    }
                  ]
                : [])
            ],
            readPageHtml: readPageHtmlIfExists
          })
      const userPrompt = buildSinglePageAgentUserPrompt({
        topic: args.topic,
        deckTitle: args.deckTitle,
        slideSize: args.slideSize,
        generationMode: args.generationMode ?? 'generate',
        singlePagePromptAddendum: args.singlePagePromptAddendum,
        pagePromptAddendum,
        requireTemplatePageRead: args.requireTemplatePageRead,
        methodLevelFixes,
        page,
        sourceDocumentPaths: pageSourceDocumentPaths,
        referenceDocumentSnippets,
        retryContext,
        titleBandAnchor
      })
      log.info('[deepagent] single-page prompt metrics', {
        sessionId: args.sessionId,
        pageId: page.pageId,
        worker: workerLabel,
        generationMode: args.generationMode ?? 'generate',
        titleBandAnchor: titleBandAnchor
          ? {
              pageId: titleBandAnchor.pageId,
              pageNumber: titleBandAnchor.pageNumber,
              bandHtmlLength: titleBandAnchor.bandHtml.length
            }
          : null,
        userPromptMetrics: measurePromptText(userPrompt)
      })
      // GLM-5.x 等思考模型在部分端点上会随机返回「只有思考、无正文、无任何
      // 工具调用」的空回合（实测约半数页面尝试命中）。与其立刻整页重建重试，
      // 不如把会话历史发回同一个 agent 续跑一次，成本远低于完整重试。
      const MAX_EMPTY_TURN_CONTINUATIONS = 2
      let conversationMessages: unknown[] = [{ role: 'user', content: userPrompt }]
      // Final user-facing generation replies are built later from validated page facts.
      // Raw messages may be token deltas, tool-call turns, or cumulative provider chunks.
      let streamError: unknown = null
      let lastWriteValidationFailure = ''
      let finalAssistantText = ''
      let sawToolCallInRun = false
      let modelReturnedEmptyTurn = false
      let afterPageHtml = ''
      let pageCommitted = false

      for (
        let continuationRound = 0;
        continuationRound <= MAX_EMPTY_TURN_CONTINUATIONS;
        continuationRound += 1
      ) {
        const stream = await deepAgent.stream(
          {
            messages: conversationMessages
          },
          {
            streamMode: ['updates', 'messages', 'custom'],
            subgraphs: true,
            signal: combinedSignal
          }
        )

        try {
          const streamOutcome = await processAgentStreamCore(stream, {
            emit: args.emit,
            runId: args.runId || '',
            stage: 'rendering',
            totalPages: context.totalPages,
            provider: args.provider,
            model: args.model,
            sessionId: args.sessionId,
            workerLabel,
            onCustom: (custom) => {
              const writeValidationFailure = extractWriteValidationFailure(custom)
              if (writeValidationFailure) lastWriteValidationFailure = writeValidationFailure
              const mappedPageProgress = resolvePageProgressFromCustomStatus(custom)
              const normalizedLabel = progressLabel(args.appLocale, custom.label)
              const normalizedDetail =
                /所有页面已填充|当前页面已填充|All pages filled|Current page filled/i.test(
                  custom.label || ''
                )
                  ? uiText(
                      args.appLocale,
                      `${page.title} · 页面内容已写入`,
                      `${page.title} · page content written`
                    )
                  : custom.detail
              progress.emitPageStatus({
                pageId: page.pageId,
                label:
                  normalizedLabel === progressText(args.appLocale, 'generating')
                    ? context.renderingLabel
                    : normalizedLabel,
                detail: normalizedDetail,
                pageProgress: mappedPageProgress
              })
            },
            onModelThinking: (defaultProgress) => {
              const mappedPageProgress = Math.max(12, Math.min(96, defaultProgress))
              progress.emitPageStatus({
                pageId: page.pageId,
                label: context.renderingLabel,
                detail: page.title,
                pageProgress: mappedPageProgress
              })
            }
          })
          finalAssistantText = streamOutcome.finalAssistantText
          sawToolCallInRun = sawToolCallInRun || streamOutcome.sawToolCall
          if (streamOutcome.conversationMessages.length > 0) {
            conversationMessages = streamOutcome.sawHumanMessage
              ? streamOutcome.conversationMessages
              : [{ role: 'user', content: userPrompt }, ...streamOutcome.conversationMessages]
          }
        } catch (error) {
          streamError = error
          // The model may time out after the write tool has already committed the
          // page (for example while producing its final acknowledgement). The file
          // is the product; a trailing model turn must not turn a valid commit into
          // a failure or feed a false MODEL_TIMEOUT into the run circuit breaker.
          afterPageHtml = await readPageHtmlIfExists(currentPagePath)
          pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)
          break
        }

        afterPageHtml = await readPageHtmlIfExists(currentPagePath)
        pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)
        if (pageCommitted) break

        // 模型没调用写盘工具、但把 HTML 写在了最终回复里时，直接提取落盘，
        // 走同一套修复/校验管道，避免重试耗尽整页失败。
        const rescueCandidate = extractHtmlFragmentCandidate(finalAssistantText)
        if (rescueCandidate) {
          try {
            log.info('[deepagent] rescuing page from final assistant text', {
              sessionId: args.sessionId,
              pageId: page.pageId,
              worker: workerLabel,
              contentLength: rescueCandidate.length
            })
            progress.emitPageStatus({
              pageId: page.pageId,
              label: context.renderingLabel,
              detail: uiText(
                args.appLocale,
                `${page.title} · 从最终回复恢复页面内容`,
                `${page.title} · recovered page content from the final response`
              ),
              pageProgress: 60
            })
            await persistPageHtmlFromFragment({
              content: rescueCandidate,
              pageId: page.pageId,
              pageNumber: page.pageNumber,
              projectDir: args.projectDir,
              targetPath: currentPagePath,
              slideSize: args.slideSize,
              designFonts: args.designContract
                ? {
                    titleFont: args.designContract.titleFont,
                    subtitleFont: args.designContract.subtitleFont,
                    bodyFont: args.designContract.bodyFont
                  }
                : undefined
            })
            afterPageHtml = await readPageHtmlIfExists(currentPagePath)
            pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)
          } catch (rescueError) {
            log.warn('[deepagent] rescue write from final response failed', {
              sessionId: args.sessionId,
              pageId: page.pageId,
              message: rescueError instanceof Error ? rescueError.message : String(rescueError)
            })
          }
          if (pageCommitted) break
        } else {
          log.warn('[deepagent] page not written; final assistant text preview', {
            sessionId: args.sessionId,
            pageId: page.pageId,
            worker: workerLabel,
            preview: finalAssistantText.slice(0, 400)
          })
        }

        const emptyTurn = isModelEmptyTurn({
          sawToolCall: sawToolCallInRun,
          finalAssistantText
        })
        modelReturnedEmptyTurn = emptyTurn
        if (!emptyTurn || continuationRound >= MAX_EMPTY_TURN_CONTINUATIONS) break
        log.warn('[deepagent] model returned an empty turn; continuing the same session', {
          sessionId: args.sessionId,
          pageId: page.pageId,
          worker: workerLabel,
          continuationRound: continuationRound + 1,
          maxContinuations: MAX_EMPTY_TURN_CONTINUATIONS,
          provider: args.provider,
          model: args.model
        })
        progress.emitPageStatus({
          pageId: page.pageId,
          label: progressText(args.appLocale, 'retrying'),
          detail: uiText(
            args.appLocale,
            `${page.title} · 模型返回空回复，同一会话自动续跑`,
            `${page.title} · model returned an empty turn; continuing automatically`
          ),
          pageProgress: 15
        })
        conversationMessages = [
          ...conversationMessages,
          {
            role: 'user',
            content: buildEmptyTurnContinuationMessage({
              pageId: page.pageId,
              writeToolName,
              continuationRound: continuationRound + 1
            })
          }
        ]
      }
      if (streamError && !pageCommitted) throw streamError
      if (!pageCommitted) {
        log.error('[deepagent] page not written after continuations', {
          sessionId: args.sessionId,
          pageId: page.pageId,
          worker: workerLabel,
          modelReturnedEmptyTurn,
          sawToolCallInRun,
          lastWriteValidationFailure
        })
        throw new Error(
          buildPageNotWrittenMessage({
            pageId: page.pageId,
            writeToolName,
            lastWriteValidationFailure,
            modelReturnedEmptyTurn
          })
        )
      }

      const backgroundErrors = validateAssignedDeckBackground(
        afterPageHtml,
        page.backgroundAsset,
        args.appLocale
      )
      if (backgroundErrors.length > 0) {
        throw new Error(
          uiText(
            args.appLocale,
            `PPT 背景图约束未通过 (${page.pageId})：${backgroundErrors.join('；')}。请将分配的背景图作为创意根节点的第一个子元素后重试。`,
            `PPT background constraint failed (${page.pageId}): ${backgroundErrors.join('; ')}. Add the assigned background image as the first child of the creative root and retry.`
          )
        )
      }

      if (streamError) {
        log.warn('[deepagent] preserved validated page after post-write stream failure', {
          sessionId: args.sessionId,
          pageId: page.pageId,
          worker: workerLabel,
          reason: streamError instanceof Error ? streamError.message : String(streamError)
        })
        progress.emitPageStatus({
          pageId: page.pageId,
          label: progressLabel(args.appLocale, '页面内容已写入'),
          detail: uiText(
            args.appLocale,
            `${page.title} · 模型收尾连接中断，已保留通过校验的页面`,
            `${page.title} · final model response failed; preserved the validated page`
          ),
          pageProgress: 95
        })
      }

      progress.emitPageStatus({
        pageId: page.pageId,
        label: progressLabel(args.appLocale, '页面内容已写入'),
        detail: `${page.pageId} · ${page.title}`,
        pageProgress: 95
      })

      await args.onPageCompleted?.({
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
        backgroundAsset: page.backgroundAsset,
        htmlPath: currentPagePath
      })

      progress.setPageProgress(page.pageId, 100)
      const completedCount = progress.getCompletedPageCount()
      progress.emitRenderingStatus({
        label: progressText(args.appLocale, 'completed'),
        detail: uiText(
          args.appLocale,
          `${page.title} · 已完成 ${completedCount}/${context.totalPages} 页`,
          `${page.title} · ${completedCount}/${context.totalPages} pages completed`
        ),
        progress: progress.getOverallRenderProgress()
      })

      log.info('[deepagent] page generation finished', {
        sessionId: args.sessionId,
        worker: workerLabel,
        styleId: args.styleId || '',
        pageId: page.pageId,
        retryAttempt: retryContext?.attempt || 0,
        elapsedMs: Date.now() - pageStartedAt,
        pagePath: currentPagePath
      })

      return buildLocalCompletedGenerationPageSummary({
        appLocale: args.appLocale || 'zh',
        pageTitle: page.title
      })
    } finally {
      args.agentManager.removePageAgent(args.sessionId, page.pageId)
    }
  }

  // 仅重试失败页面，避免影响已成功页面。
  // Tool validation already self-repairs inside ReAct. Keep outer reruns bounded.
  const MAX_PAGE_RETRIES = 2
  const RETRY_DELAY_BASE_MS = 1_000
  // 限流是瞬态错误：页面级先长退避自动重试，耗尽重试额度才交给熔断器暂停整套生成。
  // 共享冷却时间让并行 worker 错峰重试，避免双路同时撞 429。
  let rateLimitCooldownUntil = 0
  // 方法信号门禁：同类错误在 2 次（跨页或跨尝试）后升级为方法级修正，
  // 注入后续所有页面的提示词，避免整套 deck 反复栽进同一个坑。
  const METHOD_SIGNAL_ESCALATE_THRESHOLD = 2
  const methodSignalCounts = new Map<string, number>()
  const methodLevelFixes: string[] = []
  const registerMethodSignal = (errorMessage: string, pageId: string): void => {
    const signal = classifyPageMethodSignal(errorMessage)
    if (!signal) return
    const count = (methodSignalCounts.get(signal.signalClass) || 0) + 1
    methodSignalCounts.set(signal.signalClass, count)
    if (count >= METHOD_SIGNAL_ESCALATE_THRESHOLD && !methodLevelFixes.includes(signal.fix)) {
      methodLevelFixes.push(signal.fix)
      log.warn('[deepagent] method-level signal escalated for later slides', {
        sessionId: args.sessionId,
        styleId: args.styleId || '',
        signalClass: signal.signalClass,
        occurrences: count,
        triggeredByPage: pageId
      })
    }
  }
  const generateSinglePageWithRetry = async (
    page: PageRef,
    workerLabel: string
  ): Promise<string> => {
    let lastError: unknown = null
    let attempt = 0
    let rateLimitAttempts = 0
    while (attempt <= MAX_PAGE_RETRIES) {
      try {
        const retryContext =
          attempt > 0 && lastError
            ? {
                attempt,
                maxRetries: MAX_PAGE_RETRIES,
                previousError: lastError instanceof Error ? lastError.message : String(lastError)
              }
            : undefined
        return await generateSinglePage(page, workerLabel, retryContext)
      } catch (error) {
        lastError = error
        const reason = error instanceof Error ? error.message : String(error)
        registerMethodSignal(reason, page.pageId)
        const failure = classifyGenerationError(error)

        if (failure.code === 'MODEL_RATE_LIMIT') {
          const backoff = resolveRateLimitBackoff({
            attemptsAlreadyUsed: rateLimitAttempts,
            cooldownUntil: rateLimitCooldownUntil,
            nowMs: Date.now(),
            random: Math.random
          })
          if (backoff) {
            rateLimitAttempts = backoff.attempt
            rateLimitCooldownUntil = backoff.cooldownUntil
            if (context.concurrencyGate.capacity > 1) {
              context.concurrencyGate.downgradeCapacity(1)
              log.warn('[deepagent] rate limit downgraded page concurrency to serial', {
                sessionId: args.sessionId,
                styleId: args.styleId || '',
                pageId: page.pageId,
                worker: workerLabel,
                preference: context.pageConcurrencyPreference
              })
            }
            progress.emitPageStatus({
              pageId: page.pageId,
              label: progressText(args.appLocale, 'retrying'),
              detail: uiText(
                args.appLocale,
                `模型服务限流，${Math.round(backoff.waitMs / 1000)} 秒后自动重试（第 ${backoff.attempt}/${MAX_RATE_LIMIT_RETRIES} 次）`,
                `Model service rate limited; retrying automatically in ${Math.round(
                  backoff.waitMs / 1000
                )}s (attempt ${backoff.attempt}/${MAX_RATE_LIMIT_RETRIES})`
              ),
              pageProgress: 8
            })
            log.warn('[deepagent] rate limit backoff scheduled', {
              sessionId: args.sessionId,
              styleId: args.styleId || '',
              pageId: page.pageId,
              worker: workerLabel,
              rateLimitAttempt: backoff.attempt,
              maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
              waitMs: backoff.waitMs,
              reason
            })
            await sleep(backoff.waitMs, args.signal)
            continue
          }
        }

        if (failure.scope === 'system') break
        if (!failure.retryable || attempt >= MAX_PAGE_RETRIES) break
        const retryAttempt = attempt + 1
        const retryDelayMs = RETRY_DELAY_BASE_MS * retryAttempt
        progress.emitPageStatus({
          pageId: page.pageId,
          label: progressText(args.appLocale, 'retrying'),
          detail: uiText(
            args.appLocale,
            `仅重试失败页：上次失败原因 ${reason}`,
            `Retrying only the failed page. Previous failure: ${reason}`
          ),
          pageProgress: 12
        })
        log.warn('[deepagent] page generation retry scheduled', {
          sessionId: args.sessionId,
          styleId: args.styleId || '',
          pageId: page.pageId,
          worker: workerLabel,
          attempt: retryAttempt,
          maxRetries: MAX_PAGE_RETRIES,
          retryDelayMs,
          lastErrorReason: reason,
          reason
        })
        attempt = retryAttempt
        await sleep(retryDelayMs, args.signal)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          String(lastError ?? uiText(args.appLocale, '页面生成失败', 'Page generation failed'))
        )
  }

  return { generateSinglePage, generateSinglePageWithRetry }
}
