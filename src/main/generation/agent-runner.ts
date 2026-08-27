/** Generation orchestration: LLM planning + DeepAgent execution. */
import fs from 'fs'
import pLimit from 'p-limit'
import log from 'electron-log/main.js'
import { createSessionDeckAgent, createSessionEditAgent } from '../agent-runtime/agent'
import { assertModelText, extractJsonBlock, extractModelText, resolveModel } from '../agent-runtime/model'
import type { GenerationAgentManager, GenerationModelControl } from './context'
import type { ModelRuntimeConfig } from '../agent-runtime/model'
import { runWithModelTemperatureControl } from '../agent-runtime/model'
import {
  buildDesignContractSystemPrompt,
  buildDesignContractUserPrompt,
  buildEditUserPrompt,
  buildPlanningSystemPrompt,
  buildPlanningUserPrompt,
  buildSinglePageGenerationPrompt,
  CONTENT_LANGUAGE_RULES
} from '../agent-runtime/prompt'
import type {
  AnimationPreferencesPayload,
  DeckEditScope,
  DesignContract,
  FontSelection,
  GenerateChunkEvent,
  OutlineItem,
  VisualFormat,
  SelectedElementRuntimeContext
} from '@shared/generation'
import { isSectionAgendaOutline, resolvePlannedVisualFormat } from '@shared/generation'
import { normalizeLayoutIntent, type LayoutIntent } from '@shared/layout-intent'
import { formatLayoutMasterPrompt, resolveLayoutMasterTemplate } from '@shared/layout-master'
import {
  diversifyUniversalLayoutSequence,
  formatUniversalLayoutCatalogPrompt,
  formatUniversalLayoutPrompt,
  normalizeContentDensity,
  normalizeContentStructure,
  normalizeUniversalLayoutId,
  normalizeVisualAspect,
  resolveUniversalLayoutId,
  type UniversalLayoutId
} from '@shared/universal-layouts'
import { resolveModelTimeoutMs, type ModelTimeoutProfile } from '@shared/model-timeout'
import { progressLabel, progressText } from '@shared/progress'
import type { SlideSizePreset } from '@shared/slide-size'
import {
  assertFontFamilyAvailable,
  buildAvailableFontsForPrompt,
  type AvailableFont
} from '../presentation/fonts/font-registry'
import { sleep } from '../ipc/utils'
import {
  createReferenceDocumentRetriever,
  formatReferenceDocumentSnippets
} from './reference-document-retrieval'
import { logAgentToolEvents } from '../utils/agent-tool-logger'
import {
  normalizeAudienceMove,
  normalizeOutlineEntries,
  normalizeOutlineText
} from './outline-normalizer'
import { classifyPageMethodSignal } from './method-signals'
import {
  MAX_RATE_LIMIT_RETRIES,
  resolveRateLimitBackoff
} from './rate-limit-backoff'
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
  extractWriteValidationFailure
} from './page-write-failure'
import { validateAssignedDeckBackground } from './deck-backgrounds'
import {
  describeTemplatePageRole,
  isValidTemplatePageRole
} from '../templates/template-page-roles'
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

const withModelControl = <T>(
  modelControl: GenerationModelControl | undefined,
  task: () => T
): T => (modelControl ? runWithModelTemperatureControl(modelControl, task) : task())

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

// ── Shared agent stream processor ───────────────────────────────────────

interface DeckToolStatusChunk {
  type?: string
  label?: string
  detail?: string
  progress?: number
  pageId?: string
  agentName?: string
}

interface StreamProcessOptions {
  emit?: (chunk: GenerateChunkEvent) => void
  runId: string
  stage: string
  totalPages: number
  provider: string
  model: string
  sessionId: string
  workerLabel?: string
  /**
   * Called for each `deck_tool_status` custom chunk.
   * Return `true` to break the stream loop (e.g. all pages written).
   */
  onCustom?: (custom: DeckToolStatusChunk) => boolean | void
  /** Called when `updates.model` is detected — the model is actively thinking. */
  onModelThinking?: (defaultProgress: number) => void
}

