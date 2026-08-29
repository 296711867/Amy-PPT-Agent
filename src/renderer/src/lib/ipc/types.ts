/** 渲染进程 IPC 门面的共享类型：会话/样式/字体/导出等载荷与结果契约。 */
import type {
  FontSelection,
  GenerateChunkEvent,
  GenerateStartPayload,
  SourceDocumentPlan
} from '@shared/generation.js'
import type { HtmlThumbnailResourceType } from '@shared/thumbnail'
import type { ThinkingParameterMode } from '@shared/model-config.js'
import type { PageMergeDisabledReason } from '@shared/page-merge'
import type { SlideSizePresetId } from '@shared/slide-size'
import type { ImageModelConfig, ImageModelProvider } from '@shared/image-generation.js'
import type { GeneratedImageAsset } from '@shared/image-generation.js'

export interface StyleCategory {
  name: string
  styles: Array<{
    id: string
    label: string
    description: string
    source?: 'builtin' | 'custom' | 'override'
    editable?: boolean
    styleCase?: string
  }>
}

export interface StyleDetail {
  id: string
  styleKey?: string
  label: string
  name?: {
    zh: string
    en: string
  }
  description: string
  aliases: string[]
  styleSkill: string
  source?: 'builtin' | 'custom' | 'override'
  editable?: boolean
  category?: string
  version?: string
  styleCase?: string
  packageDir?: string
}

