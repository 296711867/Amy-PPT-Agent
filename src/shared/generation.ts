import type { LayoutIntent } from './layout-intent'
import type {
  ContentDensity,
  ContentStructure,
  UniversalLayoutId,
  VisualAspect
} from './universal-layouts'
import type { GenerationFailureInfo } from './generation-error'

/** 单个内容要点的结构化表示（锁定版式模式的数据源）。 */
export type OutlineItemPriority = 'primary' | 'supporting' | 'detail'
export interface OutlineItemData {
  /** 稳定 id，用于跨方案追踪同一要点。 */
  id: string
  /** 要点短标签（≤32 字）。 */
  label: string
  /** 数值（如有）：指标值、百分比等。 */
  value?: string | number
  /** 数值单位（如有）：%、万、亿等。 */
  unit?: string
  /** 展示用格式化值（如 "42.7%"），优先于 value+unit。 */
  displayValue?: string
  /** 补充说明（≤60 字）。 */
  detail?: string
  /** 要点在本页中的角色。 */
  priority?: OutlineItemPriority
}

export type OutlineItemEntry = string | OutlineItemData

/** A generated slide's semantic plan, shared by planning, generation, and page tools. */
export interface OutlineItem {
  title: string
  contentOutline: string
  layoutIntent?: LayoutIntent
  /** Semantic shape of the content before a concrete layout is selected. */
  contentStructure?: ContentStructure
  /** Number of meaningful content modules the selected layout must accommodate. */
  moduleCount?: number
  /** Intended image-frame orientation, decided during planning before layout selection. */
  visualAspect?: VisualAspect
  /** Visible content load used to prefer rows, stacks, grids, or feature compositions. */
  contentDensity?: ContentDensity
  /** Planned visual expression (diagram/chart/table/quote/...) decided together with the outline. */
  visualFormat?: VisualFormat
  /** One-line audience state transition ("before → after") this slide must achieve. */
  audienceMove?: string
  /** M3a resolves a session layout master into a flexible generation constraint. */
  layoutId?: UniversalLayoutId | string
  layoutPrompt?: string
  imagePolicy?: ImagePolicy
  /** 规划期 keyPoints（结构化要点），锁定版式模式下列表/指标槽的数据源。 */
  items?: OutlineItemEntry[]
  imageAssetPath?: string
  imageAssetPaths?: string[]
  /** Reusable full-canvas background assigned from the deck background package. */
  backgroundAsset?: DeckBackgroundAsset
}

/**
 * 规划期为每页决定的视觉表达格式。diagram-* 前缀的格式由 amy-ppt-diagram
 * 技能负责落地，chart 由 amy-ppt-chart 技能负责，其余为常规页面形态。
 */
export type VisualFormat =
  | 'cover'
  | 'section-divider'
  | 'ending'
  | 'diagram-flow'
  | 'diagram-timeline'
  | 'diagram-architecture'
  | 'diagram-cycle'
  | 'diagram-hierarchy'
  | 'diagram-quadrant'
  | 'diagram-funnel'
  | 'diagram-venn'
  | 'diagram-comparison'
  | 'chart'
  | 'table'
  | 'big-number'
  | 'quote'
  | 'image-focus'
  | 'card-grid'
  | 'narrative'

export const VISUAL_FORMATS: readonly VisualFormat[] = [
  'cover',
  'section-divider',
  'ending',
  'diagram-flow',
  'diagram-timeline',
  'diagram-architecture',
  'diagram-cycle',
  'diagram-hierarchy',
  'diagram-quadrant',
  'diagram-funnel',
  'diagram-venn',
  'diagram-comparison',
  'chart',
  'table',
  'big-number',
  'quote',
  'image-focus',
  'card-grid',
  'narrative'
]

export const isVisualFormat = (value: unknown): value is VisualFormat =>
  typeof value === 'string' && (VISUAL_FORMATS as readonly string[]).includes(value)

