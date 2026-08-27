import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useThinkingStore } from '../store/thinkingStore'
import { useSessionStore, useSettingsStore, useToastStore } from '../store'
import { ipc } from '@renderer/lib/ipc'
import { ThinkingChat } from '../components/thinking/ThinkingChat'
import { ThinkingPageCards } from '../components/thinking/ThinkingPageCards'
import { GenerationConfirmDialog } from '../components/thinking/GenerationConfirmDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from '../components/ui/AlertDialog'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/Popover'
import { useLang, useT, type I18nKey } from '../i18n'
import { Clock3, FileText, FolderSearch, History, Loader2, Plus, Trash2 } from 'lucide-react'
import type { SessionStyleSelection, SourceDocumentPlan } from '@shared/generation'
import type { SlideSizePresetId } from '@shared/slide-size'
import type {
  ThinkingChatMessage,
  ThinkingSource,
  ThinkingPrepareGenerationResult,
  ThinkingStage,
  ThinkingWorkspaceListItem
} from '@shared/thinking'

const buildWelcomeMessage = (
  t: (key: 'thinking.welcomeMessage') => string
): ThinkingChatMessage => ({
  role: 'assistant',
  content: t('thinking.welcomeMessage'),
  timestamp: Date.now()
})

const buildThinkingGenerationPrompt = (args: {
  topic: string
  pageCount: number
  referenceDocumentPath: string
}): string =>
  [
    `Create a ${args.pageCount}-slide presentation about "${args.topic}" from the finalized thinking document.`,
    `Use the attached source document at ${args.referenceDocumentPath} as the authoritative thinking brief.`,
    'Follow the prepared page outline exactly. Each page outline is derived from the matching "## Page N: ..." section.',
    'Before writing a page, inspect only the relevant source range for that page instead of reading the full document.',
    'If the attached reference document includes image source notes, use the listed ./images/... public paths when relevant.',
    'Determine the presentation content language from the thinking document and source notes; do not infer it from the application UI language.'
  ].join('\n')

const stageKeyByStage: Record<ThinkingStage, I18nKey> = {
  collect: 'thinking.stageCollect',
  outline: 'thinking.stageOutline',
  draft: 'thinking.stageDraft',
  refine: 'thinking.stageRefine',
  ready: 'thinking.stageReady'
}

const contextSectionOrder = [
  'Topic',
  'User Intent',
  'Confirmed Decisions',
  'Open Questions',
  'Source Notes',
  'Latest Direction'
]

function readMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markdown.match(
    new RegExp(`^##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|\\s*$)`, 'm')
  )
  return match?.[1]?.trim() || ''
}

function buildContextMessage(
  contextMd: string,
  t: (key: I18nKey) => string
): ThinkingChatMessage | null {
  const parts = contextSectionOrder
    .map((heading) => {
      const content = readMarkdownSection(contextMd, heading)
      return content ? `**${heading}**\n${content}` : ''
    })
    .filter(Boolean)

  if (parts.length === 0) return null

  return {
    role: 'assistant',
    content: [`**${t('thinking.restoredContextTitle')}**`, ...parts].join('\n\n'),
    timestamp: Date.now()
  }
}

