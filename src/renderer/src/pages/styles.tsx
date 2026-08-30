import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from '../components/ui/AlertDialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/Tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../components/ui/DropdownMenu'
import { ipc, type HtmlThumbnailTask } from '@renderer/lib/ipc'
import { useStylePreviewStore, useToastStore } from '../store'
import {
  ChevronDown,
  Download,
  FolderOpen,
  Loader2,
  Palette,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useT } from '../i18n'
import { useThumbnailUpdates } from '../hooks/useThumbnailUpdates'
import { useVisibleItemIds } from '../hooks/useVisibleItemIds'
import { filterByStyleCase, filterByStyleKeyword, parseStyleCases } from '@renderer/lib/style-case'
import { StyleCaseFilter } from '../components/style/StyleCaseFilter'
import { cn } from '@renderer/lib/utils'
import { localAssetUrl } from '@shared/local-asset'

type StyleSummary = {
  id: string
  label: string
  description: string
  source?: 'builtin' | 'custom' | 'override'
  editable?: boolean
  category: string
  styleCase?: string
  previewPath?: string | null
  thumbnailPath?: string | null
  favoriteAt?: number | null
  createdAt?: number
  updatedAt?: number
}

const MAX_VISIBLE_IFRAMES = 8
const OFFICIAL_STYLE_SKILL_URL =
  'https://github.com/296711867/Amy-PPT/tree/main/resources/skills/amy-ppt-layout'

const stylePreviewUrl = (filePath: string): string =>
  import.meta.env.MODE === 'test' ? 'about:blank' : localAssetUrl(filePath)
const compareStylesByUpdated = (a: StyleSummary, b: StyleSummary): number =>
  (b.updatedAt || 0) - (a.updatedAt || 0) ||
  (b.createdAt || 0) - (a.createdAt || 0) ||
  a.id.localeCompare(b.id)
const compareStylesByFavorite = (a: StyleSummary, b: StyleSummary): number =>
  (b.favoriteAt || 0) - (a.favoriteAt || 0) || compareStylesByUpdated(a, b)