export const normalizeVisualFormat = (value: unknown): VisualFormat | undefined =>
  isVisualFormat(value) ? value : undefined

/** 规划结果缺 visualFormat 时按 layoutIntent 兜底推导；无映射则交由页面 Agent 自行决定。 */
const LAYOUT_INTENT_VISUAL_FORMAT_FALLBACK: Partial<Record<LayoutIntent, VisualFormat>> = {
  cover: 'cover',
  timeline: 'diagram-timeline',
  process: 'diagram-flow',
  comparison: 'diagram-comparison',
  quote: 'quote',
  'image-focus': 'image-focus'
}

export const resolvePlannedVisualFormat = (
  value: unknown,
  layoutIntent?: LayoutIntent
): VisualFormat | undefined =>
  normalizeVisualFormat(value) ||
  (layoutIntent ? LAYOUT_INTENT_VISUAL_FORMAT_FALLBACK[layoutIntent] : undefined)

export type ImagePolicy = 'placeholder' | 'ai'

/**
 * 视觉元素偏好：用户在创建会话时指定，注入规划 prompt 让 AI 在设计大纲时
 * 主动分配图表/图片/表格到合适的页面。
 */
export type VisualElementLevel = 'none' | 'few' | 'moderate' | 'rich'

export type VisualElementPreferences = {
  /** 图表（Chart.js 数据图）。 */
  charts: VisualElementLevel
  /** 图片（产品图/场景图/示意图）。 */
  images: VisualElementLevel
  /** 表格（多维度对比/数据列表）。 */
  tables: VisualElementLevel
}

const VISUAL_ELEMENT_LEVELS: readonly VisualElementLevel[] = ['none', 'few', 'moderate', 'rich']

export const DEFAULT_VISUAL_ELEMENT_PREFERENCES: VisualElementPreferences = {
  charts: 'none',
  images: 'none',
  tables: 'none'
}

const normalizeVisualElementLevel = (value: unknown): VisualElementLevel =>
  VISUAL_ELEMENT_LEVELS.includes(value as VisualElementLevel)
    ? (value as VisualElementLevel)
    : 'none'

export const normalizeVisualElementPreferences = (
  value: unknown
): VisualElementPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_VISUAL_ELEMENT_PREFERENCES
  }
  const record = value as Record<string, unknown>
  return {
    charts: normalizeVisualElementLevel(record.charts),
    images: normalizeVisualElementLevel(record.images),
    tables: normalizeVisualElementLevel(record.tables)
  }
}

/** 把偏好级别转为规划 prompt 的指导文本。 */
export const formatVisualElementGuidance = (prefs: VisualElementPreferences): string => {
  const lines: string[] = []
  const levelText: Record<VisualElementLevel, string> = {
    none: '',
    few: '1-2',
    moderate: '3-5',
    rich: 'as many as suitable'
  }
  if (prefs.charts !== 'none') {
    lines.push(`- Charts: include ${levelText[prefs.charts]} chart page(s). Assign visualFormat "chart" to pages that present data trends, comparisons, or proportions.`)
  }
  if (prefs.images !== 'none') {
    lines.push(`- Images: include ${levelText[prefs.images]} image-focused page(s). Assign visualFormat "image-focus" to pages where a visual (product photo, scene, or diagram) should dominate.`)
  }
  if (prefs.tables !== 'none') {
    lines.push(`- Tables: include ${levelText[prefs.tables]} table page(s). Assign visualFormat "table" to pages comparing multiple items across dimensions.`)
  }
  if (lines.length === 0) return ''
  return [
    'Visual element requirements (must be distributed across specific pages in the outline):',
    ...lines,
    'When assigning these formats, choose the pages where the content genuinely calls for that visual form — do not force a chart onto a concept page or a table onto a narrative page.'
  ].join('\n')
}

