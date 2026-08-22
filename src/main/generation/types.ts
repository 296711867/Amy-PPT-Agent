import type { ModelTimeoutProfile } from '@shared/model-timeout'
import type {
  AnimationPreferencesPayload,
  DesignContract,
  FontSelection,
  SelectedElementRuntimeContext,
  SourceDocumentPlan
} from '@shared/generation'
import type {
  CommonGenerationContext,
  GenerationDbPort,
  GenerationModelControl
} from './context'
import type { ModelRuntimeConfig } from '../agent-runtime/model'

export type GenerateMode = 'generate' | 'edit' | 'retry' | 'addPage' | 'retrySinglePage'
export type GenerateChatType = 'main' | 'page'

// Minimal context needed by finalize functions.
// Both GenerationContext and AddPageContext satisfy this interface.
export type FinalizeContext = {
  sessionId: string
  runId: string
  styleId: string
  previousSessionStatus: string
  effectiveMode: GenerateMode
  messageScope: GenerateChatType
  messagePageId?: string
  targetPageId?: string
  projectId: string
  modelConfigId?: string
  modelConfigName?: string
  modelControl?: GenerationModelControl
  runModel?: string
  animationPreferences?: AnimationPreferencesPayload | null
}

export type GenerationRunContext = {
  sessionId: string
  userMessage: string
  requestedType?: 'deck' | 'page'
  effectiveMode: GenerateMode
  selectedPageId?: string
  selectPageIds: string[]
  htmlPath?: string
  selector?: string
  elementTag?: string
  elementText?: string
  selectedElementContext?: SelectedElementRuntimeContext
  sourceRunId?: string
  session: Awaited<ReturnType<GenerationDbPort['getSession']>>
  sessionRecord: Record<string, unknown>
  previousSessionStatus: string
  projectDir: string
  abortSignal: AbortSignal
  runId: string
  styleId: string
  styleSkill: CommonGenerationContext['styleSkill']
  layoutRulesPrompt: string
  styleKey: string
  styleName: string
  styleVersion: string
  slideSize: CommonGenerationContext['slideSize']
  userProvidedOutlineTitles: string[]
  totalPages: number
  provider: string
  apiKey: string
  model: string
  modelConfigId?: string
  modelConfigName?: string
  runModel?: string
  modelControl: GenerationModelControl
  maxTokens: number
  modelRuntime: ModelRuntimeConfig
  modelTimeouts: Record<ModelTimeoutProfile, number>
  pageConcurrency: CommonGenerationContext['pageConcurrency']
  generationMode: import('@shared/generation').GenerationMode
  providerBaseUrl: string
  projectId: string
  messageScope: GenerateChatType
  messagePageId?: string
  imagePaths: string[]
  videoPaths: string[]
  sourceDocumentPaths: string[]
  sourcePlan: SourceDocumentPlan | null
  topic: string
  deckTitle: string
  appLocale: 'zh' | 'en'
  fontSelection: FontSelection
  imagePolicy: import('@shared/generation').ImagePolicy
  deckBackgroundPolicy: import('@shared/generation').DeckBackgroundPolicy
  animationPreferences: AnimationPreferencesPayload | null
}

export type DeckContext = GenerationRunContext & { effectiveMode: 'generate' }
export type EditContext = GenerationRunContext & {
  effectiveMode: 'edit'
  resetVisualStyle?: boolean
  designContract?: DesignContract
  onDeckEditStarted?: () => void
  skipGenerationRunCreation?: boolean
}
export type RetryContext = GenerationRunContext & { effectiveMode: 'retry' }

export type AnyFlowContext =
  | DeckContext
  | EditContext
  | RetryContext
  | {
      sessionId: string
      runId: string
      messageScope: GenerateChatType
      messagePageId?: string
      runModel?: string
    }

export type FinalizeGenerationArgs = {
  context: FinalizeContext
  indexPath: string
  totalPages: number
  generatedPages: Array<{
    id?: string
    pageNumber: number
    title: string
    pageId: string
    htmlPath: string
    html: string
  }>
  designContract?: DesignContract
}

export type EmitAssistantFn = (context: AnyFlowContext, content: string) => Promise<void>
