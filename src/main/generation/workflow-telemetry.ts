/**
 * 工作流遥测：按阶段记录耗时、重试次数和关键指标。
 * 写入 generation_runs.metadata.workflowTelemetry，
 * UI 侧可用于展示"慢在哪"的耗时分解。
 */
import log from 'electron-log/main.js'

export type WorkflowStageName =
  | 'planning'
  | 'design-contract'
  | 'backgrounds'
  | 'locked-layouts'
  | 'page-images'
  | 'preflight-spec'
  | 'page-scaffold'
  | 'page-generation'
  | 'deck-quality-review'
  | 'narrative-review'
  | 'visual-review'
  | 'asset-integrity'
  | 'finalization'

export type StageAttempt = {
  sequence: number
  stage: WorkflowStageName
  status: 'passed' | 'failed'
  startedAtMs: number
  finishedAtMs: number
  durationMs: number
  retry: boolean
  metrics?: Record<string, number | string | boolean>
}

export type WorkflowTelemetry = {
  stages: Record<string, StageAttempt[]>
  totalMs: number
  startedAtMs: number
}

export function createWorkflowTelemetry(): {
  report: WorkflowTelemetry
  begin: (
    stage: WorkflowStageName,
    metrics?: Record<string, number | string | boolean>
  ) => {
    finish: (ok?: boolean, extraMetrics?: Record<string, number | string | boolean>) => void
  }
  toMetadata: () => Record<string, unknown>
  logSummary: () => void
} {
  const startedAtMs = Date.now()
  let sequence = 0
  const report: WorkflowTelemetry = {
    stages: {},
    totalMs: 0,
    startedAtMs
  }

  const begin = (
    stage: WorkflowStageName,
    metrics?: Record<string, number | string | boolean>
  ) => {
    const stageStartedAtMs = Date.now()
    const attempts = report.stages[stage] || []
    const retry = attempts.length > 0 && attempts[attempts.length - 1].status === 'failed'
    let finished = false

    return {
      finish: (
        ok = true,
        extraMetrics?: Record<string, number | string | boolean>
      ) => {
        if (finished) return
        finished = true
        const finishedAtMs = Date.now()
        sequence += 1
        attempts.push({
          sequence,
          stage,
          status: ok ? 'passed' : 'failed',
          startedAtMs: stageStartedAtMs,
          finishedAtMs,
          durationMs: Math.max(0, finishedAtMs - stageStartedAtMs),
          retry,
          metrics: { ...metrics, ...extraMetrics }
        })
        report.stages[stage] = attempts
        report.totalMs = finishedAtMs - startedAtMs

        const label = ok ? 'completed' : 'failed'
        log.info(`[telemetry] ${stage} ${label}`, {
          durationMs: attempts[attempts.length - 1].durationMs,
          retry,
          ...(metrics || {}),
          ...(extraMetrics || {})
        })
      }
    }
  }

  const toMetadata = (): Record<string, unknown> => {
    report.totalMs = Date.now() - startedAtMs
    // 只传轻量的摘要给 metadata，避免膨胀
    const stageSummaries: Record<string, { durationMs: number; attempts: number; lastStatus: string }> = {}
    for (const [stage, attempts] of Object.entries(report.stages)) {
      const total = attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
      stageSummaries[stage] = {
        durationMs: total,
        attempts: attempts.length,
        lastStatus: attempts[attempts.length - 1]?.status || 'unknown'
      }
    }
    return {
      totalMs: report.totalMs,
      stages: stageSummaries
    }
  }

  const logSummary = (): void => {
    report.totalMs = Date.now() - startedAtMs
    const lines = Object.entries(report.stages).map(([stage, attempts]) => {
      const total = attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
      const retries = attempts.filter((a) => a.retry).length
      return `  ${stage}: ${total}ms (${attempts.length} attempt${attempts.length > 1 ? 's' : ''}${retries > 0 ? `, ${retries} retry` : ''})`
    })
    log.info('[telemetry] workflow summary', {
      totalMs: report.totalMs,
      breakdown: lines.join('\n')
    })
  }

  return { report, begin, toMetadata, logSummary }
}