/**
 * 生成方式：
 * - creative：现有自由创作，Agent 逐页写 HTML
 * - locked：锁定版式优先 —— 规划出的内容按版式契约确定性填充，
 *   匹配不到合适版式的页面自动回退自由创作
 */
export type GenerationMode = 'creative' | 'locked'

export const normalizeGenerationMode = (value: unknown): GenerationMode =>
  value === 'locked' ? 'locked' : 'creative'

/**
 * 图片占位符模式下，所有图片槽位统一指向的占位资源路径。
 * 页面提示词通过识别该路径切换为「语义占位块」指令，而不是塞真实 <img>。
 */
export const AMY_IMAGE_PLACEHOLDER_PATH = './assets/amy-image-placeholder.png'

export const normalizeImagePolicy = (value: unknown): ImagePolicy =>
  value === 'ai' ? 'ai' : 'placeholder'

export type DeckBackgroundWhitespace =
  | 'cover-safe'
  | 'blank-left'
  | 'blank-right'
  | 'blank-top-center'
  | 'ending-safe'

export interface DeckBackgroundPolicy {
  enabled: boolean
  coverEnabled: boolean
  contentEnabled: boolean
  endingEnabled: boolean
  contentBackgroundCount: 1 | 2 | 3
}

export interface DeckBackgroundAsset {
  role: 'cover' | 'content' | 'ending'
  whitespace: DeckBackgroundWhitespace
  path: string
  prompt: string
}

export interface DeckBackgroundManifest {
  version: 1
  slideSizeId: string
  assets: DeckBackgroundAsset[]
}

export const DEFAULT_DECK_BACKGROUND_POLICY: DeckBackgroundPolicy = {
  enabled: false,
  coverEnabled: true,
  contentEnabled: true,
  endingEnabled: true,
  contentBackgroundCount: 1
}

export const normalizeDeckBackgroundPolicy = (value: unknown): DeckBackgroundPolicy => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const rawCount = Number(record.contentBackgroundCount)
  const contentBackgroundCount: 1 | 2 | 3 = rawCount === 2 || rawCount === 3 ? rawCount : 1
  const hasExplicitRoleSelection =
    typeof record.coverEnabled === 'boolean' ||
    typeof record.contentEnabled === 'boolean' ||
    typeof record.endingEnabled === 'boolean'
  const coverEnabled = hasExplicitRoleSelection ? record.coverEnabled === true : true
  const contentEnabled = hasExplicitRoleSelection ? record.contentEnabled === true : true
  const endingEnabled = hasExplicitRoleSelection ? record.endingEnabled === true : true
  const hasEnabledRole = coverEnabled || contentEnabled || endingEnabled
  return {
    enabled: record.enabled === true && hasEnabledRole,
    coverEnabled,
    contentEnabled,
    endingEnabled,
    contentBackgroundCount
  }
}

/** Deck-level visual rules persisted with a session and applied to every generated page. */
export interface DesignContract {
  theme: string
  background: string
  palette: string[]
  titleStyle: string
  layoutMotif: string
  chartStyle: string
  shapeLanguage: string
  titleFont: string
  subtitleFont: string
  bodyFont: string
}

export type DeckEditScope = 'page' | 'deck' | 'presentation-container'

export interface UploadedAsset {
  id: string
  fileName: string
  originalName: string
  relativePath: string
  absolutePath?: string
  mimeType: string
  size: number
  createdAt: number
}

export interface ParseDocumentPlanPayload {
  files: Array<{
    path: string
    name?: string
  }>
  modelConfigId?: string
  topic?: string
  existingBrief?: string
}

export interface SourceDocumentPlan {
  version: 1
  confidence: 'high' | 'medium' | 'low'
  sourceDocumentPath?: string
  sourceDocumentName?: string
  pageSkeleton: DocumentPlanPageSkeletonItem[]
}

export interface PrepareReferenceDocumentPayload {
  files: Array<{
    path: string
    name?: string
  }>
}

