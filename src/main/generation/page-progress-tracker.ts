/** 渲染阶段进度聚合：页级进度只增不减，整体进度由所有页聚合后映射到 10-90 区间。 */
import type { GenerateChunkEvent } from '@shared/generation'
import type { DeckToolStatusChunk } from './agent-stream-processor'
import type { PageRef } from './page-refs'

const clampProgress = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

export const resolvePageProgressFromCustomStatus = (custom: DeckToolStatusChunk): number => {
  const label = custom.label || ''
  if (/读取会话上下文|Reading session context/i.test(label)) return 25
  if (/更新\s*page-\S+|更新单页\s+\S+|Updating\s+\S+/i.test(label)) return 60
  if (/验证完成状态|Verifying completion/i.test(label)) return 85
  if (/所有页面已填充|当前页面已填充|All pages filled|Current page filled/i.test(label)) return 95
  if (/生成完成|修改完成|Generation completed|Edit completed/i.test(label)) return 100
  if (Number.isFinite(custom.progress)) {
    const raw = Number(custom.progress)
    return Math.max(12, Math.min(96, raw))
  }
  return 50
}

export type PageProgressTracker = ReturnType<typeof createPageProgressTracker>

export const createPageProgressTracker = (args: {
  runId?: string
  totalPages: number
  pageRefs: PageRef[]
  provider: string
  model: string
  emit?: (chunk: GenerateChunkEvent) => void
}) => {
  const pageProgressMap = new Map<string, number>()
  let renderingProgress = 0

  const toRenderingProgress = (target: number): number => {
    const capped = clampProgress(Math.min(90, target))
    renderingProgress = Math.max(renderingProgress, capped)
    return renderingProgress
  }

  const emitRenderingStatus = (input: {
    label: string
    detail?: string
    progress: number
  }): void => {
    args.emit?.({
      type: 'llm_status',
      payload: {
        runId: args.runId || '',
        stage: 'rendering',
        label: input.label,
        detail: input.detail,
        progress: toRenderingProgress(input.progress),
        totalPages: args.totalPages,
        provider: args.provider,
        model: args.model
      }
    })
  }

  const setPageProgress = (pageId: string, rawProgress: number): number => {
    const prev = pageProgressMap.get(pageId) ?? 0
    const bounded = Math.max(0, Math.min(100, Math.round(rawProgress)))
    const next = Math.max(prev, bounded)
    pageProgressMap.set(pageId, next)
    return next
  }

  const getCompletedPageCount = (): number =>
    args.pageRefs.reduce(
      (count, page) => count + ((pageProgressMap.get(page.pageId) ?? 0) >= 100 ? 1 : 0),
      0
    )

  const getOverallRenderProgress = (): number => {
    const sum = args.pageRefs.reduce(
      (acc, page) => acc + (pageProgressMap.get(page.pageId) ?? 0),
      0
    )
    const ratio = sum / Math.max(1, args.totalPages * 100)
    return 10 + ratio * 80
  }

  const emitPageStatus = (input: {
    pageId: string
    label: string
    detail?: string
    pageProgress: number
  }): void => {
    setPageProgress(input.pageId, input.pageProgress)
    emitRenderingStatus({
      label: input.label,
      detail: input.detail,
      progress: getOverallRenderProgress()
    })
  }

  return {
    emitRenderingStatus,
    emitPageStatus,
    setPageProgress,
    getCompletedPageCount,
    getOverallRenderProgress
  }
}
