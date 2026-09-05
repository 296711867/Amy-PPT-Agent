import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ipc } from '@renderer/lib/ipc'
import type { AnimationPreferencesPayload, GenerateChunkEvent } from '@shared/generation.js'
import type { GenerationFailureInfo } from '@shared/generation-error'
import {
  getEditorGate,
  parseSessionMetadata,
  type EditorGate
} from '../lib/sessionMetadata'
import { useLang, type Lang } from '../i18n'
import {
  GenerationPreviewGrid,
  GenerationSidebar,
  GenerationStatusPanel,
  type GenerationPreviewPage,
  type GenerationRunStatus,
  type GenerationStageKey
} from '../components/session-generating'
import { useModelAction } from '../hooks/useModelAction'
import { trySessionSlideSize, type SlideSizePreset } from '@shared/slide-size'
import { AmyLogoMotion } from '../components/brand/AmyLogoMotion'

type LocationState = {
  initialPrompt?: string
  modelConfigId?: string
  retry?: boolean
  rerunToken?: number
  animationPreferences?: AnimationPreferencesPayload | null
  failedRunId?: string
}

type GenerationKind = 'standard' | 'template'

type SessionGeneratedPage = {
  id?: string
  pageNumber: number
  title: string
  htmlPath?: string
  pageId?: string
  sourceUrl?: string
  status?: string
  error?: string | null
}

type GenerationSessionSnapshot = {
  status?: string
  title?: string | null
  page_count?: number | null
  metadata?: string | null
  slideSizeId?: string | null
  slideWidth?: number | null
  slideHeight?: number | null
  slide_size_id?: string | null
  slide_width?: number | null
  slide_height?: number | null
}

const NEUTRAL_GENERATION_PROMPT =
  'Create a clear first draft that can be previewed directly. Determine the content language from the session topic, outline, detailed brief, and source documents; do not infer it from the application UI language or this instruction language.'

const isSessionFullyGenerated = (gate: EditorGate): boolean =>
  gate.generatedCount >= gate.totalCount && gate.failedCount === 0

const LOG_AUTO_SCROLL_THRESHOLD = 48

const isNearLogBottom = (el: HTMLDivElement): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_AUTO_SCROLL_THRESHOLD

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const eventDedupeKey = (value: string): string =>
  compactWhitespace(value)
    .replace(/\s*·\s*\d{1,3}%$/g, '')
    .replace(/\s+\d{1,3}%$/g, '')

const hasTechnicalDetail = (message: string): boolean => {
  const compact = compactWhitespace(message)
  if (compact.length > 160 || message.includes('\n')) return true
  return (
    /Received tool input did not match expected schema|Error invoking tool|ZodError|expected schema|HTML 验证失败|HTML 落盘校验失败|页面编辑结果验证失败|ERR_FILE_NOT_FOUND|Failed to load URL|文件不存在|at\s+\S+.*:\d+:\d+|<html|<!doctype|data-ppt/i.test(
      compact
    ) ||
    /HTML 末尾|未闭合标签|开闭标签数量不一致|内容可能被截断|<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(
      compact
    )
  )
}

const friendlyText = (lang: Lang, zh: string, en: string): string => (lang === 'en' ? en : zh)

const friendlyProgressDetail = (detail: string, lang: Lang): string => {
  const compact = compactWhitespace(detail)
  if (!compact) return ''
  const pageMatch = compact.match(/(\d+)\/(\d+)\s*(页|pages?)/i)
  if (pageMatch) {
    return friendlyText(
      lang,
      `已处理 ${pageMatch[1]}/${pageMatch[2]} 页`,
      `Processed ${pageMatch[1]}/${pageMatch[2]} pages`
    )
  }
  if (/没有检测到.*变化|without any detected page changes|no page changes/i.test(compact)) {
    return friendlyText(
      lang,
      '刚才没有写入变化，正在换一种方式重试。',
      'No changes were written yet; trying another way.'
    )
  }
  if (
    /HTML 末尾|未闭合标签|开闭标签数量不一致|内容可能被截断|<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(
      compact
    )
  ) {
    return friendlyText(
      lang,
      '页面结构检查未通过，正在尝试修复。',
      'The page structure needs a fix; trying to repair it.'
    )
  }
  if (/schema|工具调用参数|tool call/i.test(compact)) {
    return friendlyText(
      lang,
      '工具参数需要修正，正在自动重试。',
      'Tool arguments need a quick fix; retrying automatically.'
    )
  }
  if (/校验|验证|validat/i.test(compact)) {
    return friendlyText(
      lang,
      '页面结构需要修正，正在自动重试。',
      'The page structure needs a fix; retrying automatically.'
    )
  }
  if (/重试|retry/i.test(compact)) {
    return friendlyText(
      lang,
      '处理中遇到问题，正在自动重试。',
      'Something needs another pass; retrying automatically.'
    )
  }
  if (/准备完成|ready/i.test(compact)) {
    return friendlyText(lang, '准备完成，开始生成页面。', 'Ready. Starting page generation.')
  }
  const pageTitleMatch = compact.match(/^page-[\w-]+\s*·\s*(.+)$/i)
  if (pageTitleMatch?.[1]) {
    const title = pageTitleMatch[1].trim()
    return friendlyText(lang, `正在处理「${title}」`, `Processing "${title}"`)
  }
  return hasTechnicalDetail(compact) ? '' : compact
}

const isFailureProgress = (label: string | undefined, detail: string): boolean =>
  /失败|failed|fail|error|错误/i.test(`${label || ''} ${detail}`)

const isCancellationMessage = (message: string | null | undefined): boolean =>
  /^(生成已取消|Generation cancelled|Generation canceled)$/i.test((message || '').trim())

