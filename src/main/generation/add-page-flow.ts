import log from 'electron-log/main.js'
import {
  createGenerationPageCallbacks,
  generatePagesWithRetry,
  resolvePageHtmlPath,
  uiText
} from './generation-utils'
import {
  type GenerationContext,
  resolveCommonContext,
  type RuntimeJobExecutionContext
} from './context'
import { finalizeGenerationSuccess } from './finalization'
import { progressText } from '@shared/progress'
import path from 'path'
import fs from 'fs'
import { customAlphabet, nanoid } from 'nanoid'
import { type LayoutIntent } from '@shared/layout-intent'
import { normalizeUniversalLayoutId, type UniversalLayoutId } from '@shared/universal-layouts'
import { validatePersistedPageHtml } from '../presentation/html/html-utils'
import {
  buildProjectIndexHtml,
  buildPageScaffoldHtml,
  type DeckPageFile
} from '../session/template-builder'
import { planNewPage } from './agent-runner'
import type { DesignContract } from '@shared/generation'
import type { ModelTimeoutProfile } from '@shared/model-timeout'
import type { ModelRuntimeConfig } from '../agent-runtime/model'
import type { GenerationModelControl } from './context'
import type { ImagePolicy } from '@shared/generation'
import { prepareDeckImageAssets } from './deck-images'
import { readDeckBackgroundManifest, resolveDeckBackgroundAsset } from './deck-backgrounds'
import { parseJsonObject } from '../ipc/utils'
import {
  classifyTemplatePageRole,
  isValidTemplatePageRole,
  replaceTemplatePageId
} from '../templates/template-page-roles'
import {
  TEMPLATE_SINGLE_PAGE_PROMPT_ADDENDUM,
  TEMPLATE_SYSTEM_PROMPT_ADDENDUM
} from './template-prompt-addenda'

const pageSlugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10)

// ── Independent AddPage context (not shared with generation/retry/edit) ──

export type AddPageContext = {
  sessionId: string
  runId: string
  userDescription: string
  insertAfterPageNumber: number
  targetPageId?: string
  provider: string
  apiKey: string
  model: string
  modelConfigId?: string
  modelConfigName?: string
  modelControl: GenerationModelControl
  runModel?: string
  providerBaseUrl: string
  maxTokens: number
  modelRuntime: ModelRuntimeConfig
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
  imagePolicy: ImagePolicy
  sessionRecord: Record<string, unknown>
  previousSessionStatus: string
  messageScope: 'main' | 'page'
  messagePageId?: string
  projectId: string
  effectiveMode: 'addPage'
}

export async function resolveAddPageContext(
  ctx: GenerationContext,
  sessionId: string,
  userDescription: string,
  insertAfterPageNumber: number,
  modelConfigId?: string,
  targetPageId?: string,
  execution?: RuntimeJobExecutionContext
): Promise<AddPageContext> {
  log.info('[generate:addPage] resolving context', {
    sessionId,
    insertAfterPageNumber,
    targetPageId
  })
  const common = await resolveCommonContext(ctx, sessionId, modelConfigId, execution)
  const { sessionRecord } = common

  log.info('[generate:addPage] context resolved', {
    sessionId,
    projectDir: common.projectDir,
    styleId: common.styleId,
    provider: common.provider,
    model: common.model,
    insertAfterPageNumber
  })

  return {
    ...common,
    sessionId,
    userDescription,
    insertAfterPageNumber,
    targetPageId,
    sessionRecord,
    messageScope: 'main' as const,
    messagePageId: undefined,
    effectiveMode: 'addPage' as const
  }
}

// ── Execute the full add-page generation ──