export interface ParseImageReferencePayload {
  file: {
    path: string
    name?: string
  }
  modelConfigId?: string
}

export interface ParsedDocumentPlanResult {
  topic: string
  pageCount: number
  briefText: string
  pageSkeleton?: DocumentPlanPageSkeletonItem[]
  sourcePlan?: SourceDocumentPlan
  files: Array<{
    name: string
    type: 'markdown' | 'text' | 'csv' | 'docx' | 'image'
    characterCount: number
    path: string
  }>
}

export interface DocumentPlanPageSkeletonItem {
  id?: string
  pageNumber: number
  title: string
  role: 'chapter-divider' | 'content'
  sourceHeading: string
  headingLevel: number
  lineStart: number
  lineEnd: number
  reason: string
  layoutIntent?: LayoutIntent
  contentStructure?: ContentStructure
  moduleCount?: number
  visualAspect?: VisualAspect
  contentDensity?: ContentDensity
  layoutId?: string
}

export const SECTION_AGENDA_OUTLINE_MARKER = 'Page role: section-agenda'
export const SECTION_AGENDA_REASON_PREFIX_ZH = '章节目录页'
export const SECTION_AGENDA_REASON_PREFIX_EN = 'Section agenda page'

export const isSectionAgendaReason = (reason: string): boolean =>
  new RegExp(
    `^(?:${SECTION_AGENDA_REASON_PREFIX_ZH}|${SECTION_AGENDA_REASON_PREFIX_EN})\\s*[:：]`,
    'i'
  ).test(reason.trim())

export const isSectionAgendaOutline = (outline: string): boolean =>
  /Page role:\s*section-agenda/i.test(outline)

export const isInternalDocumentPlanPageReason = (reason: string): boolean => {
  const normalized = reason.toLowerCase()
  return (
    normalized.includes('major # heading') ||
    normalized.includes('leaf ## section') ||
    normalized.includes('top-level ## section') ||
    normalized.includes('standalone level-') ||
    normalized.includes('section has substantial own body')
  )
}

export interface PreparedReferenceDocumentResult {
  files: ParsedDocumentPlanResult['files']
}

export interface PptxImportPayload {
  filePath: string
  title?: string
  styleId?: string | null
  modelConfigId?: string
}

/** Style source selected for a newly created session. */
export type SessionStyleSelection =
  | {
      mode: 'preset'
      styleId: string
    }
  | {
      mode: 'ai'
      description: string
      themeColors: string[]
    }

export interface PptxImportProgressPayload {
  sessionId?: string
  stage: 'reading' | 'parsing' | 'media' | 'pages' | 'index' | 'database' | 'completed'
  progress: number
  label: string
  pageNumber?: number
  totalPages?: number
}

export interface PptxImportResult {
  sessionId: string
  pageCount: number
  warnings: string[]
}

export interface FontRef {
  source: 'google' | 'uploaded' | 'system'
  family: string
  id?: string
}

export type FontSelection =
  | { mode: 'auto' }
  | {
      mode: 'pair'
      presetId?: string
      title: FontRef
      /** Old sessions omit this field; normalizeFontSelection then inherits body. */
      subtitle?: FontRef
      body: FontRef
    }