export interface StyleListItem {
  id: string
  styleKey?: string
  label: string
  name?: {
    zh: string
    en: string
  }
  description: string
  aliases?: string[]
  category: string
  source?: 'builtin' | 'custom' | 'override'
  editable?: boolean
  version?: string
  styleCase?: string
  packageDir?: string
  favoriteAt?: number | null
  previewPath?: string | null
  thumbnailPath?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface HtmlThumbnailTask {
  resourceType: HtmlThumbnailResourceType
  resourceId: string
  variant: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  thumbnailPath: string | null
  error?: string
}

export interface StyleParseResult {
  label: string
  description: string
  category: string
  aliases: string[]
  styleSkill: string
  styleCase?: string
}

export interface GenerateRunStateSnapshot {
  sessionId: string
  runId: string | null
  status: 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  hasActiveRun: boolean
  progress: number
  totalPages: number
  completedPageCount?: number
  failedPageCount?: number
  events: GenerateChunkEvent[]
  error: string | null
  startedAt: number | null
  updatedAt: number | null
  kind?:
    | 'standard'
    | 'template'
    | 'retry'
    | 'add-page'
    | 'single-page-retry'
    | 'edit'
    | 'page-edit'
    | 'deck-edit'
    | 'style-switch'
    | 'page-beautify'
  targetPageId?: string
  targetPageNumber?: number
  activityKind?:
    | 'page-edit'
    | 'deck-edit'
    | 'edit'
    | 'style-switch'
    | 'page-beautify'
    | 'single-page-retry'
    | 'addPage'
  retryPayload?: GenerateStartPayload
}

export interface StyleSwitchJobSnapshot {
  sessionId: string
  runId: string | null
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  hasActiveRun: boolean
  progress: number
  totalPages: number
  completedPageCount: number
  failedPageCount: number
  targetStyleId: string | null
  targetStyleName: string | null
  pages: Array<{
    pageId: string
    pageNumber: number
    title: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    error: string | null
    retryCount: number
  }>
  error: string | null
  startedAt: number | null
  updatedAt: number | null
  kind: 'style-switch'
}

export interface ExportDeckResult {
  success: boolean
  cancelled?: boolean
  path?: string
  warnings?: string[]
  pageCount?: number
  durationMs?: number
  frameCount?: number
}

export interface MergeSourceSessionSummary {
  id: string
  title: string
  pageCount: number
  slideSizeId: SlideSizePresetId
  slideWidth: number
  slideHeight: number
  updatedAt: number
  status: string
  selectable: boolean
  disabledReason?: PageMergeDisabledReason
}

export interface MergeTemplateSourceSummary {
  id: string
  title: string
  pageCount: number
  slideSizeId: SlideSizePresetId
  slideWidth: number
  slideHeight: number
  updatedAt: number
  thumbnailPath: string | null
  selectable: boolean
  disabledReason?: PageMergeDisabledReason
  isSource: boolean
}

export interface MergeSourcePageSummary {
  id: string
  pageId: string
  pageNumber: number
  title: string
  contentOutline?: string | null
  slideSizeId: SlideSizePresetId
  slideWidth: number
  slideHeight: number
  htmlPath?: string
  sourceUrl?: string
  status?: string
  selectable: boolean
  disabledReason?: PageMergeDisabledReason
}

export interface ImportSessionFileResult {
  success: boolean
  cancelled?: boolean
  sessionId?: string
  title?: string
  pageCount?: number
  warnings?: string[]
}

export interface HtmlEditorImportResult {
  docId: string
  title: string
  htmlPath: string
  sourcePath: string
  designWidth: number
  html: string
}

export interface HtmlEditorAiMessage {
  role: 'user' | 'assistant'
  content: string
  selectedElement?: HtmlEditorAiElementContext
}

export interface HtmlEditorAiElementContext {
  selector: string
  label?: string
  elementTag?: string
  elementText?: string
  html?: string
}

export interface HtmlEditorAiEditBatch {
  propertyEdits: Array<Record<string, unknown>>
  textEdits: Array<Record<string, unknown>>
  dragEdits: Array<Record<string, unknown>>
  deletes: Array<Record<string, unknown>>
  addElements: Array<Record<string, unknown>>
}

export type HtmlEditorAiIntent = 'inspect' | 'redesign' | 'style' | 'layout' | 'content' | 'other'

export interface HtmlEditorAiPlan {
  intent: HtmlEditorAiIntent
  target: string
  summary: string
  changes: string[]
  confirmationQuestion: string
  edits: HtmlEditorAiEditBatch
}

export interface HtmlEditorAiHistoryMessage extends HtmlEditorAiMessage {
  id: string
  createdAt: number
  intent?: HtmlEditorAiIntent
  plan?: HtmlEditorAiPlan | null
  requiresConfirmation?: boolean
}

export type HtmlEditorFileImportResult =
  | { cancelled: true; reason?: 'user-cancelled' | 'storage-not-configured' }
  | ({ cancelled: false } & HtmlEditorImportResult)

export interface TemplateListItem {
  id: string
  name: string
  description: string
  source: 'user'
  pageCount: number
  tags: string[]
  slideSizeId?: import('@shared/slide-size').SlideSizePresetId
  slideWidth?: number
  slideHeight?: number
  previewHtmlPath: string | null
  thumbnailPath: string | null
  previewPages: Array<{
    pageNumber: number
    pageId: string
    title: string
    htmlPath: string
  }>
  createdAt: number
  updatedAt: number
}

export interface EnsureElementAnchorPayload {
  sessionId?: string
  htmlPath: string
  pageId: string
  selector: string
  elementTag?: string
  elementText?: string
  reason?: 'inspect' | 'drag' | 'text-edit'
  formula?: {
    latex: string
    html: string
    displayMode: boolean
  }
}

export interface EnsureElementAnchorResult {
  success: boolean
  selector: string
  blockId: string
  changed: boolean
}

export interface UploadAssetsPayload {
  sessionId: string
  files: Array<{
    path: string
    name?: string
  }>
}

export interface UpdateElementLayoutPayload {
  sessionId: string
  htmlPath: string
  pageId: string
  selector: string
  x: number
  y: number
  width?: number
  height?: number
  childUpdates?: Array<{
    path: number[]
    width?: number
    height?: number
  }>
  isAbsoluteMode?: boolean
}

export interface UpdateElementPropertiesPayload {
  sessionId: string
  htmlPath: string
  pageId: string
  selector: string
  patch: {
    html?: string
    text?: string
    textTarget?: {
      type: 'text-node'
      parentSelector: string
      textNodeIndex: number
      text: string
    }
    style?: {
      color?: string
      fontSize?: string
      fontWeight?: string
      textAlign?: string
    }
  }
}

export interface CreateSessionPayload {
  topic: string
  styleId?: string
  styleSelection?: import('@shared/generation').SessionStyleSelection
  modelConfigId?: string
  pageCount?: number
  slideSizeId?: import('@shared/slide-size').SlideSizePresetId
  referenceDocumentPath?: string
  fontSelection?: FontSelection
  imagePolicy?: import('@shared/generation').ImagePolicy
  generationMode?: import('@shared/generation').GenerationMode
  visualElementPreferences?: import('@shared/generation').VisualElementPreferences
  deckBackgroundPolicy?: import('@shared/generation').DeckBackgroundPolicy
  sourcePlan?: SourceDocumentPlan
}

export interface SaveSessionAsNewPayload {
  sessionId: string
  title: string
}

export interface SaveSessionAsNewResult {
  sessionId: string
}

export interface ModelConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'openai-responses' | 'google' | 'zhipu' | 'deepseek' | 'kimi'
  model: string
  apiKey: string
  hasApiKey: boolean
  baseUrl: string
  maxTokens: number
  disableTemperature: boolean
  thinkingParameterMode: ThinkingParameterMode
  active: boolean
  createdAt: number
  updatedAt: number
}

export type { GeneratedImageAsset, ImageModelConfig, ImageModelProvider }

export interface UploadPrerequisitesResult {
  ready: boolean
  missing: Array<'storagePath' | 'activeModel' | 'apiKey' | 'model'>
  message?: string
}

export type FontRole = 'title' | 'subtitle' | 'body'
export type FontScript = 'latin' | 'cjk'
export type FontSource = 'google' | 'uploaded' | 'system'

export interface FontFileEntry {
  file: string
  weight: number
  style: 'normal' | 'italic'
  format?: 'woff2' | 'truetype' | 'opentype'
  size?: number
  sha256?: string
}

export interface FontListItem {
  id: string
  family: string
  source: FontSource
  category: string
  role: FontRole[]
  scripts: FontScript[]
  files?: FontFileEntry[]
  createdAt?: number
  updatedAt?: number
}

export interface FontRegistryResponse {
  googleFonts: FontListItem[]
  systemFonts: FontListItem[]
  userFonts: FontListItem[]
}

export interface UploadFontPayload {
  files: Array<{
    path: string
    weight?: number
    style?: 'normal' | 'italic'
  }>
  family: string
  category?: string
  role?: FontRole[]
  scripts?: FontScript[]
}