const friendlyProgressLabel = (label: string | undefined, detail: string, lang: Lang): string => {
  const compactLabel = compactWhitespace(label || '')
  if (isFailureProgress(label, detail)) {
    return friendlyText(lang, '检查页面', 'Checking pages')
  }
  return compactLabel
}

const friendlyFailureProgressDetail = (lang: Lang, rawDetail = ''): string => {
  // 服务端瞬态错误优先展示真实原因
  if (/\b(?:503|502)\b|service\s+(?:temporarily\s+)?unavailable|overloaded/i.test(rawDetail)) {
    return friendlyText(
      lang,
      '模型服务临时不可用，正在退避等待后自动重试。',
      'The model service is temporarily unavailable; retrying with backoff.'
    )
  }
  if (/\b429\b|rate.?limit|quota/i.test(rawDetail)) {
    return friendlyText(
      lang,
      '模型服务限流，正在等待后自动重试。',
      'The model service is rate limiting; retrying automatically.'
    )
  }
  if (/页面结构|structure|html.*校验|未闭合|placeholder/i.test(rawDetail)) {
    return friendlyText(
      lang,
      '页面结构检查未通过，正在尝试修复。',
      'The page structure needs a fix; trying to repair it.'
    )
  }
  // 其他失败：展示原始错误摘要，不谎报为结构问题
  const summary = compactWhitespace(rawDetail).slice(0, 120)
  if (summary) {
    return summary
  }
  return friendlyText(lang, '生成遇到问题，正在处理。', 'Generation hit an issue; working on it.')
}

const friendlyFailureMessage = (message: string | null | undefined, lang: Lang): string => {
  const compact = compactWhitespace(message || '')
  if (!compact) {
    return friendlyText(lang, '生成没有完成，请重试。', 'Generation did not finish. Please retry.')
  }
  if (
    /API Key|api key|provider|模型|model|timeout|timed out|ECONN|network|fetch failed/i.test(
      compact
    )
  ) {
    return friendlyText(
      lang,
      '模型服务暂时不可用，请检查设置后重试。',
      'The model service is not available. Check settings and retry.'
    )
  }
  if (/文件不存在|ERR_FILE_NOT_FOUND|Failed to load URL|ENOENT/i.test(compact)) {
    return friendlyText(
      lang,
      '页面文件暂时不可用，请返回会话后重试。',
      'The page files are not available. Return to the session and retry.'
    )
  }
  if (/schema|tool call|工具调用参数/i.test(compact)) {
    return friendlyText(
      lang,
      '生成工具调用失败，请重试一次。',
      'The generation tool call failed. Please retry.'
    )
  }
  if (/校验|验证|validat|HTML/i.test(compact)) {
    return friendlyText(
      lang,
      '页面结果没有通过检查，请重试一次。',
      'The page result did not pass checks. Please retry.'
    )
  }
  return hasTechnicalDetail(compact)
    ? friendlyText(lang, '生成没有完成，请重试。', 'Generation did not finish. Please retry.')
    : compact
}

const progressLine = (args: { label?: string; detail?: string }): string => {
  const label = compactWhitespace(args.label || '')
  const detail = compactWhitespace(args.detail || '')
  const parts = [label, detail].filter(Boolean)
  return parts.join(' · ')
}

const buildPagePlaceholders = (
  totalPages: number,
  lang: Lang,
  existing: GenerationPreviewPage[] = []
): GenerationPreviewPage[] => {
  const count = Math.max(1, Math.floor(totalPages || 1))
  const byNumber = new Map(existing.map((page) => [page.pageNumber, page]))
  return Array.from({ length: count }, (_, index) => {
    const pageNumber = index + 1
    const existingPage = byNumber.get(pageNumber)
    if (existingPage) return existingPage
    return {
      id: `placeholder-${pageNumber}`,
      pageNumber,
      title: friendlyText(lang, `第 ${pageNumber} 页`, `Page ${pageNumber}`),
      status: 'pending'
    }
  })
}

const mergePreviewPage = (
  pages: GenerationPreviewPage[],
  incoming: GenerationPreviewPage,
  totalPages: number,
  lang: Lang
): GenerationPreviewPage[] => {
  const placeholders = buildPagePlaceholders(totalPages, lang, pages)
  const index = placeholders.findIndex((page) => page.pageNumber === incoming.pageNumber)
  const previousPage = index >= 0 ? placeholders[index] : undefined
  const nextPage = {
    ...incoming,
    id: incoming.id || incoming.pageId || `page-${incoming.pageNumber}`,
    pageId: incoming.pageId || `page-${incoming.pageNumber}`,
    status: incoming.status,
    previewVersion: (previousPage?.previewVersion || 0) + 1
  }
  if (index >= 0) {
    placeholders[index] = {
      ...placeholders[index],
      ...nextPage
    }
  } else {
    placeholders.push(nextPage)
  }
  return placeholders.sort((a, b) => a.pageNumber - b.pageNumber)
}

const buildPreviewPagesFromGeneratedPages = (
  pageCount: number,
  pages: SessionGeneratedPage[],
  lang: Lang
): GenerationPreviewPage[] => {
  const maxPageNumber = pages.reduce((max, page) => Math.max(max, page.pageNumber || 0), 0)
  const totalPages = Math.max(1, pageCount, maxPageNumber, pages.length)
  return buildPagePlaceholders(
    totalPages,
    lang,
    pages.map((page) => ({
      id: page.id || page.pageId || `page-${page.pageNumber}`,
      pageNumber: page.pageNumber,
      title: page.title,
      htmlPath: page.htmlPath,
      pageId: page.pageId || `page-${page.pageNumber}`,
      sourceUrl: page.sourceUrl,
      status:
        page.status === 'failed'
          ? 'failed'
          : page.status === 'completed'
            ? 'completed'
            : page.status
              ? 'pending'
              : page.htmlPath || page.sourceUrl
                ? 'completed'
                : 'pending'
    }))
  )
}

