import { useState, useEffect, useCallback, type ReactElement } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/Dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select'
import { StyleSelect } from '../style/StyleSelect'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Input'
import { useT, type I18nKey } from '@renderer/i18n'
import { ipc } from '@renderer/lib/ipc'
import { FontSchemeSelector } from '../font/FontSchemeSelector'
import type { FontSelection, SessionStyleSelection, SourceDocumentPlan } from '@shared/generation'
import {
  DEFAULT_SLIDE_SIZE_ID,
  SLIDE_SIZE_PRESETS,
  type SlideSizePresetId
} from '@shared/slide-size'
import type { ThinkingPrepareGenerationResult } from '@shared/thinking'
import { Sparkles } from 'lucide-react'
import { ModelSplitButton } from '../model/ModelActionButton'
import { useModelAction } from '@renderer/hooks/useModelAction'
import { Checkbox } from '../ui/Checkbox'
import { resolveStyleIdOrStableDefault } from '@renderer/lib/style-selection'
import {
  buildSessionStyleSelection,
  DEFAULT_AI_THEME_COLORS
} from '@renderer/lib/ai-style-selection'

const MIN_PAGE_COUNT = 1
const MAX_PAGE_COUNT = 500

const resolvePageCount = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  const resolved = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(MAX_PAGE_COUNT, Math.max(MIN_PAGE_COUNT, resolved))
}

const getSlideSizeLabelKey = (id: SlideSizePresetId): I18nKey => {
  switch (id) {
    case 'wide-16-9':
      return 'home.slideSizeWide'
    case 'vertical-9-16':
      return 'home.slideSizeVertical'
    case 'standard-4-3':
      return 'home.slideSizeStandard'
    case 'square-1-1':
      return 'home.slideSizeSquare'
    case 'vertical-3-4':
      return 'home.slideSizePortrait'
    case 'xiaohongshu-note':
      return 'home.slideSizeXiaohongshu'
  }
}

interface StyleOption {
  id: string
  styleKey?: string
  label: string
  description: string
  aliases?: string[]
  styleCase?: string
  thumbnailPath?: string | null
  previewPath?: string | null
  favoriteAt?: number | null
}

