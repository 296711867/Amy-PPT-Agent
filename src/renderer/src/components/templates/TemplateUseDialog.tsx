import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronDown,
  CircleAlert,
  Eye,
  FileText,
  LayoutTemplate,
  Loader2,
  Pencil,
  Settings2,
  Sparkles,
  X
} from 'lucide-react'
import { Button } from '../ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/Dialog'
import { Input, Textarea } from '../ui/Input'
import { ScrollArea } from '../ui/ScrollArea'
import { ModelSplitButton } from '../model/ModelActionButton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/Tooltip'
import { useModelAction } from '@renderer/hooks/useModelAction'
import { useT } from '@renderer/i18n'
import { ipc, type TemplateListItem } from '@renderer/lib/ipc'
import { useTemplateStore, useToastStore } from '@renderer/store'
import {
  normalizeAnimationPreferences,
  type AnimationPreferenceId,
  type ImagePolicy,
  type ParsedDocumentPlanResult
} from '@shared/generation'
import ReactMarkdown from 'react-markdown'
import { AnimationPreferenceChips } from '../session-create/AnimationPreferenceChips'
import {
  buildSuggestionDraft,
  formatSourceOutlineBriefText,
  SessionCreateSuggestionDialog,
  type DocumentPlanSuggestion,
  type DocumentPlanSuggestionDraft
} from '../session-create/SessionCreateSuggestionDialog'

const MIN_PAGE_COUNT = 1
const MAX_PAGE_COUNT = 500
const MAX_DOCUMENT_SIZE_MB = 10
const MAX_DOCUMENT_SIZE_BYTES = MAX_DOCUMENT_SIZE_MB * 1024 * 1024

type AttachedReferenceFile = ParsedDocumentPlanResult['files'][number]

const resolvePageCount = (raw: string, fallback: number): number => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, parsed))
}

const buildTemplateInitialPrompt = (args: {
  templateName: string
  title: string
  pageCount: number
  brief: string
}): string =>
  [
    `Create a ${args.pageCount}-slide presentation titled "${args.title}".`,
    `Use the selected template "${args.templateName}" as the fixed visual template reference.`,
    'Regenerate every slide from the new brief/source document. Preserve the template direction for layout roles, visual rhythm, colors, typography, and component treatment, but do not reuse old slide text unless the user asks for it.',
    'Page-count mapping: preserve the template cover/opening role for slide 1 and the closing/ending role for the final slide when possible. If the final deck has more pages than the template, add the extra pages in the middle by reusing or varying relevant middle-page roles. If it has fewer pages, merge or skip less relevant middle-page roles. Do not force one-to-one page matching.',
    'Determine the presentation content language from the brief and source documents; do not infer it from the application UI language or this instruction language.',
    '',
    'Brief:',
    args.brief
  ].join('\n')

