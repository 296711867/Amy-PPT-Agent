import log from 'electron-log/main.js'
import {
  extractModelText,
  resolveModel,
  runWithModelTemperatureControl,
  type ModelRuntimeConfig
} from '../../agent-runtime/model'
import { buildPlanningSystemPrompt, buildPlanningUserPrompt } from '../../agent-runtime/prompt'
import type { GenerateChunkEvent, ImagePolicy, OutlineItem } from '@shared/generation'
import { resolvePlannedVisualFormat } from '@shared/generation'
import { normalizeLayoutIntent } from '@shared/layout-intent'
import {
  diversifyUniversalLayoutSequence,
  normalizeContentDensity,
  normalizeContentStructure,
  normalizeVisualAspect,
  resolveUniversalLayoutId
} from '@shared/universal-layouts'
import { resolveModelTimeoutMs, type ModelTimeoutProfile } from '@shared/model-timeout'
import { progressText } from '@shared/progress'
import type { GenerationModelControl } from '../context'
import {
  normalizeAudienceMove,
  normalizeOutlineEntries,
  outlineEntryToPromptText,
  normalizeOutlineText
} from '../outline-normalizer'
import { parseModelJson } from './model-response'

type AppLocale = 'zh' | 'en'

const uiText = (locale: AppLocale | undefined, zh: string, en: string): string =>
  locale === 'en' ? en : zh

const withModelControl = <T>(modelControl: GenerationModelControl | undefined, task: () => T): T =>
  modelControl ? runWithModelTemperatureControl(modelControl, task) : task()

const modelCallSignal = (
  timeoutMs: unknown,
  profile: ModelTimeoutProfile,
  upstreamSignal?: AbortSignal
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs(timeoutMs, profile))
  return upstreamSignal ? AbortSignal.any([timeoutSignal, upstreamSignal]) : timeoutSignal
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
    '- Each item must have exactly these fields: title, keyPoints, layoutIntent, visualFormat, audienceMove, contentStructure, moduleCount, visualAspect, contentDensity, layoutId.',
    '- visualFormat and audienceMove are required. audienceMove must be one concise "before → after" transition.',
    '- layoutId must be a universal layout catalog ID or null.',
    '- keyPoints must be an array with 1-10 short strings.'
  ].join('\n')

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
  imagePolicy?: ImagePolicy
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
    visualElementPreferences: args.visualElementPreferences,
    imagePolicy: args.imagePolicy
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
      const keyPoints = structuredEntries.map(outlineEntryToPromptText)
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
      if (!visualFormat) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM plan_deck 第 ${index + 1} 页缺少可执行的 visualFormat。`,
            `LLM plan_deck item ${index + 1} is missing an actionable visualFormat.`
          )
        )
      }
      if (!audienceMove || !audienceMove.includes('→')) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM plan_deck 第 ${index + 1} 页缺少有效的 audienceMove（before → after）。`,
            `LLM plan_deck item ${index + 1} is missing a valid audienceMove (before → after).`
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
    if (items.length !== args.totalPages) {
      throw new Error(
        uiText(
          args.appLocale,
          `LLM plan_deck 返回 ${items.length} 页，但要求精确返回 ${args.totalPages} 页。`,
          `LLM plan_deck returned ${items.length} slides but exactly ${args.totalPages} are required.`
        )
      )
    }
    return diversifyUniversalLayoutSequence(items)
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