export const normalizeFontSelection = (value: unknown): FontSelection => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (record.mode !== 'pair') return { mode: 'auto' }
  const title =
    record.title && typeof record.title === 'object'
      ? (record.title as Record<string, unknown>)
      : {}
  const body =
    record.body && typeof record.body === 'object' ? (record.body as Record<string, unknown>) : {}
  const titleFamily = typeof title.family === 'string' ? title.family.trim() : ''
  const bodyFamily = typeof body.family === 'string' ? body.family.trim() : ''
  if (!titleFamily || !bodyFamily) return { mode: 'auto' }
  const normalizeSource = (source: unknown): FontRef['source'] =>
    source === 'uploaded' || source === 'system' ? source : 'google'
  const normalizeRef = (font: Record<string, unknown>, family: string): FontRef => ({
    source: normalizeSource(font.source),
    family,
    id: typeof font.id === 'string' ? font.id : undefined
  })
  const subtitle =
    record.subtitle && typeof record.subtitle === 'object'
      ? (record.subtitle as Record<string, unknown>)
      : body
  const subtitleFamily = typeof subtitle.family === 'string' ? subtitle.family.trim() : bodyFamily
  return {
    mode: 'pair',
    presetId: typeof record.presetId === 'string' ? record.presetId.trim() || undefined : undefined,
    title: normalizeRef(title, titleFamily),
    subtitle: normalizeRef(subtitle, subtitleFamily || bodyFamily),
    body: normalizeRef(body, bodyFamily)
  }
}

/**
 * A bounded, read-only snapshot of the element that initiated a selector-scoped AI edit.
 *
 * The renderer reads this from the live preview; the main process normalizes it again before
 * it reaches an agent prompt. It deliberately excludes HTML, event handlers, and editor-only
 * markers so it remains context rather than an alternate document-editing channel.
 */
export interface SelectedElementRuntimeContext {
  classList?: string[]
  attributes?: Record<string, string>
  inlineStyle?: Record<string, { value: string; priority?: '' | 'important' }>
  computedStyle?: Record<string, string>
  bounds?: { x: number; y: number; width: number; height: number }
}

/**
 * The renderer samples only these computed properties and the main process accepts only these
 * keys from IPC. Keep the list shared so the two trust-boundary checks cannot drift.
 */
export const SELECTED_ELEMENT_CONTEXT_COMPUTED_STYLE_PROPERTIES = [
  'display',
  'position',
  'box-sizing',
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin',
  'padding',
  'gap',
  'z-index',
  'opacity',
  'visibility',
  'overflow',
  'transform',
  'transform-origin',
  'color',
  'background-color',
  'background-image',
  'border',
  'border-radius',
  'box-shadow',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'white-space',
  'flex',
  'flex-direction',
  'align-items',
  'justify-content',
  'grid-template-columns',
  'grid-template-rows',
  'object-fit',
  'object-position'
] as const

export interface GenerateStartPayload {
  sessionId: string
  modelConfigId?: string
  userMessage: string
  type?: 'deck' | 'page'
  chatType?: 'main' | 'page'
  resetVisualStyle?: boolean
  persistUserMessage?: boolean
  /** Renderer-generated ID so an optimistic chat message is reconciled with its DB record. */
  clientMessageId?: string
  chatPageId?: string
  selectPageIds?: string[]
  selectedPageId?: string
  htmlPath?: string
  selector?: string
  elementTag?: string
  elementText?: string
  selectedElementContext?: SelectedElementRuntimeContext
  imagePaths?: string[]
  videoPaths?: string[]
  docPaths?: string[]
  animationPreferences?: AnimationPreferencesPayload
  autoApply?: boolean
  approvedPlan?: SessionPageEditPlan
}

export const SESSION_PAGE_EDIT_INTENTS = [
  'content',
  'style',
  'layout',
  'redesign',
  'other'
] as const

export type SessionPageEditIntent = (typeof SESSION_PAGE_EDIT_INTENTS)[number]

export interface SessionPageEditPlan {
  intent: SessionPageEditIntent
  target: string
  summary: string
  changes: string[]
  confirmationQuestion: string
}

export interface SessionPageEditAssessment {
  plan: SessionPageEditPlan
  requiresConfirmation: boolean
}

