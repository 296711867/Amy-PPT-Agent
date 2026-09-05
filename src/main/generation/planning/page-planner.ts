import {
  extractModelText,
  resolveModel,
  runWithModelTemperatureControl
} from '../../agent-runtime/model'
import type { ModelRuntimeConfig } from '../../agent-runtime/model'
import { CONTENT_LANGUAGE_RULES } from '../../agent-runtime/prompt'
import type { GenerationModelControl } from '../context'
import { normalizeLayoutIntent, type LayoutIntent } from '@shared/layout-intent'
import { resolvePlannedVisualFormat, VISUAL_FORMATS, type VisualFormat } from '@shared/generation'
import {
  formatUniversalLayoutCatalogPrompt,
  normalizeContentDensity,
  normalizeContentStructure,
  normalizeVisualAspect,
  resolveUniversalLayoutId,
  type UniversalLayoutId
} from '@shared/universal-layouts'
import {
  normalizeAudienceMove,
  normalizeOutlineEntries,
  normalizeOutlineText,
  outlineEntryToPromptText
} from '../outline-normalizer'
import { parseModelJson } from './model-response'

type AppLocale = 'zh' | 'en'

export interface PlanNewPageArgs {
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
}

export interface PlannedNewPage {
  title: string
  contentOutline: string
  layoutIntent: LayoutIntent
  contentStructure?: import('@shared/universal-layouts').ContentStructure
  moduleCount?: number
  visualAspect?: import('@shared/universal-layouts').VisualAspect
  contentDensity?: import('@shared/universal-layouts').ContentDensity
  visualFormat: VisualFormat
  audienceMove: string
  layoutId?: UniversalLayoutId
}

export const planNewPage = async (args: PlanNewPageArgs): Promise<PlannedNewPage> => {
  const createClient = (): ReturnType<typeof resolveModel> =>
    resolveModel(
      args.provider,
      args.apiKey,
      args.model,
      args.baseUrl,
      args.temperature,
      args.maxTokens,
      args.modelRuntime
    )
  const client = args.modelControl
    ? runWithModelTemperatureControl(args.modelControl, createClient)
    : createClient()
  const systemPrompt = [
    'You are a PPT slide planner. The user wants to add ONE new slide to an existing deck.',
    'Generate an assertion title, concise supporting key points (1-10 items), an audience move, a visual format, a layout intent, and a universal layout ID for this single slide.',
    '',
    CONTENT_LANGUAGE_RULES,
    '',
    'The new slide must fit naturally into the existing deck:',
    '- The title language and style must match existing slide titles.',
    '- Do NOT duplicate or closely paraphrase any existing slide title.',
    '- The title must state the slide conclusion rather than name a generic topic.',
    '- audienceMove must describe the purpose as one concise "before → after" transition.',
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
    `visualFormat must be one of: ${VISUAL_FORMATS.join(', ')}. Choose the format that best expresses the content; do not default to card-grid when a chart, table, diagram, big number, quote, or image communicates it better.`,
    '',
    'Universal layout catalog:',
    formatUniversalLayoutCatalogPrompt(),
    '',
    'Choose contentStructure, moduleCount, visualAspect, and contentDensity before choosing a compatible catalog layoutId. Five or six portrait visuals with short labels may use one row; landscape visuals must use rows or grids. Nearby slides with the same structure should use a different silhouette.',
    'Return only a JSON object with exactly these fields: title, keyPoints, layoutIntent, visualFormat, audienceMove, contentStructure, moduleCount, visualAspect, contentDensity, layoutId.',
    'Do not add explanations, Markdown, or extra text.',
    'keyPoints must contain 1-10 short phrases. If the user explicitly lists topics for this slide, preserve each listed topic as a separate key point when possible.'
  ]
    .filter(Boolean)
    .join('\n')
  const contextParts: string[] = []
  if (args.existingTitles && args.existingTitles.length > 0) {
    contextParts.push('Existing slide titles (do NOT duplicate these):')
    args.existingTitles.forEach((title, index) => contextParts.push(`  ${index + 1}. ${title}`))
    contextParts.push('')
  }
  contextParts.push('User request for the new slide:')
  contextParts.push(args.userDescription)

  const combinedSignal = args.modelTimeoutMs
    ? AbortSignal.any([
        AbortSignal.timeout(args.modelTimeoutMs),
        args.signal || AbortSignal.timeout(120_000)
      ])
    : args.signal || undefined
  const response = await client.invoke(
    [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: contextParts.join('\n') }
    ],
    { signal: combinedSignal }
  )
  const parsed = parseModelJson(extractModelText(response), args.appLocale)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM plan_new_page returned invalid format; expected a JSON object.')
  }
  const item = parsed as Record<string, unknown>
  const title = String(item.title ?? '').trim()
  if (!title) throw new Error('LLM plan_new_page missing title field.')

  const structuredEntries = normalizeOutlineEntries(item.keyPoints)
  const keyPoints = structuredEntries.map(outlineEntryToPromptText)
  const layoutIntent = normalizeLayoutIntent(item.layoutIntent)
  const visualFormat = resolvePlannedVisualFormat(item.visualFormat, layoutIntent)
  const audienceMove = normalizeAudienceMove(item.audienceMove)
  if (!visualFormat) throw new Error('LLM plan_new_page missing actionable visualFormat field.')
  if (!audienceMove || !audienceMove.includes('→')) {
    throw new Error('LLM plan_new_page missing valid audienceMove field (before → after).')
  }
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
    contentOutline: normalizeOutlineText(keyPoints.join('；')),
    layoutIntent,
    contentStructure,
    moduleCount,
    visualAspect,
    contentDensity,
    visualFormat,
    audienceMove,
    layoutId
  }
}
