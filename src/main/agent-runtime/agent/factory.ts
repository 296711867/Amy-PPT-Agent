import log from 'electron-log/main.js'
import { createDeepAgent } from 'deepagents'
import { buildDeckAgentSystemPrompt } from '../prompt/composers/deck-system'
import { buildEditAgentSystemPrompt } from '../prompt/composers/edit-system'
import { measurePromptText } from '../prompt/metrics'
import { createSessionBoundDeckTools } from '../tools/deck-tools'
import { getRequiredProductSkillNamesForSlideSize } from '../../product-skills'
import { resolveModel } from '../model/resolve'
import type { ModelRuntimeConfig } from '../model/usage'
import { attachProductSkillsBackend } from '../skills/backend'
import {
  createProductGeneralPurposeSubagent,
  GuardedFilesystemBackend,
  shouldEnableGeneralPurposeSubagent
} from './backend'
import { validatePersistedPageAfterEdit } from '../../presentation/html/page-writer-core'
import { validateRenderedPresentationPage } from '../../presentation/html/rendered-page-validator'
import {
  formatDeckQualityFeedback,
  inspectPresentationDeckQuality,
  type DeckQualityReport
} from '../../presentation/html/deck-quality-validator'
import { findNewDeckHardViolations } from '../../presentation/html/deck-quality-guard'
import {
  findNewNarrativeHardViolations,
  formatDeckNarrativeFeedback,
  inspectPresentationDeckNarrative,
  type DeckNarrativeReport
} from '../../presentation/html/deck-narrative-validator'
import type { DeepAgentStreamResult, SessionDeckGenerationContext } from './types'

export type CreateSessionEditAgentArgs = {
  provider: string
  apiKey: string
  model: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  modelRuntime?: ModelRuntimeConfig
  styleId?: string | null
  context: SessionDeckGenerationContext
}

export type CreateSessionDeckAgentArgs = CreateSessionEditAgentArgs & {
  systemPromptAddendum?: string
}

function shouldBlockNativeEditFile(context: SessionDeckGenerationContext): boolean {
  if (context.editScope === 'presentation-container') return true
  return !Boolean(context.selectedSelector?.trim())
}

function shouldBlockNativeWriteFile(context: SessionDeckGenerationContext): boolean {
  // Every edit scope has a narrower write path with scope and validation enforcement:
  // selector -> edit_file, page -> update_single_page_file,
  // deck -> update_page_file, container -> set_index_transition.
  return context.mode === 'edit'
}

export function createSessionEditAgent(args: CreateSessionEditAgentArgs): DeepAgentStreamResult {
  const model = resolveModel(
    args.provider,
    args.apiKey,
    args.model,
    args.baseUrl,
    args.temperature,
    args.maxTokens,
    args.modelRuntime
  )
  const context: SessionDeckGenerationContext = {
    ...args.context,
    provider: args.provider,
    model: args.model
  }
  const disableNativeEditFile = shouldBlockNativeEditFile(context)
  const disableNativeWriteFile = shouldBlockNativeWriteFile(context)
  const selectedPageId = context.selectedPageId
  const selectedPagePath = selectedPageId ? context.pageFileMap[selectedPageId] : undefined
  const deckPages = Object.keys(context.pageFileMap).map((pageId, index) => ({
    pageId,
    pageNumber: context.pageNumbers?.[pageId] || index + 1,
    title: context.outlineItems[index]?.title || pageId,
    htmlPath: context.pageFileMap[pageId],
    layoutIntent: context.outlineItems[index]?.layoutIntent
  }))
  const inspectDeckQuality = (): Promise<DeckQualityReport> =>
    inspectPresentationDeckQuality({
      pages: deckPages,
      slideSize: context.slideSize,
      designContract: context.designContract
    })
  const inspectDeckNarrative = (): Promise<DeckNarrativeReport> =>
    inspectPresentationDeckNarrative({ pages: deckPages })
  const selectorDeckBaselinePromise: Promise<DeckQualityReport> | null =
    !disableNativeEditFile && selectedPageId && selectedPagePath ? inspectDeckQuality() : null
  const selectorNarrativeBaselinePromise: Promise<DeckNarrativeReport> | null =
    !disableNativeEditFile && selectedPageId && selectedPagePath ? inspectDeckNarrative() : null
  const backend = new GuardedFilesystemBackend({
    rootDir: context.projectDir,
    virtualMode: true,
    disableEditFile: disableNativeEditFile,
    disableWriteFile: disableNativeWriteFile,
    editBlockedReason: disableNativeEditFile
      ? '当前编辑任务禁止使用 edit_file。请改用 update_single_page_file(pageId, content) 或 update_page_file(pageId, content)。'
      : undefined,
    writeBlockedReason:
      '当前编辑任务禁止使用 write_file。请使用 update_single_page_file(pageId, content)、update_page_file(pageId, content) 或允许的 edit_file。',
    validateEditedFile:
      !disableNativeEditFile && selectedPageId && selectedPagePath
        ? async (filePath) => {
            const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
            const expected = `${selectedPageId}.html`
            if (normalized !== expected) {
              throw new Error(`Selector 编辑仅允许修改 /${expected}；收到: ${filePath}`)
            }
            await validatePersistedPageAfterEdit({
              pageId: selectedPageId,
              targetPath: selectedPagePath,
              slideSize: context.slideSize,
              validateRenderedPage: validateRenderedPresentationPage
            })
            const before = await selectorDeckBaselinePromise
            const narrativeBefore = await selectorNarrativeBaselinePromise
            if (!before || !narrativeBefore) return
            const [after, narrativeAfter] = await Promise.all([
              inspectDeckQuality(),
              inspectDeckNarrative()
            ])
            const newQualityViolations = findNewDeckHardViolations({
              before,
              after,
              pageIds: [selectedPageId]
            })
            const newNarrativeViolations = findNewNarrativeHardViolations({
              before: narrativeBefore,
              after: narrativeAfter,
              pageIds: [selectedPageId]
            })
            if (newQualityViolations.length > 0 || newNarrativeViolations.length > 0) {
              throw new Error(
                [
                  formatDeckQualityFeedback(newQualityViolations, selectedPageId),
                  formatDeckNarrativeFeedback(newNarrativeViolations, selectedPageId)
                ]
                  .filter(Boolean)
                  .join('\n')
              )
            }
          }
        : undefined
  })
  const requiredSkillNames = getRequiredProductSkillNamesForSlideSize(context.slideSize)
  const agentBackend = attachProductSkillsBackend(backend, 'session-edit', requiredSkillNames)
  const tools = createSessionBoundDeckTools(context)
  const systemPrompt = buildEditAgentSystemPrompt(args.styleId, context)
  const hasSelector = Boolean(context.selectedSelector?.trim())
  const isDeckEdit = context.mode === 'edit' && context.editScope === 'deck'
  const isContainerEdit = context.mode === 'edit' && context.editScope === 'presentation-container'
  const promptMode = isContainerEdit
    ? 'container'
    : hasSelector
      ? 'selector'
      : isDeckEdit
        ? 'deck'
        : 'single-page'

  log.info('[deepagent] create session edit agent', {
    sessionId: context.sessionId,
    provider: args.provider,
    model: args.model,
    styleId: args.styleId || '',
    projectDir: context.projectDir,
    indexPath: context.indexPath,
    selectedPageId: context.selectedPageId,
    selectPageIds: context.selectPageIds,
    disableNativeEditFile,
    disableNativeWriteFile,
    promptMode,
    skillsEnabled: agentBackend.enabled,
    requiredSkillNames
  })

  return createDeepAgent({
    model: model as any,
    backend: agentBackend.backend,
    systemPrompt,
    tools: tools as any,
    middleware: agentBackend.middleware as any,
    subagents: createProductGeneralPurposeSubagent({
      model,
      tools,
      backend: agentBackend.backend,
      skillSource: agentBackend.skillSource,
      requiredSkillNames
    })
  })
}