export function ThinkingDetailPage(): ReactElement {
  const t = useT()
  const { lang } = useLang()
  const navigate = useNavigate()
  const { success, error: toastError } = useToastStore()
  const { createSession } = useSessionStore()
  const { settings, chooseStoragePath, saveSettings } = useSettingsStore()
  const {
    thinkingId,
    thinkingMd,
    contextMd,
    stage,
    messages,
    sources,
    loading,
    thinkingSteps,
    connectionState,
    chatFailure,
    animatingText,
    createWorkspace,
    loadWorkspace,
    loadLatestWorkspace,
    reset,
    sendMessage,
    retryLastMessage,
    reconnectAndRetry,
    dismissChatFailure
  } = useThinkingStore()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [prepared, setPrepared] = useState<ThinkingPrepareGenerationResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [pendingSources, setPendingSources] = useState<ThinkingSource[]>([])
  const [historyItems, setHistoryItems] = useState<ThinkingWorkspaceListItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ThinkingWorkspaceListItem | null>(null)
  const [deletingThinkingId, setDeletingThinkingId] = useState<string | null>(null)
  const storageReady = Boolean(settings?.storagePath?.trim())

  const refreshHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshHistory = useCallback(async (): Promise<void> => {
    if (refreshHistoryTimerRef.current) {
      clearTimeout(refreshHistoryTimerRef.current)
      refreshHistoryTimerRef.current = null
    }
    if (!storageReady) {
      setHistoryItems([])
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    try {
      const items = await ipc.thinkingListWorkspaces({ limit: 50 })
      setHistoryItems(items)
    } catch (err) {
      toastError(t('thinking.historyLoadFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setHistoryLoading(false)
    }
  }, [storageReady, t, toastError])
  const debouncedRefreshHistory = useCallback(() => {
    if (refreshHistoryTimerRef.current) clearTimeout(refreshHistoryTimerRef.current)
    refreshHistoryTimerRef.current = setTimeout(() => void refreshHistory(), 300)
  }, [refreshHistory])

  useEffect(() => {
    if (storageReady && !thinkingId && !loading) {
      void loadLatestWorkspace()
    }
    setPendingSources([])
  }, [storageReady, thinkingId, loading, loadLatestWorkspace])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  // The thinking store owns stream state globally; this page only refreshes history metadata.
  useEffect(() => {
    const unsubscribeEnd = ipc.onThinkingStreamEnd((payload) => {
      if (payload.thinkingId === thinkingId) {
        debouncedRefreshHistory()
      }
    })
    return () => {
      unsubscribeEnd()
    }
  }, [thinkingId, debouncedRefreshHistory])

  const handleCreateWorkspace = async (): Promise<void> => {
    if (creatingWorkspace) return
    setCreatingWorkspace(true)
    try {
      if (!storageReady) {
        const selectedPath = await chooseStoragePath()
        const pathError = useSettingsStore.getState().storagePathError
        if (pathError) {
          toastError(t('thinking.storageSetupFailed'), { description: pathError })
          return
        }
        if (!selectedPath) return

        await saveSettings({ storagePath: selectedPath })
        const saveError = useSettingsStore.getState().verificationMessage
        if (saveError) {
          toastError(t('thinking.storageSetupFailed'), { description: saveError })
          return
        }
        success(t('thinking.storageReady'), { description: selectedPath })
      }
      await createWorkspace()
      await refreshHistory()
      setHistoryOpen(false)
    } catch (err) {
      toastError(t('thinking.createFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setCreatingWorkspace(false)
    }
  }

  const handleDeleteWorkspace = async (): Promise<void> => {
    if (!deleteTarget || deletingThinkingId) return
    const targetId = deleteTarget.thinkingId
    setDeletingThinkingId(targetId)
    try {
      await ipc.thinkingDeleteWorkspace(targetId)
      success(t('thinking.deleteWorkspaceDone'))
      setDeleteTarget(null)
      if (targetId === thinkingId) {
        setHistoryOpen(false)
        reset()
      }
      await refreshHistory()
    } catch (err) {
      toastError(t('thinking.deleteWorkspaceFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setDeletingThinkingId(null)
    }
  }

  const handleSend = (content: string, modelConfigId: string): void => {
    const attachments = pendingSources.length > 0 ? pendingSources : undefined
    setPendingSources([])
    void sendMessage(content, attachments, modelConfigId)
  }

  const handleSourcesUploaded = (newSources: ThinkingSource[]): void => {
    useThinkingStore.setState((state) => ({
      sources: [...state.sources, ...newSources]
    }))
    setPendingSources((prev) => [...prev, ...newSources])
  }

  const handleSourceRemoved = (sourceId: string): void => {
    useThinkingStore.setState((state) => ({
      sources: state.sources.filter((source) => source.id !== sourceId)
    }))
    setPendingSources((prev) => prev.filter((source) => source.id !== sourceId))
  }

  const handleConfirmGenerate = async (): Promise<void> => {
    if (!thinkingId) return
    try {
      const result = await ipc.thinkingPrepareGeneration({ thinkingId })
      setPrepared(result)
      setConfirmOpen(true)
    } catch (err) {
      toastError(t('thinking.prepareFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    }
  }

  const handleRevealWorkspace = async (): Promise<void> => {
    if (!thinkingId) return
    try {
      await ipc.thinkingRevealWorkspace(thinkingId)
    } catch (err) {
      toastError(t('thinking.revealWorkspace'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    }
  }

  const handleGenerationConfirm = async (params: {
    topic: string
    pageCount: number
    styleSelection: SessionStyleSelection
    fontSelection: import('@shared/generation').FontSelection
    slideSizeId: SlideSizePresetId
    referenceDocumentPath: string
    sourcePlan?: SourceDocumentPlan
    imagePolicy: import('@shared/generation').ImagePolicy
    generationMode: import('@shared/generation').GenerationMode
    deckBackgroundPolicy: import('@shared/generation').DeckBackgroundPolicy
    modelConfigId?: string
  }): Promise<void> => {
    if (generating || !prepared) return
    setGenerating(true)
    try {
      const sessionId = await createSession({
        topic: params.topic,
        styleSelection: params.styleSelection,
        modelConfigId: params.modelConfigId,
        pageCount: params.pageCount,
        slideSizeId: params.slideSizeId,
        referenceDocumentPath: params.referenceDocumentPath,
        fontSelection: params.fontSelection,
        imagePolicy: params.imagePolicy,
        generationMode: params.generationMode,
        deckBackgroundPolicy: params.deckBackgroundPolicy,
        sourcePlan: params.sourcePlan
      })
      success(t('home.sessionCreated'), {
        description: t('home.generationStarted'),
        duration: 1000
      })
      navigate(`/sessions/${sessionId}/generating`, {
        state: {
          modelConfigId: params.modelConfigId,
          initialPrompt: buildThinkingGenerationPrompt({
            topic: params.topic,
            pageCount: params.pageCount,
            referenceDocumentPath: params.referenceDocumentPath
          })
        }
      })
    } catch (err) {
      toastError(t('home.sessionCreateFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setGenerating(false)
    }
  }

  const restoredContextMessage = useMemo(() => buildContextMessage(contextMd, t), [contextMd, t])

  const displayMessages: ThinkingChatMessage[] = useMemo(() => {
    if (messages.length > 0) {
      const shouldAppendContext =
        restoredContextMessage && !loading && !messages.some((m) => m.role === 'assistant')
      return shouldAppendContext ? [...messages, restoredContextMessage] : messages
    }
    if (restoredContextMessage) return [restoredContextMessage]
    return [buildWelcomeMessage(t)]
  }, [messages, restoredContextMessage, loading, t])
  const showOutlinePanel = Boolean(thinkingId) && stage !== 'collect'
  const [outlineGrid, setOutlineGrid] = useState(false)
  const dateFormatter = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="relative z-50 shrink-0 border-b border-border bg-background/90 px-6 py-4 backdrop-blur">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              {t('thinking.eyebrow')}
            </p>
            <h1 className="organic-serif mt-2 flex min-w-0 items-baseline gap-3 text-[32px] font-semibold leading-none text-foreground">
              <span className="truncate">{t('thinking.title')}</span>
              {thinkingId && (
                <button
                  type="button"
                  className="min-w-0 rounded-full px-2 py-0.5 font-mono text-[11px] font-normal leading-none text-muted-foreground transition-colors hover:bg-[var(--ui-action-soft)] hover:text-foreground"
                  onClick={() => void handleRevealWorkspace()}
                  title={t('thinking.revealWorkspace')}
                >
                  {thinkingId}
                </button>
              )}
            </h1>
            <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
              {t('thinking.description')}
            </p>
          </div>
          <div className="relative flex shrink-0 items-center gap-2">
            <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)]/95 px-4 text-[13px] font-semibold text-foreground shadow-[0_10px_22px_rgb(var(--ui-shadow-color)/0.12)] transition-colors hover:bg-background"
                >
                  {historyLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <History className="h-4 w-4 text-primary" />
                  )}
                  {t('thinking.historyTitle')}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                className="z-[60] flex w-[320px] flex-col overflow-hidden rounded-[1.5rem] border border-border bg-[var(--ui-surface-elevated)]/98 p-0 shadow-[0_22px_54px_rgb(var(--ui-shadow-color)/0.22)] backdrop-blur"
                style={{ height: 'min(420px, calc(100vh - 160px))' }}
              >
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <History className="h-4 w-4 shrink-0 text-primary" />
                    <h2 className="truncate text-[13px] font-semibold text-foreground">
                      {t('thinking.historyTitle')}
                    </h2>
                  </div>
                  {historyLoading && (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {historyItems.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {historyItems.map((item) => {
                        const active = item.thinkingId === thinkingId
                        const deleteDisabled = active && loading
                        return (
                          <div
                            key={item.thinkingId}
                            className={`group flex w-full items-start gap-1.5 rounded-[1.25rem] border p-2 transition-colors ${
                              active
                                ? 'border-[var(--ui-focus)] bg-[var(--ui-action-soft)] text-foreground'
                                : 'border-transparent bg-background/76 text-foreground hover:border-[var(--ui-border-strong)] hover:bg-muted'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setHistoryOpen(false)
                                setPendingSources([])
                                void loadWorkspace(item.thinkingId)
                              }}
                              className="min-w-0 flex-1 rounded-[1rem] p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <div className="flex min-w-0 items-start gap-2.5">
                                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] font-semibold">
                                    {item.topic || t('thinking.untitledWorkspace')}
                                  </div>
                                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <Clock3 className="h-3 w-3 shrink-0" />
                                    <span className="truncate">
                                      {dateFormatter.format(item.updatedAt)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div className="mt-2 inline-flex rounded-full bg-[var(--ui-surface-elevated)]/72 px-2 py-0.5 text-[10px] font-semibold text-primary">
                                {t(stageKeyByStage[item.stage])}
                              </div>
                            </button>
                            <button
                              type="button"
                              disabled={deleteDisabled || deletingThinkingId === item.thinkingId}
                              onClick={(event) => {
                                event.stopPropagation()
                                setDeleteTarget(item)
                              }}
                              className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-destructive opacity-75 transition-colors hover:bg-[var(--ui-danger-soft)] hover:text-[var(--ui-danger-hover)] disabled:cursor-not-allowed disabled:opacity-35"
                              title={t('thinking.deleteWorkspace')}
                            >
                              {deletingThinkingId === item.thinkingId ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="flex h-full min-h-[180px] flex-col items-center justify-center px-4 text-center">
                      <p className="text-[13px] font-semibold text-foreground">
                        {t('thinking.historyEmptyTitle')}
                      </p>
                      <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                        {t('thinking.historyEmptyDescription')}
                      </p>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <button
              type="button"
              onClick={() => void handleCreateWorkspace()}
              disabled={creatingWorkspace}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_22px_rgb(var(--ui-shadow-color)/0.18)] transition-colors hover:bg-[var(--ui-action-hover)] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {creatingWorkspace ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {t('thinking.newWorkspace')}
            </button>
          </div>
        </div>
      </div>

      <div
        className={`relative grid min-h-0 flex-1 gap-4 p-4 ${
          showOutlinePanel
            ? outlineGrid
              ? 'lg:grid-cols-[minmax(0,1fr)_640px]'
              : 'lg:grid-cols-[minmax(0,1fr)_360px]'
            : 'grid-cols-1'
        }`}
      >
        <section className="min-h-0 overflow-hidden rounded-[2rem] border border-border bg-[var(--ui-surface-elevated)] shadow-[0_14px_34px_rgb(var(--ui-shadow-color)/0.12)]">
          {thinkingId ? (
            <ThinkingChat
              thinkingId={thinkingId}
              messages={displayMessages}
              sources={sources}
              pendingSources={pendingSources}
              loading={loading}
              thinkingSteps={thinkingSteps}
              connectionState={connectionState}
              chatFailure={chatFailure}
              animatingText={animatingText}
              onSend={handleSend}
              onSourcesUploaded={handleSourcesUploaded}
              onSourceRemoved={handleSourceRemoved}
              onRetry={retryLastMessage}
              onReconnect={reconnectAndRetry}
              onDismissFailure={dismissChatFailure}
            />
          ) : (
            <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-[10%_90%_16%_84%/78%_22%_78%_22%] bg-[var(--ui-action-soft)] text-foreground">
                {storageReady ? (
                  <History className="h-6 w-6" />
                ) : (
                  <FolderSearch className="h-6 w-6" />
                )}
              </div>
              <h2 className="organic-serif mt-5 text-[28px] font-semibold leading-none text-foreground">
                {storageReady
                  ? t('thinking.emptyWorkspaceTitle')
                  : t('thinking.storageRequiredTitle')}
              </h2>
              <p className="mt-3 max-w-md text-[13px] leading-relaxed text-primary">
                {storageReady
                  ? t('thinking.emptyWorkspaceDescription')
                  : t('thinking.storageRequiredDescription')}
              </p>
              <button
                type="button"
                onClick={() => void handleCreateWorkspace()}
                disabled={creatingWorkspace}
                className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_22px_rgb(var(--ui-shadow-color)/0.18)] transition-colors hover:bg-[var(--ui-action-hover)] disabled:cursor-not-allowed disabled:opacity-65"
              >
                {creatingWorkspace ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {storageReady ? t('thinking.newWorkspace') : t('thinking.chooseStorageAndCreate')}
              </button>
            </div>
          )}
        </section>
        {showOutlinePanel && (
          <aside className="min-h-0 overflow-hidden rounded-[2rem] border border-[var(--ui-border-strong)] bg-[var(--ui-action-soft)] shadow-[0_14px_34px_rgb(var(--ui-shadow-color)/0.12)]">
            <ThinkingPageCards
              thinkingMd={thinkingMd}
              stage={stage}
              onConfirmGenerate={() => void handleConfirmGenerate()}
              loading={loading || generating}
              onOutlineLayoutChange={(layout) => setOutlineGrid(layout === 'grid')}
            />
          </aside>
        )}
      </div>

      <GenerationConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        prepared={prepared}
        onConfirm={(params) => void handleGenerationConfirm(params)}
      />

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deletingThinkingId) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t('thinking.deleteWorkspaceTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('thinking.deleteWorkspaceDescription', {
              title: deleteTarget?.topic || t('thinking.untitledWorkspace')
            })}
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel disabled={Boolean(deletingThinkingId)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(deletingThinkingId)}
              onClick={(event) => {
                event.preventDefault()
                void handleDeleteWorkspace()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-[var(--ui-danger-hover)] disabled:cursor-not-allowed disabled:opacity-65"
            >
              {deletingThinkingId ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('common.delete')}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
