import type { HtmlThumbnailResourceType } from '@shared/thumbnail'
import type { SlideSizePresetId } from '@shared/slide-size'

export type SessionStatus = 'active' | 'completed' | 'failed' | 'archived'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageType = 'text' | 'tool_call' | 'tool_result' | 'stream_chunk'
export type ChatScope = 'main' | 'page'
export type StyleSource = 'builtin' | 'custom' | 'override'
export type GenerationRunMode =
  | 'generate'
  | 'retry'
  | 'edit'
  | 'import'
  | 'addPage'
  | 'retrySinglePage'
  | 'style-switch'
  | 'page-beautify'
export type GenerationRunStatus = 'running' | 'completed' | 'failed' | 'partial'
export type SessionJobKind =
  | 'standard'
  | 'template'
  | 'retry'
  | 'add-page'
  | 'single-page-retry'
  | 'page-edit'
  | 'deck-edit'
  | 'style-switch'
  | 'page-beautify'
export type SessionJobStatus = 'pending' | 'active' | 'finished' | 'aborted'
export type GenerationPageStatus = 'pending' | 'running' | 'completed' | 'failed'
export type SessionPageStatus = import('./schema').SessionPageStatus
export type SourcePageSkeletonRole = 'chapter-divider' | 'content'
export type SourcePageSkeletonConfidence = 'high' | 'medium' | 'low'
export type SessionOperationType =
  | 'generate'
  | 'edit'
  | 'addPage'
  | 'retry'
  | 'import'
  | 'rollback'
  | 'reorder'
  | 'delete'
export type SessionOperationScope = 'session' | 'deck' | 'page' | 'selector' | 'shell'
export type SessionOperationStatus = 'committing' | 'completed' | 'failed' | 'noop'

export interface Session {
  id: string
  title: string
  topic: string | null
  styleId: string | null
  page_count: number | null
  slideSizeId?: SlideSizePresetId
  slideWidth?: number
  slideHeight?: number
  reference_document_path: string | null
  referenceDocumentPath?: string | null
  status: SessionStatus
  provider: string
  model: string
  created_at: number
  updated_at: number
  metadata: string | null
  designContract?: string | null
  currentOperationId?: string | null
  currentCommit?: string | null
  totalTokens?: number | null
}

export interface Message {
  id: string
  session_id: string
  chat_scope: ChatScope
  page_id: string | null
  selector: string | null
  image_paths: string[] | null
  video_paths: string[] | null
  role: MessageRole
  content: string
  type: MessageType
  tool_name: string | null
  tool_call_id: string | null
  token_count: number | null
  run_model: string | null
  created_at: number
}

export interface GenerationRunRecord {
  id: string
  session_id: string
  mode: GenerationRunMode
  status: GenerationRunStatus
  total_pages: number
  error: string | null
  metadata: string | null
  animation_preferences: string | null
  model_config_id: string | null
  created_at: number
  updated_at: number
}

export interface SessionJobRecord {
  id: string
  session_id: string
  kind: SessionJobKind
  previous_session_status: SessionStatus
  target_page_id: string | null
  target_page_number: number | null
  selector: string | null
  total_pages: number | null
  status: SessionJobStatus
  abort_reason: string | null
  created_at: number
  activated_at: number | null
  updated_at: number
  finished_at: number | null
}

export interface GenerationPageRecord {
  id: string
  run_id: string
  session_id: string
  page_id: string
  page_number: number
  title: string
  content_outline: string | null
  layout_intent: string | null
  visual_format: string | null
  audience_move: string | null
  layout_id: string | null
  image_asset_path: string | null
  image_asset_paths: string[]
  html_path: string | null
  status: GenerationPageStatus
  error: string | null
  retry_count: number
  created_at: number
  updated_at: number
}

