import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, Image as ImageIcon, Table as TableIcon } from 'lucide-react'
import type { VisualElementLevel } from '@shared/generation'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Textarea } from '../components/ui/Input'
import { Card, CardContent } from '../components/ui/Card'
import { ScrollArea } from '../components/ui/ScrollArea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../components/ui/Select'
import { StyleSelect } from '../components/style/StyleSelect'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/Tooltip'
import { CircleAlert, Eye, FileText, Loader2, Pencil, Sparkles, X } from 'lucide-react'
import { useSessionStore } from '../store'
import { useSettingsStore } from '../store'
import { useToastStore } from '../store'
import { ModelSplitButton } from '../components/model/ModelActionButton'
import { useModelAction } from '../hooks/useModelAction'
import { ipc } from '@renderer/lib/ipc'
import { resolveStyleIdOrStableDefault } from '@renderer/lib/style-selection'
import { FontSchemeSelector } from '../components/font/FontSchemeSelector'
import {
  normalizeAnimationPreferences,
  type AnimationPreferenceId,
  type FontSelection,
  type ParsedDocumentPlanResult
} from '@shared/generation'
import {
  buildSessionStyleSelection,
  DEFAULT_AI_THEME_COLORS,
  normalizeAiStyleDescription
} from '@renderer/lib/ai-style-selection'
import { useT } from '../i18n'
import ReactMarkdown from 'react-markdown'
import { isSupportedImageMimeType } from '@shared/image-mime'
import {
  buildSuggestionDraft,
  formatSourceOutlineBriefText,
  SessionCreateSuggestionDialog,
  type DocumentPlanSuggestion,
  type DocumentPlanSuggestionDraft
} from '../components/session-create/SessionCreateSuggestionDialog'
import { AnimationPreferenceChips } from '../components/session-create/AnimationPreferenceChips'
import { Checkbox } from '../components/ui/Checkbox'
import {
  DEFAULT_SLIDE_SIZE_ID,
  SLIDE_SIZE_PRESETS,
  type SlideSizePresetId
} from '@shared/slide-size'
const MIN_PAGE_COUNT = 1
const MAX_PAGE_COUNT = 500
const DEFAULT_PAGE_COUNT = 5
const MAX_DOCUMENT_SIZE_MB = 10
const MAX_DOCUMENT_SIZE_BYTES = MAX_DOCUMENT_SIZE_MB * 1024 * 1024
const MAX_IMAGE_SIZE_MB = 5
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
const isImageFileName = (name: string): boolean => /\.(png|jpe?g|webp)$/i.test(name.trim())

const isSupportedImageFile = (file: File): boolean =>
  isSupportedImageMimeType(file.type) || isImageFileName(file.name || '')

type AttachedReferenceFile = ParsedDocumentPlanResult['files'][number]

const compactInputClass =
  'h-10 border-[var(--ui-border-strong)]/70 bg-white/75 px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(var(--ui-shadow-color)/0.04)] placeholder:text-muted-foreground'
const settingsInputClass =
  'h-8 border-[var(--ui-border-strong)]/70 bg-white/75 px-2.5 py-1.5 text-xs shadow-[inset_0_1px_2px_rgb(var(--ui-shadow-color)/0.04)] placeholder:text-muted-foreground'
const settingsSelectTriggerClass =
  'h-8 border-[var(--ui-border-strong)]/70 bg-white/75 px-2.5 py-1.5 text-xs shadow-[inset_0_1px_2px_rgb(var(--ui-shadow-color)/0.04)]'
const compactSelectContentClass = 'text-xs'
const compactSelectItemClass = 'px-2.5 py-1.5 text-xs'
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms))

const buildNeutralInitialPrompt = (args: {
  topic: string
  pageCount: number
  styleLabel: string
}): string =>
  [
    `Create a ${args.pageCount}-slide presentation about "${args.topic}".`,
    `Style preset: ${args.styleLabel}.`,
    'Determine the presentation content language from the topic, detailed brief, and source documents; do not infer it from the application UI language or this instruction language.'
  ].join('\n')

const resolvePageCount = (raw: string): number => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_COUNT
  return Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, parsed))
}