const updatePreviewPageStatus = (
  pages: GenerationPreviewPage[],
  incoming: {
    id?: string
    pageNumber: number
    title: string
    pageId?: string
    htmlPath?: string
    sourceUrl?: string
    status: GenerationPreviewPage['status']
  },
  totalPages: number,
  lang: Lang
): GenerationPreviewPage[] => {
  const placeholders = buildPagePlaceholders(totalPages, lang, pages)
  return placeholders
    .map((page) => {
      if (page.pageNumber !== incoming.pageNumber) return page
      const nextStatus =
        page.status === 'completed' && incoming.status === 'generating'
          ? page.status
          : incoming.status
      return {
        ...page,
        id: incoming.id || page.id,
        pageId: incoming.pageId || page.pageId,
        htmlPath: incoming.htmlPath || page.htmlPath,
        sourceUrl: incoming.sourceUrl || page.sourceUrl,
        title: incoming.title || page.title,
        status: nextStatus
      }
    })
    .sort((a, b) => a.pageNumber - b.pageNumber)
}

export function SessionGeneratingPage({
  generationKind = 'standard'
}: {
  generationKind?: GenerationKind
} = {}): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { lang, t } = useLang()
  const modelAction = useModelAction()
  const { ensureModelActive, selectedModelConfigId } = modelAction
  const state = (location.state as LocationState | null) || null
  const startedSessionRef = useRef<string | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const terminalStatusRef = useRef<'completed' | 'paused' | 'failed' | null>(null)
  const eventsContainerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const shouldAutoScrollRef = useRef(true)
  const currentStageRef = useRef<string>('preflight')
  const lastProgressLogRef = useRef<{ stage: string; progress: number; time: number } | null>(null)

  const [status, setStatus] = useState<GenerationRunStatus>('running')
  const [progress, setProgress] = useState(0)
  const [events, setEvents] = useState<Array<{ text: string; time?: string }>>([
    { text: t('generating.created'), time: new Date().toISOString() }
  ])
  const [error, setError] = useState<string | null>(null)
  const [pauseFailure, setPauseFailure] = useState<GenerationFailureInfo | null>(null)
  const [pauseTechnicalDetail, setPauseTechnicalDetail] = useState<string | null>(null)
  const [pendingPageCount, setPendingPageCount] = useState(0)
  const [totalPages, setTotalPages] = useState<number>(1)
  const [editorGate, setEditorGate] = useState<EditorGate>(() => getEditorGate(null))
  const [currentStage, setCurrentStage] = useState<string>('preflight')
  const [previewPages, setPreviewPages] = useState<GenerationPreviewPage[]>(() =>
    buildPagePlaceholders(1, lang)
  )
  const [hasRetryablePages, setHasRetryablePages] = useState(false)
  const [slideSize, setSlideSize] = useState<SlideSizePreset | null>(null)
  const [presentationTitle, setPresentationTitle] = useState<string>('')
  const [cancelPending, setCancelPending] = useState(false)
  const generatingPath =
    generationKind === 'template' && id
      ? `/sessions/${id}/template-generating`
      : `/sessions/${id}/generating`

  const appendEvent = (line: string, timestamp?: string): void => {
    const el = eventsContainerRef.current
    shouldAutoScrollRef.current = !el || stickToBottomRef.current || isNearLogBottom(el)
    setEvents((prev) => {
      const normalized = line.replace(/\s+/g, ' ').trim()
      if (!normalized) return prev
      const normalizedKey = eventDedupeKey(normalized)
      const normalizedPrev = prev.map((item) => eventDedupeKey(item.text))
      const previousKey = normalizedPrev[normalizedPrev.length - 1]
      if (previousKey === normalizedKey || previousKey?.startsWith(`${normalizedKey} · `)) {
        return prev
      }
      if (previousKey && normalizedKey.startsWith(`${previousKey} · `)) {
        const next = [...prev.slice(0, -1), { text: line, time: timestamp }]
        return next.length > 300 ? next.slice(next.length - 300) : next
      }
      const recent = normalizedPrev.slice(-4)
      if (
        recent.some(
          (item) =>
            item === normalizedKey ||
            item.startsWith(`${normalizedKey} · `) ||
            normalizedKey.startsWith(`${item} · `)
        )
      ) {
        return prev
      }
      const next = [...prev, { text: line, time: timestamp }]
      return next.length > 300 ? next.slice(next.length - 300) : next
    })
  }

  const scrollLogToBottom = (): void => {
    const el = eventsContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    window.requestAnimationFrame(() => {
      const next = eventsContainerRef.current
      if (!next) return
      next.scrollTop = next.scrollHeight
      stickToBottomRef.current = true
    })
  }

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return
    scrollLogToBottom()
  }, [events, status])

  useEffect(() => {
    if (!id) {
      navigate('/sessions', { replace: true })
      return
    }
    let active = true

    const explicitRerun = typeof state?.rerunToken === 'number'
    if (state?.retry || explicitRerun) {
      startedSessionRef.current = null
      activeRunIdRef.current = null
      terminalStatusRef.current = null
      currentStageRef.current = 'preflight'
      lastProgressLogRef.current = null
      shouldAutoScrollRef.current = true
      stickToBottomRef.current = true
      window.setTimeout(() => {
        setStatus('running')
        setProgress(0)
        setError(null)
        setPauseFailure(null)
        setPauseTechnicalDetail(null)
        setPendingPageCount(0)
        setCancelPending(false)
        setCurrentStage('preflight')
        setEvents([{ text: t('generating.created'), time: new Date().toISOString() }])
      }, 0)
    }

    const applyChunk = (event: GenerateChunkEvent, options?: { replay?: boolean }): void => {
      if (import.meta.env.DEV) {
        console.debug('[generate:chunk] received', event)
      }
      if (event.payload.sessionId && event.payload.sessionId !== id) return
      const incomingRunId = event.payload.runId
      if (activeRunIdRef.current && incomingRunId && incomingRunId !== activeRunIdRef.current)
        return
      if (!options?.replay && !activeRunIdRef.current && incomingRunId) {
        activeRunIdRef.current = incomingRunId
      }
      const applyProgress = (
        next: number | undefined,
        options?: { allowTerminal?: boolean }
      ): void => {
        const hardMax = options?.allowTerminal ? 100 : 90
        const value = Math.max(0, Math.min(hardMax, Math.round(next ?? 0)))
        setProgress((prev) => Math.max(prev, value))
      }
      const applyTotalPages = (next: number | undefined): void => {
        if (!Number.isFinite(next)) return
        const pages = Math.max(1, Math.floor(next as number))
        setTotalPages((prev) => Math.max(prev, pages))
        setPreviewPages((prev) => buildPagePlaceholders(Math.max(prev.length, pages), lang, prev))
      }
      if (event.type === 'stage_started' || event.type === 'stage_progress') {
        applyProgress(event.payload.progress)
        applyTotalPages(event.payload.totalPages)
        const prevStage = currentStageRef.current
        const stageChanged = event.payload.stage && event.payload.stage !== prevStage
        if (event.payload.stage) {
          currentStageRef.current = event.payload.stage
          setCurrentStage(event.payload.stage)
        }
        const now = Date.now()
        const previousLog = lastProgressLogRef.current
        const progressValue = Math.round(event.payload.progress ?? 0)
        const shouldLogProgress =
          stageChanged ||
          event.type === 'stage_started' ||
          !previousLog ||
          progressValue - previousLog.progress >= 6 ||
          now - previousLog.time >= 8000
        if (shouldLogProgress) {
          lastProgressLogRef.current = {
            stage: event.payload.stage || currentStageRef.current,
            progress: progressValue,
            time: now
          }
          appendEvent(
            progressLine({
              label: event.payload.label
            }),
            event.payload.timestamp
          )
        }
        return
      }

      if (event.type === 'llm_status') {
        applyProgress(event.payload.progress)
        applyTotalPages(event.payload.totalPages)

        // Track stage changes (compare before updating)
        const prevStage = currentStageRef.current
        const stageChanged = event.payload.stage && event.payload.stage !== prevStage
        if (event.payload.stage) {
          currentStageRef.current = event.payload.stage
          setCurrentStage(event.payload.stage)
        }

        // Parse page completion count from detail
        const detail = event.payload.detail || ''
        const failureProgress = isFailureProgress(event.payload.label, detail)
        const friendlyDetail = failureProgress
          ? friendlyFailureProgressDetail(lang, detail)
          : friendlyProgressDetail(detail, lang)
        const pageMatch = detail.match(/(\d+)\/(\d+)\s*(页|pages?)/)

        // Filter: only append meaningful events to log
        const hasPageCompletion = Boolean(pageMatch)
        const now = Date.now()
        const previousLog = lastProgressLogRef.current
        const progressValue = Math.round(event.payload.progress ?? 0)
        const progressMoved =
          !previousLog ||
          progressValue - previousLog.progress >= 6 ||
          (event.payload.stage || currentStageRef.current) !== previousLog.stage
        const progressTimedOut = !previousLog || now - previousLog.time >= 8000
        const isValidationOrError =
          Boolean(friendlyDetail) ||
          detail.includes('校验') ||
          detail.includes('validat') ||
          detail.includes('失败') ||
          detail.includes('fail') ||
          detail.includes('重试') ||
          detail.includes('retry') ||
          detail.includes('准备完成') ||
          detail.includes('ready')
        const isRetryLabel =
          event.payload.label?.includes('重试') || event.payload.label?.includes('retry')
        const friendlyLabel = friendlyProgressLabel(event.payload.label, detail, lang)

        if (
          stageChanged ||
          hasPageCompletion ||
          isValidationOrError ||
          isRetryLabel ||
          progressMoved ||
          progressTimedOut
        ) {
          lastProgressLogRef.current = {
            stage: event.payload.stage || currentStageRef.current,
            progress: progressValue,
            time: now
          }
          appendEvent(
            progressLine({
              label: friendlyLabel,
              detail: friendlyDetail
            }),
            event.payload.timestamp
          )
        }
        return
      }

      if (event.type === 'page_generated' || event.type === 'page_updated') {
        applyProgress(event.payload.progress)
        applyTotalPages(Math.max(event.payload.totalPages ?? 0, event.payload.pageNumber))
        setPreviewPages((prev) =>
          mergePreviewPage(
            prev,
            {
              id: event.payload.id || event.payload.pageId || `page-${event.payload.pageNumber}`,
              pageNumber: event.payload.pageNumber,
              title: event.payload.title,
              htmlPath: event.payload.htmlPath,
              pageId: event.payload.pageId || `page-${event.payload.pageNumber}`,
              sourceUrl: event.payload.sourceUrl,
              status: 'completed'
            },
            Math.max(prev.length, event.payload.totalPages || event.payload.pageNumber),
            lang
          )
        )
        appendEvent(
          `${event.payload.label} · ${t('generating.pageDetail', { pageNumber: event.payload.pageNumber, title: event.payload.title })}`,
          event.payload.timestamp
        )
        return
      }

      if (event.type === 'assistant_message') {
        return
      }

      if (
        event.type === 'page_planned' ||
        event.type === 'page_started' ||
        event.type === 'page_failed'
      ) {
        applyProgress(event.payload.progress)
        applyTotalPages(Math.max(event.payload.totalPages ?? 0, event.payload.pageNumber))
        setPreviewPages((prev) =>
          updatePreviewPageStatus(
            prev,
            {
              id: event.payload.id || event.payload.pageId || `page-${event.payload.pageNumber}`,
              pageNumber: event.payload.pageNumber,
              title: event.payload.title,
              htmlPath: event.payload.htmlPath,
              pageId: event.payload.pageId || `page-${event.payload.pageNumber}`,
              status:
                event.type === 'page_planned'
                  ? 'pending'
                  : event.type === 'page_started'
                    ? 'generating'
                    : 'failed'
            },
            Math.max(prev.length, event.payload.totalPages || event.payload.pageNumber),
            lang
          )
        )
        if (event.type === 'page_failed') {
          appendEvent(
            progressLine({
              label: friendlyText(lang, '页面生成失败', 'Page generation failed'),
              detail: event.payload.title
            }),
            event.payload.timestamp
          )
        }
        return
      }

      if (event.type === 'run_completed') {
        if (!active) return
        terminalStatusRef.current = 'completed'
        setStatus('completed')
        applyProgress(100, { allowTerminal: true })
        applyTotalPages(event.payload.totalPages)
        appendEvent(t('generating.completed'), event.payload.timestamp)
        if (options?.replay) return
        window.setTimeout(() => {
          if (!active) return
          navigate(`/sessions/${id}`)
        }, 850)
        return
      }

      if (event.type === 'run_paused') {
        if (!active) return
        terminalStatusRef.current = 'paused'
        setStatus('paused')
        setError(event.payload.message)
        setPauseFailure(event.payload.failure)
        setPauseTechnicalDetail(
          [
            `Error code: ${event.payload.failure.code}`,
            `Provider: ${event.payload.provider || '-'}`,
            `Model: ${event.payload.model || '-'}`,
            `Occurrences: ${event.payload.occurrences}`,
            `Original error: ${event.payload.failure.technicalDetail}`
          ].join('\n')
        )
        setPendingPageCount(event.payload.pendingPageCount)
        appendEvent(
          friendlyText(
            lang,
            `生成已暂停 · ${event.payload.failure.titleZh}`,
            `Generation paused · ${event.payload.failure.code}`
          ),
          event.payload.timestamp
        )
        void ipc
          .getSession(id)
          .then(({ session, generatedPages }) => {
            if (!active) return
            const snapshot = session as GenerationSessionSnapshot | null
            setPresentationTitle(String(snapshot?.title || ''))
            setSlideSize(trySessionSlideSize(snapshot))
            setEditorGate(getEditorGate(snapshot))
            setHasRetryablePages(generatedPages.length > 0)
            setPreviewPages(
              buildPreviewPagesFromGeneratedPages(
                typeof snapshot?.page_count === 'number' ? snapshot.page_count : 0,
                generatedPages,
                lang
              )
            )
          })
          .catch(() => {})
        return
      }

      if (event.type === 'run_error') {
        if (options?.replay && state?.retry) return
        if (!active) return
        const wasCancelled = isCancellationMessage(event.payload.message)
        terminalStatusRef.current = 'failed'
        setStatus(wasCancelled ? 'cancelled' : 'failed')
        setError(friendlyFailureMessage(event.payload.message, lang))
        appendEvent(t('generating.failedRetryOrBack'), event.payload.timestamp)
        void ipc
          .getSession(id)
          .then(({ session, generatedPages }) => {
            if (!active) return
            const snapshot = session as GenerationSessionSnapshot | null
            setPresentationTitle(String(snapshot?.title || ''))
            setSlideSize(trySessionSlideSize(snapshot))
            setEditorGate(getEditorGate(snapshot))
            setHasRetryablePages(generatedPages.length > 0)
            setPreviewPages(
              buildPreviewPagesFromGeneratedPages(
                typeof snapshot?.page_count === 'number' ? snapshot.page_count : 0,
                generatedPages,
                lang
              )
            )
          })
          .catch(() => {})
      }
    }

    const unsubscribe = ipc.onGenerateChunk((event) => applyChunk(event))

    const startRun = async (promptOverride?: string): Promise<void> => {
      const resolvedModelConfigId = await ensureModelActive(
        state?.modelConfigId || selectedModelConfigId
      )
      if (!active || !resolvedModelConfigId) return
      const runKey = `${id}:${generationKind}:${state?.retry ? 'retry' : 'generate'}:${state?.rerunToken ?? 'initial'}:${resolvedModelConfigId}`
      if (startedSessionRef.current === runKey) return
      startedSessionRef.current = runKey
      setStatus('running')
      setError(null)
      setPauseFailure(null)
      setPauseTechnicalDetail(null)
      setPendingPageCount(0)
      terminalStatusRef.current = null
      // 路由 state 优先；重启/取消后从会话元数据恢复模板初始大纲。
      const manualPrompt = (promptOverride ?? state?.initialPrompt ?? '').trim()
      const runPrompt = manualPrompt || NEUTRAL_GENERATION_PROMPT
      if (import.meta.env.DEV) {
        console.info('[generate:start] request', {
          sessionId: id,
          generationKind,
          retry: Boolean(state?.retry),
          hasInitialPrompt: Boolean(manualPrompt),
          modelConfigId: resolvedModelConfigId
        })
      }
      const request = state?.retry
        ? generationKind === 'template'
          ? ipc.startTemplateGenerate({
              sessionId: id,
              modelConfigId: resolvedModelConfigId,
              userMessage: manualPrompt,
              type: 'deck',
              retry: true,
              animationPreferences: state?.animationPreferences || undefined
            })
          : ipc.retryFailedPages({
              sessionId: id,
              modelConfigId: resolvedModelConfigId,
              userMessage: manualPrompt || undefined,
              failedRunId: state.failedRunId
            })
        : generationKind === 'template'
          ? ipc.startTemplateGenerate({
              sessionId: id,
              modelConfigId: resolvedModelConfigId,
              userMessage: runPrompt,
              type: 'deck',
              animationPreferences: state?.animationPreferences || undefined
            })
          : ipc.startGenerate({
              sessionId: id,
              modelConfigId: resolvedModelConfigId,
              userMessage: runPrompt,
              type: 'deck',
              animationPreferences: state?.animationPreferences || undefined
            })
      void request
        .then((result) => {
          if (result?.runId) {
            activeRunIdRef.current = result.runId
          }
          if (result?.alreadyRunning) {
            appendEvent(t('generating.stillRunning'), new Date().toISOString())
            return
          }
          if (import.meta.env.DEV) {
            console.info('[generate:start] promise resolved', { sessionId: id })
          }
          if (!active || terminalStatusRef.current) return
          if (result?.queued) {
            setStatus('queued')
            appendEvent(t('generating.queued'), new Date().toISOString())
            return
          }
          appendEvent(t('generating.started'), new Date().toISOString())
        })
        .catch((e) => {
          if (import.meta.env.DEV) {
            console.error('[generate:start] promise rejected', {
              sessionId: id,
              message: e instanceof Error ? e.message : String(e)
            })
          }
          if (!active) return
          const rawMessage = e instanceof Error ? e.message : t('generating.failed')
          const message = friendlyFailureMessage(rawMessage, lang)
          appendEvent(t('generating.failedRetryOrBack'), new Date().toISOString())
          setStatus('failed')
          setError(message)
          void ipc
            .getSession(id)
            .then(({ session, generatedPages }) => {
              if (!active) return
              const snapshot = session as GenerationSessionSnapshot | null
              setPresentationTitle(String(snapshot?.title || ''))
              setSlideSize(trySessionSlideSize(snapshot))
              setEditorGate(getEditorGate(snapshot))
              setHasRetryablePages(generatedPages.length > 0)
              setPreviewPages(
                buildPreviewPagesFromGeneratedPages(
                  typeof snapshot?.page_count === 'number' ? snapshot.page_count : 0,
                  generatedPages,
                  lang
                )
              )
            })
            .catch(() => {})
        })
    }

    void Promise.all([ipc.getSession(id), ipc.getGenerateState(id).catch(() => null)])
      .then(([sessionResult, runState]) => {
        if (!active) return
        const { session, generatedPages } = sessionResult
        const snapshot = (session || {}) as GenerationSessionSnapshot
        const currentStatus = snapshot.status || 'active'
        const snapshotGate = getEditorGate(snapshot)
        const fullyGenerated = isSessionFullyGenerated(snapshotGate)
        setPresentationTitle(String(snapshot.title || ''))
        setSlideSize(trySessionSlideSize(snapshot))
        setEditorGate(snapshotGate)
        setHasRetryablePages(generatedPages.length > 0)
        if (typeof snapshot.page_count === 'number' && snapshot.page_count > 0) {
          setTotalPages(Math.floor(snapshot.page_count))
        }
        setPreviewPages(
          buildPreviewPagesFromGeneratedPages(
            typeof snapshot.page_count === 'number' ? snapshot.page_count : 0,
            generatedPages,
            lang
          )
        )

        // 路由 state 没带大纲时（重启/取消后从会话列表重进），用创建时持久化的
        // 模板初始大纲恢复手动开始意图，避免“没有生成入口”的死局。
        const templateInitialPrompt =
          generationKind === 'template'
            ? parseSessionMetadata(snapshot.metadata).templateInitialPrompt?.trim() || ''
            : ''
        const hasManualStartIntent = Boolean(
          state?.retry ||
            explicitRerun ||
            (state?.initialPrompt && state.initialPrompt.trim().length > 0) ||
            templateInitialPrompt
        )

        if (fullyGenerated && !state?.retry && !explicitRerun && !runState?.hasActiveRun) {
          // 用户带着初始大纲/指令进入时必须启动生成，即使页面快照看起来“已完成”
          // （模板会话在首次生成前就带有已落盘的模板页）。
          if (!hasManualStartIntent) {
            navigate(`/sessions/${id}`, { replace: true })
            return
          }
        }

        if (runState) {
          const shouldHydrateFromSnapshot = !hasManualStartIntent || runState.hasActiveRun

          if (runState.hasActiveRun && runState.runId) {
            activeRunIdRef.current = runState.runId
          }
          if (
            shouldHydrateFromSnapshot &&
            typeof runState.totalPages === 'number' &&
            runState.totalPages > 0
          ) {
            setTotalPages((prev) => Math.max(prev, Math.floor(runState.totalPages)))
          }
          if (
            shouldHydrateFromSnapshot &&
            typeof runState.progress === 'number' &&
            runState.progress > 0
          ) {
            const safeProgress =
              runState.status === 'completed'
                ? Math.min(100, Math.floor(runState.progress))
                : Math.min(90, Math.floor(runState.progress))
            setProgress((prev) => Math.max(prev, safeProgress))
          }
          if (
            shouldHydrateFromSnapshot &&
            (runState.status === 'paused' ||
              runState.status === 'failed' ||
              runState.status === 'cancelled') &&
            runState.error
          ) {
            setError(friendlyFailureMessage(runState.error, lang))
          }
          if (
            shouldHydrateFromSnapshot &&
            Array.isArray(runState.events) &&
            runState.events.length > 0
          ) {
            for (const event of runState.events) {
              applyChunk(event, { replay: true })
            }
          }
          if (runState.status === 'completed' && !state?.retry && !explicitRerun) {
            navigate(`/sessions/${id}`, { replace: true })
            return
          }
          if (
            (runState.status === 'paused' ||
              runState.status === 'failed' ||
              runState.status === 'cancelled') &&
            !state?.retry &&
            !explicitRerun
          ) {
            setStatus(runState.status)
            setError(
              runState.error
                ? runState.status === 'paused'
                  ? runState.error
                  : friendlyFailureMessage(runState.error, lang)
                : t('generating.previousFailed')
            )
            appendEvent(
              runState.status === 'paused'
                ? friendlyText(
                    lang,
                    '已保留成功页面，可继续生成剩余页。',
                    'Completed pages were kept. You can continue the remaining pages.'
                  )
                : t('generating.keptFailed'),
              new Date().toISOString()
            )
            return
          }
          if (runState.hasActiveRun) {
            setStatus(runState.status === 'queued' ? 'queued' : 'running')
            appendEvent(
              runState.status === 'queued' ? t('generating.queued') : t('generating.resumed'),
              new Date().toISOString()
            )
            return
          }
        }

        if (fullyGenerated && !state?.retry && !explicitRerun && !hasManualStartIntent) {
          navigate(`/sessions/${id}`, { replace: true })
          return
        }
        if (
          currentStatus === 'completed' &&
          !state?.retry &&
          !explicitRerun &&
          !hasManualStartIntent
        ) {
          navigate(`/sessions/${id}`, { replace: true })
          return
        }
        if (!fullyGenerated && !hasManualStartIntent) {
          setStatus('failed')
          if (snapshotGate.generatedCount > 0) {
            setError(
              t('generating.incompleteSome', {
                generated: snapshotGate.generatedCount,
                total: snapshotGate.totalCount
              })
            )
            appendEvent(t('generating.continueRemainingEvent'), new Date().toISOString())
          } else {
            setError(t('generating.incompleteNone', { total: snapshotGate.totalCount }))
            appendEvent(t('generating.noValidPagesEvent'), new Date().toISOString())
          }
          return
        }
        if (
          currentStatus === 'failed' &&
          !state?.retry &&
          !explicitRerun &&
          !hasManualStartIntent
        ) {
          setStatus('failed')
          setError(t('generating.previousFailed'))
          appendEvent(t('generating.keptFailed'), new Date().toISOString())
          return
        }
        void startRun(state?.initialPrompt?.trim() || templateInitialPrompt || undefined)
      })
      .catch(() => {
        void startRun()
      })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [
    id,
    navigate,
    location.key,
    generationKind,
    state?.initialPrompt,
    state?.modelConfigId,
    state?.retry,
    state?.rerunToken,
    state?.animationPreferences,
    state?.failedRunId,
    ensureModelActive,
    selectedModelConfigId,
    lang,
    t
  ])

  useEffect(() => {
    if (status !== 'queued' && status !== 'running') {
      setCancelPending(false)
    }
  }, [status])

  const displayProgress = Math.max(0, Math.min(100, Math.round(progress)))
  const fullyGenerated = isSessionFullyGenerated(editorGate)
  const canEnterEditor = getEditorGate(
    { page_count: editorGate.totalCount, generatedCount: editorGate.generatedCount },
    0.68
  ).canEdit
  const showProgressEditorShortcut = canEnterEditor && !state?.retry
  const completedPreviewCount = previewPages.filter((page) => page.status === 'completed').length
  const failedPreviewLabels = previewPages
    .filter((page) => page.status === 'failed')
    .map((page) => `P${page.pageNumber}`)
  const failedPageSummary =
    failedPreviewLabels.length > 0
      ? friendlyText(
          lang,
          `${failedPreviewLabels.join('、')} 失败`,
          `${failedPreviewLabels.join(', ')} failed`
        )
      : null
  const failureMessage =
    failedPageSummary ||
    (error && /部分页面生成失败|some pages failed|pages failed/i.test(error)
      ? t('generating.failedRetry')
      : error || t('generating.failedRetry'))
  const canContinueRemaining = hasRetryablePages && !fullyGenerated
  const displayedTotalPages = Math.max(totalPages, previewPages.length)
  const generationStages = [
    'preflight',
    'planning',
    'rendering',
    'validation'
  ] as const satisfies readonly GenerationStageKey[]
  const stageLabels: Record<GenerationStageKey, string> = {
    preflight: t('generating.stages.preflight'),
    planning: t('generating.stages.planning'),
    rendering: t('generating.stages.rendering'),
    validation: t('generating.stages.validation')
  }
  const handleContinueRemaining = (modelConfigId: string): void => {
    if (!id) return
    navigate(generatingPath, {
      replace: true,
      state: {
        modelConfigId,
        retry: true,
        failedRunId: activeRunIdRef.current || undefined,
        rerunToken: Date.now()
      }
    })
  }
  const handleRegenerate = (modelConfigId: string): void => {
    if (!id) return
    navigate(generatingPath, {
      replace: true,
      state: {
        initialPrompt: state?.initialPrompt,
        modelConfigId,
        retry: false,
        animationPreferences: state?.animationPreferences || undefined,
        rerunToken: Date.now()
      }
    })
  }
  const handleCancelGeneration = (): void => {
    if (!id || cancelPending || (status !== 'queued' && status !== 'running')) return
    setCancelPending(true)
    void ipc
      .cancelGenerate(id)
      .then((result) => {
        if (!result?.success) {
          setCancelPending(false)
        }
      })
      .catch(() => {
        setCancelPending(false)
      })
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--ui-selected)]">
      <style>{`
        @keyframes gen-shimmer-move { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }
        @keyframes gen-page-rise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes amy-logo-bounce { 0%, 100% { transform: translateY(0) scale(1, 1) rotate(-1deg); } 42% { transform: translateY(-22px) scale(0.96, 1.04) rotate(1deg); } 68% { transform: translateY(3px) scale(1.04, 0.96) rotate(0deg); } }
        @keyframes amy-logo-shadow { 0%, 100% { transform: translateX(-50%) scaleX(1); opacity: 0.2; } 42% { transform: translateX(-50%) scaleX(0.68); opacity: 0.09; } }
        @keyframes amy-logo-float { 0%, 100% { transform: translate3d(0, 0, 0) rotate(-3deg); } 50% { transform: translate3d(0, -14px, 0) rotate(3deg); } }
        @keyframes amy-logo-spark { 0%, 100% { transform: scale(0.72) rotate(0deg); opacity: 0.25; } 50% { transform: scale(1.18) rotate(90deg); opacity: 0.9; } }
        .amy-logo-scene { background: radial-gradient(circle at 78% 58%, rgba(245, 142, 119, 0.22), transparent 27%), linear-gradient(145deg, #fff8f0 0%, #f9eadf 52%, #f2dfd3 100%); }
        .amy-logo-stage { position: absolute; right: clamp(2rem, 8vw, 9rem); bottom: 8%; width: clamp(190px, 21vw, 320px); aspect-ratio: 1; opacity: 0.82; }
        .amy-logo-character { position: absolute; inset: 0; transform-origin: center bottom; animation: amy-logo-bounce 2.5s cubic-bezier(.45,.05,.35,1) infinite; }
        .amy-logo-character img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 20px 26px rgba(75, 48, 38, 0.16)); image-rendering: auto; }
        .amy-logo-shadow { position: absolute; left: 50%; bottom: -3%; width: 62%; height: 9%; border-radius: 50%; background: #65483d; filter: blur(11px); animation: amy-logo-shadow 2.5s cubic-bezier(.45,.05,.35,1) infinite; }
        .amy-logo-orbit { position: absolute; display: grid; gap: 14px; animation: amy-logo-float 4.8s ease-in-out infinite; opacity: 0.42; }
        .amy-logo-orbit span { display: block; width: 76px; height: 48px; border: 2px solid rgba(184, 102, 87, 0.32); border-radius: 8px; background: rgba(255, 247, 239, 0.7); box-shadow: 0 12px 28px rgba(89, 57, 45, 0.08); }
        .amy-logo-orbit span::before { content: ''; display: block; width: 46%; height: 5px; margin: 12px 10px 0; border-radius: 3px; background: rgba(245, 142, 119, 0.55); box-shadow: 0 10px 0 rgba(39, 52, 47, 0.16); }
        .amy-logo-orbit-left { left: 4%; top: 18%; transform: rotate(-8deg); }
        .amy-logo-orbit-right { right: 3%; top: 12%; transform: rotate(8deg); animation-delay: -1.4s; }
        .amy-logo-spark { position: absolute; z-index: 2; color: #e76d5c; font-size: 34px; font-weight: 700; animation: amy-logo-spark 2s ease-in-out infinite; }
        .amy-logo-spark-one { left: 2%; top: 15%; }
        .amy-logo-spark-two { right: 4%; top: 34%; animation-delay: -1s; color: #d9a82e; font-size: 25px; }
        @media (prefers-reduced-motion: reduce) { .amy-logo-character, .amy-logo-shadow, .amy-logo-orbit, .amy-logo-spark { animation: none !important; } }
      `}</style>

      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <AmyLogoMotion />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,248,240,0.82)_0%,rgba(255,248,240,0.65)_42%,rgba(255,248,240,0.34)_100%)]" />
      </div>

      <div className="app-drag-region app-titlebar relative z-20 flex items-center bg-muted/90 backdrop-blur-sm" />

      <div className="app-no-drag relative z-10 flex min-h-0 flex-1 flex-col gap-4 px-5 pb-5 pt-4 lg:flex-row">
        <GenerationSidebar
          title={presentationTitle || t('generating.title')}
          backHomeLabel={t('generating.backToSessions')}
          logTitle={friendlyText(lang, '生成日志', 'Generation log')}
          pageCountLabel={`${completedPreviewCount}/${displayedTotalPages}`}
          growingLabel={t('generating.growing')}
          failedLabel={t('generating.failed')}
          events={events}
          status={status}
          onBackHome={() => navigate('/sessions')}
          viewportRef={eventsContainerRef}
          onViewportScroll={(e) => {
            const el = e.currentTarget
            stickToBottomRef.current = isNearLogBottom(el)
            if (stickToBottomRef.current) {
              shouldAutoScrollRef.current = true
            }
          }}
        />

        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <GenerationStatusPanel
            status={status}
            progress={displayProgress}
            stages={generationStages}
            stageLabels={stageLabels}
            currentStage={currentStage}
            completedPageCount={completedPreviewCount}
            totalPages={displayedTotalPages}
            error={failureMessage}
            technicalError={pauseTechnicalDetail || pauseFailure?.technicalDetail || null}
            pendingPageCount={pendingPageCount}
            pausedLabel={friendlyText(lang, '生成已暂停', 'Generation paused')}
            pausedProgressLabel={friendlyText(lang, '已完成', 'Completed')}
            pageUnitLabel={friendlyText(lang, '页', 'pages')}
            errorDetailsLabel={friendlyText(lang, '错误详情', 'Error details')}
            reconnectLabel={friendlyText(lang, '重新连接并继续', 'Reconnect and continue')}
            interruptedLabel={t('generating.interrupted')}
            enterEditorLabel={t('generating.enterEditor')}
            continueRemainingLabel={t('generating.continueRemaining')}
            regenerateLabel={t('generating.regenerate')}
            checkSettingsLabel={friendlyText(lang, '检查模型设置', 'Check model settings')}
            cancelLabel={t('generating.cancelGeneration')}
            isCancelling={cancelPending}
            hasRetryablePages={canContinueRemaining}
            canEnterEditor={canEnterEditor}
            showEditorShortcut={showProgressEditorShortcut}
            modelAction={modelAction}
            onEnterEditor={() => navigate(`/sessions/${id}`)}
            onContinueRemaining={handleContinueRemaining}
            onRegenerate={handleRegenerate}
            onOpenSettings={() => navigate('/settings')}
            onCancel={handleCancelGeneration}
          />

          <GenerationPreviewGrid pages={previewPages} slideSize={slideSize} />
        </main>
      </div>
    </div>
  )
}