const tokenizeStyleText = (value: string): string[] => {
  const compact = value.trim().toLowerCase()
  const baseTokens = compact
    .split(/[\s,，、/|;；:：()[\]{}"'“”‘’<>《》]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const latinTokens = Array.from(compact.matchAll(/[a-z0-9-]{2,}/g), (match) => match[0])
  const cnBigrams = Array.from(compact.matchAll(/[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => {
    const text = match[0]
    const grams: string[] = []
    for (let index = 0; index < text.length - 1; index += 1) {
      grams.push(text.slice(index, index + 2))
    }
    return grams
  })
  return Array.from(new Set([...baseTokens, ...latinTokens, ...cnBigrams]))
}

const resolveFallbackStyleId = (fallbackStyleId: string, options: StyleOption[]): string => {
  return resolveStyleIdOrStableDefault(fallbackStyleId, options)
}

const resolveMatchedStyleId = (
  styleText: string | undefined,
  fallbackStyleId: string,
  options: StyleOption[]
): string => {
  const normalizedStyleText = (styleText || '').trim().toLowerCase()
  const resolvedFallbackStyleId = resolveFallbackStyleId(fallbackStyleId, options)
  if (options.length === 0) return resolvedFallbackStyleId
  if (!normalizedStyleText) return resolvedFallbackStyleId

  const exact = options.find((option) => {
    const candidates = [
      option.id,
      option.styleKey || '',
      option.label,
      ...(option.aliases || [])
    ].map((value) => value.toLowerCase())
    return candidates.includes(normalizedStyleText)
  })
  if (exact) return exact.id

  const queryTokens = tokenizeStyleText(normalizedStyleText)
  let best: { id: string; score: number } | null = null
  for (const option of options) {
    const haystack = [
      option.id,
      option.styleKey || '',
      option.label,
      ...(option.aliases || []),
      option.description,
      option.styleCase || ''
    ]
      .join(' ')
      .toLowerCase()
    let score = 0
    for (const token of queryTokens) {
      if (!token || !haystack.includes(token)) continue
      score += token.length >= 2 ? 2 : 1
    }
    if (!best || score > best.score) best = { id: option.id, score }
  }
  return best && best.score > 0 ? best.id : resolvedFallbackStyleId
}

interface GenerationConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  prepared: ThinkingPrepareGenerationResult | null
  onConfirm: (params: {
    topic: string
    pageCount: number
    styleSelection: SessionStyleSelection
    fontSelection: FontSelection
    slideSizeId: SlideSizePresetId
    referenceDocumentPath: string
    sourcePlan?: SourceDocumentPlan
    imagePolicy: import('@shared/generation').ImagePolicy
    generationMode: import('@shared/generation').GenerationMode
    deckBackgroundPolicy: import('@shared/generation').DeckBackgroundPolicy
    modelConfigId?: string
  }) => void
}

export function GenerationConfirmDialog({
  open,
  onOpenChange,
  prepared,
  onConfirm
}: GenerationConfirmDialogProps): ReactElement {
  const t = useT()
  const modelAction = useModelAction()
  const { selectedModelConfigId, ensureModelActive } = modelAction
  const [confirming, setConfirming] = useState(false)
  const [topic, setTopic] = useState('')
  const [pageCount, setPageCount] = useState('5')
  const [styleMode, setStyleMode] = useState<'preset' | 'ai'>('preset')
  const [styleId, setStyleId] = useState('')
  const [aiStyleDescription, setAiStyleDescription] = useState('')
  const [aiThemeColors, setAiThemeColors] = useState<string[]>([...DEFAULT_AI_THEME_COLORS])
  const [styleOptions, setStyleOptions] = useState<StyleOption[]>([])
  const [fontSelection, setFontSelection] = useState<FontSelection>({ mode: 'auto' })
  const [slideSizeId, setSlideSizeId] = useState<SlideSizePresetId>(DEFAULT_SLIDE_SIZE_ID)
  const [generateImagesWithAi, setGenerateImagesWithAi] = useState(false)
  const [useLockedLayouts, setUseLockedLayouts] = useState(false)
  const [generateDeckBackgrounds, setGenerateDeckBackgrounds] = useState(false)
  const [generateCoverBackground, setGenerateCoverBackground] = useState(true)
  const [generateContentBackgrounds, setGenerateContentBackgrounds] = useState(true)
  const [generateEndingBackground, setGenerateEndingBackground] = useState(true)
  const [contentBackgroundCount, setContentBackgroundCount] = useState<'1' | '2' | '3'>('1')

  useEffect(() => {
    if (prepared) {
      setTopic(prepared.topic)
      setPageCount(String(prepared.pageCount))
      setStyleMode('preset')
      setAiStyleDescription(prepared.styleText?.trim() || '')
      if (styleOptions.length > 0) {
        setStyleId(resolveMatchedStyleId(prepared.styleText, prepared.styleId, styleOptions))
      }
    }
  }, [prepared, styleOptions])

  useEffect(() => {
    setFontSelection(prepared?.fontSelection || { mode: 'auto' })
  }, [prepared])

  const loadOptions = useCallback(async (): Promise<void> => {
    const styleRes = await ipc.listStyles()
    const sorted = [...styleRes.items].sort(
      (a, b) =>
        (b.favoriteAt || 0) - (a.favoriteAt || 0) ||
        (b.updatedAt || 0) - (a.updatedAt || 0) ||
        (b.createdAt || 0) - (a.createdAt || 0) ||
        a.id.localeCompare(b.id)
    )
    setStyleOptions(
      sorted.map((item) => ({
        id: item.id,
        styleKey: item.styleKey,
        label: item.label,
        description: item.description,
        aliases: item.aliases,
        styleCase: item.styleCase,
        thumbnailPath: item.thumbnailPath,
        previewPath: item.previewPath,
        favoriteAt: item.favoriteAt
      }))
    )
  }, [])

  useEffect(() => {
    if (open) void loadOptions()
  }, [open, loadOptions])

  if (!prepared) return <></>

  const resolvedConfirmStyleId = styleId || resolveFallbackStyleId(prepared.styleId, styleOptions)
  const resolvedStyleSelection = buildSessionStyleSelection({
    mode: styleMode,
    styleId: resolvedConfirmStyleId,
    description: aiStyleDescription,
    themeColors: aiThemeColors
  })
  const canConfirm = Boolean(resolvedStyleSelection)

  const handleConfirm = async (modelConfigId = selectedModelConfigId): Promise<void> => {
    if (!resolvedStyleSelection || confirming) return
    const resolvedModelConfigId = await ensureModelActive(modelConfigId)
    if (!resolvedModelConfigId) return
    setConfirming(true)
    try {
      const resolvedPageCount = resolvePageCount(pageCount, prepared.pageCount)
      onConfirm({
        topic: topic.trim() || prepared.topic,
        pageCount: resolvedPageCount,
        styleSelection: resolvedStyleSelection,
        fontSelection,
        slideSizeId,
        referenceDocumentPath: prepared.thinkingDocumentPath,
        sourcePlan:
          prepared.sourcePlan?.pageSkeleton.length === resolvedPageCount
            ? prepared.sourcePlan
            : undefined,
        imagePolicy: generateImagesWithAi ? 'ai' : 'placeholder',
        generationMode: useLockedLayouts ? 'locked' : 'creative',
        deckBackgroundPolicy: {
          enabled: generateDeckBackgrounds,
          coverEnabled: generateCoverBackground,
          contentEnabled: generateContentBackgrounds,
          endingEnabled: generateEndingBackground,
          contentBackgroundCount: Number(contentBackgroundCount) as 1 | 2 | 3
        },
        modelConfigId: resolvedModelConfigId
      })
      onOpenChange(false)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('thinking.generationDialogTitle')}</DialogTitle>
          <DialogDescription className="text-[12px]">
            {t('thinking.generationDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 py-2 [&_button[role=combobox]]:h-8 [&_input]:h-8 [&_label]:mb-1.5 [&_label]:text-xs">
          <div className="min-w-0">
            <label className="block font-medium">{t('home.topic')}</label>
            <Input className="min-w-0" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(20rem,1fr)_6.25rem_minmax(0,12rem)]">
            <div className="min-w-0">
              <label className="block font-medium">{t('home.style')}</label>
              <div
                role="radiogroup"
                aria-label={t('home.style')}
                className="mb-2 grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1"
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
                  value={styleId}
                  onChange={setStyleId}
                  options={styleOptions}
                  placeholder={t('home.stylePlaceholder')}
                  className="h-8 min-w-0 py-0 text-xs"
                  dropdownClassName="w-[min(640px,calc(100vw-3rem))]"
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
                    className="min-h-[76px] resize-y px-2.5 py-2 text-xs leading-5"
                  />
                  <div>
                    <span className="mb-1.5 block text-[11px] font-medium">
                      {t('home.aiThemeColors')}
                    </span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {aiThemeColors.map((color, index) => (
                        <label
                          key={index}
                          className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/20 px-1.5 py-1"
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

            <div className="min-w-0">
              <label className="block font-medium">{t('home.pageCount')}</label>
              <Input
                className="min-w-0 text-center"
                type="text"
                inputMode="numeric"
                value={pageCount}
                onChange={(e) => {
                  const next = e.target.value
                  if (next === '' || /^\d+$/.test(next)) setPageCount(next)
                }}
                onBlur={() => {
                  setPageCount(String(resolvePageCount(pageCount, prepared.pageCount)))
                }}
              />
            </div>

            <div className="min-w-0">
              <label className="block font-medium">{t('home.slideSize')}</label>
              <Select
                value={slideSizeId}
                onValueChange={(value) => setSlideSizeId(value as SlideSizePresetId)}
              >
                <SelectTrigger className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLIDE_SIZE_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {t(getSlideSizeLabelKey(preset.id))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="min-w-0">
            <label className="block font-medium">{t('home.fontScheme')}</label>
            <div className="mt-1">
              <FontSchemeSelector value={fontSelection} onChange={setFontSelection} compact />
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium">{t('home.imageModeLabel')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setGenerateImagesWithAi(false)}
                className={`rounded-md border p-3 text-left transition-colors ${
                  !generateImagesWithAi
                    ? 'border-primary bg-[var(--ui-action-soft)]/45'
                    : 'border-border bg-muted/30 hover:border-[var(--ui-focus)]'
                }`}
              >
                <span className="block text-xs font-medium">{t('home.imageModePlaceholder')}</span>
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
                    : 'border-border bg-muted/30 hover:border-[var(--ui-focus)]'
                }`}
              >
                <span className="block text-xs font-medium">{t('home.imageModeAi')}</span>
                <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                  {t('home.generateImagesWithAiHint')}
                </span>
              </button>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium">{t('home.generationModeLabel')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setUseLockedLayouts(true)}
                className={`rounded-md border p-3 text-left transition-colors ${
                  useLockedLayouts
                    ? 'border-primary bg-[var(--ui-action-soft)]/45'
                    : 'border-border bg-muted/30 hover:border-[var(--ui-focus)]'
                }`}
              >
                <span className="block text-xs font-medium">
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
                    : 'border-border bg-muted/30 hover:border-[var(--ui-focus)]'
                }`}
              >
                <span className="block text-xs font-medium">
                  {t('home.generationModeCreative')}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                  {t('home.generationModeCreativeHint')}
                </span>
              </button>
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox
                checked={generateDeckBackgrounds}
                onCheckedChange={(checked) => setGenerateDeckBackgrounds(checked === true)}
                aria-label={t('home.generateDeckBackgrounds')}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">
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
                      onCheckedChange={(checked) => setGenerateCoverBackground(checked === true)}
                    />
                    <span className="min-w-0 leading-4">{t('home.coverBackground')}</span>
                  </label>
                  <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px]">
                    <Checkbox
                      checked={generateContentBackgrounds}
                      onCheckedChange={(checked) => setGenerateContentBackgrounds(checked === true)}
                    />
                    <span className="min-w-0 leading-4">{t('home.contentPageBackground')}</span>
                  </label>
                  <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[11px]">
                    <Checkbox
                      checked={generateEndingBackground}
                      onCheckedChange={(checked) => setGenerateEndingBackground(checked === true)}
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
                      onValueChange={(value) => setContentBackgroundCount(value as '1' | '2' | '3')}
                    >
                      <SelectTrigger className="h-8 w-24">
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
          </div>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
            className="w-full rounded-full sm:w-auto"
          >
            {t('common.cancel')}
          </Button>
          <ModelSplitButton
            modelAction={modelAction}
            label={t('home.createAndStart')}
            loadingLabel={t('home.creating')}
            loading={confirming}
            disabled={!canConfirm}
            icon={Sparkles}
            tone="primary"
            className="w-full sm:w-auto"
            mainClassName="min-w-0 flex-1 sm:flex-none sm:min-w-[156px]"
            onRun={handleConfirm}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
