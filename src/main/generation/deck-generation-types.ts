/** deck 生成运行的参数与结果契约，编排层与单页生成/评审修复子模块共享。 */
import type {
  AnimationPreferencesPayload,
  DesignContract,
  GenerateChunkEvent,
  OutlineItem
} from '@shared/generation'
import type { GenerationAgentManager, GenerationModelControl } from './context'
import type { PageConcurrencyPreference } from '@shared/page-concurrency'
import type { GenerationFailureInfo } from '@shared/generation-error'
import type { AppLocale } from './runner-shared'
import type { PageTaskInput } from './page-refs'

export type DeckGenerationArgs = {
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
  pageTasks?: PageTaskInput[]
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
  /**
   * 可选的会话事件落盘回调（由持有 db 的调用方注入）。
   * 生成编排层用它把 deck 评审结果写进 session_events，失败不阻断生成。
   */
  appendSessionEvent?: (data: {
    eventType: string
    payload?: Record<string, unknown>
    actor?: string
  }) => Promise<unknown>
}

export type DeckGenerationResult = {
  summary: string
  failedPages: Array<{ pageId: string; title: string; reason: string }>
  pendingPages: Array<{ pageId: string; title: string }>
  pause: {
    failure: GenerationFailureInfo
    occurrences: number
  } | null
}