export function StylesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [styles, setStyles] = useState<StyleSummary[]>([])
  const [importingPackageType, setImportingPackageType] = useState<'zip' | 'directory' | ''>('')
  const [exportingStyleId, setExportingStyleId] = useState('')
  const [selectedStyleCase, setSelectedStyleCase] = useState('')
  const [query, setQuery] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [favoriteUpdatingStyleId, setFavoriteUpdatingStyleId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<StyleSummary | null>(null)
  const [deletingStyleId, setDeletingStyleId] = useState('')
  const { error, info, success, warning } = useToastStore()
  const generatingPreviewStyleId = useStylePreviewStore((state) => state.generatingStyleId)
  const previewCompletionVersion = useStylePreviewStore((state) => state.completionVersion)
  const generatePreview = useStylePreviewStore((state) => state.generatePreview)
  const t = useT()

  const favoriteCount = useMemo(
    () => styles.filter((style) => style.favoriteAt != null).length,
    [styles]
  )
  const styleCaseAvailableStyles = useMemo(() => {
    const byKeyword = filterByStyleKeyword(styles, query)
    return favoriteOnly ? byKeyword.filter((style) => style.favoriteAt != null) : byKeyword
  }, [favoriteOnly, query, styles])
  const filteredStyles = useMemo(() => {
    const byCase = filterByStyleCase(styleCaseAvailableStyles, selectedStyleCase)
    return favoriteOnly ? [...byCase].sort(compareStylesByFavorite) : byCase
  }, [favoriteOnly, selectedStyleCase, styleCaseAvailableStyles])
  const emptyStylesText =
    favoriteOnly && favoriteCount === 0
      ? t('styles.noFavoriteStyles')
      : t('styles.noMatchingStyles')
  const fallbackStyleIds = useMemo(
    () =>
      new Set(
        filteredStyles
          .filter((style) => !style.thumbnailPath && style.previewPath)
          .map((style) => style.id)
      ),
    [filteredStyles]
  )
  const builtinStyleCount = useMemo(
    () => styles.filter((style) => style.source === 'builtin').length,
    [styles]
  )
  const customStyleCount = useMemo(
    () => styles.filter((style) => style.source === 'custom' || style.source === 'override').length,
    [styles]
  )
  const { visibleIds: visibleFallbackIds, setItemRef } = useVisibleItemIds(
    fallbackStyleIds,
    MAX_VISIBLE_IFRAMES
  )

  const loadStyles = useCallback(async (): Promise<void> => {
    try {
      const { items } = await ipc.listStyles()
      const sorted = [...items].sort(compareStylesByUpdated)
      setStyles(sorted)
    } catch (e) {
      error(t('styles.loadFailed'), {
        description: e instanceof Error ? e.message : t('common.retryLater')
      })
    }
  }, [error, t])

  const applyThumbnail = useCallback((task: HtmlThumbnailTask): void => {
    if (!task.thumbnailPath) return
    setStyles((current) =>
      current.map((style) =>
        style.id === task.resourceId ? { ...style, thumbnailPath: task.thumbnailPath } : style
      )
    )
  }, [])

  useThumbnailUpdates('style', applyThumbnail)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStyles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadStyles, previewCompletionVersion])

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget || deletingStyleId) return
    const style = deleteTarget
    setDeletingStyleId(style.id)
    try {
      const result = await ipc.deleteStyle(style.id)
      if (!result.deleted) {
        warning(t('styles.deleteFailed'), { description: t('common.retryLater') })
        return
      }
      info(t('styles.deleted'))
      setDeleteTarget(null)
      await loadStyles()
    } catch (e) {
      error(t('styles.deleteFailed'), {
        description: e instanceof Error ? e.message : t('common.retryLater')
      })
    } finally {
      setDeletingStyleId('')
    }
  }, [deleteTarget, deletingStyleId, error, info, warning, t, loadStyles])

  const handleImportPackage = useCallback(
    async (type: 'zip' | 'directory'): Promise<void> => {
      if (importingPackageType) return
      setImportingPackageType(type)
      try {
        const result =
          type === 'zip'
            ? await ipc.importStylePackageZip()
            : await ipc.importStylePackageDirectory()
        if (result.cancelled) return
        success(t('styles.packageImported'), {
          description:
            result.source === 'override'
              ? t('styleEditor.savedOverride')
              : t('styleEditor.savedCustom')
        })
        await loadStyles()
      } catch (e) {
        error(t('styles.packageImportFailed'), {
          description: e instanceof Error ? e.message : t('common.retryLater')
        })
      } finally {
        setImportingPackageType('')
      }
    },
    [error, importingPackageType, loadStyles, success, t]
  )

  const handleExportPackage = useCallback(
    async (style: StyleSummary): Promise<void> => {
      if (exportingStyleId) return
      setExportingStyleId(style.id)
      try {
        const result = await ipc.exportStylePackageZip({ styleId: style.id })
        if (result.canceled) return
        success(t('styles.packageExported'), {
          description: result.filePath || style.label
        })
      } catch (e) {
        error(t('styles.packageExportFailed'), {
          description: e instanceof Error ? e.message : t('common.retryLater')
        })
      } finally {
        setExportingStyleId('')
      }
    },
    [error, exportingStyleId, success, t]
  )

  const handleGeneratePreview = useCallback(
    async (style: StyleSummary): Promise<void> => {
      try {
        const started = await generatePreview(style.id)
        if (!started) return
        success(t('styles.previewGenerated'), {
          description: style.label
        })
      } catch (e) {
        error(t('styles.previewGenerationFailed'), {
          description: e instanceof Error ? e.message : t('common.retryLater')
        })
      }
    },
    [error, generatePreview, success, t]
  )

  const handleToggleFavorite = useCallback(
    async (style: StyleSummary): Promise<void> => {
      if (favoriteUpdatingStyleId) return
      const nextFavorite = style.favoriteAt == null
      const previousFavoriteAt = style.favoriteAt ?? null
      const optimisticFavoriteAt = nextFavorite ? Math.floor(Date.now() / 1000) : null
      setFavoriteUpdatingStyleId(style.id)
      setStyles((current) =>
        current.map((item) =>
          item.id === style.id ? { ...item, favoriteAt: optimisticFavoriteAt } : item
        )
      )
      try {
        const result = await ipc.setStyleFavorite({ styleId: style.id, favorite: nextFavorite })
        if (!result.success) {
          throw new Error(t('common.retryLater'))
        }
        setStyles((current) =>
          current.map((item) =>
            item.id === style.id ? { ...item, favoriteAt: result.favoriteAt } : item
          )
        )
      } catch (e) {
        setStyles((current) =>
          current.map((item) =>
            item.id === style.id ? { ...item, favoriteAt: previousFavoriteAt } : item
          )
        )
        error(t('styles.favoriteFailed'), {
          description: e instanceof Error ? e.message : t('common.retryLater')
        })
      } finally {
        setFavoriteUpdatingStyleId('')
      }
    },
    [error, favoriteUpdatingStyleId, t]
  )

  return (
    <TooltipProvider delayDuration={180}>
      <div className="mx-auto w-full max-w-6xl p-6">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
            {t('styles.eyebrow')}
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="organic-serif text-[32px] font-semibold leading-none text-foreground">
                {t('styles.title')}
              </h1>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-w-[112px]"
                    disabled={Boolean(importingPackageType)}
                    title={t('styles.importMenuTooltip')}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {importingPackageType ? t('styles.importingPackage') : t('styles.importMenu')}
                    <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-75" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[300px]">
                  <DropdownMenuItem onSelect={() => navigate('/styles/new')}>
                    <Sparkles className="h-4 w-4" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{t('styles.importParse')}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('styles.importParseTooltip')}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={Boolean(importingPackageType)}
                    onSelect={() => void handleImportPackage('zip')}
                  >
                    <Upload className="h-4 w-4" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{t('styles.importPackage')}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('styles.importPackageTooltip')}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={Boolean(importingPackageType)}
                    onSelect={() => void handleImportPackage('directory')}
                  >
                    <FolderOpen className="h-4 w-4" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {t('styles.importPackageDirectory')}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('styles.importPackageDirectoryTooltip')}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
                    {t('styles.importMenuTooltip')}{' '}
                    <a
                      href={OFFICIAL_STYLE_SKILL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-primary underline underline-offset-2 hover:text-[var(--ui-action-hover)]"
                    >
                      {t('styles.officialSkillLabel')}
                    </a>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="min-w-[112px]"
                    onClick={() => navigate('/styles/new')}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('styles.newStyle')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">
                  {t('styles.newStyleTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
            {t('styles.description', {
              builtin: builtinStyleCount,
              custom: customStyleCount
            })}
          </p>
        </div>

        <div className="mb-5 rounded-lg border border-border bg-card/75 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-h-9 flex-1 items-center gap-2 rounded-md border border-border bg-[var(--ui-surface-solid)]/80 px-2.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('styles.searchPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t('styles.clearSearch')}
                  title={t('styles.clearSearch')}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setFavoriteOnly((current) => !current)}
              className={cn(
                'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors',
                favoriteOnly
                  ? 'border-primary bg-accent text-foreground'
                  : 'border-border bg-card/70 text-muted-foreground hover:bg-accent'
              )}
              aria-pressed={favoriteOnly}
            >
              <Star className={cn('h-3.5 w-3.5', favoriteOnly && 'fill-primary text-primary')} />
              {`${t('styles.favoriteStyles')} · ${favoriteCount}`}
            </button>
          </div>
          <StyleCaseFilter
            className="mt-3"
            items={styles}
            availableItems={styleCaseAvailableStyles}
            selected={selectedStyleCase}
            onSelect={setSelectedStyleCase}
            allLabel={t('styles.allStyleCases')}
            title={t('styles.styleCaseFilter')}
          />
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
          {filteredStyles.map((style) => (
            <div
              key={style.id}
              ref={!style.thumbnailPath && style.previewPath ? setItemRef(style.id) : undefined}
              data-style-card-id={style.id}
              className="group overflow-hidden rounded-lg border border-border bg-card/80 text-left shadow-[0_4px_16px_rgb(var(--ui-shadow-color)/0.08)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_26px_rgb(var(--ui-shadow-color)/0.15)]"
            >
              <div className="relative aspect-video overflow-hidden bg-secondary">
                {style.thumbnailPath ? (
                  <img
                    src={stylePreviewUrl(style.thumbnailPath)}
                    loading="lazy"
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : style.previewPath && visibleFallbackIds.has(style.id) ? (
                  <iframe
                    data-testid="style-preview-iframe"
                    src={stylePreviewUrl(style.previewPath)}
                    sandbox=""
                    tabIndex={-1}
                    className="pointer-events-none absolute left-0 top-0 h-[900px] w-[1600px] origin-top-left border-0 bg-white"
                    style={{ transform: 'scale(0.2)' }}
                    title={`${style.label} preview`}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    {generatingPreviewStyleId === style.id ? (
                      <Loader2 className="h-8 w-8 animate-spin" />
                    ) : (
                      <Palette className="h-8 w-8" />
                    )}
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(
                        'absolute left-3 top-3 z-20 h-8 w-8 rounded-md bg-[var(--ui-surface-solid)]/95 p-0 text-muted-foreground shadow-[0_3px_10px_rgb(var(--ui-shadow-color)/0.16)]',
                        style.favoriteAt != null
                          ? 'text-primary opacity-100'
                          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                      )}
                      disabled={favoriteUpdatingStyleId === style.id}
                      onClick={() => void handleToggleFavorite(style)}
                      aria-label={
                        style.favoriteAt != null
                          ? t('styles.unfavoriteStyle')
                          : t('styles.favoriteStyle')
                      }
                      title={
                        style.favoriteAt != null
                          ? t('styles.unfavoriteStyleTooltip')
                          : t('styles.favoriteStyleTooltip')
                      }
                    >
                      {favoriteUpdatingStyleId === style.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Star
                          className={cn(
                            'h-3.5 w-3.5',
                            style.favoriteAt != null && 'fill-primary text-primary'
                          )}
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start">
                    {style.favoriteAt != null
                      ? t('styles.unfavoriteStyleTooltip')
                      : t('styles.favoriteStyleTooltip')}
                  </TooltipContent>
                </Tooltip>
                <div className="absolute inset-x-0 top-0 flex items-start justify-end gap-1.5 bg-gradient-to-b from-black/30 to-transparent p-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {!style.previewPath && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 rounded-md bg-[var(--ui-surface-solid)]/95 p-0 text-foreground shadow-[0_3px_10px_rgb(var(--ui-shadow-color)/0.16)]"
                          disabled={Boolean(generatingPreviewStyleId)}
                          onClick={() => void handleGeneratePreview(style)}
                          aria-label={
                            generatingPreviewStyleId === style.id
                              ? t('styles.generatingPreview')
                              : t('styles.generatePreview')
                          }
                          title={
                            generatingPreviewStyleId === style.id
                              ? t('styles.generatingPreview')
                              : t('styles.generatePreviewTooltip')
                          }
                        >
                          {generatingPreviewStyleId === style.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" align="end">
                        {generatingPreviewStyleId === style.id
                          ? t('styles.generatingPreview')
                          : t('styles.generatePreviewTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 rounded-md bg-[var(--ui-surface-solid)]/95 p-0 text-foreground shadow-[0_3px_10px_rgb(var(--ui-shadow-color)/0.16)]"
                        onClick={() => navigate(`/styles/${style.id}`)}
                        aria-label={t('common.edit')}
                        title={t('styles.editTooltip')}
                      >
                        <PencilLine className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      {t('styles.editTooltip')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 rounded-md bg-[var(--ui-surface-solid)]/95 p-0 text-foreground shadow-[0_3px_10px_rgb(var(--ui-shadow-color)/0.16)]"
                        disabled={exportingStyleId === style.id}
                        onClick={() => void handleExportPackage(style)}
                        aria-label={t('styles.exportPackage')}
                        title={t('styles.exportPackageTooltip')}
                      >
                        {exportingStyleId === style.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      {t('styles.exportPackageTooltip')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 rounded-md bg-[var(--ui-surface-solid)]/95 p-0 text-destructive shadow-[0_3px_10px_rgb(var(--ui-shadow-color)/0.16)] hover:text-[var(--ui-danger-hover)]"
                        onClick={() => setDeleteTarget(style)}
                        aria-label={t('common.delete')}
                        title={t('styles.deleteTooltip')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      {t('styles.deleteTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{style.label}</p>
                    <p className="mt-0.5 text-[10px] font-medium text-muted-foreground">
                      {style.category} · {style.source || t('styles.sourceBuiltin')}
                    </p>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {style.description || style.id}
                </p>
                {style.styleCase && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {parseStyleCases(style.styleCase).map((styleCase) => (
                      <span
                        key={styleCase}
                        className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground"
                      >
                        {styleCase}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {filteredStyles.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card/40 py-12 text-center text-sm text-muted-foreground">
            {emptyStylesText}
          </div>
        )}
        <AlertDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open && !deletingStyleId) setDeleteTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>{t('styles.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('styles.deleteConfirmDescription', { name: deleteTarget?.label || '' })}
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel disabled={Boolean(deletingStyleId)}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={Boolean(deletingStyleId)}
                onClick={(event) => {
                  event.preventDefault()
                  void handleDelete()
                }}
                className="bg-destructive text-destructive-foreground hover:bg-[var(--ui-danger-hover)] disabled:cursor-not-allowed disabled:opacity-65"
              >
                {deletingStyleId ? (
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
    </TooltipProvider>
  )
}
