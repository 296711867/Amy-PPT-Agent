import { useEffect, useRef, type RefObject } from 'react'
import type { GenerateChunkEvent } from '@shared/generation'
import { ipc } from '@renderer/lib/ipc'
import { useT } from '@renderer/i18n'
import {
  useGenerateStore,
  useSessionDetailUiStore,
  useSessionStore,
  useToastStore
} from '@renderer/store'
import {
  isDeckEditGenerationEvent,
  isPageBeautifyGenerationEvent,
  isPageEditGenerationEvent,
  isStyleSwitchGenerationEvent,
  type ChatType
} from '../shared'

type SessionGenerationEpochRefs = {
  pageEditStateEpochRef: RefObject<number>
  pageBeautifyStateEpochRef: RefObject<number>
  deckEditStateEpochRef: RefObject<number>
  styleSwitchStateEpochRef: RefObject<number>
}

type UseSessionGenerationEventsArgs = SessionGenerationEpochRefs & {
  sessionId: string | undefined
  activeChatType: ChatType
  activePageId?: string
}

export function useSessionGenerationEvents(args: UseSessionGenerationEventsArgs): void {
  const {
    sessionId: id,
    activeChatType,
    activePageId,
    pageEditStateEpochRef,
    pageBeautifyStateEpochRef,
    deckEditStateEpochRef,
    styleSwitchStateEpochRef
  } = args
  const t = useT()
  const loadSession = useSessionStore((state) => state.loadSession)
  const addMessage = useSessionStore((state) => state.addMessage)
  const updateProgress = useGenerateStore((state) => state.updateProgress)
  const toastError = useToastStore((state) => state.error)
  const toastSuccess = useToastStore((state) => state.success)
  const activeChatRef = useRef<{ chatType: ChatType; pageId?: string }>({
    chatType: activeChatType,
    pageId: activePageId
  })
  activeChatRef.current = { chatType: activeChatType, pageId: activePageId }
  const handledTerminalRunsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!id) return
    const handler = (event: GenerateChunkEvent): void => {
      const { type, payload } = event
      if (payload.sessionId && payload.sessionId !== id) return
      const activePageEditJob = useGenerateStore.getState().pageEditJobs[id] || null
      const activePageBeautifyJob = useGenerateStore.getState().pageBeautifyJobs[id] || null
      const activeDeckEditJob = useGenerateStore.getState().deckEditJobs[id] || null
      const activeStyleSwitchJob = useGenerateStore.getState().styleSwitchJobs[id] || null
      const isPageEdit = isPageEditGenerationEvent(payload, activePageEditJob)
      const isPageBeautify = isPageBeautifyGenerationEvent(payload, activePageBeautifyJob)
      const isDeckEdit = isDeckEditGenerationEvent(payload, activeDeckEditJob)
      const isStyleSwitch = isStyleSwitchGenerationEvent(payload, activeStyleSwitchJob)
      const isAddingPageRun =
        payload.activityKind === 'addPage' && useSessionDetailUiStore.getState().isAddingPage
      const isRetryingSinglePageRun =
        payload.activityKind === 'single-page-retry' &&
        useSessionDetailUiStore.getState().isRetryingSinglePage
      if (
        type === 'stage_started' ||
        type === 'stage_progress' ||
        type === 'page_generated' ||
        type === 'page_started' ||
        type === 'llm_status'
      ) {
        if (isPageEdit) {
          useGenerateStore.getState().updatePageEdit(id, {
            runId: payload.runId,
            status:
              activePageEditJob?.status === 'cancelling'
                ? 'cancelling'
                : payload.stage === 'queued'
                  ? 'queued'
                  : 'running',
            label: payload.label,
            progress: payload.progress ?? 0
          })
        } else if (isPageBeautify) {
          useGenerateStore.getState().updatePageBeautify(id, {
            runId: payload.runId,
            status:
              activePageBeautifyJob?.status === 'cancelling'
                ? 'cancelling'
                : payload.stage === 'queued'
                  ? 'queued'
                  : 'running',
            label: payload.label,
            progress: payload.progress ?? 0
          })
        } else if (isDeckEdit) {
          useGenerateStore.getState().updateDeckEdit(id, {
            runId: payload.runId,
            status:
              activeDeckEditJob?.status === 'cancelling'
                ? 'cancelling'
                : payload.stage === 'queued'
                  ? 'queued'
                  : 'running',
            label: payload.label,
            progress: payload.progress ?? 0,
            totalPages: payload.totalPages
          })
        } else if (isStyleSwitch) {
          useGenerateStore.getState().updateStyleSwitchJob(id, {
            runId: payload.runId,
            status: activeStyleSwitchJob?.status === 'cancelling' ? 'cancelling' : 'running',
            progress: payload.progress ?? activeStyleSwitchJob?.progress ?? 0,
            totalPages: payload.totalPages || activeStyleSwitchJob?.totalPages || 1
          })
          if (type === 'page_started' && payload.pageId) {
            useGenerateStore.getState().updateStyleSwitchPage(id, payload.pageId, {
              status: 'running',
              error: null
            })
          }
        } else {
          // 不清空 currentPages，保持预览可见
          useGenerateStore.getState().clearSessionError(id)
          useGenerateStore.setState({ isGenerating: true, error: null, status: 'running' })
          updateProgress({
            stage: payload.stage,
            label: payload.label,
            progress: payload.progress ?? 0,
            currentPage: payload.currentPage,
            totalPages: payload.totalPages
          })
        }
        if (type === 'page_generated') {
          // Skip page_generated during addPage — pages will be reloaded on run_completed
          if (useSessionDetailUiStore.getState().isAddingPage) {
            updateProgress({
              stage: payload.stage,
              label: payload.label,
              progress: payload.progress ?? 0,
              currentPage: payload.currentPage,
              totalPages: payload.totalPages
            })
            return
          }
          const store = useGenerateStore.getState()
          const existingPage = store.currentPages.find((page) =>
            payload.id
              ? page.id === payload.id
              : payload.pageId
                ? page.pageId === payload.pageId
                : page.pageNumber === payload.pageNumber
          )
          const entityId =
            payload.id || existingPage?.id || payload.pageId || `page-${payload.pageNumber}`
          // 全新生成：第 1 页到来时清掉旧页面，避免新旧混合
          if (payload.pageNumber === 1 && store.currentPages.length > 0) {
            store.setPages([])
          }
          store.addPage({
            id: entityId,
            pageNumber: payload.pageNumber,
            title: payload.title,
            contentOutline: payload.contentOutline,
            html: payload.html,
            htmlPath: payload.htmlPath,
            pageId: payload.pageId || `page-${payload.pageNumber}`,
            sourceUrl: payload.sourceUrl,
            status: 'completed',
            error: null
          })
          if (payload.focusPage !== false) {
            useSessionDetailUiStore.getState().setSelectedPageId(entityId)
          }
          useSessionDetailUiStore.getState().bumpPreviewKey()
        }
      } else if (type === 'page_updated') {
        if (isPageEdit) {
          useGenerateStore.getState().updatePageEdit(id, {
            runId: payload.runId,
            status: activePageEditJob?.status === 'cancelling' ? 'cancelling' : 'running',
            label: payload.label,
            progress: payload.progress ?? 0
          })
        } else if (isPageBeautify) {
          useGenerateStore.getState().updatePageBeautify(id, {
            runId: payload.runId,
            status: activePageBeautifyJob?.status === 'cancelling' ? 'cancelling' : 'running',
            label: payload.label,
            progress: payload.progress ?? 0
          })
        } else if (isDeckEdit) {
          useGenerateStore.getState().updateDeckEdit(id, {
            runId: payload.runId,
            status: activeDeckEditJob?.status === 'cancelling' ? 'cancelling' : 'running',
            label: payload.label,
            progress: payload.progress ?? 0,
            totalPages: payload.totalPages
          })
        } else if (isStyleSwitch) {
          useGenerateStore.getState().updateStyleSwitchJob(id, {
            runId: payload.runId,
            status: activeStyleSwitchJob?.status === 'cancelling' ? 'cancelling' : 'running',
            progress: payload.progress ?? activeStyleSwitchJob?.progress ?? 0,
            totalPages: payload.totalPages || activeStyleSwitchJob?.totalPages || 1
          })
          if (payload.pageId) {
            useGenerateStore.getState().updateStyleSwitchPage(id, payload.pageId, {
              status: 'completed',
              error: null
            })
          }
        } else {
          useGenerateStore.getState().clearSessionError(id)
          useGenerateStore.setState({ isGenerating: true, error: null, status: 'running' })
        }
        const store = useGenerateStore.getState()
        const existingPage = store.currentPages.find((page) =>
          payload.id
            ? page.id === payload.id
            : payload.pageId
              ? page.pageId === payload.pageId
              : page.pageNumber === payload.pageNumber
        )
        const entityId =
          payload.id || existingPage?.id || payload.pageId || `page-${payload.pageNumber}`
        useGenerateStore.getState().addPage({
          id: entityId,
          pageNumber: payload.pageNumber,
          title: payload.title,
          contentOutline: payload.contentOutline,
          html: payload.html,
          htmlPath: payload.htmlPath,
          pageId: payload.pageId || `page-${payload.pageNumber}`,
          sourceUrl: payload.sourceUrl,
          status: 'completed',
          error: null
        })
        if (
          !isPageEdit &&
          !isPageBeautify &&
          !isDeckEdit &&
          !isStyleSwitch &&
          payload.focusPage !== false
        ) {
          useSessionDetailUiStore.getState().setSelectedPageId(entityId)
        }
        useSessionDetailUiStore.getState().bumpPreviewKey()
      } else if (type === 'page_failed' && isStyleSwitch) {
        if (payload.pageId) {
          useGenerateStore.getState().updateStyleSwitchPage(id, payload.pageId, {
            status: 'failed',
            error: payload.error || '页面切换失败'
          })
          const store = useGenerateStore.getState()
          const page = store.currentPages.find((item) => item.pageId === payload.pageId)
          if (page) {
            store.addPage({ ...page, status: 'failed', error: payload.error || '页面切换失败' })
          }
        }
      } else if (type === 'assistant_message') {
        const incomingType = payload.chatType === 'page' && payload.pageId ? 'page' : 'main'
        const incomingPageId = incomingType === 'page' ? payload.pageId : undefined
        const active = activeChatRef.current
        const matchesCurrentChat =
          incomingType === active.chatType &&
          (incomingType !== 'page' || incomingPageId === active.pageId)
        if (!matchesCurrentChat) return
        const createdAt = payload.timestamp
          ? Math.floor(new Date(payload.timestamp).getTime() / 1000)
          : Math.floor(Date.now() / 1000)
        addMessage({
          id: payload.id || crypto.randomUUID(),
          session_id: id,
          chat_scope: incomingType,
          page_id: incomingPageId || null,
          role: 'assistant',
          content: payload.content,
          type: 'text',
          tool_name: null,
          tool_call_id: null,
          token_count: null,
          created_at: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000)
        })
      } else if (type === 'run_completed') {
        const terminalKey = `${payload.runId}:completed`
        if (payload.runId && handledTerminalRunsRef.current.has(terminalKey)) return
        if (payload.runId) {
          handledTerminalRunsRef.current.add(terminalKey)
          if (handledTerminalRunsRef.current.size > 100) {
            const oldest = handledTerminalRunsRef.current.values().next().value
            if (typeof oldest === 'string') handledTerminalRunsRef.current.delete(oldest)
          }
        }
        if (isPageEdit) {
          pageEditStateEpochRef.current += 1
          useGenerateStore.getState().finishPageEdit(id)
        } else if (isPageBeautify) {
          pageBeautifyStateEpochRef.current += 1
          useGenerateStore.getState().finishPageBeautify(id)
          toastSuccess(
            payload.outcome === 'unchanged'
              ? t('sessionDetail.pageBeautifyUnchanged')
              : t('sessionDetail.pageBeautifyCompleted')
          )
          void loadSession(id)
        } else if (isDeckEdit) {
          deckEditStateEpochRef.current += 1
          const retryPayload = activeDeckEditJob?.payload
          const failedPageCount = Math.max(0, Number(payload.failedPageCount) || 0)
          useGenerateStore
            .getState()
            .finishDeckEdit(
              id,
              retryPayload && failedPageCount > 0
                ? { runId: payload.runId, failedPageCount, payload: retryPayload }
                : undefined
            )
          void loadSession(id)
        } else if (isStyleSwitch) {
          styleSwitchStateEpochRef.current += 1
          const failedPageCount = Math.max(0, Number(payload.failedPageCount) || 0)
          useGenerateStore.getState().finishStyleSwitch(id, {
            status: failedPageCount > 0 ? 'partial' : 'completed',
            error: failedPageCount > 0 ? activeStyleSwitchJob?.error || null : null
          })
          void loadSession(id)
        } else if (isAddingPageRun) {
          const selectedPageId = useSessionDetailUiStore.getState().selectedPageId
          void loadSession(id)
            .then((loaded) => {
              if (loaded) {
                useGenerateStore
                  .getState()
                  .setPages(useSessionStore.getState().currentGeneratedPages)
              }
            })
            .catch((error) => console.warn('[session-detail] reload added page failed', error))
            .finally(() => {
              useSessionDetailUiStore.getState().finishAddPage(selectedPageId)
              useGenerateStore.getState().finishGeneration()
            })
        } else if (isRetryingSinglePageRun) {
          void loadSession(id)
            .then((loaded) => {
              if (loaded) {
                useGenerateStore
                  .getState()
                  .setPages(useSessionStore.getState().currentGeneratedPages)
              }
            })
            .catch((error) => console.warn('[session-detail] reload retried page failed', error))
            .finally(() => {
              useSessionDetailUiStore.getState().setIsRetryingSinglePage(false)
              useGenerateStore.getState().finishGeneration()
            })
        } else if (!useSessionDetailUiStore.getState().isAddingPage) {
          useGenerateStore.getState().finishGeneration()
        }
      } else if (type === 'run_paused') {
        const terminalKey = `${payload.runId}:paused`
        if (payload.runId && handledTerminalRunsRef.current.has(terminalKey)) return
        if (payload.runId) handledTerminalRunsRef.current.add(terminalKey)
        useGenerateStore.getState().setSessionError(id, payload.message)
        useGenerateStore.setState({ status: 'failed', isGenerating: false, progress: null })
        void loadSession(id)
      } else if (type === 'run_error') {
        const terminalKey = `${payload.runId}:error`
        if (payload.runId && handledTerminalRunsRef.current.has(terminalKey)) return
        if (payload.runId) {
          handledTerminalRunsRef.current.add(terminalKey)
          if (handledTerminalRunsRef.current.size > 100) {
            const oldest = handledTerminalRunsRef.current.values().next().value
            if (typeof oldest === 'string') handledTerminalRunsRef.current.delete(oldest)
          }
        }
        if (isPageEdit) {
          pageEditStateEpochRef.current += 1
          useGenerateStore.getState().finishPageEdit(id)
          if (!payload.cancelled) {
            useGenerateStore.getState().setSessionError(id, payload.message)
          }
          void loadSession(id)
        } else if (isPageBeautify) {
          pageBeautifyStateEpochRef.current += 1
          useGenerateStore.getState().finishPageBeautify(id)
          if (!payload.cancelled) {
            useGenerateStore.getState().setSessionError(id, payload.message)
            toastError(payload.message || t('sessionDetail.pageBeautifyFailed'))
          }
          void loadSession(id)
        } else if (isDeckEdit) {
          deckEditStateEpochRef.current += 1
          const retryPayload = activeDeckEditJob?.payload
          const failedPageCount = Math.max(0, Number(payload.failedPageCount) || 0)
          const retryPageCount = failedPageCount || activeDeckEditJob?.totalPages || 1
          useGenerateStore
            .getState()
            .finishDeckEdit(
              id,
              !payload.cancelled && retryPayload
                ? { runId: payload.runId, failedPageCount: retryPageCount, payload: retryPayload }
                : undefined
            )
          if (!payload.cancelled) {
            useGenerateStore.getState().setSessionError(id, payload.message)
          }
          void loadSession(id)
        } else if (isStyleSwitch) {
          styleSwitchStateEpochRef.current += 1
          const failedPageCount = Math.max(0, Number(payload.failedPageCount) || 0)
          const status = payload.cancelled
            ? 'cancelled'
            : failedPageCount > 0 ||
                activeStyleSwitchJob?.pages.some((page) => page.status === 'completed')
              ? 'partial'
              : 'failed'
          useGenerateStore.getState().finishStyleSwitch(id, { status, error: payload.message })
          if (!payload.cancelled) useGenerateStore.getState().setSessionError(id, payload.message)
          void loadSession(id)
        } else if (isAddingPageRun) {
          const selectedPageId = useSessionDetailUiStore.getState().selectedPageId
          void loadSession(id)
            .then((loaded) => {
              if (loaded) {
                useGenerateStore
                  .getState()
                  .setPages(useSessionStore.getState().currentGeneratedPages)
              }
            })
            .catch((error) =>
              console.warn('[session-detail] reload failed added page failed', error)
            )
            .finally(() => {
              useSessionDetailUiStore.getState().finishAddPage(selectedPageId)
              useGenerateStore.getState().finishGeneration()
            })
        } else if (isRetryingSinglePageRun) {
          void loadSession(id)
            .then((loaded) => {
              if (loaded) {
                useGenerateStore
                  .getState()
                  .setPages(useSessionStore.getState().currentGeneratedPages)
              }
            })
            .catch((error) =>
              console.warn('[session-detail] reload failed retried page failed', error)
            )
            .finally(() => {
              useSessionDetailUiStore.getState().setIsRetryingSinglePage(false)
              useGenerateStore.getState().finishGeneration()
            })
        } else if (!useSessionDetailUiStore.getState().isAddingPage) {
          if (payload.cancelled) {
            useGenerateStore.getState().cancelGeneration(payload.message)
          } else {
            useGenerateStore.getState().setSessionError(id, payload.message)
            useGenerateStore.setState({ status: 'failed', isGenerating: false, progress: null })
          }
          void loadSession(id)
        }
      }
    }
    const unsubscribe = ipc.onGenerateChunk(handler)
    return () => {
      unsubscribe?.()
    }
  }, [addMessage, id, t, toastError, toastSuccess, updateProgress])
}