export async function executeAddPageGeneration(
  ctx: GenerationContext,
  context: AddPageContext
): Promise<void> {
  const {
    db,
    agentManager,
    sessionProject: { getPageSourceUrl },
    runtimeEmitters: { createDeckProgressEmitter },
    tuning: {
      designContractTemperature: DESIGN_CONTRACT_TEMPERATURE,
      pageGenerationTemperature: PAGE_GENERATION_TEMPERATURE
    }
  } = ctx

  if (!context.apiKey) {
    throw new Error(`当前 provider "${context.provider}" 缺少 API Key，请先到设置页配置。`)
  }

  const emitChunk = createDeckProgressEmitter(context.sessionId, context.appLocale)
  const sessionRecord = context.sessionRecord
  const indexPath = path.join(context.projectDir, 'index.html')
  await ctx.history.ensureBaseline(context.sessionId, context.projectDir)

  // ── Step 1: Read designContract from session independent field ──
  let designContract: DesignContract | undefined
  if (
    typeof sessionRecord.designContract === 'string' &&
    sessionRecord.designContract.trim().length > 0
  ) {
    try {
      designContract = JSON.parse(sessionRecord.designContract) as DesignContract
    } catch {
      // ignore malformed design contract
    }
  }
  if (!designContract) {
    throw new Error('当前会话缺少设计契约，无法新增页面。请先完成首次生成。')
  }

  // ── Step 2: Read existing pages from session_pages ──
  const existingPages = await db.listSessionPages(context.sessionId)

  if (existingPages.length === 0) {
    throw new Error('当前会话没有已完成的页面，无法新增。请先完成首次生成。')
  }

  const insertAfterPageNumber = context.insertAfterPageNumber
  const userDescription = context.userDescription
  const targetPage = context.targetPageId
    ? existingPages.find(
        (page) => page.id === context.targetPageId || page.file_slug === context.targetPageId
      )
    : null
  if (context.targetPageId && !targetPage) {
    throw new Error('未找到新增页面的空白占位页')
  }

  // ── Step 3: Plan new page ──
  emitChunk({
    type: 'stage_started',
    payload: {
      runId: context.runId,
      stage: 'planning',
      label: uiText(context.appLocale, '正在规划新增页面', 'Planning the new page'),
      progress: 2,
      totalPages: 1
    }
  })

  const newPageNumber =
    targetPage?.page_number ?? Math.max(...existingPages.map((p) => p.page_number)) + 1
  const newPageEntityId = targetPage?.id ?? nanoid()
  const newPageId = targetPage?.file_slug ?? `page-${pageSlugId()}`
  const newHtmlPath = targetPage
    ? resolvePageHtmlPath({
        projectDir: context.projectDir,
        fileSlug: newPageId,
        candidates: [targetPage.html_path]
      })
    : path.join(context.projectDir, `${newPageId}.html`)

  const existingTitles = existingPages.map((p) => p.title).filter(Boolean)

  let planResult: {
    title: string
    contentOutline: string
    layoutIntent: LayoutIntent
    contentStructure?: import('@shared/universal-layouts').ContentStructure
    moduleCount?: number
    visualAspect?: import('@shared/universal-layouts').VisualAspect
    contentDensity?: import('@shared/universal-layouts').ContentDensity
    layoutId?: UniversalLayoutId
    imagePolicy?: ImagePolicy
    imageAssetPath?: string
    imageAssetPaths?: string[]
  }

  try {
    planResult = await planNewPage({
      provider: context.provider,
      apiKey: context.apiKey,
      model: context.model,
      baseUrl: context.providerBaseUrl,
      maxTokens: context.maxTokens,
      modelRuntime: context.modelRuntime,
      modelControl: context.modelControl,
      modelTimeoutMs: context.modelTimeouts.planning,
      temperature: DESIGN_CONTRACT_TEMPERATURE,
      appLocale: context.appLocale,
      userDescription,
      topic: context.topic,
      existingTitles,
      sourceDocumentPaths: [],
      signal: context.abortSignal
    })
  } catch (planError) {
    // Retry plan once
    try {
      planResult = await planNewPage({
        provider: context.provider,
        apiKey: context.apiKey,
        model: context.model,
        baseUrl: context.providerBaseUrl,
        maxTokens: context.maxTokens,
        modelRuntime: context.modelRuntime,
        modelControl: context.modelControl,
        modelTimeoutMs: context.modelTimeouts.planning,
        temperature: DESIGN_CONTRACT_TEMPERATURE,
        appLocale: context.appLocale,
        userDescription,
        topic: context.topic,
        existingTitles,
        sourceDocumentPaths: [],
        signal: context.abortSignal
      })
    } catch {
      throw new Error(
        `规划新页面失败：${planError instanceof Error ? planError.message : String(planError)}`
      )
    }
  }

  const [preparedPlanResult] = await prepareDeckImageAssets({
    db,
    decryptApiKey: ctx.credentials.decryptApiKey,
    projectDir: context.projectDir,
    imagePolicy: context.imagePolicy,
    outlineItems: [planResult],
    signal: context.abortSignal,
    onStatus: ({ state, detail }) =>
      emitChunk({
        type: 'llm_status',
        payload: {
          runId: context.runId,
          stage: 'preflight',
          label: uiText(context.appLocale, '准备页面配图', 'Preparing slide visual'),
          progress: 8,
          currentPage: newPageNumber,
          totalPages: 1,
          detail:
            state === 'preparing'
              ? uiText(context.appLocale, '正在生成新增页配图', 'Generating the new slide visual')
              : state === 'generated'
                ? uiText(context.appLocale, '新增页配图已生成', 'New slide visual generated')
                : uiText(
                    context.appLocale,
                    `新增页已使用可替换占位图${detail ? `：${detail}` : ''}`,
                    `The new slide is using a replaceable placeholder${detail ? `: ${detail}` : ''}`
                  )
        }
      })
  })
  if (preparedPlanResult) {
    planResult = {
      ...planResult,
      layoutId: normalizeUniversalLayoutId(preparedPlanResult.layoutId),
      imagePolicy: preparedPlanResult.imagePolicy,
      imageAssetPath: preparedPlanResult.imageAssetPath,
      imageAssetPaths: preparedPlanResult.imageAssetPaths
    }
  }

  // 模板会话追加页不脱模：优先复制会话中"最中间的已完成内容页"作为新页基底，
  // 并让生成走模板读改链路（read_file 先行 + update_template_page_file 骨架保护）。
  const sessionMetadata = parseJsonObject(sessionRecord.metadata ?? sessionRecord.metadata_json)
  const isTemplateSession =
    sessionMetadata.source === 'template' && typeof sessionMetadata.templateId === 'string'
  const templateBaseRoles = isTemplateSession
    ? (sessionMetadata.templateBaseRoles as Record<string, unknown> | undefined)
    : undefined

  const pickTemplateBasePage = (): (typeof existingPages)[number] | null => {
    const candidates = existingPages
      .filter((page) => page.status === 'completed' && page.html_path && page.file_slug)
      .sort((a, b) => a.page_number - b.page_number)
    if (candidates.length === 0) return null
    const middle = candidates.filter(
      (_, index) => index > 0 && index < candidates.length - 1
    )
    const pool = middle.length > 0 ? middle : candidates
    // 语义匹配：按新页规划出的角色优先选同角色的基底页（如数据页配数据基底），
    // 无匹配时退回内容页，再退回最中间页。
    const desiredRole = classifyTemplatePageRole(
      {
        pageNumber: newPageNumber,
        title: planResult.title,
        contentOutline: planResult.contentOutline
      },
      existingPages.length + 1
    )
    const roleOf = (page: (typeof candidates)[number]): string | undefined => {
      const raw = templateBaseRoles?.[page.file_slug!]
      return isValidTemplatePageRole(raw) ? raw : undefined
    }
    const byRole = pool.filter((page) => roleOf(page) === desiredRole)
    if (byRole.length > 0) {
      return byRole[Math.floor((byRole.length - 1) / 2)]
    }
    const contentPages = pool.filter(
      (page) => !roleOf(page) || roleOf(page) === 'content' || roleOf(page) === 'data'
    )
    const fallbackPool = contentPages.length > 0 ? contentPages : pool
    return fallbackPool[Math.floor((fallbackPool.length - 1) / 2)]
  }

  const templateBasePage = isTemplateSession && !targetPage ? pickTemplateBasePage() : null

  // ── Step 4: Create scaffold ──
  if (!targetPage) {
    if (templateBasePage) {
      const baseHtmlPath = resolvePageHtmlPath({
        projectDir: context.projectDir,
        fileSlug: templateBasePage.file_slug!,
        candidates: [templateBasePage.html_path]
      })
      const baseHtml = fs.existsSync(baseHtmlPath)
        ? await fs.promises.readFile(baseHtmlPath, 'utf-8')
        : ''
      if (baseHtml.trim().length > 0) {
        await fs.promises.writeFile(
          newHtmlPath,
          replaceTemplatePageId(baseHtml, templateBasePage.file_slug!, newPageId),
          'utf-8'
        )
      } else {
        await fs.promises.writeFile(
          newHtmlPath,
          buildPageScaffoldHtml(
            {
              pageNumber: newPageNumber,
              pageId: newPageId,
              title: planResult.title
            },
            context.slideSize
          ),
          'utf-8'
        )
      }
    } else {
      await fs.promises.writeFile(
        newHtmlPath,
        buildPageScaffoldHtml(
          {
            pageNumber: newPageNumber,
            pageId: newPageId,
            title: planResult.title
          },
          context.slideSize
        ),
        'utf-8'
      )
    }
  }

  // ── Step 5: Generate with agent ──
  emitChunk({
    type: 'stage_started',
    payload: {
      runId: context.runId,
      stage: 'rendering',
      label: uiText(context.appLocale, '正在生成新增页面', 'Generating the new page'),
      progress: 10,
      totalPages: 1
    }
  })

  await db.createGenerationRun({
    id: context.runId,
    sessionId: context.sessionId,
    mode: 'addPage',
    totalPages: 1,
    modelConfigId: context.modelConfigId,
    metadata: {
      addPage: true,
      pageId: newPageId,
      insertAfterPageNumber,
      modelConfigId: context.modelConfigId,
      modelConfigName: context.modelConfigName,
      provider: context.provider,
      model: context.model
    }
  })
  await db.upsertGenerationPage({
    runId: context.runId,
    sessionId: context.sessionId,
    pageId: newPageId,
    pageNumber: newPageNumber,
    title: planResult.title,
    contentOutline: planResult.contentOutline,
    layoutIntent: planResult.layoutIntent,
    layoutId: planResult.layoutId,
    imageAssetPath: planResult.imageAssetPath,
    imageAssetPaths: planResult.imageAssetPaths,
    htmlPath: newHtmlPath,
    status: 'pending'
  })
  await db.upsertSessionPage({
    id: newPageEntityId,
    sessionId: context.sessionId,
    legacyPageId: null,
    fileSlug: newPageId,
    pageNumber: newPageNumber,
    title: planResult.title,
    htmlPath: newHtmlPath,
    status: 'pending',
    error: null
  })

  const pageFileMap: Record<string, string> = { [newPageId]: newHtmlPath }
  const pageNumbers: Record<string, number> = { [newPageId]: newPageNumber }
  const pageCallbacks = createGenerationPageCallbacks({
    db,
    runId: context.runId,
    sessionId: context.sessionId
  })
  let agentSummary = ''
  const backgroundManifest = await readDeckBackgroundManifest(context.projectDir)
  const newPageBackground = resolveDeckBackgroundAsset(
    backgroundManifest,
    newPageNumber,
    targetPage ? existingPages.length : existingPages.length + 1
  )
  try {
    const generationResult = await generatePagesWithRetry({
      runArgs: {
      appendSessionEvent: (data) =>
        db.appendSessionEvent({ sessionId: context.sessionId, runId: context.runId, ...data }),
        sessionId: context.sessionId,
        provider: context.provider,
        apiKey: context.apiKey,
        model: context.model,
        baseUrl: context.providerBaseUrl,
        maxTokens: context.maxTokens,
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
        userMessage: userDescription,
        outlineTitles: [planResult.title],
        outlineItems: [planResult],
        sourceDocumentPaths: [],
        generationMode: 'generate',
        renderingLabel: uiText(context.appLocale, '正在生成新增页面', 'Generating the new page'),
        ...(isTemplateSession
          ? {
              requireTemplatePageRead: true,
              systemPromptAddendum: TEMPLATE_SYSTEM_PROMPT_ADDENDUM,
              singlePagePromptAddendum: TEMPLATE_SINGLE_PAGE_PROMPT_ADDENDUM
            }
          : {}),
        pageTasks: [
          {
            pageNumber: newPageNumber,
            pageId: newPageId,
            title: planResult.title,
            contentOutline: planResult.contentOutline,
            layoutIntent: planResult.layoutIntent,
            contentStructure: planResult.contentStructure,
            moduleCount: planResult.moduleCount,
            visualAspect: planResult.visualAspect,
            contentDensity: planResult.contentDensity,
            layoutId: planResult.layoutId,
            imageAssetPath: planResult.imageAssetPath,
            imageAssetPaths: planResult.imageAssetPaths,
            backgroundAsset: newPageBackground,
            ...(templateBasePage
              ? {
                  templatePageRole: isValidTemplatePageRole(
                    templateBaseRoles?.[templateBasePage.file_slug!]
                  )
                    ? (templateBaseRoles![templateBasePage.file_slug!] as string)
                    : 'content'
                }
              : isTemplateSession
                ? {
                    templatePageRole: classifyTemplatePageRole(
                      {
                        pageNumber: newPageNumber,
                        title: planResult.title,
                        contentOutline: planResult.contentOutline
                      },
                      existingPages.length + 1
                    )
                  }
                : {})
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
      retryDetail: uiText(
        context.appLocale,
        `页面生成失败，正在重试...`,
        `Page generation failed, retrying...`
      )
    })
    agentSummary = generationResult.summary.trim()

    // ── Step 6: Validate generated page ──
    if (!fs.existsSync(newHtmlPath)) {
      throw new Error(`${newPageId}.html 缺失`)
    }
    const newPageValidation = validatePersistedPageHtml(
      await fs.promises.readFile(newHtmlPath, 'utf-8'),
      newPageId
    )
    if (!newPageValidation.valid) {
      throw new Error(`新页面 HTML 验证失败: ${newPageValidation.errors.join('; ')}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Page generation failed'
    await db.upsertSessionPage({
      id: newPageEntityId,
      sessionId: context.sessionId,
      legacyPageId: null,
      fileSlug: newPageId,
      pageNumber: newPageNumber,
      title: planResult.title,
      htmlPath: newHtmlPath,
      status: 'failed',
      error: errorMessage
    })
    throw error
  }

  // ── Step 7: Merge into existing pages and renumber ──
  const newPageHtml = await fs.promises.readFile(newHtmlPath, 'utf-8')
  const newPageEntry = {
    id: newPageEntityId,
    pageNumber: targetPage?.page_number ?? insertAfterPageNumber + 1,
    title: planResult.title,
    pageId: newPageId,
    htmlPath: newHtmlPath,
    html: newPageHtml
  }

  // Read existing page HTMLs for the merge
  const existingPageDescriptors = await Promise.all(
    existingPages.map(async (page) => {
      const pageId = page.file_slug
      const htmlPath = resolvePageHtmlPath({
        projectDir: context.projectDir,
        fileSlug: pageId,
        candidates: [page.html_path]
      })
      const html = fs.existsSync(htmlPath) ? await fs.promises.readFile(htmlPath, 'utf-8') : ''
      return {
        id: page.id,
        pageNumber: page.page_number,
        title: page.title,
        pageId,
        htmlPath,
        html
      }
    })
  )

  const mergedPages = targetPage
    ? existingPageDescriptors.map((page) => (page.id === targetPage.id ? newPageEntry : page))
    : [
        ...existingPageDescriptors.filter((page) => page.pageNumber <= insertAfterPageNumber),
        newPageEntry,
        ...existingPageDescriptors.filter((page) => page.pageNumber > insertAfterPageNumber)
      ]

  // Renumber
  const renumberedPages = mergedPages.map((page, index) => ({
    ...page,
    pageNumber: index + 1
  }))

  // ── Step 8: Rebuild index.html ──
  await fs.promises.writeFile(
    indexPath,
    buildProjectIndexHtml(
      context.deckTitle,
      renumberedPages.map(
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

  // ── Step 9: Emit page_generated event ──
  const renumberedNewPage = renumberedPages.find((p) => p.pageId === newPageId)
  const generatedPayload = {
    pageNumber: renumberedNewPage?.pageNumber ?? newPageEntry.pageNumber,
    title: newPageEntry.title,
    pageId: newPageEntry.pageId,
    htmlPath: newPageEntry.htmlPath,
    html: newPageEntry.html,
    sourceUrl: getPageSourceUrl(newPageEntry.htmlPath)
  }

  emitChunk({
    type: 'page_generated',
    payload: {
      runId: context.runId,
      stage: 'rendering',
      label: progressText(context.appLocale, 'completed'),
      progress: 95,
      currentPage: generatedPayload.pageNumber,
      totalPages: renumberedPages.length,
      ...generatedPayload
    }
  })

  // ── Step 10: Finalize ──
  // Persist assistant message
  const assistantContent =
    agentSummary ||
    uiText(
      context.appLocale,
      `已新增页面「${planResult.title}」并插入到第 ${insertAfterPageNumber} 页之后。`,
      `Added page "${planResult.title}" after page ${insertAfterPageNumber}.`
    )
  await db.addMessage(context.sessionId, {
    role: 'assistant',
    content: assistantContent,
    type: 'text',
    chat_scope: 'main' as const,
    run_model: context.runModel
  })
  emitChunk({
    type: 'assistant_message',
    payload: {
      runId: context.runId,
      content: assistantContent,
      chatType: 'main',
      pageId: undefined
    }
  })

  await finalizeGenerationSuccess(ctx, {
    context,
    indexPath,
    totalPages: renumberedPages.length,
    generatedPages: renumberedPages
  })
}
