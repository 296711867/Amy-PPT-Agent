import type { DeckContext, EmitAssistantFn } from './types'
import { uiText } from './generation-utils'
import { finalizeGenerationSuccess } from './finalization'
import { runVisualDeckReview } from './visual-review'
import { progressText } from '@shared/progress'
import path from 'path'
import fs from 'fs'
import log from 'electron-log/main.js'
import { type LayoutIntent } from '@shared/layout-intent'
import { isPlaceholderPageHtml, validatePersistedPageHtml } from '../presentation/html/html-utils'
import { buildProjectIndexHtml, type DeckPageFile } from '../session/template-builder'
import {
  buildDesignContractWithLLM,
  planDeckWithLLM,
  runDeepAgentDeckGeneration
} from './agent-runner'
import type { GeneratedPagePayload } from '@shared/generation'
import { customAlphabet, nanoid } from 'nanoid'
import {
  buildOutlineTitles,
  buildTotalPages,
  type GenerationContext,
  normalizeGeneratePayload,
  type RuntimeJobExecutionContext,
  resolveCommonContext,
  resolveSourceDocuments
} from './context'
import { canUseSourcePlanDirectly, mapSourcePlanToOutlineItems } from './source-plan'
import { retireActiveSessionPagesForReplacement } from './session-page-replacement'
import { prepareDeckImageAssets } from './deck-images'
import { assignDeckBackgroundAssets, prepareDeckBackgroundAssets } from './deck-backgrounds'
import { assignLayoutAssetsToOutline } from '@shared/layout-asset'
import { blankMetricSlots, fillLayoutAsset } from '../layout-assets/fill'
import {
  ensureLayoutLibrary,
  readLayoutManifest,
  readLayoutSkeleton
} from '../layout-assets/library'
import { createWorkflowTelemetry } from './workflow-telemetry'
import { validateAssetIntegrity } from './asset-integrity'
import { diversifyUniversalLayoutSequence } from '@shared/universal-layouts'
import { mergeSessionMetadata } from './metadata-parser'

const pageSlugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10)

export async function resolveDeckContext(
  ctx: GenerationContext,
  _event: Electron.IpcMainInvokeEvent,
  payload: unknown,
  execution?: RuntimeJobExecutionContext
): Promise<DeckContext> {
  const input = normalizeGeneratePayload(payload)
  const { db, localFiles } = ctx
  if (!input.sessionId) throw new Error('sessionId 不能为空')

  const common = await resolveCommonContext(ctx, input.sessionId, input.modelConfigId, execution)
  const userMessage = `${input.rawUserMessage}${localFiles.formatImagePathsForPrompt([])}`
  const userProvidedOutlineTitles = buildOutlineTitles(input.rawUserMessage)
  const totalPages = buildTotalPages(common.sessionRecord)
  const sourceDocumentPaths = await resolveSourceDocuments(ctx, {
    sessionId: input.sessionId,
    projectDir: common.projectDir,
    rawDocPaths: input.rawDocPaths,
    mode: 'generate',
    sessionRecord: common.sessionRecord
  })

  await db.addMessage(input.sessionId, {
    role: 'user',
    content: input.rawUserMessage,
    type: 'text',
    chat_scope: 'main',
    image_paths: [],
    run_model: common.runModel
  })
  await db.updateSessionStatus(input.sessionId, 'active')

  return {
    sessionId: input.sessionId,
    userMessage,
    requestedType: input.requestedType,
    effectiveMode: 'generate',
    selectedPageId: undefined,
    selectPageIds: [],
    htmlPath: undefined,
    selector: undefined,
    elementTag: undefined,
    elementText: undefined,
    session: common.session,
    sessionRecord: common.sessionRecord,
    previousSessionStatus: common.previousSessionStatus,
    projectDir: common.projectDir,
    abortSignal: common.abortSignal,
    runId: common.runId,
    styleId: common.styleId,
    styleSkill: common.styleSkill,
    layoutRulesPrompt: common.layoutRulesPrompt,
    styleKey: common.styleKey,
    styleName: common.styleName,
    styleVersion: common.styleVersion,
    slideSize: common.slideSize,
    userProvidedOutlineTitles,
    totalPages,
    provider: common.provider,
    apiKey: common.apiKey,
    model: common.model,
    modelConfigId: common.modelConfigId,
    modelConfigName: common.modelConfigName,
    modelControl: common.modelControl,
    runModel: common.runModel,
    modelTimeouts: common.modelTimeouts,
    pageConcurrency: common.pageConcurrency,
    providerBaseUrl: common.providerBaseUrl,
    maxTokens: common.maxTokens,
    modelRuntime: common.modelRuntime,
    projectId: common.projectId,
    messageScope: 'main',
    messagePageId: undefined,
    imagePaths: [],
    videoPaths: [],
    sourceDocumentPaths,
    sourcePlan: common.sourcePlan,
    topic: common.topic,
    deckTitle: common.deckTitle,
    appLocale: common.appLocale,
    fontSelection: common.fontSelection,
    imagePolicy: common.imagePolicy,
    generationMode: common.generationMode,
    deckBackgroundPolicy: common.deckBackgroundPolicy,
    animationPreferences: input.animationPreferences
  }
}