export function SessionCreatePage(): ReactElement {
  const navigate = useNavigate()
  const { createSession, loading } = useSessionStore()
  const { settings } = useSettingsStore()
  const { success, error, warning } = useToastStore()
  const modelAction = useModelAction()
  const { modelConfigs, selectedModelConfigId, ensureModelActive } = modelAction
  const t = useT()
  const [submitting, setSubmitting] = useState(false)
  const [topic, setTopic] = useState('')
  const [brief, setBrief] = useState('')
  const [briefMode, setBriefMode] = useState<'edit' | 'preview'>('edit')
  const [selectedAnimationPreferenceIds, setSelectedAnimationPreferenceIds] = useState<
    AnimationPreferenceId[]
  >([])
  const [pageCount, setPageCount] = useState(String(DEFAULT_PAGE_COUNT))
  const [slideSizeId, setSlideSizeId] = useState<SlideSizePresetId>(DEFAULT_SLIDE_SIZE_ID)
  const [generateImagesWithAi, setGenerateImagesWithAi] = useState(false)
  const [useLockedLayouts, setUseLockedLayouts] = useState(false)
  const [visualElementPrefs, setVisualElementPrefs] = useState({
    charts: 'none' as VisualElementLevel,
    images: 'none' as VisualElementLevel,
    tables: 'none' as VisualElementLevel
  })
  const [generateDeckBackgrounds, setGenerateDeckBackgrounds] = useState(false)
  const [generateCoverBackground, setGenerateCoverBackground] = useState(true)
  const [generateContentBackgrounds, setGenerateContentBackgrounds] = useState(true)
  const [generateEndingBackground, setGenerateEndingBackground] = useState(true)
  const [contentBackgroundCount, setContentBackgroundCount] = useState<'1' | '2' | '3'>('1')
  const [styleMode, setStyleMode] = useState<'preset' | 'ai'>('preset')
  const [selectedStyleId, setSelectedStyleId] = useState('')
  const [aiStyleDescription, setAiStyleDescription] = useState('')
  const [aiThemeColors, setAiThemeColors] = useState<string[]>([...DEFAULT_AI_THEME_COLORS])
  const [fontSelection, setFontSelection] = useState<FontSelection>({ mode: 'auto' })
  const [styleOptions, setStyleOptions] = useState<
    Array<{
      id: string
      label: string
      description: string
      styleCase?: string
      thumbnailPath?: string | null
      previewPath?: string | null
      favoriteAt?: number | null
    }>
  >([])
  const [attachedReferenceFile, setAttachedReferenceFile] = useState<AttachedReferenceFile | null>(
    null
  )
  const [parsingDocument, setParsingDocument] = useState(false)
  const [documentParseError, setDocumentParseError] = useState<string | null>(null)
  const [referenceDocumentPath, setReferenceDocumentPath] = useState<string | null>(null)
  const [suggestionDraft, setSuggestionDraft] = useState<DocumentPlanSuggestionDraft | null>(null)
  const [acceptedSourcePlan, setAcceptedSourcePlan] =
    useState<DocumentPlanSuggestion['sourcePlan']>(undefined)
  const [suggestionDialogOpen, setSuggestionDialogOpen] = useState(false)
  const [applyTopicSuggestion, setApplyTopicSuggestion] = useState(false)
  const [applyPageCountSuggestion, setApplyPageCountSuggestion] = useState(false)
  const [applyBriefSuggestion, setApplyBriefSuggestion] = useState(false)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const pendingImageReference = attachedReferenceFile?.type === 'image'

  const validateForm = (modelConfigId = selectedModelConfigId): string => {
    const topicText = topic.trim()
    if (!topicText) return t('home.validationTopic')

    if (styleMode === 'preset') {
      if (!styleOptions.length) return t('home.validationStylesLoading')
      if (!selectedStyleId) return t('home.validationStyle')
      const selectedStyle = styleOptions.find((option) => option.id === selectedStyleId)
      if (!selectedStyle) return t('home.validationStyleMissing')
    } else if (!normalizeAiStyleDescription(aiStyleDescription)) {
      return t('home.validationAiStyleDescription')
    } else if (
      !buildSessionStyleSelection({
        mode: 'ai',
        styleId: '',
        description: aiStyleDescription,
        themeColors: aiThemeColors
      })
    ) {
      return t('home.validationAiThemeColors')
    }

    const pageCountText = pageCount.trim()
    if (!pageCountText)
      return t('home.validationPageCount', { min: MIN_PAGE_COUNT, max: MAX_PAGE_COUNT })
    if (!/^\d+$/.test(pageCountText)) return t('home.validationPageCountNumber')
    const rawPageCount = Number.parseInt(pageCountText, 10)
    if (rawPageCount < MIN_PAGE_COUNT || rawPageCount > MAX_PAGE_COUNT) {
      return t('home.validationPageCountRange', { min: MIN_PAGE_COUNT, max: MAX_PAGE_COUNT })
    }

    const briefText = brief.trim()
    if (!briefText) return t('home.validationBrief')

    const selectedModelConfig = modelConfigs.find((config) => config.id === modelConfigId)
    const resolvedModel = (selectedModelConfig?.model || '').trim()
    const resolvedStoragePath = (settings?.storagePath || '').trim()
    const hasApiKey = selectedModelConfig?.hasApiKey ?? Boolean(selectedModelConfig?.apiKey?.trim())
    if (!hasApiKey || !resolvedModel || !resolvedStoragePath) {
      return t('home.settingsRequired')
    }

    return ''
  }

  const requiredReady = (() => {
    const topicText = topic.trim()
    const pageCountText = pageCount.trim()
    const briefText = brief.trim()
    const hasStyle =
      styleMode === 'preset'
        ? Boolean(selectedStyleId)
        : Boolean(
            buildSessionStyleSelection({
              mode: 'ai',
              styleId: '',
              description: aiStyleDescription,
              themeColors: aiThemeColors
            })
          )
    if (!topicText || !hasStyle || !selectedModelConfigId || !briefText) return false
    if (!/^\d+$/.test(pageCountText)) return false
    const n = Number.parseInt(pageCountText, 10)
    return n >= MIN_PAGE_COUNT && n <= MAX_PAGE_COUNT
  })()

  const loadStyleOptions = useCallback(
    async (preferredStyleId?: string): Promise<void> => {
      try {
        const { items } = await ipc.listStyles()
        const sorted = [...items].sort(
          (a, b) =>
            (b.favoriteAt || 0) - (a.favoriteAt || 0) ||
            (b.updatedAt || 0) - (a.updatedAt || 0) ||
            (b.createdAt || 0) - (a.createdAt || 0) ||
            a.id.localeCompare(b.id)
        )
        const options = sorted.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          styleCase: item.styleCase,
          thumbnailPath: item.thumbnailPath,
          previewPath: item.previewPath,
          favoriteAt: item.favoriteAt
        }))
        setStyleOptions(options)
        setSelectedStyleId((current) => {
          if (preferredStyleId && options.some((option) => option.id === preferredStyleId)) {
            return preferredStyleId
          }
          if (current && options.some((option) => option.id === current)) return current
          return resolveStyleIdOrStableDefault('', options)
        })
      } catch (err) {
        error(t('home.styleLoadFailed'), {
          description: err instanceof Error ? err.message : t('common.retryLater')
        })
      }
    },
    [error, t]
  )

  useEffect(() => {
    void loadStyleOptions()
  }, [loadStyleOptions])

  const handleSubmit = async (modelConfigId: string): Promise<void> => {
    if (parsingDocument) {
      warning(t('home.referenceProcessingWait'))
      return
    }
    if (pendingImageReference) {
      warning(t('home.completeInfoTitle'), { description: t('home.imageReferenceNeedsParse') })
      return
    }
    const validationError = validateForm(modelConfigId)
    if (validationError) {
      if (validationError === t('home.settingsRequired')) {
        warning(t('home.settingsRequiredTitle'), {
          description: t('home.settingsRequired'),
          action: {
            label: t('home.goToSettings'),
            onClick: () => navigate('/settings')
          }
        })
        return
      }
      warning(t('home.completeInfoTitle'), { description: validationError })
      return
    }
    const selectedStyle = styleOptions.find((option) => option.id === selectedStyleId)
    const styleSelection = buildSessionStyleSelection({
      mode: styleMode,
      styleId: selectedStyleId,
      description: aiStyleDescription,
      themeColors: aiThemeColors
    })
    if (!styleSelection) return
    const topicText = topic.trim()
    const briefText = brief.trim()
    const safePageCount = Number.parseInt(pageCount.trim(), 10)
    const initialPrompt =
      briefText ||
      buildNeutralInitialPrompt({
        topic: topicText || 'Untitled topic',
        pageCount: safePageCount,
        styleLabel:
          styleSelection.mode === 'preset'
            ? selectedStyle?.label || styleSelection.styleId
            : 'AI-generated session style'
      })

    setSubmitting(true)
    try {
      const resolvedModelConfigId = await ensureModelActive(modelConfigId)
      if (!resolvedModelConfigId) return
      const sessionId = await createSession({
        topic: topicText,
        styleSelection,
        modelConfigId: resolvedModelConfigId,
        pageCount: safePageCount,
        slideSizeId,
        referenceDocumentPath: referenceDocumentPath || undefined,
        sourcePlan: acceptedSourcePlan,
        fontSelection,
        imagePolicy: generateImagesWithAi ? 'ai' : 'placeholder',
        generationMode: useLockedLayouts ? 'locked' : 'creative',
        visualElementPreferences: visualElementPrefs,
        deckBackgroundPolicy: {
          enabled: generateDeckBackgrounds,
          coverEnabled: generateCoverBackground,
          contentEnabled: generateContentBackgrounds,
          endingEnabled: generateEndingBackground,
          contentBackgroundCount: Number(contentBackgroundCount) as 1 | 2 | 3
        }
      })
      success(t('home.sessionCreated'), {
        description: t('home.generationStarted'),
        duration: 1000
      })
      setPageCount(String(safePageCount))
      await delay(500)
      navigate(`/sessions/${sessionId}/generating`, {
        state: {
          initialPrompt,
          modelConfigId: resolvedModelConfigId,
          animationPreferences: normalizeAnimationPreferences(selectedAnimationPreferenceIds)
        }
      })
    } catch (err) {
      error(t('home.sessionCreateFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleChooseReferenceClick = async (): Promise<void> => {
    if (parsingDocument) return
    documentInputRef.current?.click()
  }

  const handleDocumentFilesSelected = async (files: FileList | null): Promise<void> => {
    const selectedFiles = Array.from(files || [])
    if (documentInputRef.current) {
      documentInputRef.current.value = ''
    }
    if (selectedFiles.length === 0) return
    if (selectedFiles.length > 1) {
      const message = t('home.documentSingleOnly')
      setDocumentParseError(message)
      error(t('home.documentCountExceeded'), {
        description: message
      })
      return
    }
    const selectedFile = selectedFiles[0]
    const isImage = isSupportedImageFile(selectedFile)
    const maxSizeMb = isImage ? MAX_IMAGE_SIZE_MB : MAX_DOCUMENT_SIZE_MB
    const maxSizeBytes = isImage ? MAX_IMAGE_SIZE_BYTES : MAX_DOCUMENT_SIZE_BYTES
    if (selectedFile.size > maxSizeBytes) {
      const message = isImage
        ? t('home.imageTooLarge', { maxSize: maxSizeMb })
        : t('home.documentTooLarge', { maxSize: maxSizeMb })
      setDocumentParseError(message)
      error(t('home.documentTooLargeTitle'), {
        description: message
      })
      return
    }

    const payloadFiles = selectedFiles
      .map((file) => ({
        path: window.electron?.getPathForFile?.(file) || '',
        name: file.name
      }))
      .filter((file) => file.path)

    if (payloadFiles.length === 0) {
      setDocumentParseError(t('home.documentPathFailed'))
      error(t('home.documentPathFailedTitle'))
      return
    }

    setParsingDocument(true)
    setDocumentParseError(null)
    try {
      const result = await ipc.prepareReferenceDocument({ files: payloadFiles })
      const referenceFile = result.files[0]
      setAttachedReferenceFile(referenceFile || null)
      setReferenceDocumentPath(
        referenceFile && referenceFile.type !== 'image' ? referenceFile.path : null
      )
      setSuggestionDraft(null)
      setAcceptedSourcePlan(undefined)
      success(isImage ? t('home.imageReferenceAttachedNeedsParse') : t('home.referenceAttached'), {
        description: referenceFile?.name || selectedFile.name
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.retryLater')
      setDocumentParseError(message)
      error(t('home.referenceAttachFailed'), {
        description: message
      })
    } finally {
      setParsingDocument(false)
    }
  }

  const handleRemoveReferenceFile = (): void => {
    setAttachedReferenceFile(null)
    setReferenceDocumentPath(null)
    setSuggestionDraft(null)
    setAcceptedSourcePlan(undefined)
    setDocumentParseError(null)
  }

  const handleRevealReferenceFile = async (): Promise<void> => {
    if (!attachedReferenceFile) return
    try {
      await ipc.revealFile(attachedReferenceFile.path)
    } catch (err) {
      error(t('home.revealReferenceFileFailed'), {
        description: err instanceof Error ? err.message : t('common.retryLater')
      })
    }
  }

  const handleParseImageReference = async (
    modelConfigId = selectedModelConfigId
  ): Promise<void> => {
    if (!attachedReferenceFile || attachedReferenceFile.type !== 'image' || parsingDocument) return
    const resolvedModelConfigId = await ensureModelActive(modelConfigId)
    if (!resolvedModelConfigId) return

    setParsingDocument(true)
    setDocumentParseError(null)
    try {
      const result = await ipc.parseImageReferenceDocument({
        file: { path: attachedReferenceFile.path, name: attachedReferenceFile.name },
        modelConfigId: resolvedModelConfigId
      })
      const referenceFile = result.files[0]
      if (!referenceFile) throw new Error(t('common.retryLater'))
      setAttachedReferenceFile(referenceFile)
      setReferenceDocumentPath(referenceFile.path)
      setSuggestionDraft(null)
      setAcceptedSourcePlan(undefined)
      setSuggestionDialogOpen(false)
      success(t('home.imageReferenceParsed'), { description: referenceFile.name })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.retryLater')
      setDocumentParseError(message)
      error(t('home.documentParseFailed'), { description: message })
    } finally {
      setParsingDocument(false)
    }
  }

  const handleAnalyzeReference = async (modelConfigId: string): Promise<void> => {
    if (!attachedReferenceFile || parsingDocument) return
    const resolvedModelConfigId = await ensureModelActive(modelConfigId)
    if (!resolvedModelConfigId) return

    setParsingDocument(true)
    setDocumentParseError(null)
    try {
      const result = await ipc.parseDocumentPlan({
        files: [{ path: attachedReferenceFile.path, name: attachedReferenceFile.name }],
        topic: topic.trim(),
        existingBrief: brief.trim(),
        modelConfigId: resolvedModelConfigId
      })
      const nextSuggestion = {
        topic: result.topic,
        pageCount: result.pageCount,
        briefText: result.briefText,
        sourcePlan: result.sourcePlan
      }
      const referenceFile = result.files[0] || attachedReferenceFile
      setAttachedReferenceFile(referenceFile)
      setReferenceDocumentPath(referenceFile.type !== 'image' ? referenceFile.path : null)
      setSuggestionDraft(buildSuggestionDraft(nextSuggestion))
      setAcceptedSourcePlan(undefined)
      setApplyTopicSuggestion(!topic.trim())
      setApplyPageCountSuggestion(!result.sourcePlan?.pageSkeleton.length && !pageCount.trim())
      setApplyBriefSuggestion(Boolean(result.sourcePlan?.pageSkeleton.length) || !brief.trim())
      setSuggestionDialogOpen(true)
      success(t('home.documentParsed'))
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.retryLater')
      setDocumentParseError(message)
      error(t('home.documentParseFailed'), {
        description: message
      })
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

    if (applyTopicSuggestion) setTopic(draft.topic)
    if (shouldApplySourceOutline) {
      setPageCount(String(resolvePageCount(String(sourceOutlinePageCount))))
    } else if (applyPageCountSuggestion) {
      setPageCount(String(resolvePageCount(draft.pageCount)))
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

  return (
    <div className="session-create-page mx-auto flex min-h-full w-full max-w-7xl flex-col gap-4 px-5 py-4 sm:px-6">
      <div className="flex max-w-4xl flex-col items-start gap-1.5 border-b border-border px-1 pb-4">
        <p className="rounded bg-[var(--ui-action-soft)]/78 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-foreground">
          {t('home.eyebrow')}
        </p>
        <h1 className="organic-serif text-[32px] font-semibold leading-tight text-foreground">
          {t('home.title')}
        </h1>
        <p className="text-sm leading-6 text-primary">{t('home.description')}</p>
      </div>

      <div>
        <input
          ref={documentInputRef}
          type="file"
          accept=".md,.txt,.text,.csv,.docx,image/png,image/jpeg,image/webp"
          multiple={false}
          className="hidden"
          onChange={(event) => void handleDocumentFilesSelected(event.target.files)}
        />
        {documentParseError && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-[var(--ui-danger-soft)] px-4 py-3 text-xs text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{documentParseError}</span>
          </div>
        )}

        <Card
          data-session-create-workspace
          className="session-create-workspace overflow-hidden rounded-2xl border border-border shadow-[0_12px_28px_rgb(var(--ui-shadow-color)/0.06)]"
        >
          <CardContent className="grid p-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)] [&_label]:text-[13px] [&_label]:font-semibold [&_label]:text-foreground">
            <main
              data-session-create-main
              className="flex min-w-0 flex-col gap-5 bg-transparent p-5 lg:p-6"
            >
              <div>
                <label className="mb-2 block">{t('home.topic')}</label>
                <Input
                  placeholder={t('home.topicPlaceholder')}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  required
                  className={compactInputClass}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block font-medium">{t('home.brief')}</label>
                  <div className="flex items-center gap-1 rounded-lg bg-[var(--ui-surface-elevated)]/84 p-0.5">
                    <button
                      type="button"
                      onClick={() => setBriefMode('edit')}
                      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        briefMode === 'edit'
                          ? 'bg-[var(--ui-focus)] text-foreground'
                          : 'text-primary hover:bg-[var(--ui-action-soft)]/70 hover:text-foreground'
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
                          ? 'bg-[var(--ui-focus)] text-foreground'
                          : 'text-primary hover:bg-[var(--ui-action-soft)]/70 hover:text-foreground'
                      }`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {t('common.preview')}
                    </button>
                  </div>
                </div>
                <div className="overflow-hidden rounded-xl border border-border bg-[var(--ui-surface-elevated)]/90">
                  {briefMode === 'edit' ? (
                    <Textarea
                      placeholder={t('home.briefPlaceholder')}
                      rows={8}
                      value={brief}
                      required
                      onChange={(e) => {
                        setAcceptedSourcePlan(undefined)
                        setBrief(e.target.value)
                      }}
                      className="min-h-[300px] resize-y border-0 bg-transparent px-4 py-3 text-xs leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                  ) : (
                    <ScrollArea className="h-[300px] bg-transparent" viewportClassName="p-4">
                      <ReactMarkdown
                        components={{
                          h1: ({ children }) => (
                            <h1 className="mb-2 text-lg font-semibold text-foreground">
                              {children}
                            </h1>
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
                            <p className="mb-2 text-xs leading-5 text-muted-foreground">
                              {children}
                            </p>
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
                        {brief || t('home.briefPlaceholder')}
                      </ReactMarkdown>
                    </ScrollArea>
                  )}
                </div>
                <div
                  data-session-create-reference-actions
                  className="mt-2 flex flex-wrap items-center justify-end gap-2"
                >
                  {attachedReferenceFile && (
                    <div className="flex min-w-0 max-w-full">
                      <span
                        className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-[11px] ${
                          pendingImageReference
                            ? 'border-[var(--ui-danger)]/50 bg-[var(--ui-danger-soft)] text-destructive'
                            : 'border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)]/84 text-primary'
                        }`}
                        title={
                          pendingImageReference
                            ? t('home.imageReferenceTagTooltip')
                            : attachedReferenceFile.path
                        }
                      >
                        <FileText className="h-3 w-3 shrink-0" />
                        <button
                          type="button"
                          onClick={() => void handleRevealReferenceFile()}
                          className="w-[150px] min-w-0 max-w-[150px] truncate text-left hover:underline"
                          title={t('home.revealReferenceFileTooltip')}
                          aria-label={t('home.revealReferenceFile')}
                        >
                          {attachedReferenceFile.name}
                        </button>
                        {pendingImageReference ? (
                          <>
                            <span className="shrink-0 text-destructive">
                              {t('home.imageReferenceNeedsParseShort')}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleParseImageReference(selectedModelConfigId)}
                              disabled={parsingDocument || submitting}
                              className="ml-1 inline-flex h-4 shrink-0 items-center rounded-full bg-destructive px-1.5 text-[10px] font-medium text-destructive-foreground hover:bg-[var(--ui-danger-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                              aria-label={t('home.parseImageReference')}
                            >
                              {parsingDocument
                                ? t('home.parsingImageReference')
                                : t('home.parseImageReference')}
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={handleRemoveReferenceFile}
                          className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${
                            pendingImageReference
                              ? 'text-destructive hover:bg-[var(--ui-danger-soft)]'
                              : 'text-primary hover:bg-[var(--ui-action-soft)]'
                          }`}
                          aria-label={t('home.removeReference')}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    </div>
                  )}
                  <TooltipProvider delayDuration={180}>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {!attachedReferenceFile && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  void handleChooseReferenceClick()
                                }}
                                disabled={parsingDocument}
                                className="h-8 shrink-0 rounded-lg border border-border bg-[var(--ui-surface-elevated)]/84 px-3 text-xs font-medium text-primary shadow-none hover:bg-[var(--ui-action-soft)]/65 hover:text-foreground"
                              >
                                {parsingDocument ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                {parsingDocument
                                  ? t('home.processingReference')
                                  : t('home.uploadReference')}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" align="start">
                            {t('home.uploadReferenceTooltip', {
                              maxSize: MAX_DOCUMENT_SIZE_MB,
                              imageMaxSize: MAX_IMAGE_SIZE_MB
                            })}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {attachedReferenceFile && !pendingImageReference && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <ModelSplitButton
                                modelAction={modelAction}
                                ariaLabel={t('home.analyzeReference')}
                                label={t('home.analyzeReference')}
                                loadingLabel={t('home.analyzingReference')}
                                loading={parsingDocument}
                                disabled={!attachedReferenceFile}
                                icon={Sparkles}
                                tone="primary"
                                dropdownAlign="end"
                                className="box-border h-8 rounded-lg border-0 bg-[var(--ui-focus)] shadow-[0_6px_14px_rgb(var(--ui-shadow-color)/0.15)]"
                                mainClassName="h-full bg-transparent px-2.5 text-xs text-foreground shadow-none hover:bg-white/10 hover:text-foreground hover:shadow-none"
                                triggerClassName="h-full w-8 px-0 text-foreground hover:text-foreground"
                                onRun={handleAnalyzeReference}
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start" className="max-w-xs">
                            {t('home.analyzeReferenceTooltip')}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TooltipProvider>
                </div>
              </div>

              <div className="mt-auto flex pt-1">
                <ModelSplitButton
                  modelAction={modelAction}
                  ariaLabel={t('home.createAndStart')}
                  label={t('home.createAndStart')}
                  loadingLabel={t('home.creating')}
                  loading={submitting || loading}
                  disabled={!requiredReady || parsingDocument}
                  icon={Sparkles}
                  tone="primary"
                  className="w-full sm:w-auto"
                  mainClassName="min-w-0 flex-1 h-10 px-4 sm:flex-none sm:min-w-[176px]"
                  onRun={handleSubmit}
                />
              </div>
            </main>

            <aside
              data-session-create-settings
              className="min-w-0 bg-transparent p-5 lg:border-l lg:border-border lg:p-6"
            >
              <div className="space-y-6">
                <section>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_88px] lg:grid-cols-[minmax(0,1fr)_82px]">
                    <div>
                      <label className="mb-2 block">{t('home.style')}</label>
                      <div
                        role="radiogroup"
                        aria-label={t('home.style')}
                        className="mb-2 grid grid-cols-2 gap-1 rounded-lg border border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-inset)]/70 p-1"
                      >
                        {(['preset', 'ai'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={styleMode === mode}
                            onClick={() => setStyleMode(mode)}
                            className={`h-7 rounded-md px-2 text-[11px] font-medium transition-colors ${
                              styleMode === mode
                                ? 'bg-[var(--ui-surface-solid)] text-foreground shadow-sm'
                                : 'text-muted-foreground hover:bg-[var(--ui-hover)] hover:text-foreground'
                            }`}
                          >
                            {mode === 'preset' ? t('home.styleModePreset') : t('home.styleModeAi')}
                          </button>
                        ))}
                      </div>

                      {styleMode === 'preset' ? (
                        <StyleSelect
                          value={selectedStyleId}
                          onChange={setSelectedStyleId}
                          options={styleOptions}
                          placeholder={t('home.stylePlaceholder')}
                          compact
                          className="h-8 border-[var(--ui-border-strong)] bg-[var(--ui-surface-elevated)]/90 px-2.5 py-1.5 text-xs shadow-none"
                          dropdownAlign="end"
                          dropdownClassName="w-[min(700px,calc(100vw-3rem))]"
                        />
                      ) : (
                        <div className="space-y-2">
                          <Textarea
                            value={aiStyleDescription}
                            onChange={(event) => setAiStyleDescription(event.target.value)}
                            maxLength={2000}
                            rows={3}
                            placeholder={t('home.aiStyleDescriptionPlaceholder')}
                            aria-label={t('home.aiStyleDescription')}
                            className="soft-input min-h-[76px] w-full resize-y rounded-lg px-2.5 py-2 text-xs leading-5 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                          <div>
                            <span className="mb-1.5 block text-[11px] font-medium">
                              {t('home.aiThemeColors')}
                            </span>
                            <div className="grid grid-cols-3 gap-1.5">
                              {aiThemeColors.map((color, index) => (
                                <label
                                  key={index}
                                  className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-[var(--ui-surface-solid)]/70 px-1.5 py-1"
                                >
                                  <input
                                    type="color"
                                    value={color}
                                    aria-label={t('home.aiThemeColor', { index: index + 1 })}
                                    data-ai-theme-color={index}
                                    onChange={(event) => {
                                      const next = [...aiThemeColors]
                                      next[index] = event.target.value
                                      setAiThemeColors(next)
                                    }}
                                    className="h-6 w-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                                  />
                                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                                    {color.toUpperCase()}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="mb-2 block">{t('home.pageCount')}</label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder={`${MIN_PAGE_COUNT}-${MAX_PAGE_COUNT}`}
                        value={pageCount}
                        required
                        onChange={(e) => {
                          const next = e.target.value
                          setAcceptedSourcePlan(undefined)
                          if (next === '') {
                            setPageCount('')
                            return
                          }
                          if (!/^\d+$/.test(next)) return
                          setPageCount(next)
                        }}
                        onBlur={() => {
                          setPageCount(String(resolvePageCount(pageCount)))
                        }}
                        className={settingsInputClass}
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="mb-2 block">{t('home.slideSize')}</label>
                    <Select
                      value={slideSizeId}
                      onValueChange={(value) => setSlideSizeId(value as SlideSizePresetId)}
                    >
                      <SelectTrigger className={settingsSelectTriggerClass}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={compactSelectContentClass}>
                        {SLIDE_SIZE_PRESETS.map((preset) => (
                          <SelectItem
                            key={preset.id}
                            value={preset.id}
                            className={compactSelectItemClass}
                          >
                            {preset.id === 'wide-16-9'
                              ? t('home.slideSizeWide')
                              : preset.id === 'vertical-9-16'
                                ? t('home.slideSizeVertical')
                                : preset.id === 'standard-4-3'
                                  ? t('home.slideSizeStandard')
                                  : preset.id === 'square-1-1'
                                    ? t('home.slideSizeSquare')
                                    : preset.id === 'vertical-3-4'
                                      ? t('home.slideSizePortrait')
                                      : t('home.slideSizeXiaohongshu')}
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              {preset.width}×{preset.height}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </section>

                <section>
                  <label className="mb-2 block">{t('home.fontScheme')}</label>
                  <FontSchemeSelector value={fontSelection} onChange={setFontSelection} compact />
                </section>

                <section>
                  <label className="mb-2 block text-xs font-medium text-foreground">
                    {t('home.imageModeLabel')}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setGenerateImagesWithAi(false)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        !generateImagesWithAi
                          ? 'border-primary bg-[var(--ui-action-soft)]/45'
                          : 'border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-elevated)]/60 hover:border-[var(--ui-focus)]'
                      }`}
                    >
                      <span className="block text-xs font-medium text-foreground">
                        {t('home.imageModePlaceholder')}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t('home.imageModePlaceholderHint')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenerateImagesWithAi(true)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        generateImagesWithAi
                          ? 'border-primary bg-[var(--ui-action-soft)]/45'
                          : 'border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-elevated)]/60 hover:border-[var(--ui-focus)]'
                      }`}
                    >
                      <span className="block text-xs font-medium text-foreground">
                        {t('home.imageModeAi')}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t('home.generateImagesWithAiHint')}
                      </span>
                    </button>
                  </div>
                </section>

                <section>
                  <label className="mb-2 block text-xs font-medium text-foreground">
                    {t('home.generationModeLabel')}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setUseLockedLayouts(true)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        useLockedLayouts
                          ? 'border-primary bg-[var(--ui-action-soft)]/45'
                          : 'border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-elevated)]/60 hover:border-[var(--ui-focus)]'
                      }`}
                    >
                      <span className="block text-xs font-medium text-foreground">
                        {t('home.generationModeLocked')}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t('home.generationModeLockedHint')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseLockedLayouts(false)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        !useLockedLayouts
                          ? 'border-primary bg-[var(--ui-action-soft)]/45'
                          : 'border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-elevated)]/60 hover:border-[var(--ui-focus)]'
                      }`}
                    >
                      <span className="block text-xs font-medium text-foreground">
                        {t('home.generationModeCreative')}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t('home.generationModeCreativeHint')}
                      </span>
                    </button>
                  </div>
                </section>

                <section>
                  <label className="mb-2 block text-xs font-medium text-foreground">
                    {t('home.visualElementLabel')}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {([
                      { key: 'charts' as const, icon: BarChart3 },
                      { key: 'images' as const, icon: ImageIcon },
                      { key: 'tables' as const, icon: TableIcon }
                    ]).map(({ key, icon: Icon }) => (
                      <div key={key} className="rounded-md border border-[var(--ui-border-strong)]/70 bg-[var(--ui-surface-elevated)]/60 p-2">
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5 text-primary" />
                          <span className="text-[11px] font-semibold text-foreground">
                            {key === 'charts' && t('home.visualElementCharts')}
                            {key === 'images' && t('home.visualElementImages')}
                            {key === 'tables' && t('home.visualElementTables')}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          {(['none', 'few', 'moderate', 'rich'] as const).map((level) => (
                            <button
                              key={level}
                              type="button"
                              onClick={() =>
                                setVisualElementPrefs((prev) => ({
                                  ...prev,
                                  [key]: level
                                }))
                              }
                              className={`flex-1 rounded border px-1 py-0.5 text-[10px] font-medium transition-colors ${
                                visualElementPrefs[key] === level
                                  ? 'border-primary bg-[var(--ui-action-soft)]/50 text-foreground'
                                  : 'border-border bg-muted/30 text-muted-foreground hover:border-[var(--ui-focus)]'
                              }`}
                            >
                              {level === 'none' && t('home.visualElementLevel.none')}
                              {level === 'few' && t('home.visualElementLevel.few')}
                              {level === 'moderate' && t('home.visualElementLevel.moderate')}
                              {level === 'rich' && t('home.visualElementLevel.rich')}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                    {t('home.visualElementHint')}
                  </p>
                </section>

                <section className="rounded-md border border-[var(--ui-border-strong)]/70 bg-white/55 p-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <Checkbox
                      checked={generateDeckBackgrounds}
                      onCheckedChange={(checked) => setGenerateDeckBackgrounds(checked === true)}
                      aria-label={t('home.generateDeckBackgrounds')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-foreground">
                        {t('home.generateDeckBackgrounds')}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t('home.generateDeckBackgroundsHint')}
                      </span>
                    </span>
                  </label>
                  {generateDeckBackgrounds ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="grid grid-cols-3 gap-2">
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px]">
                          <Checkbox
                            checked={generateCoverBackground}
                            onCheckedChange={(checked) =>
                              setGenerateCoverBackground(checked === true)
                            }
                          />
                          <span className="min-w-0 leading-4">{t('home.coverBackground')}</span>
                        </label>
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px]">
                          <Checkbox
                            checked={generateContentBackgrounds}
                            onCheckedChange={(checked) =>
                              setGenerateContentBackgrounds(checked === true)
                            }
                          />
                          <span className="min-w-0 leading-4">
                            {t('home.contentPageBackground')}
                          </span>
                        </label>
                        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px]">
                          <Checkbox
                            checked={generateEndingBackground}
                            onCheckedChange={(checked) =>
                              setGenerateEndingBackground(checked === true)
                            }
                          />
                          <span className="min-w-0 leading-4">{t('home.endingBackground')}</span>
                        </label>
                      </div>
                      {generateContentBackgrounds ? (
                        <div className="mt-3 flex items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">
                            {t('home.contentBackgroundVariants')}
                          </span>
                          <Select
                            value={contentBackgroundCount}
                            onValueChange={(value) =>
                              setContentBackgroundCount(value as '1' | '2' | '3')
                            }
                          >
                            <SelectTrigger className="h-8 w-24 bg-white/70">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(['1', '2', '3'] as const).map((count) => (
                                <SelectItem key={count} value={count}>
                                  {t('home.contentBackgroundVariantOption', { count })}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <section>
                  <label className="mb-2 flex items-center gap-2">
                    <span>{t('home.animationPreferences')}</span>
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {t('common.optional')}
                    </span>
                  </label>
                  <AnimationPreferenceChips
                    selectedIds={selectedAnimationPreferenceIds}
                    onChange={setSelectedAnimationPreferenceIds}
                    compact
                  />
                </section>
              </div>
            </aside>
          </CardContent>
        </Card>
      </div>

      <SessionCreateSuggestionDialog
        open={suggestionDialogOpen}
        onOpenChange={setSuggestionDialogOpen}
        attachedReferenceFile={attachedReferenceFile}
        suggestionDraft={suggestionDraft}
        setSuggestionDraft={setSuggestionDraft}
        applyTopicSuggestion={applyTopicSuggestion}
        setApplyTopicSuggestion={setApplyTopicSuggestion}
        applyPageCountSuggestion={applyPageCountSuggestion}
        setApplyPageCountSuggestion={setApplyPageCountSuggestion}
        applyBriefSuggestion={applyBriefSuggestion}
        setApplyBriefSuggestion={setApplyBriefSuggestion}
        onApplySelected={applyDocumentSuggestion}
      />
    </div>
  )
}
