/**
 * 会话事件日志：把关键决策记录为追加式（append-only）事件流。
 * 支持时间旅行（任意时间点的 deck 状态）、审计追踪和回放。
 *
 * 事件类型语义：
 *   planning/completed  → 规划完成，outline 确定
 *   design-contract/set → 设计契约确定
 *   page/generated      → 单页生成完成
 *   page/adjusted       → 控件面板调节（模块数/配色/重点/布局）
 *   page/edited         → AI 编辑完成
 *   page/failed         → 单页失败
 *   run/completed       → 整套完成
 *   run/paused          → 整套暂停
 *   run/failed          → 整套失败
 */

export type SessionEventType =
  | 'planning/completed'
  | 'design-contract/set'
  | 'page/generated'
  | 'page/adjusted'
  | 'page/edited'
  | 'page/failed'
  | 'run/completed'
  | 'run/paused'
  | 'run/failed'

export type SessionEventActor = 'system' | 'ai' | 'user'

export interface SessionEvent {
  id: number
  sessionId: string
  runId: string | null
  sequence: number
  eventType: SessionEventType
  payload: Record<string, unknown>
  actor: SessionEventActor
  createdAt: number
}

export interface AppendSessionEventInput {
  sessionId: string
  runId?: string | null
  eventType: SessionEventType
  payload?: Record<string, unknown>
  actor?: SessionEventActor
}

/** 序列号生成：内存缓存 per session，避免每次查库。 */
const sequenceCache = new Map<string, number>()

export function nextSequence(sessionId: string): number {
  const current = sequenceCache.get(sessionId) || 0
  const next = current + 1
  sequenceCache.set(sessionId, next)
  return next
}

/** 重置序列缓存（测试用）。 */
export function resetSequenceCache(sessionId?: string): void {
  if (sessionId) {
    sequenceCache.delete(sessionId)
  } else {
    sequenceCache.clear()
  }
}

/** 把 DB 行转为 SessionEvent。 */
export function rowToSessionEvent(row: {
  id: number
  sessionId: string
  runId: string | null
  sequence: number
  eventType: string
  payload: string
  actor: string
  createdAt: number
}): SessionEvent {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    sequence: row.sequence,
    eventType: row.eventType as SessionEventType,
    payload,
    actor: row.actor as SessionEventActor,
    createdAt: row.createdAt
  }
}

/** 把 AppendSessionEventInput 转为 DB 插入值。 */
export function toInsertValues(input: AppendSessionEventInput): {
  sessionId: string
  runId: string | null
  sequence: number
  eventType: string
  payload: string
  actor: string
  createdAt: number
} {
  return {
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    sequence: nextSequence(input.sessionId),
    eventType: input.eventType,
    payload: JSON.stringify(input.payload || {}),
    actor: input.actor || 'system',
    createdAt: Math.floor(Date.now() / 1000)
  }
}

/**
 * 回放：从事件流重建 deck 状态摘要。
 * 不重建 HTML（太重），只重建可审计的决策链。
 */
export function replaySessionSummary(events: SessionEvent[]): {
  totalRuns: number
  totalGenerations: number
  totalAdjustments: number
  totalEdits: number
  totalFailures: number
  lastEventType: SessionEventType | null
  timeline: Array<{
    sequence: number
    eventType: SessionEventType
    actor: SessionEventActor
    summary: string
    createdAt: number
  }>
} {
  const timeline = events.map((event) => ({
    sequence: event.sequence,
    eventType: event.eventType,
    actor: event.actor,
    summary: summarizeEvent(event),
    createdAt: event.createdAt
  }))

  return {
    totalRuns: events.filter((e) => e.eventType === 'run/completed').length,
    totalGenerations: events.filter((e) => e.eventType === 'page/generated').length,
    totalAdjustments: events.filter((e) => e.eventType === 'page/adjusted').length,
    totalEdits: events.filter((e) => e.eventType === 'page/edited').length,
    totalFailures: events.filter((e) => e.eventType === 'page/failed').length,
    lastEventType: events.length > 0 ? events[events.length - 1].eventType : null,
    timeline
  }
}

function summarizeEvent(event: SessionEvent): string {
  switch (event.eventType) {
    case 'planning/completed':
      return `规划 ${event.payload.totalPages || '?'} 页`
    case 'design-contract/set':
      return `设计契约：${String(event.payload.theme || '').slice(0, 30)}`
    case 'page/generated':
      return `第 ${event.payload.pageNumber || '?'} 页生成：${String(event.payload.title || '').slice(0, 20)}`
    case 'page/adjusted':
      return `第 ${event.payload.pageNumber || '?'} 页调节：${String(event.payload.adjustment || '')}`
    case 'page/edited':
      return `第 ${event.payload.pageNumber || '?'} 页编辑`
    case 'page/failed':
      return `第 ${event.payload.pageNumber || '?'} 页失败：${String(event.payload.reason || '').slice(0, 40)}`
    case 'run/completed':
      return `生成完成，${event.payload.completedPages || '?'} 页`
    case 'run/paused':
      return `生成暂停：${String(event.payload.reason || '').slice(0, 40)}`
    case 'run/failed':
      return `生成失败：${String(event.payload.reason || '').slice(0, 40)}`
    default:
      return event.eventType
  }
}