export function createSessionDeckAgent(args: CreateSessionDeckAgentArgs): DeepAgentStreamResult {
  const model = resolveModel(
    args.provider,
    args.apiKey,
    args.model,
    args.baseUrl,
    args.temperature,
    args.maxTokens,
    args.modelRuntime
  )
  const context: SessionDeckGenerationContext = {
    ...args.context,
    provider: args.provider,
    model: args.model
  }
  const backend = new GuardedFilesystemBackend({
    rootDir: context.projectDir,
    virtualMode: true,
    disableEditFile: true,
    compactTemplatePagePath:
      context.templatePageReadRequired && context.selectedPageId
        ? `/${context.selectedPageId}.html`
        : undefined,
    editBlockedReason: context.templatePageReadRequired
      ? '当前模板生成任务禁止使用 edit_file。请使用 update_template_page_file(pageId, content)。'
      : '当前生成/全局编辑任务禁止使用 edit_file。请使用 update_single_page_file(pageId, content) 或 update_page_file(pageId, content)。'
  })
  const requiredSkillNames = getRequiredProductSkillNamesForSlideSize(context.slideSize)
  const agentBackend = attachProductSkillsBackend(backend, 'session-deck', requiredSkillNames)
  const getToolName = (tool: unknown): string => {
    const maybe = tool as { name?: unknown; lc_kwargs?: { name?: unknown } }
    if (typeof maybe.name === 'string') return maybe.name
    if (typeof maybe.lc_kwargs?.name === 'string') return maybe.lc_kwargs.name
    return ''
  }
  const tools = createSessionBoundDeckTools(context)
  const enableGeneralPurposeSubagent = shouldEnableGeneralPurposeSubagent(context)
  const systemPrompt = [
    buildDeckAgentSystemPrompt(args.styleId, context),
    args.systemPromptAddendum?.trim() || ''
  ]
    .filter(Boolean)
    .join('\n\n')
  const systemPromptMetrics = measurePromptText(systemPrompt)

  log.info('[deepagent] create session deck agent', {
    sessionId: context.sessionId,
    provider: args.provider,
    model: args.model,
    styleId: args.styleId || '',
    projectDir: context.projectDir,
    indexPath: context.indexPath,
    selectedPageId: context.selectedPageId,
    skillsEnabled: agentBackend.enabled,
    generalPurposeSubagentEnabled: enableGeneralPurposeSubagent,
    systemPromptMetrics,
    requiredSkillNames,
    selectedPagePath:
      context.selectedPageId && context.pageFileMap[context.selectedPageId]
        ? context.pageFileMap[context.selectedPageId]
        : '',
    totalPages: context.outlineTitles.length,
    toolNames: tools.map((tool) => getToolName(tool)).filter((name) => name.length > 0)
  })

  return createDeepAgent({
    model: model as any,
    backend: agentBackend.backend,
    systemPrompt,
    tools: tools as any,
    middleware: agentBackend.middleware as any,
    subagents: createProductGeneralPurposeSubagent({
      model,
      tools,
      backend: agentBackend.backend,
      skillSource: agentBackend.skillSource,
      requiredSkillNames,
      enabled: enableGeneralPurposeSubagent
    })
  })
}