export interface SessionPageRecord {
  id: string
  session_id: string
  legacy_page_id: string | null
  file_slug: string
  page_number: number
  title: string
  html_path: string
  status: SessionPageStatus
  error: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type ThumbnailStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface ThumbnailRecord {
  key: string
  resourceType: HtmlThumbnailResourceType
  resourceId: string
  variant: string
  sourcePath: string
  sourceMtimeMs: number
  signature: string
  thumbnailPath: string
  status: ThumbnailStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface SourcePageSkeletonRecord {
  id: string
  session_id: string
  page_number: number
  title: string
  role: SourcePageSkeletonRole
  source_document_path: string
  source_document_name: string | null
  source_heading: string
  heading_level: number
  line_start: number
  line_end: number
  reason: string | null
  layout_intent: string | null
  layout_id: string | null
  confidence: SourcePageSkeletonConfidence
  created_at: number
  updated_at: number
}

export interface SessionPageInput {
  id: string
  sessionId: string
  legacyPageId?: string | null
  fileSlug: string
  pageNumber: number
  title: string
  htmlPath: string
  status?: SessionPageStatus
  error?: string | null
}

export interface SessionWithPageCount {
  session: Session
  pageCount: number
}

export const sessionPageRecordToInput = (page: SessionPageRecord): SessionPageInput => ({
  id: page.id,
  sessionId: page.session_id,
  legacyPageId: page.legacy_page_id,
  fileSlug: page.file_slug,
  pageNumber: page.page_number,
  title: page.title,
  htmlPath: page.html_path,
  status: page.status,
  error: page.error
})

export interface StyleRow {
  id: string
  style: string
  styleName: string
  styleNameZh: string
  styleNameEn: string
  description: string
  category: string
  aliases: string // JSON array
  source: StyleSource
  styleSkill: string // plain markdown
  version: string
  styleCase: string
  packageDir: string
  active: boolean
  favoriteAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SessionStyleSnapshotRow {
  id: string
  sessionId: string
  styleId: string
  styleKey: string
  styleName: string
  styleNameZh: string
  styleNameEn: string
  description: string
  category: string
  aliases: string
  source: StyleSource
  version: string
  styleCase: string
  packageDir: string
  styleSkill: string
  createdAt: number
}

/** Session-local style data used when a presentation is created without a catalog preset. */
export interface SessionStyleSnapshotInput {
  styleId: string
  styleKey: string
  styleName: string
  styleNameZh?: string
  styleNameEn?: string
  description?: string
  category?: string
  aliases?: string
  source?: StyleSource
  version?: string
  styleCase?: string
  packageDir?: string
  styleSkill: string
}

export interface ModelConfigRow {
  id: string
  name: string
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  disableTemperature: number
  thinkingParameterMode: string
  active: number
  createdAt: number
  updatedAt: number
}

export interface ImageModelConfigRow {
  id: string
  name: string
  provider: string
  active: number
  modelConfig: string
  createdAt: number
  updatedAt: number
}

export interface ImageGenerationHistoryRow {
  id: string
  sessionId: string
  pageId: string
  prompt: string
  imagePaths: string
  modelConfigId: string
  provider: string
  model: string
  createdAt: number
}

export interface UserPreferenceRecord {
  key: string
  value: unknown
  confidence: number
  source_sessions: string[]
  created_at: number
  updated_at: number
  last_used_at: number | null
}

export interface ProjectRecord {
  id: string
  session_id: string
  title: string
  output_path: string
  root_path: string | null
  file_count: number
  total_size: number
  status: 'draft' | 'published' | 'exported'
  created_at: number
  updated_at: number
}

export interface SessionOperationRecord {
  id: string
  session_id: string
  type: SessionOperationType
  status: SessionOperationStatus
  scope: SessionOperationScope | null
  prompt: string | null
  parent_operation_id: string | null
  before_commit: string | null
  after_commit: string | null
  target_operation_id: string | null
  target_commit: string | null
  changed_files_json: string
  changed_pages_json: string
  tracked_files_json: string
  metadata_json: string
  created_at: number
  completed_at: number | null
}

export interface SessionOperationPageRecord {
  id: string
  operation_id: string
  session_id: string
  page_id: string
  legacy_page_id: string | null
  file_slug: string
  page_number: number
  title: string
  html_path: string
  status: SessionPageStatus
  error: string | null
  created_at: number
  updated_at: number
}
