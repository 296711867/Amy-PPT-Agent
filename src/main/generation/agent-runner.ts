/** Generation orchestration: LLM planning + DeepAgent execution. */
import fs from 'fs'
import pLimit from 'p-limit'
import log from 'electron-log/main.js'
import { createSessionDeckAgent, createSessionEditAgent } from '../agent-runtime/agent'
import type { GenerationAgentManager, GenerationModelControl } from './context'
import { runWithModelTemperatureControl } from '../agent-runtime/model'
import {
  buildEditUserPrompt,
  buildSinglePageAgentUserPrompt,
  measurePromptText
} from '../agent-runtime/prompt'
import type {
  AnimationPreferencesPayload,
  DeckEditScope,
  DesignContract,
  GenerateChunkEvent,
  OutlineItem,
  VisualFormat,
  SelectedElementRuntimeContext
} from '@shared/generation'
import { isSectionAgendaOutline } from '@shared/generation'
import { formatLayoutMasterPrompt, resolveLayoutMasterTemplate } from '@shared/layout-master'
import { formatUniversalLayoutPrompt, normalizeUniversalLayoutId } from '@shared/universal-layouts'
import { resolveModelTimeoutMs, type ModelTimeoutProfile } from '@shared/model-timeout'
import { progressLabel, progressText } from '@shared/progress'
import { sleep } from '../ipc/utils'
import {
  createReferenceDocumentRetriever,
  formatReferenceDocumentSnippets
} from './reference-document-retrieval'
import { processAgentStreamCore, type DeckToolStatusChunk } from './agent-stream-processor'
export { planNewPage } from './planning/page-planner'
import { classifyPageMethodSignal } from './method-signals'
import { MAX_RATE_LIMIT_RETRIES, resolveRateLimitBackoff } from './rate-limit-backoff'
import { createRuntimeConcurrencyGate } from './concurrency-gate'
import {
  normalizePageConcurrencyPreference,
  resolvePageWorkerCount,
  type PageConcurrencyPreference
} from '@shared/page-concurrency'
import { buildLocalCompletedGenerationPageSummary } from './generation-summary'
import { readSessionLayoutLibrary } from '../session/master-service'
import { classifyGenerationError, type GenerationFailureInfo } from '@shared/generation-error'
import { createGenerationCircuitBreaker } from '@shared/generation-circuit-breaker'
import { hasCommittedGeneratedPage } from './page-commit'
import {
  buildPageNotWrittenMessage,
  extractHtmlFragmentCandidate,
  extractWriteValidationFailure
} from './page-write-failure'
import { persistPageHtmlFromFragment } from '../presentation/html/page-writer-core'
import { validateAssignedDeckBackground } from './deck-backgrounds'
import { resolveTitleBandAnchor } from './title-band-anchor'
import {
  formatDeckQualityFeedback,
  inspectPresentationDeckQuality,
  type DeckQualityViolation
} from '../presentation/html/deck-quality-validator'
import { resolveIncompleteDeckRenderPages } from './deck-render-gate'
import {
  formatDeckNarrativeFeedback,
  inspectPresentationDeckNarrative,
  type DeckNarrativeViolation
} from '../presentation/html/deck-narrative-validator'
import {
  reviewDeckNarrativeWithLLM,
  selectNarrativeRepairPageIds,
  type NarrativeReviewIssue
} from './deck-narrative-reviewer'

type AppLocale = 'zh' | 'en'

const withModelControl = <T>(modelControl: GenerationModelControl | undefined, task: () => T): T =>
  modelControl ? runWithModelTemperatureControl(modelControl, task) : task()

const uiText = (locale: AppLocale | undefined, zh: string, en: string): string =>
  locale === 'en' ? en : zh

const resolveLayoutMasterOutlineItems = async (
  projectDir: string,
  outlineItems: OutlineItem[]
): Promise<OutlineItem[]> => {
  const layoutLibrary = (await readSessionLayoutLibrary(projectDir)).library
  return outlineItems.map((item) => {
    if (!item.layoutIntent) return item
    const universalLayoutId = normalizeUniversalLayoutId(item.layoutId)
    if (universalLayoutId) {
      return {
        ...item,
        layoutId: universalLayoutId,
        layoutPrompt: formatUniversalLayoutPrompt(universalLayoutId)
      }
    }
    const template = resolveLayoutMasterTemplate(layoutLibrary, item.layoutIntent)
    return {
      ...item,
      layoutId: template.id,
      layoutPrompt: formatLayoutMasterPrompt(template)
    }
  })
}

async function readPageHtmlIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

const modelCallSignal = (
  timeoutMs: unknown,
  profile: ModelTimeoutProfile,
  upstreamSignal?: AbortSignal
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs(timeoutMs, profile))
  return upstreamSignal ? AbortSignal.any([timeoutSignal, upstreamSignal]) : timeoutSignal
}

export { planDeckWithLLM } from './planning/deck-planner'

export { buildDesignContractWithLLM } from './planning/design-contract-builder'