export async function executeDeckGeneration(
  ctx: GenerationContext,
  emitAssistant: EmitAssistantFn,
  context: DeckContext
): Promise<void> {
  const {
    db,
    agentManager,
    sessionProject: { getPageSourceUrl, validateProjectIndexHtml },
    runtimeEmitters: { createDeckProgressEmitter },
    sessionScaffold: { scaffoldProjectFiles },
    tuning: {
      plannerTemperature: PLANNER_TEMPERATURE,
      designContractTemperature: DESIGN_CONTRACT_TEMPERATURE,
      pageGenerationTemperature: PAGE_GENERATION_TEMPERATURE
    }
  } = ctx
  const buildSessionMetadata = (patch: Record<string, unknown>) =>
    mergeSessionMetadata(
      String(context.sessionRecord.metadata ?? context.sessionRecord.metadata_json ?? ''),
      {
        fontSelection: context.fontSelection,
        imagePolicy: context.imagePolicy,
        deckBackgroundPolicy: context.deckBackgroundPolicy,
        ...patch
      }
    )

  if (!context.apiKey) {
    throw new Error(`当前 provider "${context.provider}" 缺少 API Key，请先到设置页配置。`)
  }

  // 工作流遥测：按阶段记录耗时和重试，写入 generation_run metadata
  const telemetry = createWorkflowTelemetry()

  const emitDeckChunk = createDeckProgressEmitter(context.sessionId, context.appLocale)

  emitDeckChunk({
    type: 'stage_started',
    payload: {
      runId: context.runId,
      stage: 'preflight',
      label: progressText(context.appLocale, 'understanding'),
      progress: 2,
      totalPages: context.totalPages
    }
  })
  await db.addMessage(context.sessionId, {
    role: 'system',
    content: uiText(
      context.appLocale,
      '正在梳理需求并准备生成画布。',
      'Organizing requirements and preparing the canvas.'
    ),
    type: 'stream_chunk',
    chat_scope: context.messageScope,
    page_id: context.messagePageId,
    run_model: context.runModel
  })

  const pageRefs = Array.from({ length: context.totalPages }, (_unused, index) => {
    const pageNumber = index + 1
    const id = nanoid()
    const pageId = `page-${pageSlugId()}`
    const htmlPath = path.join(context.projectDir, `${pageId}.html`)
    const fallbackTitle = context.userProvidedOutlineTitles[index] || `Slide ${pageNumber}`
    return { id, pageNumber, title: fallbackTitle, pageId, htmlPath }
  })
  const indexPath = path.join(context.projectDir, 'index.html')
  await db.createGenerationRun({
    id: context.runId,
    sessionId: context.sessionId,
    mode: 'generate',
    totalPages: pageRefs.length,
    modelConfigId: context.modelConfigId,
    animationPreferences: context.animationPreferences,
    metadata: {
      topic: context.topic,
      styleId: context.styleId,
      modelConfigId: context.modelConfigId,
      modelConfigName: context.modelConfigName,
      provider: context.provider,
      model: context.model,
      projectDir: context.projectDir,
      indexPath
    }
  })

  emitDeckChunk({
    type: 'stage_progress',
    payload: {
      runId: context.runId,
      stage: 'planning',
      label: progressText(context.appLocale, 'planning'),
      progress: 6,
      totalPages: context.totalPages
    }
  })
  const scaffoldPromise = scaffoldProjectFiles({
    deckTitle: context.deckTitle,
    indexPath,
    pages: pageRefs,
    slideSize: context.slideSize
  }).then(() => {
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'preflight',
        label: progressText(context.appLocale, 'preparing'),
        progress: 4,
        totalPages: pageRefs.length,
        detail: uiText(
          context.appLocale,
          `已创建 index.html 与 ${pageRefs.length} 个页面骨架`,
          `Created index.html and ${pageRefs.length} page shells`
        )
      }
    })
  })
  const tScaffold = telemetry.begin('page-scaffold', { pages: pageRefs.length })
  scaffoldPromise.then(() => tScaffold.finish(true), () => tScaffold.finish(false))

  const shouldUseSourcePlan = canUseSourcePlanDirectly({
    sourcePlan: context.sourcePlan,
    totalPages: pageRefs.length,
    userMessage: context.userMessage
  })
  const tPlanning = telemetry.begin('planning', { sourcePlan: shouldUseSourcePlan })
  const plannerPromise = Promise.resolve(
    shouldUseSourcePlan && context.sourcePlan
      ? mapSourcePlanToOutlineItems(context.sourcePlan)
      : planDeckWithLLM({
          provider: context.provider,
          apiKey: context.apiKey,
          model: context.model,
          baseUrl: context.providerBaseUrl,
          maxTokens: context.maxTokens,
          modelRuntime: context.modelRuntime,
          modelControl: context.modelControl,
          modelTimeoutMs: context.modelTimeouts.planning,
          temperature: PLANNER_TEMPERATURE,
          styleId: context.styleId,
          totalPages: pageRefs.length,
          appLocale: context.appLocale,
          topic: context.topic,
          userMessage: context.userMessage,
          sourceDocumentPaths: context.sourceDocumentPaths,
          emit: (chunk) => emitDeckChunk(chunk),
          runId: context.runId,
          signal: context.abortSignal
        })
  ).then(
    (result) => {
      tPlanning.finish(true, { pages: result.length })
      return result
    },
    (error) => {
      tPlanning.finish(false)
      throw error
    }
  )
  if (shouldUseSourcePlan) {
    log.info('[generate:deck] using source page skeleton as outline plan', {
      sessionId: context.sessionId,
      pageCount: pageRefs.length,
      sourceDocumentPath: context.sourcePlan?.sourceDocumentPath ?? null
    })
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'planning',
        label: progressText(context.appLocale, 'planning'),
        progress: 9,
        totalPages: pageRefs.length,
        detail: uiText(
          context.appLocale,
          `已使用源文档结构生成 ${pageRefs.length} 页计划`,
          `Using source document structure for ${pageRefs.length} slide plans`
        )
      }
    })
  }
  // 设计契约不再人为延迟：与规划并行，尽早解锁后续步骤。
  const tDesign = telemetry.begin('design-contract')
  const designContractPromise = buildDesignContractWithLLM({
      provider: context.provider,
      apiKey: context.apiKey,
      model: context.model,
      baseUrl: context.providerBaseUrl,
      maxTokens: context.maxTokens,
      modelRuntime: context.modelRuntime,
      modelControl: context.modelControl,
      modelTimeoutMs: context.modelTimeouts.design,
      temperature: DESIGN_CONTRACT_TEMPERATURE,
      styleId: context.styleId,
      styleSkillPrompt: context.styleSkill.prompt,
      layoutRulesPrompt: context.layoutRulesPrompt,
      styleKey: context.styleKey,
      styleName: context.styleName,
      styleVersion: context.styleVersion,
      appLocale: context.appLocale,
      totalPages: context.totalPages,
      slideSize: context.slideSize,
      topic: context.topic,
      userMessage: context.userMessage,
      fontSelection: context.fontSelection,
      emit: (chunk) => emitDeckChunk(chunk),
      runId: context.runId,
      signal: context.abortSignal
    }).then(
      (result) => {
        tDesign.finish(true)
        return result
      },
      (error) => {
        tDesign.finish(false)
        throw error
      }
    )
  const [plannedOutlineItems, designContract] = await Promise.all([
    plannerPromise,
    designContractPromise,
    scaffoldPromise
  ])
  await db.updateSessionDesignContract(context.sessionId, designContract)
  const plannedOutline = diversifyUniversalLayoutSequence(
    pageRefs.map((page, index) => {
      const planned = plannedOutlineItems[index]
      return {
        title: planned?.title?.trim() || page.title,
        contentOutline: planned?.contentOutline?.trim() || '',
        layoutIntent: planned?.layoutIntent,
        contentStructure: planned?.contentStructure,
        moduleCount: planned?.moduleCount,
        visualAspect: planned?.visualAspect,
        contentDensity: planned?.contentDensity,
        visualFormat: planned?.visualFormat,
        audienceMove: planned?.audienceMove,
        layoutId: planned?.layoutId
      }
    })
  )
  // 背景图生成与锁定版式分配并行：两者互不依赖，节省串行等待
  const tBackgrounds = telemetry.begin('backgrounds', {
    enabled: context.deckBackgroundPolicy.enabled
  })
  const tLocked = telemetry.begin('locked-layouts', {
    mode: context.generationMode
  })
  const [backgroundManifest, lockedAssignments] = await Promise.all([
    prepareDeckBackgroundAssets({
      db,
      decryptApiKey: ctx.credentials.decryptApiKey,
      projectDir: context.projectDir,
      policy: context.deckBackgroundPolicy,
      pageCount: plannedOutline.length,
      slideSize: context.slideSize,
      topic: context.topic,
      stylePrompt: context.styleSkill.prompt,
      provider: context.provider,
      apiKey: context.apiKey,
      model: context.model,
      baseUrl: context.providerBaseUrl,
      maxTokens: context.maxTokens,
      modelControl: context.modelControl,
      modelRuntime: context.modelRuntime,
      signal: context.abortSignal,
      onStatus: ({ state, current, total, role, whitespace, detail }) =>
        emitDeckChunk({
          type: 'llm_status',
          payload: {
            runId: context.runId,
            stage: 'preflight',
            label: uiText(context.appLocale, '生成 PPT 背景图', 'Generating PPT backgrounds'),
            progress: 9,
            totalPages: pageRefs.length,
            detail:
              state === 'planning'
                ? uiText(
                    context.appLocale,
                    `正在根据主题和风格规划 ${total} 张背景图提示词`,
                    `Planning prompts for ${total} theme-aware backgrounds`
                  )
                : state === 'generating'
                  ? uiText(
                      context.appLocale,
                      `正在生成第 ${current}/${total} 张背景图（${role || ''} · ${whitespace || ''}）`,
                      `Generating background ${current}/${total} (${role || ''} · ${whitespace || ''})`
                    )
                  : state === 'failed'
                    ? detail ||
                      uiText(
                        context.appLocale,
                        '背景图生成失败，已跳过，演示生成将继续',
                        'Background generation failed and was skipped; the deck will continue'
                      )
                    : uiText(
                        context.appLocale,
                        `第 ${current}/${total} 张背景图已完成`,
                        `Background ${current}/${total} completed`
                      )
          }
        })
    }),
    // 锁定版式模式：整 deck 分配版式资产；配不上的页自动回退自由创作。
    context.generationMode === 'locked'
      ? ensureLayoutLibrary()
          .then(() => readLayoutManifest())
          .then((manifest) =>
            manifest.assets.length === 0
              ? []
              : assignLayoutAssetsToOutline(plannedOutline, manifest.assets, {
                  slideSizeId: context.slideSize.id,
                  seed: context.runId
                })
          )
      : Promise.resolve([])
  ])
  tBackgrounds.finish(true, { manifestAssets: backgroundManifest?.assets.length || 0 })
  tLocked.finish(true, { lockedPages: lockedAssignments.filter(Boolean).length })
  const outlineWithBackgrounds = assignDeckBackgroundAssets(plannedOutline, backgroundManifest)
  const lockedPageIds = new Set(
    pageRefs
      .filter((_page, index) => Boolean(lockedAssignments[index]))
      .map((page) => page.pageId)
  )
  if (lockedPageIds.size > 0) {
    log.info('[generate:deck] locked layout mode assigned', {
      sessionId: context.sessionId,
      lockedPages: lockedPageIds.size,
      totalPages: pageRefs.length
    })
  }
  const tImages = telemetry.begin('page-images', { policy: context.imagePolicy })
  const outlineItems = await prepareDeckImageAssets({
    db,
    decryptApiKey: ctx.credentials.decryptApiKey,
    projectDir: context.projectDir,
    imagePolicy: context.imagePolicy,
    // 锁定页使用版式自带视觉，清除通用 layoutId 避免为其准备/生成配图
    outlineItems: outlineWithBackgrounds.map((item, index) =>
      lockedAssignments[index] ? { ...item, layoutId: undefined } : item
    ),
    signal: context.abortSignal,
    onStatus: ({ pageNumber, state, detail }) =>
      emitDeckChunk({
        type: 'llm_status',
        payload: {
          runId: context.runId,
          stage: 'preflight',
          label: uiText(context.appLocale, '准备页面配图', 'Preparing slide visuals'),
          progress: 9,
          currentPage: pageNumber,
          totalPages: pageRefs.length,
          detail:
            state === 'preparing'
              ? uiText(
                  context.appLocale,
                  `正在为第 ${pageNumber} 页生成配图`,
                  `Generating a visual for slide ${pageNumber}`
                )
              : state === 'generated'
                ? uiText(
                    context.appLocale,
                    `第 ${pageNumber} 页配图已生成`,
                    `Visual generated for slide ${pageNumber}`
                  )
                : uiText(
                    context.appLocale,
                    `第 ${pageNumber} 页已使用可替换占位图${detail ? `：${detail}` : ''}`,
                    `Slide ${pageNumber} is using a replaceable placeholder${detail ? `: ${detail}` : ''}`
                  )
        }
      })
  })
  tImages.finish(true)
  const outlineTitles = outlineItems.map((item) => item.title)
  const retiredPageCount = await retireActiveSessionPagesForReplacement(db, context.sessionId)
  if (retiredPageCount > 0) {
    log.info('[generate:deck] retired previous active session pages for full replacement', {
      sessionId: context.sessionId,
      runId: context.runId,
      retiredPageCount
    })
  }
  for (const page of pageRefs) {
    page.title = outlineTitles[page.pageNumber - 1] || page.title
    await db.upsertGenerationPage({
      runId: context.runId,
      sessionId: context.sessionId,
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      contentOutline: outlineItems[page.pageNumber - 1]?.contentOutline || '',
      layoutIntent: outlineItems[page.pageNumber - 1]?.layoutIntent,
      layoutId: outlineItems[page.pageNumber - 1]?.layoutId,
      imageAssetPath: outlineItems[page.pageNumber - 1]?.imageAssetPath,
      imageAssetPaths: outlineItems[page.pageNumber - 1]?.imageAssetPaths,
      htmlPath: page.htmlPath,
      status: 'pending'
    })
    await db.upsertSessionPage({
      id: page.id,
      sessionId: context.sessionId,
      legacyPageId: page.pageId.match(/^page-\d+$/) ? page.pageId : null,
      fileSlug: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      htmlPath: page.htmlPath,
      status: 'pending',
      error: null
    })
  }

  await fs.promises.writeFile(
    indexPath,
    buildProjectIndexHtml(
      context.deckTitle,
      pageRefs.map(
        (page): DeckPageFile => ({
          id: page.id,
          pageNumber: page.pageNumber,
          pageId: page.pageId,
          title: page.title,
          htmlPath: path.basename(page.htmlPath)
        })
      ),
      context.slideSize
    ),
    'utf-8'
  )
  emitDeckChunk({
    type: 'llm_status',
    payload: {
      runId: context.runId,
      stage: 'preflight',
      label: progressText(context.appLocale, 'generating'),
      progress: 10,
      totalPages: pageRefs.length,
      detail: uiText(
        context.appLocale,
        `已完成规划并更新目录标题，设计契约：${designContract.theme}`,
        `Planning completed and index titles updated. Design contract: ${designContract.theme}`
      )
    }
  })

  const beforePageMap = new Map<string, string>()
  const beforePageResults = await Promise.all(
    pageRefs.map(async (page) => ({
      pageId: page.pageId,
      html: await fs.promises.readFile(page.htmlPath, 'utf-8')
    }))
  )
  for (const item of beforePageResults) {
    beforePageMap.set(item.pageId, item.html)
  }

  const persistedGeneratedPagesById = new Map<
    string,
    {
      pageNumber: number
      title: string
      pageId: string
      htmlPath: string
    }
  >()
  const persistedFailedPagesById = new Map<
    string,
    {
      pageId: string
      title: string
      reason: string
    }
  >()
  const persistGenerationSnapshotMetadata = async (): Promise<void> => {
    await db.updateSessionMetadata(context.sessionId, buildSessionMetadata({
      lastRunId: context.runId,
      entryMode: 'multi_page',
      indexPath,
      projectId: context.projectId
    }))
  }
  const persistCompletedGeneratedPage = async (page: {
    pageNumber: number
    pageId: string
    title: string
    contentOutline: string
    layoutIntent?: LayoutIntent
    layoutId?: import('@shared/generation').OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    htmlPath: string
  }): Promise<void> => {
    if (!fs.existsSync(page.htmlPath)) {
      throw new Error(`${page.pageId}.html 缺失`)
    }
    const html = await fs.promises.readFile(page.htmlPath, 'utf-8')
    const validation = validatePersistedPageHtml(html, page.pageId)
    if (!validation.valid) {
      throw new Error(`HTML 验证失败 (${page.pageId}): ${validation.errors.join('; ')}`)
    }
    await db.upsertGenerationPage({
      runId: context.runId,
      sessionId: context.sessionId,
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      contentOutline: page.contentOutline,
      layoutIntent: page.layoutIntent,
      layoutId: page.layoutId,
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      htmlPath: page.htmlPath,
      status: 'completed'
    })
    persistedFailedPagesById.delete(page.pageId)
    persistedGeneratedPagesById.set(page.pageId, {
      pageNumber: page.pageNumber,
      title: page.title,
      pageId: page.pageId,
      htmlPath: page.htmlPath
    })
    const pageRef = pageRefs.find((item) => item.pageId === page.pageId)
    emitDeckChunk({
      type: 'page_generated',
      payload: {
        runId: context.runId,
        stage: 'rendering',
        label: progressText(context.appLocale, 'completed'),
        progress: 10 + Math.round((page.pageNumber / Math.max(pageRefs.length, 1)) * 80),
        currentPage: page.pageNumber,
        totalPages: pageRefs.length,
        id: pageRef?.id,
        pageNumber: page.pageNumber,
        title: page.title,
        html,
        pageId: page.pageId,
        htmlPath: page.htmlPath,
        sourceUrl: getPageSourceUrl(page.htmlPath)
      }
    })
    await persistGenerationSnapshotMetadata()
  }
  const persistFailedGeneratedPage = async (page: {
    pageNumber: number
    pageId: string
    title: string
    contentOutline: string
    layoutIntent?: LayoutIntent
    layoutId?: import('@shared/generation').OutlineItem['layoutId']
    imageAssetPath?: string
    imageAssetPaths?: string[]
    htmlPath: string
    reason: string
  }): Promise<void> => {
    await db.upsertGenerationPage({
      runId: context.runId,
      sessionId: context.sessionId,
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      contentOutline: page.contentOutline,
      layoutIntent: page.layoutIntent,
      layoutId: page.layoutId,
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      htmlPath: page.htmlPath,
      status: 'failed',
      error: page.reason
    })
    persistedGeneratedPagesById.delete(page.pageId)
    persistedFailedPagesById.set(page.pageId, {
      pageId: page.pageId,
      title: page.title,
      reason: page.reason
    })
    await persistGenerationSnapshotMetadata()
  }

  // 锁定版式页：读骨架 → 确定性填充 → 落盘并按完成页记录（不经过 LLM）。
  // 单页填充失败自动降级为自由创作页。
  const skeletonCache = new Map<string, string>()
  for (let index = 0; index < pageRefs.length; index += 1) {
    const assigned = lockedAssignments[index]
    const page = pageRefs[index]
    if (!assigned) continue
    try {
      let skeleton = skeletonCache.get(assigned.id)
      if (skeleton === undefined) {
        skeleton = await readLayoutSkeleton(assigned)
        skeletonCache.set(assigned.id, skeleton)
      }
      const outline = outlineItems[index]
      const listSlot = assigned.slots.find((slot) => slot.kind === 'list') as
        | { kind: 'list'; maxItems: number }
        | undefined
      const rawItems = Array.isArray(outline.items) ? outline.items : []
      const listItems = listSlot ? rawItems.slice(0, listSlot.maxItems) : []
      const leftover = listSlot ? rawItems.slice(listSlot.maxItems) : []
      const body = [outline.contentOutline, ...leftover].filter(Boolean).join('；')
      let filled = fillLayoutAsset(assigned, skeleton, {
        title: outline.title,
        body,
        listItems
      })
      filled = blankMetricSlots(assigned, filled)
      await fs.promises.writeFile(page.htmlPath, filled, 'utf-8')
      await persistCompletedGeneratedPage({
        pageNumber: page.pageNumber,
        pageId: page.pageId,
        title: page.title,
        contentOutline: outline.contentOutline,
        layoutIntent: outline.layoutIntent,
        htmlPath: page.htmlPath
      })
    } catch (layoutError) {
      lockedPageIds.delete(page.pageId)
      log.warn('[generate:deck] locked layout fill failed; falling back to creative', {
        sessionId: context.sessionId,
        pageId: page.pageId,
        layoutId: assigned.id,
        message: layoutError instanceof Error ? layoutError.message : String(layoutError)
      })
    }
  }
  if (lockedPageIds.size > 0) {
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'rendering',
        label: progressText(context.appLocale, 'generating'),
        progress: 12,
        totalPages: pageRefs.length,
        detail: uiText(
          context.appLocale,
          `已按版式快速生成 ${lockedPageIds.size} 页，其余页面继续自由创作`,
          `${lockedPageIds.size} slides were generated from locked layouts; the rest continue in creative mode`
        )
      }
    })
  }

  const llmPageRefs = pageRefs.filter((page) => !lockedPageIds.has(page.pageId))
  let agentOutcome: {
    summary: string
    failedPages: Array<{ pageId: string; title: string; reason: string }>
    pendingPages: Array<{ pageId: string; title: string }>
    pause: Awaited<ReturnType<typeof runDeepAgentDeckGeneration>>['pause']
  } = { summary: '', failedPages: [], pendingPages: [], pause: null }
  const tPages = telemetry.begin('page-generation', {
    totalPages: pageRefs.length,
    lockedPages: lockedPageIds.size,
    llmPages: llmPageRefs.length
  })
  if (llmPageRefs.length > 0) {
    agentOutcome = await runDeepAgentDeckGeneration({
    sessionId: context.sessionId,
    provider: context.provider,
    apiKey: context.apiKey,
    model: context.model,
    baseUrl: context.providerBaseUrl,
    maxTokens: context.maxTokens,
    modelTimeoutMs: context.modelTimeouts.agent,
    temperature: PAGE_GENERATION_TEMPERATURE,
    pageConcurrency: context.pageConcurrency,
    styleId: context.styleId,
    styleSkillPrompt: context.styleSkill.prompt,
    layoutRulesPrompt: context.layoutRulesPrompt,
    styleKey: context.styleKey,
    styleName: context.styleName,
    styleVersion: context.styleVersion,
    slideSize: context.slideSize,
    appLocale: context.appLocale,
    animationPreferences: context.animationPreferences,
    topic: context.topic,
    deckTitle: context.deckTitle,
    userMessage: context.userMessage,
    outlineTitles,
    outlineItems,
    pageTasks: llmPageRefs.map((page) => ({
      pageNumber: page.pageNumber,
      pageId: page.pageId,
      title: page.title,
      contentOutline: outlineItems[page.pageNumber - 1]?.contentOutline || '',
      layoutIntent: outlineItems[page.pageNumber - 1]?.layoutIntent,
      contentStructure: outlineItems[page.pageNumber - 1]?.contentStructure,
      moduleCount: outlineItems[page.pageNumber - 1]?.moduleCount,
      visualAspect: outlineItems[page.pageNumber - 1]?.visualAspect,
      contentDensity: outlineItems[page.pageNumber - 1]?.contentDensity,
      visualFormat: outlineItems[page.pageNumber - 1]?.visualFormat,
      audienceMove: outlineItems[page.pageNumber - 1]?.audienceMove,
      layoutId: outlineItems[page.pageNumber - 1]?.layoutId,
      imageAssetPath: outlineItems[page.pageNumber - 1]?.imageAssetPath,
      imageAssetPaths: outlineItems[page.pageNumber - 1]?.imageAssetPaths,
      backgroundAsset: outlineItems[page.pageNumber - 1]?.backgroundAsset
    })),
    sourceDocumentPaths: context.sourceDocumentPaths,
    generationMode: 'generate',
    designContract,
    projectDir: context.projectDir,
    indexPath,
    pageFileMap: Object.fromEntries(
      llmPageRefs.map((page) => [page.pageId, page.htmlPath])
    ),
    pageNumbers: Object.fromEntries(llmPageRefs.map((page) => [page.pageId, page.pageNumber])),
    agentManager,
    emit: (chunk) => emitDeckChunk(chunk),
    onPageCompleted: persistCompletedGeneratedPage,
    onPageFailed: persistFailedGeneratedPage,
    runId: context.runId,
    signal: context.abortSignal
    })
  }
  const { summary: agentSummary, failedPages, pendingPages, pause } = agentOutcome
  tPages.finish(failedPages.length === 0, {
    failedPages: failedPages.length,
    completedPages: pageRefs.length - failedPages.length
  })
  const lockedSummary =
    lockedPageIds.size > 0
      ? uiText(
          context.appLocale,
          `其中 ${lockedPageIds.size} 页按模板版式快速生成；`,
          `${lockedPageIds.size} slides were generated from locked template layouts; `
        )
      : ''
  const summary = lockedSummary + agentSummary

  if (pause) {
    const existingSessionPages = await db.listSessionPages(context.sessionId, {
      includeDeleted: true
    })
    const existingBySlug = new Map(existingSessionPages.map((page) => [page.file_slug, page]))
    const failedPageIdSet = new Set(failedPages.map((page) => page.pageId))
    const completedPageIdSet = new Set(persistedGeneratedPagesById.keys())
    for (const page of pageRefs) {
      const existing = existingBySlug.get(page.pageId)
      const status = completedPageIdSet.has(page.pageId)
        ? 'completed'
        : failedPageIdSet.has(page.pageId)
          ? 'failed'
          : 'pending'
      const failedPage = failedPages.find((item) => item.pageId === page.pageId)
      await db.upsertSessionPage({
        id: existing?.id || page.id,
        sessionId: context.sessionId,
        legacyPageId:
          existing?.legacy_page_id || (page.pageId.match(/^page-\d+$/) ? page.pageId : null),
        fileSlug: page.pageId,
        pageNumber: page.pageNumber,
        title: page.title,
        htmlPath: page.htmlPath,
        status,
        error: failedPage?.reason || null
      })
    }
    const message = `${pause.failure.titleZh}：${pause.failure.detailZh}`
    await db.updateGenerationRunStatus(
      context.runId,
      completedPageIdSet.size > 0 ? 'partial' : 'failed',
      pause.failure.technicalDetail
    )
    await db.updateSessionMetadata(context.sessionId, buildSessionMetadata({
      lastRunId: context.runId,
      entryMode: 'multi_page',
      indexPath,
      projectId: context.projectId
    }))
    await db.updateSessionDesignContract(context.sessionId, designContract)
    await db.updateProjectStatus(context.projectId, 'draft')
    emitDeckChunk({
      type: 'run_paused',
      payload: {
        runId: context.runId,
        message,
        failure: pause.failure,
        completedPageCount: completedPageIdSet.size,
        failedPageCount: failedPages.length,
        pendingPageCount: failedPages.length + pendingPages.length,
        pendingPageIds: [
          ...failedPages.map((page) => page.pageId),
          ...pendingPages.map((page) => page.pageId)
        ],
        occurrences: pause.occurrences,
        provider: context.provider,
        model: context.model
      }
    })
    return
  }

  const failedPageIdSet = new Set(failedPages.map((item) => item.pageId))
  const postValidationErrors: string[] = []
  const postValidationFailures: Array<{ pageId: string; title: string; reason: string }> = []
  if (!fs.existsSync(indexPath)) {
    postValidationErrors.push('index.html 缺失')
  } else {
    const indexHtml = await fs.promises.readFile(indexPath, 'utf-8')
    postValidationErrors.push(...validateProjectIndexHtml(indexHtml))
  }
  const validationPages = await Promise.all(
    pageRefs.map(async (page) => {
      if (!fs.existsSync(page.htmlPath)) {
        return { pageId: page.pageId, missing: true, html: '' }
      }
      const html = await fs.promises.readFile(page.htmlPath, 'utf-8')
      return { pageId: page.pageId, missing: false, html }
    })
  )
  for (const item of validationPages) {
    const pageRef = pageRefs.find((page) => page.pageId === item.pageId)
    if (item.missing) {
      const reason = `${item.pageId}.html 缺失`
      postValidationErrors.push(reason)
      if (!failedPageIdSet.has(item.pageId)) {
        postValidationFailures.push({
          pageId: item.pageId,
          title: pageRef?.title || item.pageId,
          reason
        })
      }
      continue
    }
    if (!/<html[\s>]/i.test(item.html)) {
      const reason = `${item.pageId}.html 缺少 <html>`
      postValidationErrors.push(reason)
      if (!failedPageIdSet.has(item.pageId)) {
        postValidationFailures.push({
          pageId: item.pageId,
          title: pageRef?.title || item.pageId,
          reason
        })
      }
      continue
    }
    if (!failedPageIdSet.has(item.pageId)) {
      const validation = validatePersistedPageHtml(item.html, item.pageId)
      if (!validation.valid) {
        const reason = validation.errors.join('; ')
        postValidationErrors.push(`${item.pageId}.html ${reason}`)
        postValidationFailures.push({
          pageId: item.pageId,
          title: pageRef?.title || item.pageId,
          reason
        })
      }
    }
  }
  for (const failure of postValidationFailures) {
    failedPageIdSet.add(failure.pageId)
    failedPages.push(failure)
  }
  emitDeckChunk({
    type: 'llm_status',
    payload: {
      runId: context.runId,
      stage: 'validation',
      label: progressText(
        context.appLocale,
        postValidationErrors.length > 0 ? 'failed' : 'checking'
      ),
      progress: 92,
      totalPages: outlineTitles.length,
      detail:
        postValidationErrors.length > 0
          ? postValidationErrors.join('; ')
          : uiText(
              context.appLocale,
              '页面生成队列处理完成，正在核对有效页面',
              'Page generation queue completed. Checking valid pages'
            )
    }
  })

  const placeholderPages: string[] = []
  const pageDescriptors: Array<{
    id: string
    pageNumber: number
    title: string
    pageId: string
    htmlPath: string
    html: string
  }> = []
  const generatedPageReads = await Promise.all(
    pageRefs.map(async (pageRef) => {
      if (!fs.existsSync(pageRef.htmlPath)) return null
      const html = await fs.promises.readFile(pageRef.htmlPath, 'utf-8')
      return { pageRef, html }
    })
  )
  for (const item of generatedPageReads) {
    if (!item) continue
    const { pageRef, html } = item
    if (failedPageIdSet.has(pageRef.pageId)) {
      continue
    }
    if (isPlaceholderPageHtml(html)) {
      const reason = '页面仍为占位内容，模型没有成功写入真实页面'
      placeholderPages.push(pageRef.pageId)
      failedPageIdSet.add(pageRef.pageId)
      failedPages.push({
        pageId: pageRef.pageId,
        title: pageRef.title,
        reason
      })
      continue
    }
    const page: GeneratedPagePayload = {
      id: pageRef.id,
      pageNumber: pageRef.pageNumber,
      title: pageRef.title,
      html,
      pageId: pageRef.pageId,
      htmlPath: pageRef.htmlPath,
      sourceUrl: getPageSourceUrl(pageRef.htmlPath)
    }
    pageDescriptors.push({
      id: pageRef.id,
      pageNumber: pageRef.pageNumber,
      title: pageRef.title,
      pageId: pageRef.pageId,
      htmlPath: pageRef.htmlPath,
      html
    })
    if (!persistedGeneratedPagesById.has(pageRef.pageId)) {
      await db.upsertGenerationPage({
        runId: context.runId,
        sessionId: context.sessionId,
        pageId: pageRef.pageId,
        pageNumber: pageRef.pageNumber,
        title: pageRef.title,
        contentOutline: outlineItems[pageRef.pageNumber - 1]?.contentOutline || '',
        layoutIntent: outlineItems[pageRef.pageNumber - 1]?.layoutIntent,
        layoutId: outlineItems[pageRef.pageNumber - 1]?.layoutId,
        imageAssetPath: outlineItems[pageRef.pageNumber - 1]?.imageAssetPath,
        imageAssetPaths: outlineItems[pageRef.pageNumber - 1]?.imageAssetPaths,
        htmlPath: pageRef.htmlPath,
        status: 'completed'
      })
    }
    const changed = beforePageMap.get(pageRef.pageId) !== html
    await db.addMessage(context.sessionId, {
      role: 'tool',
      content: `${changed ? '已更新' : '已确认'} ${page.pageId}: ${page.title}`,
      type: 'tool_result',
      tool_name: 'update_page_file',
      tool_call_id: context.runId,
      chat_scope: context.messageScope,
      page_id: context.messagePageId,
      run_model: context.runModel
    })
  }

  if (placeholderPages.length > 0) {
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'rendering',
        label: progressText(context.appLocale, 'checking'),
        progress: 90,
        totalPages: outlineTitles.length,
        detail: uiText(
          context.appLocale,
          `以下页面可能仍是占位内容：${placeholderPages.join(', ')}`,
          `These pages may still contain placeholders: ${placeholderPages.join(', ')}`
        )
      }
    })
  }

  if (failedPages.length > 0) {
    const failedDetails = failedPages
      .map((item) => `${item.pageId}（${item.title}）：${item.reason}`)
      .join('；')
    for (const failedPage of failedPages) {
      const pageRef = pageRefs.find((page) => page.pageId === failedPage.pageId)
      if (!pageRef) continue
      emitDeckChunk({
        type: 'page_failed',
        payload: {
          runId: context.runId,
          stage: 'validation',
          label: progressText(context.appLocale, 'failed'),
          progress: 92,
          currentPage: pageRef.pageNumber,
          totalPages: pageRefs.length,
          pageNumber: pageRef.pageNumber,
          pageId: pageRef.pageId,
          title: pageRef.title,
          htmlPath: pageRef.htmlPath,
          error: failedPage.reason
        }
      })
      await db.upsertGenerationPage({
        runId: context.runId,
        sessionId: context.sessionId,
        pageId: pageRef.pageId,
        pageNumber: pageRef.pageNumber,
        title: pageRef.title,
        contentOutline: outlineItems[pageRef.pageNumber - 1]?.contentOutline || '',
        layoutIntent: outlineItems[pageRef.pageNumber - 1]?.layoutIntent,
        layoutId: outlineItems[pageRef.pageNumber - 1]?.layoutId,
        imageAssetPath: outlineItems[pageRef.pageNumber - 1]?.imageAssetPath,
        imageAssetPaths: outlineItems[pageRef.pageNumber - 1]?.imageAssetPaths,
        htmlPath: pageRef.htmlPath,
        status: 'failed',
        error: failedPage.reason
      })
    }
    const existingSessionPages = await db.listSessionPages(context.sessionId, {
      includeDeleted: true
    })
    const existingBySlug = new Map(existingSessionPages.map((sp) => [sp.file_slug, sp]))
    for (const failedPage of failedPages) {
      const pageRef = pageRefs.find((page) => page.pageId === failedPage.pageId)
      if (!pageRef) continue
      const existing = existingBySlug.get(pageRef.pageId)
      await db.upsertSessionPage({
        id: existing?.id || pageRef.id,
        sessionId: context.sessionId,
        legacyPageId:
          existing?.legacy_page_id || (pageRef.pageId.match(/^page-\d+$/) ? pageRef.pageId : null),
        fileSlug: pageRef.pageId,
        pageNumber: pageRef.pageNumber,
        title: pageRef.title,
        htmlPath: pageRef.htmlPath,
        status: 'failed',
        error: failedPage.reason
      })
    }
    for (const page of pageDescriptors) {
      const existing = existingBySlug.get(page.pageId)
      await db.upsertSessionPage({
        id: existing?.id || page.id,
        sessionId: context.sessionId,
        legacyPageId:
          existing?.legacy_page_id || (page.pageId.match(/^page-\d+$/) ? page.pageId : null),
        fileSlug: page.pageId,
        pageNumber: page.pageNumber,
        title: page.title,
        htmlPath: page.htmlPath,
        status: 'completed',
        error: null
      })
    }
    await db.updateGenerationRunStatus(
      context.runId,
      pageDescriptors.length > 0 ? 'partial' : 'failed',
      failedDetails
    )
    await db.updateSessionMetadata(context.sessionId, buildSessionMetadata({
      lastRunId: context.runId,
      entryMode: 'multi_page',
      indexPath,
      projectId: context.projectId
    }))
    await db.updateSessionDesignContract(context.sessionId, designContract)
    await db.updateProjectStatus(context.projectId, 'draft')
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'rendering',
        label: progressText(context.appLocale, 'failed'),
        progress: 90,
        totalPages: outlineTitles.length,
        detail: uiText(
          context.appLocale,
          `本次已完成 ${pageDescriptors.length}/${pageRefs.length} 页，失败页面：${failedDetails}`,
          `${pageDescriptors.length}/${pageRefs.length} pages completed. Failed pages: ${failedDetails}`
        )
      }
    })
    throw new Error(
      `部分页面生成失败（${failedPages.length}/${pageRefs.length}）：${failedPages
        .map((item) => `${item.pageId}(${item.title})`)
        .join(', ')}`
    )
  }

  const fallbackCompletionSummary =
    placeholderPages.length > 0
      ? uiText(
          context.appLocale,
          `演示已生成完成。当前共 ${pageDescriptors.length} 页，主题「${context.topic}」。其中 ${placeholderPages.length} 页可以继续优化。`,
          `The presentation has been generated. It has ${pageDescriptors.length} pages for "${context.topic}". ${placeholderPages.length} pages can still be improved.`
        )
      : uiText(
          context.appLocale,
          `演示已生成完成。共 ${pageDescriptors.length} 页，主题「${context.topic}」。`,
          `The presentation has been generated. It has ${pageDescriptors.length} pages for "${context.topic}".`
        )
  await emitAssistant(context, summary.trim() || fallbackCompletionSummary)

  // 渲染级视觉自检：信息性评审，移出关键路径 —— 完成状态先行，
  // 审阅结果异步送达（内部全量容错，任何失败只降级提示）。
  void runVisualDeckReview({
    sessionId: context.sessionId,
    runId: context.runId,
    slideSize: context.slideSize,
    pages: pageDescriptors.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      title: page.title,
      htmlPath: page.htmlPath
    })),
    model: {
      provider: context.provider,
      apiKey: context.apiKey,
      model: context.model,
      baseUrl: context.providerBaseUrl,
      maxTokens: context.maxTokens,
      modelRuntime: context.modelRuntime,
      modelControl: context.modelControl,
      timeoutMs: context.modelTimeouts.document
    },
    appLocale: context.appLocale,
    isEnabled: async () =>
      (await db.getSetting<string>('visual_review').catch(() => null)) !== 'off',
    emit: (chunk) => emitDeckChunk(chunk),
    signal: context.abortSignal
  }).catch((reviewError) => {
    log.warn('[generate:deck] visual review failed (non-blocking)', {
      sessionId: context.sessionId,
      message: reviewError instanceof Error ? reviewError.message : String(reviewError)
    })
  })

  // 资产完整性校验：扫描本地资源引用，缺失记录为警告（不阻塞交付）
  const tIntegrity = telemetry.begin('asset-integrity')
  const integrityReport = validateAssetIntegrity(
    pageDescriptors.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      htmlPath: page.htmlPath
    }))
  )
  tIntegrity.finish(true, {
    checkedPages: integrityReport.checkedPages,
    totalRefs: integrityReport.totalReferences,
    violations: integrityReport.violations.length
  })
  if (integrityReport.violations.length > 0) {
    emitDeckChunk({
      type: 'llm_status',
      payload: {
        runId: context.runId,
        stage: 'rendering',
        label: progressText(context.appLocale, 'completed'),
        progress: 100,
        totalPages: pageRefs.length,
        detail: uiText(
          context.appLocale,
          `注意：${integrityReport.violations.length} 个本地资源引用缺失（如图片路径不存在），页面上可能显示裂图。`,
          `Warning: ${integrityReport.violations.length} local asset references are missing; broken images may appear.`
        )
      }
    })
  }

  // 遥测落盘 + 日志汇总
  telemetry.logSummary()
  const telemetryMetadata = telemetry.toMetadata()
  await db.updateGenerationRunStatus(context.runId, 'completed', null)
  await db.updateSessionMetadata(context.sessionId, buildSessionMetadata({
    lastRunTelemetry: telemetryMetadata,
    ...(integrityReport.violations.length > 0
      ? { lastAssetWarnings: integrityReport.violations.slice(0, 20) }
      : {})
  }))
  await finalizeGenerationSuccess(ctx, {
    context,
    indexPath,
    totalPages: outlineTitles.length,
    generatedPages: pageDescriptors,
    designContract
  })
}