export function TemplateUseDialog({
  template,
  onOpenChange
}: {
  template: TemplateListItem | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const t = useT()
  const { createSessionFromTemplate } = useTemplateStore()
  const { success, error, warning } = useToastStore()
  const modelAction = useModelAction()
  const { selectedModelConfigId, ensureModelActive } = modelAction
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [briefMode, setBriefMode] = useState<'edit' | 'preview'>('edit')
  const [pageCount, setPageCount] = useState('5')
  const [attachedReferenceFile, setAttachedReferenceFile] = useState<AttachedReferenceFile | null>(
    null
  )
  const [referenceDocumentPath, setReferenceDocumentPath] = useState<string | null>(null)
  const [parsingDocument, setParsingDocument] = useState(false)
  const [documentParseError, setDocumentParseError] = useState<string | null>(null)
  const [hasParsedSource, setHasParsedSource] = useState(false)
  const [suggestionDraft, setSuggestionDraft] = useState<DocumentPlanSuggestionDraft | null>(null)
  const [acceptedSourcePlan, setAcceptedSourcePlan] =
    useState<DocumentPlanSuggestion['sourcePlan']>(undefined)
  const [suggestionDialogOpen, setSuggestionDialogOpen] = useState(false)
  const [applyTitleSuggestion, setApplyTitleSuggestion] = useState(false)
  const [applyPageCountSuggestion, setApplyPageCountSuggestion] = useState(false)
  const [applyBriefSuggestion, setApplyBriefSuggestion] = useState(false)
  const [creating, setCreating] = useState(false)
  // 模板链路默认不额外配图：模板页基底就是视觉事实来源。
  const [imagePolicy, setImagePolicy] = useState<ImagePolicy>('none')
  const [selectedAnimationPreferenceIds, setSelectedAnimationPreferenceIds] = useState<
    AnimationPreferenceId[]
  >([])
  const [optionsOpen, setOptionsOpen] = useState(false)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const open = Boolean(template)

  useEffect(() => {
    if (!template) return
    setTitle(template.name)
    setBrief('')
    setBriefMode('edit')
    setPageCount(String(resolvePageCount(String(template.pageCount || 5), 5)))
    setAttachedReferenceFile(null)
    setReferenceDocumentPath(null)
    setDocumentParseError(null)
    setHasParsedSource(false)
    setSuggestionDraft(null)
    setAcceptedSourcePlan(undefined)
    setSuggestionDialogOpen(false)
    setImagePolicy('none')
    setSelectedAnimationPreferenceIds([])
    setOptionsOpen(false)
  }, [template])

  const close = (): void => {
    if (creating || parsingDocument) return
    onOpenChange(false)
  }

  const ensureUploadPrerequisites = async (): Promise<boolean> => {
    const validation = await ipc.validateUploadPrerequisites()
    if (validation.ready) return true
    warning(t('templates.settingsRequiredTitle'), {
      description: validation.message || t('templates.settingsRequiredDescription'),
      action: {
        label: t('templates.goToSettings'),
        onClick: () => navigate('/settings')
      }
    })
    return false
  }

  const handleChooseDocumentClick = async (): Promise<void> => {
    if (parsingDocument) return
    if (!(await ensureUploadPrerequisites())) return
    documentInputRef.current?.click()
  }

  const handleDocumentFilesSelected = async (files: FileList | null): Promise<void> => {
    const selectedFiles = Array.from(files || [])
    if (documentInputRef.current) {
      documentInputRef.current.value = ''
    }
    if (!template || selectedFiles.length === 0) return
    if (selectedFiles.length > 1) {
      const message = t('templates.documentSingleOnly')
      setDocumentParseError(message)
      error(t('templates.documentCountExceeded'), { description: message })
      return
    }

    const selectedFile = selectedFiles[0]
    if (selectedFile.size > MAX_DOCUMENT_SIZE_BYTES) {
      const message = t('templates.documentTooLarge', { maxSize: MAX_DOCUMENT_SIZE_MB })
      setDocumentParseError(message)
      error(t('templates.documentTooLargeTitle'), { description: message })
      return
    }

    const payloadFiles = selectedFiles
      .map((file) => ({
        path: window.electron?.getPathForFile?.(file) || '',
        name: file.name
      }))
      .filter((file) => file.path)
    if (payloadFiles.length === 0) {
      setDocumentParseError(t('templates.documentPathFailed'))
      error(t('templates.documentPathFailedTitle'))
      return
    }

    setParsingDocument(true)
    setDocumentParseError(null)
    setHasParsedSource(false)
    try {
      const result = await ipc.prepareReferenceDocument({ files: payloadFiles })
      const referenceFile = result.files[0]
      setAttachedReferenceFile(referenceFile || null)
      setReferenceDocumentPath(
        referenceFile && referenceFile.type !== 'image' ? referenceFile.path : null
      )
      setSuggestionDraft(null)
      setAcceptedSourcePlan(undefined)
      setSuggestionDialogOpen(false)
      success(t('templates.referenceAttached'), {
        description: referenceFile?.name || selectedFile.name
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.retryLater')
      setDocumentParseError(message)
      error(t('templates.referenceAttachFailed'), { description: message })
    } finally {
      setParsingDocument(false)
    }
  }

  const handleRemoveReferenceFile = (): void => {
    setAttachedReferenceFile(null)
    setReferenceDocumentPath(null)
    setDocumentParseError(null)
    setHasParsedSource(false)
    setSuggestionDraft(null)
    setAcceptedSourcePlan(undefined)
    setSuggestionDialogOpen(false)
  }

  const handleAnalyzeDocument = async (modelConfigId = selectedModelConfigId): Promise<void> => {
    if (!template || !attachedReferenceFile || parsingDocument) return
    const resolvedModelConfigId = await ensureModelActive(modelConfigId)
    if (!resolvedModelConfigId) return

    setParsingDocument(true)
    setDocumentParseError(null)
    try {
      const result = await ipc.parseDocumentPlan({
        files: [{ path: attachedReferenceFile.path, name: attachedReferenceFile.name }],
        topic: title.trim() || template.name,
        existingBrief: brief.trim(),
        modelConfigId: resolvedModelConfigId
      })
      const referenceFile = result.files[0] || attachedReferenceFile
      setAttachedReferenceFile(referenceFile)
      setReferenceDocumentPath(referenceFile.type !== 'image' ? referenceFile.path : null)
      const nextSuggestion = {
        topic: result.topic || title || template.name,
        pageCount: resolvePageCount(String(result.pageCount), 5),
        briefText: result.briefText,
        sourcePlan: result.sourcePlan
      }
      setSuggestionDraft(buildSuggestionDraft(nextSuggestion))
      setAcceptedSourcePlan(undefined)
      setApplyTitleSuggestion(!title.trim() || title.trim() === template.name)
      setApplyPageCountSuggestion(!result.sourcePlan?.pageSkeleton.length)
      setApplyBriefSuggestion(Boolean(result.sourcePlan?.pageSkeleton.length) || !brief.trim())
      setSuggestionDialogOpen(true)
      setHasParsedSource(true)
      success(t('templates.documentParsed'), {
        description: t('templates.documentParsedDescription', { count: result.files.length })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.retryLater')
      setDocumentParseError(message)
      error(t('templates.documentParseFailed'), { description: message })
    } finally {
      setParsingDocument(false)
    }
  }

  const applyDocumentSuggestion = (): void => {
    const draft = suggestionDraft
    if (!draft) return
    const sourceOutlinePageCount = draft.sourcePlan?.pageSkeleton.length || 0
    const hasSourceOutline = sourceOutlinePageCount > 0
    const shouldApplySourceOutline = hasSourceOutline && applyBriefSuggestion

    if (applyTitleSuggestion) setTitle(draft.topic)
    if (shouldApplySourceOutline) {
      setPageCount(String(resolvePageCount(String(sourceOutlinePageCount), 5)))
    } else if (applyPageCountSuggestion) {
      setPageCount(String(resolvePageCount(draft.pageCount, 5)))
    }
    if (applyBriefSuggestion) {
      setBrief(
        draft.sourcePlan?.pageSkeleton.length
          ? formatSourceOutlineBriefText(draft.sourcePlan.pageSkeleton)
          : draft.briefText
      )
    }
    setAcceptedSourcePlan(shouldApplySourceOutline ? draft.sourcePlan : undefined)
    setSuggestionDialogOpen(false)
  }

  const handleCreate = async (modelConfigId = selectedModelConfigId): Promise<void> => {
    if (!template || creating) return
    const resolvedModelConfigId = await ensureModelActive(modelConfigId)
    if (!resolvedModelConfigId) return
    const deckTitle = title.trim() || template.name
    const briefText = brief.trim()
    if (!briefText) {
      warning(t('templates.briefRequired'))
      return
    }
    const safePageCount = resolvePageCount(pageCount, template.pageCount || 5)
    setCreating(true)
    try {
      const initialPrompt = buildTemplateInitialPrompt({
        templateName: template.name,
        title: deckTitle,
        pageCount: safePageCount,
        brief: briefText
      })
      const sessionId = await createSessionFromTemplate({
        templateId: template.id,
        title: deckTitle,
        modelConfigId: resolvedModelConfigId,
        pageCount: safePageCount,
        referenceDocumentPath: referenceDocumentPath || undefined,
        sourcePlan: acceptedSourcePlan,
        // 大纲随会话创建持久化，重启/取消后生成页可从会话元数据恢复。
        initialPrompt,
        imagePolicy
      })
      success(t('templates.sessionCreated'), {
        description: t('templates.sessionCreatedDescription')
      })
      onOpenChange(false)
      navigate(`/sessions/${sessionId}/template-generating`, {
        state: {
          initialPrompt,
          modelConfigId: resolvedModelConfigId,
          animationPreferences: normalizeAnimationPreferences(selectedAnimationPreferenceIds)
        }
      })
    } catch (err) {
      error(t('templates.createFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LayoutTemplate className="h-4 w-4" />
              {t('templates.useDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t('templates.useDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('templates.sessionTitleLabel')}
                </label>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
              <div className="w-full sm:w-28">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('templates.pageCountLabel')}
                </label>
                <Input
                  value={pageCount}
                  inputMode="numeric"
                  onChange={(event) => {
                    setAcceptedSourcePlan(undefined)
                    setPageCount(event.target.value)
                  }}
                />
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-muted-foreground">
                  {t('templates.briefLabel')}
                </label>
                <div className="flex items-center gap-2">
                  {hasParsedSource && !parsingDocument ? (
                    <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-foreground">
                      {t('templates.parsed')}
                    </span>
                  ) : null}
                  <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
                    <button
                      type="button"
                      onClick={() => setBriefMode('edit')}
                      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        briefMode === 'edit'
                          ? 'bg-foreground text-background'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBriefMode('preview')}
                      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        briefMode === 'preview'
                          ? 'bg-foreground text-background'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {t('common.preview')}
                    </button>
                  </div>
                </div>
              </div>
              {briefMode === 'edit' ? (
                <Textarea
                  value={brief}
                  onChange={(event) => {
                    setAcceptedSourcePlan(undefined)
                    setBrief(event.target.value)
                  }}
                  className="min-h-[150px] resize-y px-3 py-2 text-xs leading-5"
                  placeholder={t('templates.briefPlaceholder')}
                />
              ) : (
                <ScrollArea
                  className="h-[180px] rounded-lg border border-border/70 bg-background/70"
                  viewportClassName="p-4"
                >
                  <ReactMarkdown
                    components={{
                      h1: ({ children }) => (
                        <h1 className="mb-2 text-lg font-semibold text-foreground">{children}</h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="mb-2 mt-3 text-base font-semibold text-foreground">
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="mb-1.5 mt-2.5 text-sm font-semibold text-foreground">
                          {children}
                        </h3>
                      ),
                      p: ({ children }) => (
                        <p className="mb-2 text-xs leading-5 text-muted-foreground">{children}</p>
                      ),
                      ul: ({ children }) => (
                        <ul className="mb-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="mb-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => <li>{children}</li>,
                      code: ({ children }) => (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                          {children}
                        </code>
                      ),
                      blockquote: ({ children }) => (
                        <blockquote className="mb-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                          {children}
                        </blockquote>
                      )
                    }}
                  >
                    {brief || t('templates.briefPlaceholder')}
                  </ReactMarkdown>
                </ScrollArea>
              )}
            </div>
            {attachedReferenceFile ? (
              <div className="flex min-w-0">
                <span
                  className="inline-flex h-6 max-w-[260px] items-center gap-1 rounded-md border border-border bg-accent px-2 text-[10px] text-foreground"
                  title={attachedReferenceFile.path}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 truncate">{attachedReferenceFile.name}</span>
                  <button
                    type="button"
                    onClick={handleRemoveReferenceFile}
                    className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary"
                    aria-label={t('templates.removeReference')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              </div>
            ) : null}
            <input
              ref={documentInputRef}
              type="file"
              accept=".md,.txt,.text,.csv,.docx"
              multiple={false}
              className="hidden"
              onChange={(event) => void handleDocumentFilesSelected(event.target.files)}
            />
            <TooltipProvider delayDuration={180}>
              <div className="flex flex-wrap items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleChooseDocumentClick()}
                        disabled={parsingDocument || creating}
                        className="h-8 shrink-0 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-foreground shadow-none hover:bg-accent"
                      >
                        {parsingDocument ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileText className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {parsingDocument
                          ? t('templates.processingDocument')
                          : t('templates.uploadDocument')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start">
                    {t('templates.uploadDocumentTooltip', { maxSize: MAX_DOCUMENT_SIZE_MB })}
                  </TooltipContent>
                </Tooltip>
                {attachedReferenceFile ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <ModelSplitButton
                          modelAction={modelAction}
                          label={t('templates.analyzeDocument')}
                          loadingLabel={t('templates.analyzingDocument')}
                          loading={parsingDocument}
                          disabled={creating || !attachedReferenceFile}
                          icon={Sparkles}
                          tone="primary"
                          dropdownAlign="start"
                          className="h-8 rounded-lg border-0 bg-[linear-gradient(135deg,var(--ui-action),var(--ui-action-hover))] shadow-[0_8px_18px_rgb(var(--ui-shadow-color)/0.18)]"
                          mainClassName="h-full bg-transparent px-2.5 text-xs text-primary-foreground shadow-none hover:bg-card/10 hover:text-primary-foreground hover:shadow-none"
                          triggerClassName="h-full w-8 px-0"
                          onRun={handleAnalyzeDocument}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-xs">
                      {t('templates.analyzeDocumentTooltip')}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {t('templates.supportedDocuments', { maxSize: MAX_DOCUMENT_SIZE_MB })}
                </span>
              </div>
            </TooltipProvider>
            {documentParseError ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/35 bg-[var(--ui-danger-soft)] px-3 py-2 text-xs text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{documentParseError}</span>
              </div>
            ) : null}
            <div className="rounded-lg border border-border/70">
              <button
                type="button"
                onClick={() => setOptionsOpen((prev) => !prev)}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="flex items-center gap-1.5">
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('templates.generationOptions')}
                </span>
                <span className="flex items-center gap-2">
                  {imagePolicy !== 'none' || selectedAnimationPreferenceIds.length > 0 ? (
                    <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] text-foreground">
                      {t('templates.generationOptionsCustomized')}
                    </span>
                  ) : null}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${optionsOpen ? 'rotate-180' : ''}`}
                  />
                </span>
              </button>
              {optionsOpen ? (
                <div className="space-y-3 border-t border-border/70 px-3 py-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('templates.imagePolicyLabel')}
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {(
                        [
                          ['none', 'templates.imagePolicyNone'],
                          ['placeholder', 'templates.imagePolicyPlaceholder'],
                          ['ai', 'templates.imagePolicyAi']
                        ] as Array<[ImagePolicy, Parameters<typeof t>[0]]>
                      ).map(([value, labelKey]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setImagePolicy(value)}
                          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                            imagePolicy === value
                              ? 'bg-foreground text-background'
                              : 'border border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {t(labelKey)}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                      {t('templates.imagePolicyHint')}
                    </p>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('home.animationPreferences')}
                    </label>
                    <AnimationPreferenceChips
                      selectedIds={selectedAnimationPreferenceIds}
                      onChange={setSelectedAnimationPreferenceIds}
                      compact
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={close}
              disabled={creating || parsingDocument}
            >
              {t('common.cancel')}
            </Button>
            <ModelSplitButton
              modelAction={modelAction}
              label={t('templates.createAndGenerate')}
              loadingLabel={t('templates.creating')}
              loading={creating}
              disabled={parsingDocument}
              icon={Sparkles}
              tone="primary"
              onRun={handleCreate}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SessionCreateSuggestionDialog
        open={suggestionDialogOpen}
        onOpenChange={setSuggestionDialogOpen}
        attachedReferenceFile={attachedReferenceFile}
        suggestionDraft={suggestionDraft}
        setSuggestionDraft={setSuggestionDraft}
        applyTopicSuggestion={applyTitleSuggestion}
        setApplyTopicSuggestion={setApplyTitleSuggestion}
        applyPageCountSuggestion={applyPageCountSuggestion}
        setApplyPageCountSuggestion={setApplyPageCountSuggestion}
        applyBriefSuggestion={applyBriefSuggestion}
        setApplyBriefSuggestion={setApplyBriefSuggestion}
        onApplySelected={applyDocumentSuggestion}
      />
    </>
  )
}