export const runDeepAgentDeckGeneration = async (args: {
  sessionId: string
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelControl?: GenerationModelControl
  styleId: string | null | undefined
  styleSkillPrompt: string
  layoutRulesPrompt: string
  styleKey?: string
  styleName?: string
  styleVersion?: string
  slideSize: import('@shared/slide-size').SlideSizePreset
  appLocale?: AppLocale
  animationPreferences?: AnimationPreferencesPayload | null
  modelTimeoutMs?: number
  topic: string
  deckTitle: string
  userMessage: string
  outlineTitles: string[]
  outlineItems: OutlineItem[]
  sourceDocumentPaths?: string[]
  systemPromptAddendum?: string
  singlePagePromptAddendum?: string
  requireTemplatePageRead?: boolean
  generationMode?: 'generate' | 'retry'
  pageConcurrency?: PageConcurrencyPreference
  renderingLabel?: string
  pageTasks?: Array<{
    pageNumber: number
    pageId: string
    title: string
    contentOutline?: string | null
    layoutIntent?: OutlineItem['layoutIntent']
    contentStructure?: OutlineItem['contentStructure']
    moduleCount?: OutlineItem['moduleCount']
    visualAspect?: OutlineItem['visualAspect']
    contentDensity?: OutlineItem['contentDensity']
    visualFormat?: OutlineItem['visualFormat']
    audienceMove?: OutlineItem['audienceMove']
    layoutId?: OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
    templatePageRole?: string
  }>
  designContract?: DesignContract
  projectDir: string
  indexPath: string
  pageFileMap: Record<string, string>
  pageNumbers?: Record<string, number>
  agentManager: GenerationAgentManager
  emit?: (chunk: GenerateChunkEvent) => void
  onPageCompleted?: (page: {
    pageNumber: number
    pageId: string
    title: string
    contentOutline: string
    layoutIntent?: OutlineItem['layoutIntent']
    layoutId?: OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
    htmlPath: string
  }) => Promise<void>
  onPageFailed?: (page: {
    pageNumber: number
    pageId: string
    title: string
    contentOutline: string
    layoutIntent?: OutlineItem['layoutIntent']
    layoutId?: OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    htmlPath: string
    reason: string
  }) => Promise<void>
  runId?: string
  signal?: AbortSignal
}): Promise<{
  summary: string
  failedPages: Array<{ pageId: string; title: string; reason: string }>
  pendingPages: Array<{ pageId: string; title: string }>
  pause: {
    failure: GenerationFailureInfo
    occurrences: number
  } | null
}> => {
  const layoutLibrary = (await readSessionLayoutLibrary(args.projectDir)).library
  type PageRef = {
    pageNumber: number
    pageId: string
    title: string
    outline: string
    layoutIntent?: OutlineItem['layoutIntent']
    contentStructure?: OutlineItem['contentStructure']
    moduleCount?: OutlineItem['moduleCount']
    visualAspect?: OutlineItem['visualAspect']
    contentDensity?: OutlineItem['contentDensity']
    visualFormat?: VisualFormat
    audienceMove?: string
    layoutId: string
    layoutPrompt: string
    imageAssetPath?: string
    imageAssetPaths?: string[]
    backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
    templatePageRole?: string
  }
  const resolvePageRef = (page: {
    pageNumber: number
    pageId: string
    title: string
    contentOutline?: string | null
    layoutIntent?: OutlineItem['layoutIntent']
    contentStructure?: OutlineItem['contentStructure']
    moduleCount?: OutlineItem['moduleCount']
    visualAspect?: OutlineItem['visualAspect']
    contentDensity?: OutlineItem['contentDensity']
    visualFormat?: OutlineItem['visualFormat']
    audienceMove?: OutlineItem['audienceMove']
    layoutId?: OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
    templatePageRole?: string
  }): PageRef => {
    const universalLayoutId = normalizeUniversalLayoutId(page.layoutId)
    const layoutTemplate = resolveLayoutMasterTemplate(layoutLibrary, page.layoutIntent)
    return {
      pageNumber: page.pageNumber,
      pageId: page.pageId,
      title: page.title,
      outline: page.contentOutline || '',
      layoutIntent: page.layoutIntent,
      contentStructure: page.contentStructure,
      moduleCount: page.moduleCount,
      visualAspect: page.visualAspect,
      contentDensity: page.contentDensity,
      visualFormat: page.visualFormat,
      audienceMove: page.audienceMove,
      layoutId: universalLayoutId || layoutTemplate.id,
      layoutPrompt: universalLayoutId
        ? formatUniversalLayoutPrompt(universalLayoutId)
        : formatLayoutMasterPrompt(layoutTemplate),
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      backgroundAsset: page.backgroundAsset,
      templatePageRole: page.templatePageRole
    }
  }
  const pageRefs: PageRef[] =
    args.pageTasks && args.pageTasks.length > 0
      ? args.pageTasks.map(resolvePageRef)
      : (() => {
          const pageIds = Object.keys(args.pageFileMap || {})
          if (pageIds.length === 0) {
            throw new Error('pageFileMap 为空，无法建立页面任务。')
          }
          return args.outlineTitles.map((title, index) =>
            resolvePageRef({
              pageNumber: index + 1,
              pageId: pageIds[index] || pageIds[Math.min(index, pageIds.length - 1)],
              title,
              contentOutline: args.outlineItems[index]?.contentOutline || '',
              layoutIntent: args.outlineItems[index]?.layoutIntent,
              contentStructure: args.outlineItems[index]?.contentStructure,
              moduleCount: args.outlineItems[index]?.moduleCount,
              visualAspect: args.outlineItems[index]?.visualAspect,
              contentDensity: args.outlineItems[index]?.contentDensity,
              visualFormat: args.outlineItems[index]?.visualFormat,
              audienceMove: args.outlineItems[index]?.audienceMove,
              layoutId: args.outlineItems[index]?.layoutId,
              imageAssetPath: args.outlineItems[index]?.imageAssetPath,
              imageAssetPaths: args.outlineItems[index]?.imageAssetPaths,
              backgroundAsset: args.outlineItems[index]?.backgroundAsset
            })
          )
        })()
  const totalPages = pageRefs.length
  const clampProgress = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))
  const pageSummaryMap = new Map<number, string>()
  const pageConcurrencyPreference: PageConcurrencyPreference = normalizePageConcurrencyPreference(
    args.pageConcurrency
  )
  const initialWorkerCount = resolvePageWorkerCount(pageConcurrencyPreference, totalPages)
  // 限流时把闸门降到 1（只降不升），未开始的页面自动改为逐页生成。
  const pageConcurrencyGate = createRuntimeConcurrencyGate(initialWorkerCount)
  const useDualWorkerQueue = initialWorkerCount === 2
  const pageProgressMap = new Map<string, number>()
  let renderingProgress = 0
  const toRenderingProgress = (target: number): number => {
    const capped = clampProgress(Math.min(90, target))
    renderingProgress = Math.max(renderingProgress, capped)
    return renderingProgress
  }
  const emitRenderingStatus = (input: {
    label: string
    detail?: string
    progress: number
  }): void => {
    args.emit?.({
      type: 'llm_status',
      payload: {
        runId: args.runId || '',
        stage: 'rendering',
        label: input.label,
        detail: input.detail,
        progress: toRenderingProgress(input.progress),
        totalPages,
        provider: args.provider,
        model: args.model
      }
    })
  }

  const setPageProgress = (pageId: string, rawProgress: number): number => {
    const prev = pageProgressMap.get(pageId) ?? 0
    const bounded = Math.max(0, Math.min(100, Math.round(rawProgress)))
    const next = Math.max(prev, bounded)
    pageProgressMap.set(pageId, next)
    return next
  }

  const getCompletedPageCount = (): number =>
    pageRefs.reduce(
      (count, page) => count + ((pageProgressMap.get(page.pageId) ?? 0) >= 100 ? 1 : 0),
      0
    )

  const getOverallRenderProgress = (): number => {
    const sum = pageRefs.reduce((acc, page) => acc + (pageProgressMap.get(page.pageId) ?? 0), 0)
    const ratio = sum / Math.max(1, totalPages * 100)
    return 10 + ratio * 80
  }

  const resolvePageProgressFromCustomStatus = (custom: DeckToolStatusChunk): number => {
    const label = custom.label || ''
    if (/读取会话上下文|Reading session context/i.test(label)) return 25
    if (/更新\s*page-\S+|更新单页\s+\S+|Updating\s+\S+/i.test(label)) return 60
    if (/验证完成状态|Verifying completion/i.test(label)) return 85
    if (/所有页面已填充|当前页面已填充|All pages filled|Current page filled/i.test(label)) return 95
    if (/生成完成|修改完成|Generation completed|Edit completed/i.test(label)) return 100
    if (Number.isFinite(custom.progress)) {
      const raw = Number(custom.progress)
      return Math.max(12, Math.min(96, raw))
    }
    return 50
  }

  const emitPageStatus = (args: {
    pageId: string
    label: string
    detail?: string
    pageProgress: number
  }): void => {
    setPageProgress(args.pageId, args.pageProgress)
    emitRenderingStatus({
      label: args.label,
      detail: args.detail,
      progress: getOverallRenderProgress()
    })
  }

  const renderingLabel = args.renderingLabel || progressText(args.appLocale, 'generating')

  emitRenderingStatus({
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

  const generateSinglePage = async (
    page: PageRef,
    workerLabel: string,
    retryContext?: {
      attempt: number
      maxRetries: number
      previousError: string
    },
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

    emitPageStatus({
      pageId: page.pageId,
      label: renderingLabel,
      detail: `${page.pageId} · ${page.title}`,
      pageProgress: 5
    })
    args.emit?.({
      type: 'page_started',
      payload: {
        runId: args.runId || '',
        stage: 'rendering',
        label: renderingLabel,
        progress: getOverallRenderProgress(),
        currentPage: page.pageNumber,
        totalPages,
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
      referenceDocumentRetriever && !isSectionAgendaPage
        ? formatReferenceDocumentSnippets(
            referenceDocumentRetriever.search({
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
      hasRetriever: Boolean(referenceDocumentRetriever),
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
              ...pageRefs
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
      const stream = await deepAgent.stream(
        {
          messages: [
            {
              role: 'user',
              content: userPrompt
            }
          ]
        },
        {
          streamMode: ['updates', 'messages', 'custom'],
          subgraphs: true,
          signal: combinedSignal
        }
      )

      // Final user-facing generation replies are built later from validated page facts.
      // Raw messages may be token deltas, tool-call turns, or cumulative provider chunks.
      let streamError: unknown = null
      let lastWriteValidationFailure = ''
      let finalAssistantText = ''
      try {
        const streamOutcome = await processAgentStreamCore(stream, {
          emit: args.emit,
          runId: args.runId || '',
          stage: 'rendering',
          totalPages,
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
            emitPageStatus({
              pageId: page.pageId,
              label:
                normalizedLabel === progressText(args.appLocale, 'generating')
                  ? renderingLabel
                  : normalizedLabel,
              detail: normalizedDetail,
              pageProgress: mappedPageProgress
            })
          },
          onModelThinking: (defaultProgress) => {
            const mappedPageProgress = Math.max(12, Math.min(96, defaultProgress))
            emitPageStatus({
              pageId: page.pageId,
              label: renderingLabel,
              detail: page.title,
              pageProgress: mappedPageProgress
            })
          }
        })
        finalAssistantText = streamOutcome.finalAssistantText
      } catch (error) {
        streamError = error
      }

      let afterPageHtml = await readPageHtmlIfExists(currentPagePath)
      let pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)
      if (!pageCommitted && !streamError) {
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
            emitPageStatus({
              pageId: page.pageId,
              label: renderingLabel,
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
        } else {
          log.warn('[deepagent] page not written; final assistant text preview', {
            sessionId: args.sessionId,
            pageId: page.pageId,
            worker: workerLabel,
            preview: finalAssistantText.slice(0, 400)
          })
        }
      }
      if (streamError && !pageCommitted) throw streamError
      if (!pageCommitted) {
        throw new Error(
          buildPageNotWrittenMessage({
            pageId: page.pageId,
            writeToolName,
            lastWriteValidationFailure
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
        emitPageStatus({
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

      emitPageStatus({
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
        layoutId: page.layoutId,
        imageAssetPath: page.imageAssetPath,
        imageAssetPaths: page.imageAssetPaths,
        backgroundAsset: page.backgroundAsset,
        htmlPath: currentPagePath
      })

      setPageProgress(page.pageId, 100)
      const completedCount = getCompletedPageCount()
      emitRenderingStatus({
        label: progressText(args.appLocale, 'completed'),
        detail: uiText(
          args.appLocale,
          `${page.title} · 已完成 ${completedCount}/${totalPages} 页`,
          `${page.title} · ${completedCount}/${totalPages} pages completed`
        ),
        progress: getOverallRenderProgress()
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
            if (pageConcurrencyGate.capacity > 1) {
              pageConcurrencyGate.downgradeCapacity(1)
              log.warn('[deepagent] rate limit downgraded page concurrency to serial', {
                sessionId: args.sessionId,
                styleId: args.styleId || '',
                pageId: page.pageId,
                worker: workerLabel,
                preference: pageConcurrencyPreference
              })
            }
            emitPageStatus({
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
        emitPageStatus({
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

  const workerCount = useDualWorkerQueue ? 2 : 1
  const PAGE_GENERATION_STAGGER_MS = 500
  if (useDualWorkerQueue) {
    emitRenderingStatus({
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
              log.error('[deepagent] system failure opened page generation circuit', {
                sessionId: args.sessionId,
                provider: args.provider,
                model: args.model,
                pageId: page.pageId,
                code: failure.code,
                fingerprint: failure.fingerprint,
                occurrences: circuitState.occurrences
              })
            }
            args.emit?.({
              type: 'page_failed',
              payload: {
                runId: args.runId || '',
                stage: 'rendering',
                label: progressText(args.appLocale, 'failed'),
                progress: getOverallRenderProgress(),
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
  const failedPages: Array<{ pageId: string; title: string; reason: string }> = []
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
  let deckQualityWarnings: DeckQualityViolation[] = []
  let deckNarrativeWarnings: Array<DeckNarrativeViolation | NarrativeReviewIssue> = []
  const canReviewCompleteDeck =
    args.generationMode !== 'retry' &&
    !circuitBreaker.getState().paused &&
    failedPages.length === 0 &&
    pageRefs.length >= 2
  if (canReviewCompleteDeck) {
    emitRenderingStatus({
      label: progressLabel(args.appLocale, '检查整套一致性'),
      detail: uiText(
        args.appLocale,
        '正在检查跨页字体、配色、标题、留白、密度和版式节奏',
        'Checking cross-slide typography, palette, titles, margins, density, and layout rhythm'
      ),
      progress: 90
    })
    const inspectDeck = (): ReturnType<typeof inspectPresentationDeckQuality> =>
      inspectPresentationDeckQuality({
        pages: pageRefs.map((page) => ({
          pageId: page.pageId,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: args.pageFileMap[page.pageId] || '',
          layoutIntent: page.layoutIntent
        })),
        slideSize: args.slideSize,
        designContract: args.designContract,
        preserveTemplate: args.requireTemplatePageRead
      })
    let deckReport = await inspectDeck()
    log.info('[deepagent] deck quality review completed', {
      sessionId: args.sessionId,
      styleId: args.styleId || '',
      reviewedPages: deckReport.pages.length,
      unavailablePages: deckReport.unavailablePages,
      violations: deckReport.violations.map((violation) => ({
        code: violation.code,
        severity: violation.severity,
        pageIds: violation.pageIds
      }))
    })

    const incompleteRenderPages = resolveIncompleteDeckRenderPages(deckReport)
    for (const unavailable of incompleteRenderPages) {
      const page = pageRefs.find((candidate) => candidate.pageId === unavailable.pageId)
      if (!page || failedPages.some((failure) => failure.pageId === page.pageId)) continue
      const reason = uiText(
        args.appLocale,
        `浏览器渲染验收不可用：${unavailable.reason}。本页未被视为生成完成。`,
        `Browser render validation was unavailable: ${unavailable.reason}. This slide was not accepted as complete.`
      )
      failedPages.push({ pageId: page.pageId, title: page.title, reason })
      await args.onPageFailed?.({
        pageNumber: page.pageNumber,
        pageId: page.pageId,
        title: page.title,
        contentOutline: page.outline,
        layoutIntent: page.layoutIntent,
        layoutId: page.layoutId,
        imageAssetPath: page.imageAssetPath,
        imageAssetPaths: page.imageAssetPaths,
        htmlPath: args.pageFileMap[page.pageId] || '',
        reason
      })
    }

    const hardViolations = deckReport.available
      ? deckReport.violations.filter((violation) => violation.severity === 'error')
      : []
    const repairPageIds = Array.from(
      new Set(hardViolations.flatMap((violation) => violation.pageIds))
    )
    for (const pageId of repairPageIds) {
      if (args.signal?.aborted) {
        throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
      }
      const page = pageRefs.find((candidate) => candidate.pageId === pageId)
      if (!page) continue
      const feedback = formatDeckQualityFeedback(hardViolations, pageId)
      emitPageStatus({
        pageId,
        label: progressLabel(args.appLocale, '修复整套一致性'),
        detail: uiText(
          args.appLocale,
          `${page.title} · 正在按 Deck 评审修复`,
          `${page.title} · repairing deck-level consistency`
        ),
        pageProgress: 18
      })
      try {
        await generateSinglePage(
          page,
          'deck-quality-repair',
          { attempt: 1, maxRetries: 1, previousError: feedback },
          [
            'You are performing one bounded deck-level quality repair.',
            "Keep this slide's narrative job, facts, and intended layout. Do not redesign unrelated content.",
            'IMPORTANT: First read the existing page HTML with read_file, then make ONLY the targeted fixes listed below.',
            'Preserve all content, facts, and layout elements that were correct in the previous version.',
            'Do not rewrite the entire page from scratch — fix only the failing elements.',
            feedback
          ].join('\n')
        )
      } catch (error) {
        const reason = `Deck 质量定向修复失败：${error instanceof Error ? error.message : String(error)}`
        failedPages.push({ pageId, title: page.title, reason })
        await args.onPageFailed?.({
          pageNumber: page.pageNumber,
          pageId,
          title: page.title,
          contentOutline: page.outline,
          layoutIntent: page.layoutIntent,
          layoutId: page.layoutId,
          imageAssetPath: page.imageAssetPath,
          imageAssetPaths: page.imageAssetPaths,
          htmlPath: args.pageFileMap[pageId] || '',
          reason
        })
      }
    }

    if (repairPageIds.length > 0 && failedPages.length === 0) {
      deckReport = await inspectDeck()
    }
    const remainingHardViolations = deckReport.violations.filter(
      (violation) => violation.severity === 'error'
    )
    for (const pageId of new Set(remainingHardViolations.flatMap((item) => item.pageIds))) {
      if (failedPages.some((failure) => failure.pageId === pageId)) continue
      const page = pageRefs.find((candidate) => candidate.pageId === pageId)
      if (!page) continue
      const reason = formatDeckQualityFeedback(remainingHardViolations, pageId)
      failedPages.push({ pageId, title: page.title, reason })
      await args.onPageFailed?.({
        pageNumber: page.pageNumber,
        pageId,
        title: page.title,
        contentOutline: page.outline,
        layoutIntent: page.layoutIntent,
        layoutId: page.layoutId,
        imageAssetPath: page.imageAssetPath,
        imageAssetPaths: page.imageAssetPaths,
        htmlPath: args.pageFileMap[pageId] || '',
        reason
      })
    }
    deckQualityWarnings = deckReport.violations.filter((violation) => violation.severity === 'warn')
    emitRenderingStatus({
      label: progressLabel(
        args.appLocale,
        deckReport.available ? '整套一致性检查完成' : '整套一致性检查未完成'
      ),
      detail: !deckReport.available
        ? incompleteRenderPages.length > 0
          ? uiText(
              args.appLocale,
              `跨页浏览器验收未完成，${incompleteRenderPages.length} 页已标记为失败，待渲染恢复后重试`,
              `Cross-slide browser validation was incomplete; ${incompleteRenderPages.length} slides were marked failed for retry`
            )
          : uiText(
              args.appLocale,
              '跨页浏览器验收暂不可用，已保留通过落盘校验的页面并记录非阻断警告',
              'Cross-slide browser validation was unavailable; statically valid slides were kept with a non-blocking advisory'
            )
        : deckQualityWarnings.length > 0
          ? uiText(
              args.appLocale,
              `已完成 Deck 评审，记录 ${deckQualityWarnings.length} 项非阻断优化建议`,
              `Deck review completed with ${deckQualityWarnings.length} non-blocking advisories`
            )
          : uiText(
              args.appLocale,
              '跨页字体、配色、标题、留白和版式节奏检查通过',
              'Cross-slide typography, palette, title, margin, and rhythm checks passed'
            ),
      progress: 90
    })

    if (failedPages.length === 0) {
      emitRenderingStatus({
        label: progressLabel(args.appLocale, '检查内容与叙事'),
        detail: uiText(
          args.appLocale,
          '正在检查开场、页面职责、证据解释、叙事推进与结尾行动',
          'Checking the opening, slide jobs, evidence interpretation, narrative flow, and close'
        ),
        progress: 91
      })
      const inspectNarrative = (): ReturnType<typeof inspectPresentationDeckNarrative> =>
        inspectPresentationDeckNarrative({
          pages: pageRefs.map((page) => ({
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            title: page.title,
            htmlPath: args.pageFileMap[page.pageId] || '',
            layoutIntent: page.layoutIntent
          }))
        })
      let narrativeReport = await inspectNarrative()
      const semanticReview = await reviewDeckNarrativeWithLLM({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        baseUrl: args.baseUrl,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        modelRuntime: args.agentManager.getSession(args.sessionId)?.modelRuntime,
        modelTimeoutMs: args.modelTimeoutMs,
        signal: args.signal,
        topic: args.topic,
        deckTitle: args.deckTitle,
        userMessage: args.userMessage,
        outlineItems: pageRefs.map((page) => ({
          title: page.title,
          contentOutline: page.outline,
          layoutIntent: page.layoutIntent
        })),
        pages: narrativeReport.pages
      })
      if (args.signal?.aborted) {
        throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
      }
      if (!semanticReview.available) {
        log.warn('[deepagent] semantic narrative review unavailable', {
          sessionId: args.sessionId,
          reason: semanticReview.unavailableReason
        })
      }
      const deterministicHardIssues = narrativeReport.violations.filter(
        (violation) => violation.severity === 'error'
      )
      const semanticHardIssues = semanticReview.issues.filter(
        (violation) => violation.severity === 'error'
      )
      const repairPageIds = selectNarrativeRepairPageIds({
        deterministicIssues: deterministicHardIssues,
        semanticIssues: semanticHardIssues,
        maxPages: 2
      })
      for (const pageId of repairPageIds) {
        if (args.signal?.aborted) {
          throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
        }
        const page = pageRefs.find((candidate) => candidate.pageId === pageId)
        if (!page) continue
        const assignedIssues = [...deterministicHardIssues, ...semanticHardIssues].filter(
          (violation) => violation.pageIds.includes(pageId)
        )
        const feedback = formatDeckNarrativeFeedback(assignedIssues, pageId)
        emitPageStatus({
          pageId,
          label: progressLabel(args.appLocale, '修复内容与叙事'),
          detail: uiText(
            args.appLocale,
            `${page.title} · 正在按叙事评审定向修复`,
            `${page.title} · repairing narrative findings`
          ),
          pageProgress: 18
        })
        try {
          await generateSinglePage(
            page,
            'deck-narrative-repair',
            { attempt: 1, maxRetries: 1, previousError: feedback },
            [
              'You are performing one bounded narrative repair on this slide.',
              "Preserve verified facts, the slide's visual system, and its intended role.",
              'IMPORTANT: First read the existing page HTML with read_file, then fix only the narrative defects listed below.',
              'Do not rewrite the entire page from scratch — preserve all correct content and make surgical fixes.',
              feedback
            ].join('\n')
          )
        } catch (error) {
          log.warn('[deepagent] narrative repair failed without aborting deck generation', {
            sessionId: args.sessionId,
            pageId,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (repairPageIds.length > 0) narrativeReport = await inspectNarrative()
      deckNarrativeWarnings = [
        ...narrativeReport.violations.filter((violation) => violation.severity === 'warn'),
        ...semanticReview.issues.filter((violation) => violation.severity === 'warn')
      ]
      const remainingNarrativeErrors = narrativeReport.violations.filter(
        (violation) => violation.severity === 'error'
      )
      deckNarrativeWarnings.push(...remainingNarrativeErrors)
      log.info('[deepagent] deck narrative review completed', {
        sessionId: args.sessionId,
        staticIssues: narrativeReport.violations.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          pageIds: issue.pageIds
        })),
        semanticAvailable: semanticReview.available,
        semanticIssues: semanticReview.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          confidence: issue.confidence,
          pageIds: issue.pageIds
        })),
        repairedPageIds: repairPageIds
      })
    }
  }
  const pendingPages = pageRefs
    .filter((page) => !dispatchedPageIds.has(page.pageId))
    .map((page) => ({ pageId: page.pageId, title: page.title }))
  const circuitState = circuitBreaker.getState()
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

type RunDeepAgentEditBaseArgs = {
  sessionId: string
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelControl?: GenerationModelControl
  styleId: string | null | undefined
  styleSkillPrompt: string
  layoutRulesPrompt: string
  styleKey?: string
  styleName?: string
  styleVersion?: string
  slideSize: import('@shared/slide-size').SlideSizePreset
  appLocale?: AppLocale
  modelTimeoutMs?: number
  topic: string
  deckTitle: string
  userMessage: string
  outlineTitles: string[]
  outlineItems: OutlineItem[]
  sourceDocumentPaths?: string[]
  projectDir: string
  indexPath: string
  pageFileMap: Record<string, string>
  pageNumbers?: Record<string, number>
  selectPageIds?: string[]
  designContract?: DesignContract
  existingPageIds?: string[]
  agentManager: GenerationAgentManager
  emit?: (chunk: GenerateChunkEvent) => void
  runId?: string
  signal?: AbortSignal
}

type RunDeepAgentScopedEditArgs = RunDeepAgentEditBaseArgs & {
  editScope: DeckEditScope
  selectedPageId?: string
  selectedPageNumber?: number
  selectedSelector?: string
  elementTag?: string
  elementText?: string
  selectedElementContext?: SelectedElementRuntimeContext
}

type RunDeepAgentPageEditArgs = RunDeepAgentEditBaseArgs & {
  editScope: Exclude<DeckEditScope, 'deck'>
  selectedPageId?: string
  selectedPageNumber?: number
  selectedSelector?: string
  elementTag?: string
  elementText?: string
  selectedElementContext?: SelectedElementRuntimeContext
}

type RunDeepAgentDeckAllPageEditArgs = RunDeepAgentEditBaseArgs

const runDeepAgentScopedEdit = async (args: RunDeepAgentScopedEditArgs): Promise<void> => {
  const appliesLayoutMaster =
    args.editScope === 'deck' || (args.editScope === 'page' && !args.selectedSelector)
  const outlineItems = appliesLayoutMaster
    ? await resolveLayoutMasterOutlineItems(args.projectDir, args.outlineItems)
    : args.outlineItems
  const editAgent = withModelControl(args.modelControl, () =>
    createSessionEditAgent({
      provider: args.provider,
      apiKey: args.apiKey,
      model: args.model,
      baseUrl: args.baseUrl,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      modelRuntime: args.agentManager.getSession(args.sessionId)?.modelRuntime,
      styleId: args.styleId,
      context: {
        mode: 'edit',
        editScope: args.editScope,
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
        designContract: args.designContract,
        userMessage: args.userMessage,
        outlineTitles: args.outlineTitles,
        outlineItems,
        sourceDocumentPaths: args.sourceDocumentPaths,
        pageFileMap: args.pageFileMap,
        pageNumbers: args.pageNumbers,
        selectPageIds: args.selectPageIds,
        selectedPageId: args.selectedPageId,
        selectedPageNumber: args.selectedPageNumber,
        selectedSelector: args.selectedSelector,
        elementTag: args.elementTag,
        elementText: args.elementText,
        selectedElementContext: args.selectedElementContext,
        existingPageIds: args.existingPageIds,
        allowedPageIds:
          args.editScope === 'page' && args.selectedPageId
            ? [args.selectedPageId]
            : args.editScope === 'deck'
              ? Object.keys(args.pageFileMap)
              : undefined
      }
    })
  )
  const concurrentDeckPageId =
    args.editScope === 'deck' && args.selectPageIds?.length === 1
      ? args.selectPageIds[0]
      : undefined
  if (concurrentDeckPageId) {
    args.agentManager.setPageAgent(args.sessionId, concurrentDeckPageId, editAgent)
  } else {
    args.agentManager.setAgent(args.sessionId, editAgent)
  }

  args.emit?.({
    type: 'llm_status',
    payload: {
      runId: args.runId || '',
      stage: 'editing',
      label: concurrentDeckPageId
        ? uiText(
            args.appLocale,
            `正在启动页面 ${concurrentDeckPageId} 的编辑`,
            `Starting edit for page ${concurrentDeckPageId}`
          )
        : progressText(args.appLocale, 'generating'),
      progress: 40,
      totalPages: args.outlineTitles.length,
      provider: args.provider,
      model: args.model,
      detail:
        args.editScope === 'presentation-container'
          ? uiText(
              args.appLocale,
              '仅修改演示容器配置，不会改动 page 页面内容',
              'Only modifying the presentation container; page content will not be changed'
            )
          : args.editScope === 'deck'
            ? uiText(
                args.appLocale,
                '正在按主会话指令修改页面',
                'Editing pages from the main-session instruction'
              )
            : uiText(
                args.appLocale,
                '仅修改目标页面，不会重排整套内容',
                'Only modifying the target page; the whole deck will not be rearranged'
              )
    }
  })

  log.info('[deepagent] invoke edit agent', {
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    temperature: args.temperature ?? null,
    styleId: args.styleId || '',
    projectDir: args.projectDir,
    indexPath: args.indexPath,
    editScope: args.editScope,
    selectedPageId: args.selectedPageId,
    selectedPageNumber: args.selectedPageNumber,
    concurrentDeckPageId,
    selectedSelector: args.selectedSelector || '',
    elementTag: args.elementTag || '',
    elementText: args.elementText || ''
  })

  const scopedEditPageIds =
    args.selectPageIds && args.selectPageIds.length > 0
      ? args.selectPageIds
      : args.selectedPageId
        ? [args.selectedPageId]
        : Object.keys(args.pageFileMap)
  const editPageNumberById = new Map(scopedEditPageIds.map((pageId, index) => [pageId, index + 1]))
  const totalPages = Math.max(1, scopedEditPageIds.length)
  let editProgress = 40
  const emitEditStatus = (payload: {
    label: string
    detail?: string
    progress?: number
    currentPage?: number
  }): void => {
    const bounded = Math.max(0, Math.min(100, Math.round(payload.progress ?? editProgress)))
    editProgress = Math.max(editProgress, bounded)
    args.emit?.({
      type: 'llm_status',
      payload: {
        runId: args.runId || '',
        stage: 'editing',
        label: payload.label,
        detail: payload.detail,
        progress: editProgress,
        currentPage: payload.currentPage,
        totalPages,
        provider: args.provider,
        model: args.model
      }
    })
  }

  try {
    const editCombinedSignal = modelCallSignal(args.modelTimeoutMs, 'agent', args.signal)
    const stream = await editAgent.stream(
      {
        messages: [
          {
            role: 'user',
            content: buildEditUserPrompt({
              userMessage: args.userMessage,
              editScope: args.editScope,
              selectedPageId: args.selectedPageId,
              selectedPageNumber: args.selectedPageNumber,
              selectedSelector: args.selectedSelector,
              elementTag: args.elementTag,
              elementText: args.elementText,
              selectedElementContext: args.selectedElementContext,
              existingPageIds: args.existingPageIds
            })
          }
        ]
      },
      {
        streamMode: ['updates', 'messages', 'custom'],
        subgraphs: true,
        signal: editCombinedSignal
      }
    )

    // Edit replies are built later from validated changed-page facts.
    await processAgentStreamCore(stream, {
      emit: args.emit,
      runId: args.runId || '',
      stage: 'editing',
      totalPages,
      provider: args.provider,
      model: args.model,
      sessionId: args.sessionId,
      workerLabel: concurrentDeckPageId,
      onCustom: (custom) => {
        emitEditStatus({
          label: progressLabel(args.appLocale, custom.label),
          detail: custom.detail,
          progress: custom.progress ?? 50,
          currentPage: custom.pageId ? editPageNumberById.get(custom.pageId) : undefined
        })
      },
      onModelThinking: (defaultProgress) => {
        emitEditStatus({
          label: concurrentDeckPageId
            ? uiText(
                args.appLocale,
                `正在编辑页面 ${concurrentDeckPageId}`,
                `Editing page ${concurrentDeckPageId}`
              )
            : progressText(args.appLocale, 'understanding'),
          detail: concurrentDeckPageId
            ? uiText(
                args.appLocale,
                '正在生成并校验当前页面',
                'Generating and validating the current page'
              )
            : uiText(
                args.appLocale,
                '正在规划最小改动路径',
                'Planning the smallest safe edit path'
              ),
          progress: defaultProgress
        })
      }
    })
  } finally {
    if (concurrentDeckPageId) {
      args.agentManager.removePageAgent(args.sessionId, concurrentDeckPageId)
    } else {
      args.agentManager.clearCachedAgent(args.sessionId)
    }
  }

  log.info('[deepagent] edit agent completed', {
    sessionId: args.sessionId,
    styleId: args.styleId || '',
    concurrentDeckPageId
  })
}

export const runDeepAgentEdit = async (args: RunDeepAgentPageEditArgs): Promise<void> =>
  runDeepAgentScopedEdit(args)

export const runDeepAgentDeckAllPageEdit = async (
  args: RunDeepAgentDeckAllPageEditArgs
): Promise<void> =>
  runDeepAgentScopedEdit({
    ...args,
    editScope: 'deck',
    selectedPageId: undefined,
    selectedPageNumber: undefined,
    selectedSelector: undefined,
    elementTag: undefined,
    elementText: undefined
  })