async function processAgentStreamCore(
  stream: AsyncIterable<unknown>,
  options: StreamProcessOptions
): Promise<void> {
  const { sessionId, workerLabel, onCustom, onModelThinking } = options
  let firstChunkLogged = false
  const seenToolEvents = new Set<string>()

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      firstChunkLogged = true
      log.info('[deepagent] stream first chunk', { sessionId, worker: workerLabel })
    }
    if (!Array.isArray(chunk) || chunk.length < 3) continue
    const parts = chunk as unknown[]
    const mode = parts[1] as string
    const data = parts[2]

    if (mode === 'updates') {
      logAgentToolEvents(data, seenToolEvents, { tag: 'deepagent', source: 'updates' })
    } else if (mode === 'messages') {
      logAgentToolEvents(data, seenToolEvents, { tag: 'deepagent', source: 'messages' })
    }

    if (mode === 'custom' && data && typeof data === 'object') {
      const custom = data as DeckToolStatusChunk
      if (custom.type === 'deck_tool_status' && custom.label) {
        const shouldBreak = onCustom?.(custom)
        if (shouldBreak) break
      }
      continue
    }

    if (mode === 'updates' && data && typeof data === 'object') {
      const updates = data as Record<string, unknown>
      if (updates.model) {
        onModelThinking?.(42)
      }
      continue
    }
  }
}

const normalizeDesignContract = (value: unknown): DesignContract => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const readText = (key: keyof Omit<DesignContract, 'palette'>): string => {
    const text = String(record[key] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text
  }
  const paletteRaw = Array.isArray(record.palette) ? record.palette : []
  const palette = paletteRaw
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 6)
  return {
    theme: readText('theme'),
    background: readText('background'),
    palette,
    titleStyle: readText('titleStyle'),
    layoutMotif: readText('layoutMotif'),
    chartStyle: readText('chartStyle'),
    shapeLanguage: readText('shapeLanguage'),
    titleFont: readText('titleFont'),
    subtitleFont: readText('subtitleFont') || readText('bodyFont'),
    bodyFont: readText('bodyFont')
  }
}

const unwrapJsonLikeString = (value: string): string => {
  const source = value.trim()
  if (source.length < 2 || !source.startsWith('"') || !source.endsWith('"')) {
    return source
  }
  const inner = source
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .trim()
  return inner.startsWith('{') || inner.startsWith('[') || inner.startsWith('```') ? inner : source
}

const parseModelJson = (responseText: string, appLocale?: AppLocale): unknown => {
  let source = responseText.trim()
  let lastError: unknown

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidates = Array.from(new Set([source, extractJsonBlock(source)]))
    let decodedJsonString = false

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (typeof parsed !== 'string') {
          return parsed
        }
        source = parsed.trim()
        lastError = null
        decodedJsonString = true
        break
      } catch (err) {
        lastError = err
      }
    }

    if (decodedJsonString) {
      continue
    }

    const unwrapped = unwrapJsonLikeString(source)
    if (unwrapped !== source) {
      source = unwrapped
      continue
    }

    const block = extractJsonBlock(source)
    if (block !== source) {
      source = block
      continue
    }

    break
  }

  const preview = source.length > 200 ? `${source.slice(0, 200)}…` : source
  throw new Error(
    uiText(
      appLocale,
      `LLM 返回的 JSON 解析失败: ${lastError instanceof Error ? lastError.message : String(lastError)}. 原始文本预览: ${preview}`,
      `Failed to parse JSON returned by the LLM: ${lastError instanceof Error ? lastError.message : String(lastError)}. Raw text preview: ${preview}`
    )
  )
}

const buildPlanningRetryUserPrompt = (
  userPrompt: string,
  totalPages: number,
  previousError: string
): string =>
  [
    userPrompt,
    '',
    'Planning retry requirement:',
    `- The previous planning response failed validation: ${previousError}`,
    `- Retry now and return exactly ${totalPages} items.`,
    '- Return only a raw JSON array. Do not wrap it in Markdown. Do not add explanations.',
    '- Each item must have exactly these fields: title, keyPoints, layoutIntent, contentStructure, moduleCount, visualAspect, contentDensity, layoutId.',
    '- layoutId must be a universal layout catalog ID or null.',
    '- keyPoints must be an array with 1-10 short strings.'
  ].join('\n')

