/** 整页/deck/selector 编辑运行：编辑 agent 创建 → 流处理 → 状态发射。 */
import log from 'electron-log/main.js'
import { createSessionEditAgent } from '../agent-runtime/agent'
import { buildEditUserPrompt } from '../agent-runtime/prompt'
import type {
  DeckEditScope,
  DesignContract,
  GenerateChunkEvent,
  OutlineItem,
  SelectedElementRuntimeContext
} from '@shared/generation'
import { progressLabel, progressText } from '@shared/progress'
import type { GenerationAgentManager, GenerationModelControl } from './context'
import { processAgentStreamCore } from './agent-stream-processor'
import { resolveLayoutMasterOutlineItems } from './page-refs'
import { modelCallSignal, uiText, withModelControl, type AppLocale } from './runner-shared'

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

export type RunDeepAgentScopedEditArgs = RunDeepAgentEditBaseArgs & {
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
): Promise<void> => runDeepAgentScopedEdit({ ...args, editScope: 'deck' })