export const normalizeSessionPageEditPlan = (value: unknown): SessionPageEditPlan | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const intent = SESSION_PAGE_EDIT_INTENTS.includes(record.intent as SessionPageEditIntent)
    ? (record.intent as SessionPageEditIntent)
    : undefined
  const target = typeof record.target === 'string' ? record.target.trim().slice(0, 500) : ''
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 1500) : ''
  const changes = Array.isArray(record.changes)
    ? record.changes
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8)
    : []
  const confirmationQuestion =
    typeof record.confirmationQuestion === 'string'
      ? record.confirmationQuestion.trim().slice(0, 300)
      : ''
  if (!intent || !target || !summary || changes.length === 0 || !confirmationQuestion)
    return undefined
  return { intent, target, summary, changes, confirmationQuestion }
}

export interface SwitchSessionStylePayload {
  sessionId: string
  styleId: string
  modelConfigId?: string
}

export type RetrySessionStylePayload = SwitchSessionStylePayload & {
  failedRunId?: string
}

export type RetryDeckEditPayload = GenerateStartPayload & {
  failedRunId?: string
}

export const MAX_SELECTED_PAGES = 50
export const MAX_STYLE_SWITCH_PAGES = 500

export const normalizeSelectPageIds = (value: unknown, limit = MAX_SELECTED_PAGES): string[] => {
  if (!Array.isArray(value)) return []
  const normalized = Array.from(
    new Set(
      value.map((item) => String(item || '').trim()).filter((item) => /^[a-z0-9_-]+$/i.test(item))
    )
  )
  if (normalized.length > limit) {
    throw new Error(`一次最多选择 ${limit} 页`)
  }
  return normalized
}

export interface GenerateRetryFailedPayload {
  sessionId: string
  modelConfigId?: string
  userMessage?: string
  failedRunId?: string
}

export type AnimationPreferenceId =
  | 'fade'
  | 'fade-up'
  | 'fade-down'
  | 'fade-left'
  | 'fade-right'
  | 'scale-in'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'fly-in'
  | 'wipe'
  | 'zoom-in'
  | 'spin-in'
  | 'pulse-soft'
  | 'pulse'
  | 'pulse-strong'
  | 'grow-shrink-soft'
  | 'grow-shrink'
  | 'grow-shrink-strong'

export interface AnimationPreferencesPayload {
  ids: AnimationPreferenceId[]
}

const ANIMATION_PREFERENCE_IDS = new Set<AnimationPreferenceId>([
  'fade',
  'fade-up',
  'fade-down',
  'fade-left',
  'fade-right',
  'scale-in',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'fly-in',
  'wipe',
  'zoom-in',
  'spin-in',
  'pulse-soft',
  'pulse',
  'pulse-strong',
  'grow-shrink-soft',
  'grow-shrink',
  'grow-shrink-strong'
])

export const normalizeAnimationPreferences = (
  value: unknown
): AnimationPreferencesPayload | null => {
  const rawIds = Array.isArray((value as AnimationPreferencesPayload | null)?.ids)
    ? (value as AnimationPreferencesPayload).ids
    : Array.isArray(value)
      ? value
      : []
  const ids = Array.from(
    new Set(
      rawIds
        .map((item) => String(item || '').trim())
        .filter((item): item is AnimationPreferenceId =>
          ANIMATION_PREFERENCE_IDS.has(item as AnimationPreferenceId)
        )
    )
  )
  const selected = ids.slice(0, 3)
  return selected.length > 0 ? { ids: selected } : null
}

export type AnimationPreferenceSourceRun = {
  session_id: string
  animation_preferences: string | null
}

/**
 * Inherit animation preferences from a prior generation run — but only when an
 * explicit source run is supplied AND it belongs to the same session. A missing
 * or stale source run must never block retry; degrade to no preferences.
 * See docs/design/session-create-animation-preferences-design.md (run 字段持久化).
 */
export const resolveInheritedAnimationPreferences = (
  sourceRun: AnimationPreferenceSourceRun | null | undefined,
  sessionId: string
): AnimationPreferencesPayload | null => {
  if (!sourceRun || sourceRun.session_id !== sessionId) return null
  try {
    return normalizeAnimationPreferences(
      sourceRun.animation_preferences ? JSON.parse(sourceRun.animation_preferences) : null
    )
  } catch {
    return null
  }
}