const buildDesignContractRetryUserPrompt = (userPrompt: string, previousError: string): string =>
  [
    userPrompt,
    '',
    'Design contract retry requirement:',
    `- The previous design contract response failed validation: ${previousError}`,
    '- Retry now and return only a raw JSON object. Do not wrap it in Markdown. Do not add explanations.',
    '- Use exactly these fields: theme, background, palette, titleStyle, layoutMotif, chartStyle, shapeLanguage, titleFont, bodyFont.',
    '- palette must be an array with 3-6 color strings.',
    '- titleFont and bodyFont must be exact family values from availableFonts in the original system prompt.',
    '- titleStyle must follow explicit typography targets in the original style specification when supplied. Otherwise use text-4xl or text-5xl. Do not exceed 88px unless the user explicitly requested oversized typography.'
  ].join('\n')

const detectFontLanguageHint = (text: string): string => {
  if (/[\u3400-\u9fff]/.test(text)) return 'cjk'
  return 'latin'
}

const resolveFontPair = (
  value: FontSelection | undefined
): { titleFont: string; subtitleFont: string; bodyFont: string } | null => {
  if (!value || value.mode !== 'pair') return null
  const titleFont = String(value.title?.family || '').trim()
  const bodyFont = String(value.body?.family || '').trim()
  const subtitleFont = String(value.subtitle?.family || bodyFont).trim()
  return titleFont && subtitleFont && bodyFont ? { titleFont, subtitleFont, bodyFont } : null
}

