import { useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import { useT } from '@renderer/i18n'
import { useThinkingStore, useToastStore } from '@renderer/store'
import type { ThinkingStage } from '@shared/thinking'
import {
  CheckCircle2,
  FileText,
  LayoutGrid,
  LayoutList,
  Loader2,
  Pencil,
  Save,
  Sparkles,
  X
} from 'lucide-react'
import { Input, Textarea } from '../ui/Input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/Dialog'

interface PageCard {
  pageNumber: number
  title: string
  role: string
  objective: string
  summary: string
  keyPoints: string[]
}

interface PageCardDraft {
  title: string
  objective: string
  summary: string
  keyPoints: string
}

type PageOutlineLayout = 'list' | 'grid'

interface ThinkingPageCardsProps {
  thinkingMd: string
  stage: ThinkingStage
  onConfirmGenerate: () => void
  loading: boolean
  onOutlineLayoutChange?: (layout: PageOutlineLayout) => void
}

function parsePageCards(thinkingMd: string): PageCard[] {
  const matches: Array<{ pageNumber: number; title: string; index: number; length: number }> = []
  const regex = /^##\s*Page\s+(\d+)\s*:\s*(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(thinkingMd)) !== null) {
    matches.push({
      pageNumber: Number.parseInt(match[1], 10),
      title: match[2].trim(),
      index: match.index,
      length: match[0].length
    })
  }
  return matches.map((item, index) => {
    const next = matches[index + 1]
    const contentStart = item.index + item.length
    const contentEnd = next?.index ?? thinkingMd.length
    const rawLines = thinkingMd
      .slice(contentStart, contentEnd)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const roleLine = rawLines.find((line) => /^-\s*Role\s*:/i.test(line))
    const objectiveLine = rawLines.find((line) => /^-\s*Objective\s*:/i.test(line))
    const role = roleLine?.replace(/^-\s*Role\s*:\s*/i, '').trim() || ''
    const objective = objectiveLine?.replace(/^-\s*Objective\s*:\s*/i, '').trim() || ''
    const bodyLines = rawLines.filter((line) => line !== roleLine && line !== objectiveLine)
    const keyPoints = bodyLines
      .filter((line) => /^-\s+/.test(line))
      .map((line) => line.replace(/^-\s+/, '').trim())
      .filter(Boolean)
    const summary = bodyLines
      .filter((line) => !/^-\s+/.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return {
      pageNumber: item.pageNumber,
      title: item.title,
      role,
      objective,
      summary,
      keyPoints
    }
  })
}

const STAGE_COLORS: Record<ThinkingStage, { bg: string; text: string; border: string }> = {
  collect: { bg: 'bg-[var(--ui-surface-inset)]', text: 'text-primary', border: 'border-[var(--ui-border-strong)]' },
  outline: { bg: 'bg-background', text: 'text-primary', border: 'border-border' },
  draft: { bg: 'bg-[var(--ui-surface-inset)]', text: 'text-primary', border: 'border-[var(--ui-border-strong)]' },
  refine: { bg: 'bg-background', text: 'text-primary', border: 'border-border' },
  ready: { bg: 'bg-[var(--ui-focus)]', text: 'text-foreground', border: 'border-[var(--ui-focus)]' }
}

const STAGE_I18N_KEYS: Record<ThinkingStage, string> = {
  collect: 'thinking.stageCollect',
  outline: 'thinking.stageOutline',
  draft: 'thinking.stageDraft',
  refine: 'thinking.stageRefine',
  ready: 'thinking.stageReady'
}

export function ThinkingPageCards({
  thinkingMd,
  stage,
  onConfirmGenerate,
  loading,
  onOutlineLayoutChange
}: ThinkingPageCardsProps): ReactElement {
  const t = useT()
  const updatePageOutline = useThinkingStore((state) => state.updatePageOutline)
  const { success, error: toastError } = useToastStore()
  const [viewMode, setViewMode] = useState<'outline' | 'document'>('outline')
  const [outlineLayout, setOutlineLayout] = useState<PageOutlineLayout>('list')
  const [editingPageNumber, setEditingPageNumber] = useState<number | null>(null)
  const [savingPageNumber, setSavingPageNumber] = useState<number | null>(null)
  const [draft, setDraft] = useState<PageCardDraft | null>(null)
  const cards = parsePageCards(thinkingMd)
  const colors = STAGE_COLORS[stage]
  const canGenerate = cards.length > 0 && stage !== 'collect'
  const hasDocument = thinkingMd.trim().length > 0
  const busy = loading || savingPageNumber !== null
  const editingCard = cards.find((card) => card.pageNumber === editingPageNumber) ?? null

  const changeOutlineLayout = (layout: PageOutlineLayout): void => {
    if (busy || editingPageNumber !== null || layout === outlineLayout) return
    setOutlineLayout(layout)
    onOutlineLayoutChange?.(layout)
  }

  const startEditing = (card: PageCard): void => {
    if (busy) return
    setEditingPageNumber(card.pageNumber)
    setDraft({
      title: card.title,
      objective: card.objective,
      summary: card.summary,
      keyPoints: card.keyPoints.join('\n')
    })
  }

  const cancelEditing = (): void => {
    if (savingPageNumber !== null) return
    setEditingPageNumber(null)
    setDraft(null)
  }

  const savePage = async (card: PageCard): Promise<void> => {
    if (!draft || savingPageNumber !== null) return
    const keyPoints = draft.keyPoints
      .split('\n')
      .map((point) => point.trim().replace(/^[-*]\s+/, ''))
      .filter(Boolean)
    if (
      !draft.title.trim() ||
      !draft.objective.trim() ||
      !draft.summary.trim() ||
      keyPoints.length === 0
    ) {
      toastError(t('thinking.outlineRequired'))
      return
    }

    setSavingPageNumber(card.pageNumber)
    try {
      await updatePageOutline({
        pageNumber: card.pageNumber,
        title: draft.title,
        role: card.role,
        objective: draft.objective,
        summary: draft.summary,
        keyPoints
      })
      setEditingPageNumber(null)
      setDraft(null)
      success(t('thinking.outlineSaved'))
    } catch (error) {
      toastError(t('thinking.outlineSaveFailed'), {
        description: error instanceof Error ? error.message : t('common.retryLater')
      })
    } finally {
      setSavingPageNumber(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--ui-border-strong)] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="organic-serif text-[22px] font-semibold leading-none text-foreground">
              {t('thinking.pageCardsTitle')}
            </h3>
            <p className="mt-1 text-[11px] text-primary">
              {cards.length > 0
                ? t('thinking.pageCountLabel', { count: cards.length })
                : t('thinking.noPagesYet')}
            </p>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-[10px] font-semibold ${colors.bg} ${colors.text} ${colors.border}`}
          >
            {t(STAGE_I18N_KEYS[stage] as Parameters<typeof t>[0])}
          </span>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <div className="grid flex-1 grid-cols-2 gap-1 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-inset)]/70 p-1">
            <button
              type="button"
              onClick={() => setViewMode('outline')}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-full text-[11px] font-semibold transition-colors ${
                viewMode === 'outline'
                  ? 'bg-[var(--ui-surface-elevated)] text-foreground shadow-sm'
                  : 'text-primary hover:bg-[var(--ui-surface-elevated)]/60'
              }`}
            >
              <LayoutList className="h-3.5 w-3.5" />
              {t('thinking.outlineView')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('document')}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-full text-[11px] font-semibold transition-colors ${
                viewMode === 'document'
                  ? 'bg-[var(--ui-surface-elevated)] text-foreground shadow-sm'
                  : 'text-primary hover:bg-[var(--ui-surface-elevated)]/60'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              thinking.md
            </button>
          </div>
          {viewMode === 'outline' && (
            <div className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-inset)]/70 p-1">
              <button
                type="button"
                onClick={() => changeOutlineLayout('list')}
                disabled={busy || editingPageNumber !== null}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  outlineLayout === 'list'
                    ? 'bg-[var(--ui-surface-elevated)] text-foreground shadow-sm'
                    : 'text-primary hover:bg-[var(--ui-surface-elevated)]/60'
                }`}
                title={t('thinking.outlineListView')}
              >
                <LayoutList className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => changeOutlineLayout('grid')}
                disabled={busy || editingPageNumber !== null}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  outlineLayout === 'grid'
                    ? 'bg-[var(--ui-surface-elevated)] text-foreground shadow-sm'
                    : 'text-primary hover:bg-[var(--ui-surface-elevated)]/60'
                }`}
                title={t('thinking.outlineGridView')}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {viewMode === 'document' ? (
          hasDocument ? (
            <div className="rounded-[2rem] border border-border bg-[var(--ui-surface-elevated)] px-4 py-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 border-b border-border pb-2 text-[11px] font-semibold text-primary">
                <FileText className="h-3.5 w-3.5" />
                <span>thinking.md</span>
              </div>
              <div className="thinking-md-preview break-words text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown
                  components={{
                    h1: ({ children }) => (
                      <h1 className="mb-3 text-[18px] font-bold leading-tight text-foreground">
                        {children}
                      </h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="mb-2 mt-4 border-t border-border pt-3 text-[13px] font-bold leading-snug text-foreground">
                        {children}
                      </h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="mb-1.5 mt-3 text-[12px] font-semibold text-foreground">
                        {children}
                      </h3>
                    ),
                    p: ({ children }) => (
                      <p className="mb-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                        {children}
                      </p>
                    ),
                    ul: ({ children }) => (
                      <ul className="mb-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed marker:text-muted-foreground">
                        {children}
                      </ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="mb-2 list-decimal space-y-1 pl-5 text-[12px] leading-relaxed marker:text-muted-foreground">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => <li className="text-muted-foreground">{children}</li>,
                    code: ({ children }) => (
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                        {children}
                      </code>
                    ),
                    pre: ({ children }) => (
                      <pre className="mb-2 overflow-x-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed text-foreground">
                        {children}
                      </pre>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="mb-2 border-l-2 border-[var(--ui-border-strong)] pl-3 text-[12px] leading-relaxed text-muted-foreground">
                        {children}
                      </blockquote>
                    )
                  }}
                >
                  {thinkingMd}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[2rem] border border-dashed border-[var(--ui-border-strong)] bg-background/72 px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-[5%_95%_10%_90%/85%_15%_85%_15%] bg-[var(--ui-focus)] text-primary-foreground">
                <FileText className="h-5 w-5" />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {t('thinking.noDocumentYet')}
              </p>
            </div>
          )
        ) : cards.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center rounded-[2rem] border border-dashed border-[var(--ui-border-strong)] bg-background/72 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-[5%_95%_10%_90%/85%_15%_85%_15%] bg-[var(--ui-focus)] text-primary-foreground">
              <FileText className="h-5 w-5" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {t('thinking.noPagesYet')}
            </p>
          </div>
        ) : outlineLayout === 'grid' ? (
          <div className="grid grid-cols-3 gap-2">
            {cards.map((card) => {
              const isCover = card.role.toUpperCase().includes('COVER')
              return (
                <div key={card.pageNumber} className="group min-w-0">
                  <button
                    type="button"
                    onClick={() => startEditing(card)}
                    disabled={busy || editingPageNumber !== null}
                    className="flex aspect-video w-full min-w-0 flex-col rounded-xl border border-[var(--ui-border-strong)] bg-background p-2 text-left shadow-sm transition-colors hover:border-[var(--ui-focus)] hover:shadow disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ui-focus)] text-[8px] font-bold text-foreground">
                      {card.pageNumber}
                    </span>
                    {isCover ? (
                      <span className="line-clamp-3 flex flex-1 items-center justify-center self-stretch px-1.5 text-center text-[11px] font-semibold leading-tight text-foreground">
                        {card.title}
                      </span>
                    ) : (
                      <>
                        <span className="mt-1 line-clamp-2 break-words text-[11px] font-semibold leading-tight text-foreground">
                          {card.title}
                        </span>
                        {card.keyPoints.length > 0 && (
                          <ul className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-hidden text-[9px] leading-tight text-muted-foreground">
                            {card.keyPoints.slice(0, 2).map((point, pointIndex) => (
                              <li key={pointIndex} className="flex gap-1">
                                <span className="mt-[0.4em] h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--ui-focus)]" />
                                <span className="line-clamp-1 break-words">{point}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </button>
                  <div className="mt-1 flex items-center justify-between gap-1 px-0.5">
                    <span className="truncate rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.04em] text-primary">
                      {card.role}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEditing(card)}
                      disabled={busy || editingPageNumber !== null}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-colors hover:bg-[var(--ui-surface-inset)] hover:text-foreground hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                      title={t('thinking.editOutline')}
                    >
                      <Pencil className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-2.5">
            {cards.map((card) => (
              <div
                key={card.pageNumber}
                className="group rounded-[1.5rem] border border-[var(--ui-border-strong)] bg-background px-3 py-3 shadow-sm transition-colors hover:border-[var(--ui-focus)]"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ui-focus)] text-[11px] font-bold text-foreground">
                    {card.pageNumber}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editingPageNumber === card.pageNumber && draft ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-primary">
                            {card.role}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={cancelEditing}
                              disabled={savingPageNumber !== null}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--ui-surface-inset)] hover:text-foreground disabled:opacity-40"
                              title={t('common.cancel')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void savePage(card)}
                              disabled={savingPageNumber !== null}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-[var(--ui-action-hover)] disabled:opacity-50"
                              title={t('thinking.saveOutline')}
                            >
                              {savingPageNumber === card.pageNumber ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Save className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-semibold text-primary">
                            {t('thinking.outlineTitle')}
                          </span>
                          <Input
                            value={draft.title}
                            onChange={(event) =>
                              setDraft((current) =>
                                current ? { ...current, title: event.target.value } : current
                              )
                            }
                            className="h-8 rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 text-[12px]"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-semibold text-primary">
                            {t('thinking.outlineObjective')}
                          </span>
                          <Textarea
                            value={draft.objective}
                            onChange={(event) =>
                              setDraft((current) =>
                                current ? { ...current, objective: event.target.value } : current
                              )
                            }
                            rows={2}
                            className="min-h-14 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-semibold text-primary">
                            {t('thinking.outlineSummary')}
                          </span>
                          <Textarea
                            value={draft.summary}
                            onChange={(event) =>
                              setDraft((current) =>
                                current ? { ...current, summary: event.target.value } : current
                              )
                            }
                            rows={3}
                            className="min-h-20 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[10px] font-semibold text-primary">
                            {t('thinking.outlineKeyPoints')}
                          </span>
                          <Textarea
                            value={draft.keyPoints}
                            onChange={(event) =>
                              setDraft((current) =>
                                current ? { ...current, keyPoints: event.target.value } : current
                              )
                            }
                            rows={4}
                            placeholder={t('thinking.outlineKeyPointsHint')}
                            className="min-h-24 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                          />
                        </label>
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="line-clamp-2 min-w-0 text-[13px] font-semibold leading-snug text-foreground">
                            {card.title}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="rounded-full border border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-primary">
                              {card.role}
                            </span>
                            <button
                              type="button"
                              onClick={() => startEditing(card)}
                              disabled={busy || editingPageNumber !== null}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-colors hover:bg-[var(--ui-surface-inset)] hover:text-foreground hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                              title={t('thinking.editOutline')}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                        <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-primary">
                          {card.objective}
                        </p>
                        {card.summary ? (
                          <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                            {card.summary}
                          </p>
                        ) : null}
                        {card.keyPoints.length > 0 && (
                          <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                            {card.keyPoints.slice(0, 3).map((point, pointIndex) => (
                              <li key={pointIndex} className="flex gap-1.5">
                                <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-[var(--ui-focus)]" />
                                <span className="line-clamp-2">{point}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--ui-border-strong)] bg-[var(--ui-action-soft)] p-3">
        <button
          type="button"
          onClick={onConfirmGenerate}
          disabled={busy || editingPageNumber !== null || !canGenerate}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-[var(--ui-action-hover)] disabled:opacity-40 disabled:hover:bg-primary"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : canGenerate ? (
            <Sparkles className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          {busy ? t('thinking.thinking') : t('thinking.confirmAndGenerate')}
        </button>
        {!canGenerate && (
          <p className="mt-2 text-center text-[10px] text-muted-foreground">
            {t('thinking.needMoreWork')}
          </p>
        )}
      </div>

      <Dialog
        open={outlineLayout === 'grid' && editingPageNumber !== null}
        onOpenChange={(open) => {
          if (!open) cancelEditing()
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('thinking.editPageOutlineTitle', { page: editingPageNumber ?? '' })}
            </DialogTitle>
            <DialogDescription className="sr-only">{t('thinking.editOutline')}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-primary">
                  {t('thinking.outlineTitle')}
                </span>
                <Input
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, title: event.target.value } : current
                    )
                  }
                  className="h-8 rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 text-[12px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-primary">
                  {t('thinking.outlineObjective')}
                </span>
                <Textarea
                  value={draft.objective}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, objective: event.target.value } : current
                    )
                  }
                  rows={2}
                  className="min-h-14 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-primary">
                  {t('thinking.outlineSummary')}
                </span>
                <Textarea
                  value={draft.summary}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, summary: event.target.value } : current
                    )
                  }
                  rows={3}
                  className="min-h-20 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-primary">
                  {t('thinking.outlineKeyPoints')}
                </span>
                <Textarea
                  value={draft.keyPoints}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, keyPoints: event.target.value } : current
                    )
                  }
                  rows={4}
                  placeholder={t('thinking.outlineKeyPointsHint')}
                  className="min-h-24 resize-y rounded-lg border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)] px-2.5 py-2 text-[12px]"
                />
              </label>
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              onClick={cancelEditing}
              disabled={savingPageNumber !== null}
              className="h-9 rounded-full border border-[var(--ui-border-strong)] px-4 text-[12px] font-semibold text-primary transition-colors hover:bg-[var(--ui-surface-elevated)] disabled:opacity-40"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => editingCard && void savePage(editingCard)}
              disabled={savingPageNumber !== null}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[12px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-[var(--ui-action-hover)] disabled:opacity-50"
            >
              {savingPageNumber === editingPageNumber ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t('thinking.saveOutline')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