export interface GenerateAddPagePayload {
  sessionId: string
  modelConfigId?: string
  userMessage: string
  insertAfterPageNumber: number
  targetPageId?: string
}

export interface GenerateRetrySinglePagePayload {
  sessionId: string
  modelConfigId?: string
  pageId: string
}

export interface GeneratedPagePayload {
  id?: string
  focusPage?: boolean
  pageNumber: number
  title: string
  contentOutline?: string | null
  html: string
  htmlPath?: string
  pageId?: string
  sourceUrl?: string
  pageCommitReady?: boolean
}

export interface PageStatusPayload {
  id?: string
  pageNumber: number
  title: string
  pageId?: string
  htmlPath?: string
  error?: string
}

export interface GenerateStagePayload {
  runId: string
  sessionId?: string
  stage: string
  label: string
  progress?: number
  currentPage?: number
  totalPages?: number
  completedPageCount?: number
  failedPageCount?: number
  timestamp?: string
  activityKind?:
    | 'page-edit'
    | 'deck-edit'
    | 'edit'
    | 'style-switch'
    | 'page-beautify'
    | 'single-page-retry'
    | 'addPage'
}

export type GenerateChunkEvent =
  | {
      type: 'stage_started' | 'stage_progress'
      payload: GenerateStagePayload
    }
  | {
      type: 'llm_status'
      payload: GenerateStagePayload & {
        provider?: string
        model?: string
        detail?: string
      }
    }
  | {
      type: 'assistant_message'
      payload: {
        id?: string
        runId: string
        sessionId?: string
        content: string
        chatType?: 'main' | 'page'
        pageId?: string
        timestamp?: string
        activityKind?:
          | 'page-edit'
          | 'deck-edit'
          | 'edit'
          | 'style-switch'
          | 'page-beautify'
          | 'single-page-retry'
          | 'addPage'
      }
    }
  | {
      type: 'page_generated'
      payload: GenerateStagePayload & GeneratedPagePayload
    }
  | {
      type: 'page_updated'
      payload: GenerateStagePayload & GeneratedPagePayload
    }
  | {
      type: 'page_planned'
      payload: GenerateStagePayload & PageStatusPayload
    }
  | {
      type: 'page_started' | 'page_failed'
      payload: GenerateStagePayload & PageStatusPayload
    }
  | {
      type: 'run_completed'
      payload: {
        runId: string
        sessionId?: string
        totalPages: number
        completedPageCount?: number
        failedPageCount?: number
        timestamp?: string
        outcome?: 'changed' | 'unchanged'
        activityKind?:
          | 'page-edit'
          | 'deck-edit'
          | 'edit'
          | 'style-switch'
          | 'page-beautify'
          | 'single-page-retry'
          | 'addPage'
      }
    }
  | {
      type: 'run_paused'
      payload: {
        runId: string
        sessionId?: string
        message: string
        failure: GenerationFailureInfo
        completedPageCount?: number
        failedPageCount?: number
        pendingPageCount: number
        pendingPageIds: string[]
        occurrences: number
        provider?: string
        model?: string
        activityKind?:
          | 'page-edit'
          | 'deck-edit'
          | 'edit'
          | 'style-switch'
          | 'page-beautify'
          | 'single-page-retry'
          | 'addPage'
        timestamp?: string
      }
    }
  | {
      type: 'run_error'
      payload: {
        runId: string
        sessionId?: string
        message: string
        cancelled?: boolean
        completedPageCount?: number
        failedPageCount?: number
        timestamp?: string
        activityKind?:
          | 'page-edit'
          | 'deck-edit'
          | 'edit'
          | 'style-switch'
          | 'page-beautify'
          | 'single-page-retry'
          | 'addPage'
      }
    }