export const planDeckWithLLM = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelRuntime?: ModelRuntimeConfig
  modelControl?: GenerationModelControl
  styleId: string | null | undefined
  totalPages: number
  appLocale?: AppLocale
  modelTimeoutMs?: number
  topic: string
  userMessage: string
  sourceDocumentPaths?: string[]
  hasSourceMaterials?: boolean
  visualElementPreferences?: import('@shared/generation').VisualElementPreferences
  emit?: (chunk: GenerateChunkEvent) => void
  runId?: string
  signal?: AbortSignal
}): Promise<OutlineItem[]> => {
  const client = withModelControl(args.modelControl, () =>
    resolveModel(
      args.provider,
      args.apiKey,
      args.model,
      args.baseUrl,
      args.temperature,
      args.maxTokens,
      args.modelRuntime
    )
  )
  const systemPrompt = buildPlanningSystemPrompt(args.totalPages)
  const userPrompt = buildPlanningUserPrompt({
    topic: args.topic,
    totalPages: args.totalPages,
    userMessage: args.userMessage,
    hasSourceMaterials: args.hasSourceMaterials || Boolean(args.sourceDocumentPaths?.length),
    visualElementPreferences: args.visualElementPreferences
  })
  const parsePlanningItems = (responseText: string): OutlineItem[] => {
    const parsed = parseModelJson(responseText, args.appLocale)
    if (!Array.isArray(parsed)) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM plan_deck 返回格式不正确，期望 [{title, keyPoints[], layoutIntent}] 数组。',
          'LLM plan_deck returned an invalid format; expected an array like [{ title, keyPoints[], layoutIntent }].'
        )
      )
    }
    if (parsed.length === 0 || typeof parsed[0] !== 'object' || parsed[0] === null) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM plan_deck pages 返回格式不正确，期望 [{title, keyPoints[], layoutIntent}] 数组。',
          'LLM plan_deck pages returned an invalid format; expected an array like [{ title, keyPoints[], layoutIntent }].'
        )
      )
    }
    const items: OutlineItem[] = (parsed as Array<Record<string, unknown>>).map((item, index) => {
      const title = String(item.title ?? '').trim()
      const structuredEntries = normalizeOutlineEntries(item.keyPoints)
      const keyPoints = structuredEntries.map((entry) => entry.label)
      const requestedModuleCount = Number(item.moduleCount)
      const moduleCount = Number.isFinite(requestedModuleCount)
        ? Math.max(1, Math.min(6, Math.floor(requestedModuleCount)))
        : Math.max(1, Math.min(6, keyPoints.length))
      const contentStructure = normalizeContentStructure(item.contentStructure)
      const visualAspect = normalizeVisualAspect(item.visualAspect)
      const contentDensity = normalizeContentDensity(item.contentDensity)
      const layoutIntent = normalizeLayoutIntent(item.layoutIntent)
      const visualFormat = resolvePlannedVisualFormat(item.visualFormat, layoutIntent)
      const audienceMove = normalizeAudienceMove(item.audienceMove)
      if (!title) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM plan_deck 第 ${index + 1} 项缺少 title，期望格式: { title, keyPoints[], layoutIntent }`,
            `LLM plan_deck item ${index + 1} is missing title; expected format: { title, keyPoints[], layoutIntent }`
          )
        )
      }
      if (keyPoints.length < 1) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM plan_deck 第 ${index + 1} 项 keyPoints 为空，至少需要 1 条。`,
            `LLM plan_deck item ${index + 1} has empty keyPoints; at least one item is required.`
          )
        )
      }
      return {
        title,
        contentOutline: normalizeOutlineText(keyPoints.join('；')),
        // 结构化内容包：带 value/unit/priority，锁定模式按槽位取用
        items: structuredEntries,
        layoutIntent,
        contentStructure,
        moduleCount,
        visualAspect,
        contentDensity,
        visualFormat,
        audienceMove,
        layoutId: resolveUniversalLayoutId({
          value: item.layoutId,
          moduleCount,
          intent: layoutIntent,
          contentStructure,
          visualAspect,
          contentDensity
        })
      }
    })
    if (items.length === 0) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM plan_deck 返回空大纲。',
          'LLM plan_deck returned an empty outline.'
        )
      )
    }
    // Pad if LLM returned fewer pages than requested
    while (items.length < args.totalPages) {
      items.push({
        title: uiText(args.appLocale, `第 ${items.length + 1} 页`, `Page ${items.length + 1}`),
        contentOutline: '',
        layoutIntent: 'concept'
      })
    }
    return diversifyUniversalLayoutSequence(items.slice(0, args.totalPages))
  }

  args.emit?.({
    type: 'llm_status',
    payload: {
      runId: args.runId || '',
      stage: 'planning',
      label: progressText(args.appLocale, 'planning'),
      progress: 4,
      totalPages: args.totalPages,
      provider: args.provider,
      model: args.model,
      detail: uiText(
        args.appLocale,
        `正在生成 ${args.totalPages} 页的标题与要点`,
        `Generating titles and key points for ${args.totalPages} pages`
      )
    }
  })
  const maxAttempts = 2
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 5,
          totalPages: args.totalPages,
          provider: args.provider,
          model: args.model,
          detail: uiText(
            args.appLocale,
            '页面计划格式异常，正在自动重试一次',
            'The page plan format was invalid; retrying once'
          )
        }
      })
    }
    const previousError =
      lastError instanceof Error ? lastError.message : lastError ? String(lastError) : ''
    const effectiveUserPrompt =
      attempt === 1
        ? userPrompt
        : buildPlanningRetryUserPrompt(userPrompt, args.totalPages, previousError)
    log.info('[llm] invoke plan_deck', {
      provider: args.provider,
      model: args.model,
      temperature: args.temperature ?? null,
      styleId: args.styleId || '',
      totalPages: args.totalPages,
      topic: args.topic,
      attempt,
      maxAttempts
    })
    try {
      const combinedSignal = modelCallSignal(args.modelTimeoutMs, 'planning', args.signal)
      const response = await client.invoke(
        [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: effectiveUserPrompt }
        ],
        { signal: combinedSignal }
      )
      const responseText = extractModelText(response)
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 9,
          totalPages: args.totalPages,
          provider: args.provider,
          model: args.model,
          detail: uiText(
            args.appLocale,
            '正在整理成可执行页面计划',
            'Converting outline into an executable page plan'
          )
        }
      })
      log.info('[llm] plan_deck response', {
        attempt,
        textLength: responseText.length,
        preview: JSON.stringify(
          responseText.length > 240 ? `${responseText.slice(0, 240)}…` : responseText
        )
      })
      return parsePlanningItems(responseText)
    } catch (error) {
      lastError = error
      if (args.signal?.aborted || attempt >= maxAttempts) {
        throw error
      }
      log.warn('[llm] plan_deck retry scheduled', {
        provider: args.provider,
        model: args.model,
        attempt,
        maxAttempts,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Planning failed'))
}

export const planNewPage = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelRuntime?: ModelRuntimeConfig
  modelControl?: GenerationModelControl
  appLocale?: AppLocale
  modelTimeoutMs?: number
  userDescription: string
  topic?: string
  existingTitles?: string[]
  sourceDocumentPaths?: string[]
  signal?: AbortSignal
}): Promise<{
  title: string
  contentOutline: string
  layoutIntent: LayoutIntent
  contentStructure?: import('@shared/universal-layouts').ContentStructure
  moduleCount?: number
  visualAspect?: import('@shared/universal-layouts').VisualAspect
  contentDensity?: import('@shared/universal-layouts').ContentDensity
  layoutId?: UniversalLayoutId
}> => {
  const client = withModelControl(args.modelControl, () =>
    resolveModel(
      args.provider,
      args.apiKey,
      args.model,
      args.baseUrl,
      args.temperature,
      args.maxTokens,
      args.modelRuntime
    )
  )
  const systemPrompt = [
    'You are a PPT slide planner. The user wants to add ONE new slide to an existing deck.',
    'Generate a title, concise key points (1-10 items), a layout intent, and a universal layout ID for this single slide.',
    '',
    CONTENT_LANGUAGE_RULES,
    '',
    'The new slide must fit naturally into the existing deck:',
    '- The title language and style must match existing slide titles.',
    '- Do NOT duplicate or closely paraphrase any existing slide title.',
    args.topic ? `- Deck topic: ${args.topic}` : '',
    args.sourceDocumentPaths?.length
      ? [
          '',
          'Source document context:',
          '- This deck has user-imported reference documents. Plan a slide title and key points that can be verified against the source during generation.',
          `- sourceDocumentPaths: ${args.sourceDocumentPaths.join(', ')}`,
          '- Do not invent unsupported exact facts, metrics, examples, risks, decisions, or conclusions in this planning step.'
        ].join('\n')
      : '',
    '',
    'Assign layoutIntent based on the slide content type:',
    '  - data-focus: metrics, KPIs, trends, or quantitative results',
    '  - comparison: comparing 2+ options or alternatives',
    '  - timeline: phases, stages, roadmap',
    '  - concept: ideas, frameworks, principles',
    '  - process: how something works, step-by-step',
    '  - summary: conclusion, key takeaways',
    '  - quote: a single statement or judgment',
    '  - image-focus: products, scenes, visuals',
    '',
    'Universal layout catalog:',
    formatUniversalLayoutCatalogPrompt(),
    '',
    'Choose contentStructure, moduleCount, visualAspect, and contentDensity before choosing a compatible catalog layoutId. Five or six portrait visuals with short labels may use one row; landscape visuals must use rows or grids. Nearby slides with the same structure should use a different silhouette.',
    'Return only a JSON object with exactly these fields: title, keyPoints, layoutIntent, contentStructure, moduleCount, visualAspect, contentDensity, layoutId.',
    'Do not add explanations, Markdown, or extra text.',
    'keyPoints must contain 1-10 short phrases. If the user explicitly lists topics for this slide, preserve each listed topic as a separate key point when possible.'
  ]
    .filter(Boolean)
    .join('\n')
  const contextParts: string[] = []
  if (args.existingTitles && args.existingTitles.length > 0) {
    contextParts.push('Existing slide titles (do NOT duplicate these):')
    args.existingTitles.forEach((t, i) => contextParts.push(`  ${i + 1}. ${t}`))
    contextParts.push('')
  }
  contextParts.push('User request for the new slide:')
  contextParts.push(args.userDescription)
  const userPrompt = contextParts.join('\n')

  const combinedSignal = args.modelTimeoutMs
    ? AbortSignal.any([
        AbortSignal.timeout(args.modelTimeoutMs),
        args.signal || AbortSignal.timeout(120_000)
      ])
    : args.signal || undefined

  const response = await client.invoke(
    [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt }
    ],
    { signal: combinedSignal }
  )
  const responseText = extractModelText(response)
  const parsed = parseModelJson(responseText, args.appLocale)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM plan_new_page returned invalid format; expected a JSON object.')
  }
  const item = parsed as Record<string, unknown>
  const title = String(item.title ?? '').trim()
  if (!title) {
    throw new Error('LLM plan_new_page missing title field.')
  }
  const structuredEntries = normalizeOutlineEntries(item.keyPoints)
  const keyPoints = structuredEntries.map((entry) => entry.label)
  const contentOutline = normalizeOutlineText(keyPoints.join('；'))
  const layoutIntent = normalizeLayoutIntent(item.layoutIntent)
  const contentStructure = normalizeContentStructure(item.contentStructure)
  const visualAspect = normalizeVisualAspect(item.visualAspect)
  const contentDensity = normalizeContentDensity(item.contentDensity)
  const requestedModuleCount = Number(item.moduleCount)
  const moduleCount = Number.isFinite(requestedModuleCount)
    ? Math.max(1, Math.min(6, Math.floor(requestedModuleCount)))
    : Math.max(1, Math.min(6, keyPoints.length))
  const layoutId = resolveUniversalLayoutId({
    value: item.layoutId,
    moduleCount,
    intent: layoutIntent,
    contentStructure,
    visualAspect,
    contentDensity
  })

  return {
    title,
    contentOutline,
    layoutIntent,
    contentStructure,
    moduleCount,
    visualAspect,
    contentDensity,
    layoutId
  }
}

export const buildDesignContractWithLLM = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelRuntime?: ModelRuntimeConfig
  modelControl?: GenerationModelControl
  styleId: string | null | undefined
  styleSkillPrompt: string
  layoutRulesPrompt?: string
  styleKey?: string
  styleName?: string
  styleVersion?: string
  appLocale?: AppLocale
  modelTimeoutMs?: number
  totalPages: number
  slideSize: SlideSizePreset
  topic?: string
  userMessage?: string
  fontSelection?: FontSelection
  emit?: (chunk: GenerateChunkEvent) => void
  runId?: string
  signal?: AbortSignal
}): Promise<DesignContract> => {
  const client = withModelControl(args.modelControl, () =>
    resolveModel(
      args.provider,
      args.apiKey,
      args.model,
      args.baseUrl,
      args.temperature,
      args.maxTokens,
      args.modelRuntime
    )
  )
  const totalPages = Math.max(1, args.totalPages)
  const availableFonts: AvailableFont[] = await buildAvailableFontsForPrompt()
  const requestedFontPair = resolveFontPair(args.fontSelection)
  if (requestedFontPair) {
    await assertFontFamilyAvailable(requestedFontPair.titleFont, 'titleFont')
    await assertFontFamilyAvailable(requestedFontPair.subtitleFont, 'subtitleFont')
    await assertFontFamilyAvailable(requestedFontPair.bodyFont, 'bodyFont')
  }
  const languageHint = detectFontLanguageHint(
    [args.topic || '', args.userMessage || '', args.styleSkillPrompt || ''].join('\n')
  )
  const systemPrompt = buildDesignContractSystemPrompt({
    styleSkill: [args.styleSkillPrompt, args.layoutRulesPrompt].filter(Boolean).join('\n\n'),
    availableFonts,
    requestedFontPair,
    languageHint,
    slideSize: args.slideSize
  })
  const userPrompt = buildDesignContractUserPrompt()
  const parseDesignContract = async (responseText: string): Promise<DesignContract> => {
    const parsed = parseModelJson(responseText, args.appLocale)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM design_contract 返回格式不正确，期望 JSON object。',
          'LLM design_contract returned an invalid format; expected a JSON object.'
        )
      )
    }
    const record = parsed as Record<string, unknown>
    const requiredKeys = [
      'theme',
      'background',
      'palette',
      'titleStyle',
      'layoutMotif',
      'chartStyle',
      'shapeLanguage',
      'titleFont',
      'bodyFont'
    ]
    const missingKeys = requiredKeys.filter(
      (key) => record[key] === undefined || record[key] === ''
    )
    if (missingKeys.length > 0) {
      throw new Error(
        uiText(
          args.appLocale,
          `LLM design_contract 缺少字段：${missingKeys.join(', ')}`,
          `LLM design_contract is missing fields: ${missingKeys.join(', ')}`
        )
      )
    }
    if (!Array.isArray(record.palette) || record.palette.length < 3) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM design_contract palette 至少需要 3 个颜色。',
          'LLM design_contract palette must contain at least 3 colors.'
        )
      )
    }
    const contract = normalizeDesignContract(parsed)
    if (requestedFontPair) {
      if (
        contract.titleFont !== requestedFontPair.titleFont ||
        contract.subtitleFont !== requestedFontPair.subtitleFont ||
        contract.bodyFont !== requestedFontPair.bodyFont
      ) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM design_contract 字体与用户选择不一致：titleFont=${contract.titleFont}, bodyFont=${contract.bodyFont}`,
            `LLM design_contract fonts do not match the user selection: titleFont=${contract.titleFont}, bodyFont=${contract.bodyFont}`
          )
        )
      }
    }
    await assertFontFamilyAvailable(contract.titleFont, 'titleFont')
    await assertFontFamilyAvailable(contract.bodyFont, 'bodyFont')
    return contract
  }
  args.emit?.({
    type: 'llm_status',
    payload: {
      runId: args.runId || '',
      stage: 'planning',
      label: progressText(args.appLocale, 'planning'),
      progress: 9,
      totalPages,
      provider: args.provider,
      model: args.model,
      detail: uiText(args.appLocale, '正在生成独立设计契约', 'Generating design contract')
    }
  })
  const maxAttempts = 2
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 9,
          totalPages,
          provider: args.provider,
          model: args.model,
          detail: uiText(
            args.appLocale,
            '设计契约格式异常，正在自动重试一次',
            'The design contract format was invalid; retrying once'
          )
        }
      })
    }
    const previousError =
      lastError instanceof Error ? lastError.message : lastError ? String(lastError) : ''
    const effectiveUserPrompt =
      attempt === 1 ? userPrompt : buildDesignContractRetryUserPrompt(userPrompt, previousError)
    try {
      const combinedSignal = modelCallSignal(args.modelTimeoutMs, 'design', args.signal)
      const response = await client.invoke(
        [
          {
            role: 'system' as const,
            content: systemPrompt
          },
          {
            role: 'user' as const,
            content: effectiveUserPrompt
          }
        ],
        { signal: combinedSignal }
      )
      const responseText = assertModelText(response, {
        maxTokens: args.maxTokens,
        locale: args.appLocale
      })
      log.info('[llm] design_contract response', {
        attempt,
        textLength: responseText.length,
        preview: JSON.stringify(
          responseText.length > 240 ? `${responseText.slice(0, 240)}…` : responseText
        )
      })
      const contract = await parseDesignContract(responseText)
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 10,
          totalPages,
          provider: args.provider,
          model: args.model,
          detail: contract.theme
        }
      })
      return contract
    } catch (error) {
      if (args.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      lastError = error
      if (attempt < maxAttempts) {
        log.warn('[llm] design_contract retry scheduled', {
          provider: args.provider,
          model: args.model,
          attempt,
          maxAttempts,
          message: error instanceof Error ? error.message : String(error)
        })
        continue
      }
    }
  }
  log.warn('[llm] design_contract failed', {
    provider: args.provider,
    model: args.model,
    temperature: args.temperature ?? null,
    styleId: args.styleId || '',
    message: lastError instanceof Error ? lastError.message : String(lastError)
  })
  throw new Error(
    uiText(
      args.appLocale,
      `设计契约生成失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      `Failed to generate design contract: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    )
  )
}

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
        sourceDocumentPaths: pageSourceDocumentPaths,
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
      const stream = await deepAgent.stream(
        {
          messages: [
            {
              role: 'user',
              content: [
                args.singlePagePromptAddendum?.trim() || '',
                pagePromptAddendum?.trim() || '',
                retryContext
                  ? [
                      '',
                      'Targeted repair instructions (this is a retry):',
                      '1. First read the existing page HTML with read_file to see what is already written.',
                      '2. Identify the specific violation from the previous error and fix ONLY that issue.',
                      '3. Preserve all content, facts, and layout elements that were correct in the previous version.',
                      '4. Do not rewrite the entire page from scratch — make surgical fixes to the failing elements.',
                      `5. Previous error: ${retryContext.previousError}`
                    ].join('\n')
                  : '',
                args.requireTemplatePageRead
                  ? [
                      'Template inspection is mandatory before writing.',
                      `1. First call read_file(path="/${page.pageId}.html", offset=0, limit=1200) to inspect the copied template page.`,
                      '2. Identify every template-skeleton asset and wrapper: background images, texture images, decorative images, masks, overlays, CSS background-image/url(...) references, <img src>, SVG image href, font scale, spacing rhythm, color language, and reusable structural wrappers from that file.',
                      '3. These background/decorative assets are not old business content. Do not delete them when replacing text, metrics, logos, or content images.',
                      '4. update_template_page_file rebuilds the page from your content fragment and rejects writes that drop template skeleton resources, so the fragment you write must explicitly include the required background/decorative layers or exact local asset references from the template page.',
                      '5. Only after reading the file, call update_template_page_file with the new content while preserving the template visual system unless the user explicitly asks for a redesign.',
                      '6. Do not call update_single_page_file in this template run.'
                    ].join('\n')
                  : '',
                isValidTemplatePageRole(page.templatePageRole)
                  ? `The template base for this slide was classified as a ${describeTemplatePageRole(page.templatePageRole).en} (${describeTemplatePageRole(page.templatePageRole).zh}). Keep that structural role: preserve the composition and hierarchy of the base (e.g. a cover base stays a cover, a data base keeps chart/table prominence) while replacing the old content.`
                  : '',
                buildSinglePageGenerationPrompt({
                  topic: args.topic,
                  deckTitle: args.deckTitle,
                  pageId: page.pageId,
                  pageNumber: page.pageNumber,
                  pageTitle: page.title,
                  pageOutline: page.outline,
                  slideSize: args.slideSize,
                  layoutIntent: page.layoutIntent,
                  contentStructure: page.contentStructure,
                  moduleCount: page.moduleCount,
                  visualAspect: page.visualAspect,
                  contentDensity: page.contentDensity,
                  visualFormat: page.visualFormat,
                  audienceMove: page.audienceMove,
                  methodLevelFixes: methodLevelFixes.slice(),
                  layoutId: page.layoutId,
                  layoutPrompt: page.layoutPrompt,
                  imageAssetPath: page.imageAssetPath,
                  imageAssetPaths: page.imageAssetPaths,
                  backgroundAsset: page.backgroundAsset,
                  sourceDocumentPaths: pageSourceDocumentPaths,
                  referenceDocumentSnippets,
                  isRetryMode: args.generationMode === 'retry',
                  writeToolName,
                  retryContext
                })
              ]
                .filter(Boolean)
                .join('\n\n')
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
      try {
        await processAgentStreamCore(stream, {
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
      } catch (error) {
        streamError = error
      }

      const afterPageHtml = await readPageHtmlIfExists(currentPagePath)
      const pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)
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
    if (
      count >= METHOD_SIGNAL_ESCALATE_THRESHOLD &&
      !methodLevelFixes.includes(signal.fix)
    ) {
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
