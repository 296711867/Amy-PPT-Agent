import { ipcMain } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import * as cheerio from 'cheerio'
import type { IpcContext } from '../ipc/context'
import { resolvePageHtmlPath } from '../generation/generation-utils'
import { isCancellationMessage, normalizeRestoredSessionStatus } from '../generation/status-utils'
import {
  ensureHistoryBaselineSafe,
  recordHistoryOperationStrict
} from '../history/git-history-service'
import { replacePageContentFragment } from '../presentation/html/page-writer-core'
import type { DesignContract } from '@shared/generation'
import { resolveGlobalModelTimeouts, resolveModelConfigForTask } from '../config/model-config-utils'
import { requireSessionSlideSize, type SlideSizePreset } from '@shared/slide-size'
import { resolveLayoutSkillName } from '../product-skills/contract'
import type { ModelTimeoutProfile } from '@shared/model-timeout'
import { JobCoordinator, sessionLockKey, type JobLease } from '../agent-runtime'
import { scopeModelRuntimeToSession, type ModelRuntimeConfig } from '../agent-runtime/model'
import {
  buildLayoutRulesPrompt,
  LAYOUT_RULES_SETTING_KEY,
  normalizeLayoutRules
} from '@shared/layout-rules'
import { runPageBeautifyAgent } from './page-beautify-agent'

type FileSnapshot = {
  path: string
  exists: boolean
  content: string
}

type ActivePageBeautifyJob = {
  sessionId: string
  runId: string
  lease: JobLease
  context: PageBeautifyContext
  targetPageId: string
  targetPageNumber: number
  targetPagePath: string
}

type PageBeautifyTarget = {
  id: string
  legacyPageId: string | null
  pageId: string
  pageNumber: number
  title: string
  htmlPath: string
  contentOutline: string
  layoutIntent?: string
  visualFormat?: string
  audienceMove?: string
  layoutId?: string
}

type PageBeautifyContext = {
  sessionId: string
  previousSessionStatus: string
  runId: string
  provider: string
  apiKey: string
  model: string
  modelConfigId?: string
  runModel?: string
  providerBaseUrl: string
  maxTokens: number
  modelRuntime: ModelRuntimeConfig
  modelTimeouts: Record<ModelTimeoutProfile, number>
  projectDir: string
  projectId: string
  styleId: string
  styleSkillPrompt: string
  layoutRulesPrompt: string
  styleCase: string
  styleKey: string
  styleName: string
  styleVersion: string
  slideSize: SlideSizePreset
  layoutSkillName: ReturnType<typeof resolveLayoutSkillName>
  appLocale: 'zh' | 'en'
  userMessage: string
  layoutAudit?: string
  target: PageBeautifyTarget
  designContract?: DesignContract
}

type PageBeautifyJobSnapshot = {
  sessionId: string
  runId: string | null
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  hasActiveRun: boolean
  progress: number
  totalPages: 1
  completedPageCount: number
  failedPageCount: number
  outcome: 'changed' | 'unchanged' | null
  error: string | null
  startedAt: number | null
  updatedAt: number | null
  kind: 'page-beautify'
  targetPageId?: string
  targetPageNumber?: number
}

const BEAUTIFY_TMP_SUFFIX = '.beautify-tmp'

const buildPageBeautifyHistoryPrompt = (pageNumber: number): string => `一键美化第 ${pageNumber} 页`

const toRelativeProjectPath = (projectDir: string, filePath: string): string => {
  const relative = path.relative(projectDir, filePath).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`一键美化页面路径不在项目目录内：${filePath}`)
  }
  return relative
}

const createPageBeautifyChangeSignature = (html: string): string => {
  const $ = cheerio.load(html.replace(/<!--[\s\S]*?-->/g, ''), { scriptingEnabled: false }, false)
  $('script, style, template, noscript').remove()
  $('*').each((_, node) => {
    const el = $(node)
    for (const name of Object.keys(el.attr() || {})) {
      if (name.startsWith('data-')) el.removeAttr(name)
    }
    const className = el.attr('class')
    if (className) el.attr('class', className.split(/\s+/).filter(Boolean).sort().join(' '))
  })
  // Layout review deliberately ignores content edits. A text or number-only change
  // must not masquerade as a page redesign, but any meaningful DOM/CSS re-layout
  // remains visible in this signature.
  $('*')
    .contents()
    .filter((_, node) => node.type === 'text')
    .remove()
  return ($.root().html() || '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
}

export const hasMeaningfulPageBeautifyChange = (original: string, next: string): boolean =>
  createPageBeautifyChangeSignature(original) !== createPageBeautifyChangeSignature(next)

async function captureSnapshots(paths: readonly string[]): Promise<FileSnapshot[]> {
  return Promise.all(
    Array.from(new Set(paths)).map(async (filePath) => ({
      path: filePath,
      exists: fs.existsSync(filePath),
      content: fs.existsSync(filePath) ? await fs.promises.readFile(filePath, 'utf-8') : ''
    }))
  )
}

async function restoreSnapshots(snapshots: readonly FileSnapshot[]): Promise<void> {
  const results = await Promise.allSettled(
    snapshots.map((snapshot) =>
      snapshot.exists
        ? fs.promises.writeFile(snapshot.path, snapshot.content, 'utf-8')
        : fs.promises.rm(snapshot.path, { force: true })
    )
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}

const removeTempFile = async (tmpPath: string): Promise<void> => {
  try {
    await fs.promises.rm(tmpPath, { force: true })
  } catch (error) {
    log.warn('[page-beautify:job] failed to remove temp file', {
      tmpPath,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

// Write to a sibling .beautify-tmp file, then atomically rename into place. If the
// process dies after the rename but before git commit, the working tree carries an
// orphan change that abortInterruptedJobs will git-restore. If it dies before the
// rename, the tmp file lingers and is cleaned up by abortInterruptedJobs on restart.
async function writeTargetHtmlAtomically(targetPath: string, html: string): Promise<void> {
  const tmpPath = `${targetPath}${BEAUTIFY_TMP_SUFFIX}`
  await fs.promises.writeFile(tmpPath, html, 'utf-8')
  try {
    await fs.promises.rename(tmpPath, targetPath)
  } catch (error) {
    await removeTempFile(tmpPath)
    throw error
  }
}

const parseDesignContract = (session: Record<string, unknown>): DesignContract | undefined => {
  const raw = session.designContract
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw) as DesignContract
  } catch {
    return undefined
  }
}

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

async function resolvePageBeautifyContext(
  ctx: IpcContext,
  args: {
    sessionId: string
    selectedPageId: string
    runId: string
    modelConfigId?: string
    layoutAudit?: string
  }
): Promise<PageBeautifyContext> {
  const [
    session,
    project,
    pages,
    latestPages,
    activeModel,
    modelTimeouts,
    styleSnapshot,
    settings
  ] = await Promise.all([
    ctx.db.getSession(args.sessionId),
    ctx.db.getProject(args.sessionId),
    ctx.db.listSessionPages(args.sessionId),
    ctx.db.listLatestGenerationPageSnapshot?.(args.sessionId) ?? Promise.resolve([]),
    resolveModelConfigForTask(ctx, { modelConfigId: args.modelConfigId, purpose: 'generation' }),
    resolveGlobalModelTimeouts(ctx),
    ctx.db.getOrCreateSessionStyleSnapshot(args.sessionId),
    ctx.db.getAllSettings()
  ])
  if (!session) throw new Error('Session not found')
  if (!project) throw new Error('一键美化的页面项目不存在')
  if (!activeModel.apiKey) {
    throw new Error(`当前 provider "${activeModel.provider}" 缺少 API Key，请先到设置页配置。`)
  }

  const page = pages.find(
    (item) => item.id === args.selectedPageId || item.file_slug === args.selectedPageId
  )
  if (!page) throw new Error('一键美化的目标页面不存在')
  const latestPage = latestPages.find((item) => item.page_id === page.file_slug)
  const projectDir = await ctx.resolveSessionProjectDir(args.sessionId)
  const htmlPath = resolvePageHtmlPath({
    projectDir,
    fileSlug: page.file_slug,
    candidates: [page.html_path]
  })
  if (!fs.existsSync(htmlPath)) throw new Error('一键美化的目标页面文件不存在')

  const sessionRecord = session as unknown as Record<string, unknown>
  const styleSkillPrompt =
    styleSnapshot.styleSkill?.trim() ||
    (styleSnapshot.description
      ? `Use ${styleSnapshot.styleKey} style: ${styleSnapshot.description}`
      : `Use ${styleSnapshot.styleKey} style.`)
  const slideSize = requireSessionSlideSize(sessionRecord)

  return {
    sessionId: args.sessionId,
    previousSessionStatus: String(sessionRecord.status || 'active'),
    runId: args.runId,
    provider: activeModel.provider,
    apiKey: activeModel.apiKey,
    model: activeModel.model,
    modelConfigId: activeModel.id,
    runModel: JSON.stringify({
      modelConfigId: activeModel.id,
      name: activeModel.name,
      provider: activeModel.provider,
      model: activeModel.model,
      baseUrl: activeModel.baseUrl || undefined,
      maxTokens: activeModel.maxTokens
    }),
    providerBaseUrl: activeModel.baseUrl,
    maxTokens: activeModel.maxTokens,
    modelRuntime: scopeModelRuntimeToSession(ctx.modelRuntime, args.sessionId),
    modelTimeouts,
    projectDir,
    projectId: project.id,
    styleId: styleSnapshot.styleId,
    styleSkillPrompt,
    layoutRulesPrompt: buildLayoutRulesPrompt(
      normalizeLayoutRules(settings[LAYOUT_RULES_SETTING_KEY]),
      slideSize
    ),
    styleCase: styleSnapshot.styleCase || '',
    styleKey: styleSnapshot.styleKey,
    styleName: styleSnapshot.styleName,
    styleVersion: styleSnapshot.version,
    // The current session is the authoritative source for the canvas. The agent
    // receives these persisted dimensions in both its system prompt and task message.
    slideSize,
    layoutSkillName: resolveLayoutSkillName(slideSize),
    appLocale: settings.locale === 'en' ? 'en' : 'zh',
    userMessage: buildPageBeautifyHistoryPrompt(page.page_number),
    layoutAudit: args.layoutAudit,
    target: {
      id: page.id,
      legacyPageId: page.legacy_page_id,
      pageId: page.file_slug,
      pageNumber: page.page_number,
      title: page.title || `第${page.page_number}页`,
      htmlPath,
      contentOutline: latestPage?.content_outline || '',
      layoutIntent: latestPage?.layout_intent || undefined,
      visualFormat: latestPage?.visual_format || undefined,
      audienceMove: latestPage?.audience_move || undefined,
      layoutId: latestPage?.layout_id || undefined
    },
    designContract: parseDesignContract(sessionRecord)
  }
}

export const extractPageBeautifyContent = (html: string): string => {
  const $ = cheerio.load(html, { scriptingEnabled: false })
  const content = $('.ppt-page-root[data-ppt-guard-root="1"] .ppt-page-content').first()
  if (!content.length) throw new Error('一键美化无法读取当前页主体')
  const fragment = (content.html() || '').trim()
  if (!fragment) throw new Error('一键美化当前页主体为空')
  return fragment
}

export class PageBeautifyJobService {
  private activeJobs = new Map<string, ActivePageBeautifyJob>()
  private reservedJobIds = new Map<string, string>()

  constructor(
    private ctx: IpcContext,
    private coordinator: JobCoordinator
  ) {}

  async start(
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<{ success: boolean; runId?: string; alreadyRunning?: boolean }> {
    const input = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const selectedPageId =
      typeof input.selectedPageId === 'string' ? input.selectedPageId.trim() : ''
    const modelConfigId =
      typeof input.modelConfigId === 'string' ? input.modelConfigId.trim() || undefined : undefined
    const layoutAudit =
      typeof input.layoutAudit === 'string'
        ? input.layoutAudit.trim().slice(0, 6000) || undefined
        : undefined
    if (!sessionId) throw new Error('sessionId 不能为空')
    if (!selectedPageId) throw new Error('一键美化缺少当前页面')

    const reservation = await this.coordinator.reserve({
      jobId: crypto.randomUUID(),
      domain: 'edit',
      owner: { kind: 'session', id: sessionId },
      claims: { write: [sessionLockKey(sessionId)] },
      wait: 'fail'
    })
    if (reservation.status === 'busy') {
      return { success: true, runId: reservation.conflictingJobId, alreadyRunning: true }
    }

    const lease = reservation.lease
    this.reservedJobIds.set(sessionId, lease.jobId)
    let context: PageBeautifyContext | null = null
    let jobCreated = false

    try {
      context = await resolvePageBeautifyContext(this.ctx, {
        sessionId,
        selectedPageId,
        runId: lease.jobId,
        modelConfigId,
        layoutAudit
      })
      if (lease.signal.aborted) throw new Error('生成已取消')
      if (context.runId !== lease.jobId) {
        throw new Error('页面美化 runId 与 JobCoordinator lease 不一致')
      }
      await this.ctx.db.updateSessionStatus(sessionId, 'active')
      await this.ctx.db.createGenerationRunWithSessionJob({
        run: {
          id: context.runId,
          sessionId,
          mode: 'page-beautify',
          totalPages: 1,
          modelConfigId: context.modelConfigId,
          metadata: {
            jobType: 'page-beautify',
            targetPageId: context.target.pageId,
            targetPageNumber: context.target.pageNumber,
            targetPageTitle: context.target.title,
            styleId: context.styleId,
            designContract: context.designContract || null
          }
        },
        job: {
          id: context.runId,
          sessionId,
          kind: 'page-beautify',
          status: 'active',
          targetPageId: context.target.pageId,
          targetPageNumber: context.target.pageNumber,
          totalPages: 1,
          previousSessionStatus: normalizeRestoredSessionStatus(context.previousSessionStatus)
        }
      })
      jobCreated = true
      this.ctx.beginSessionRunState({
        sessionId,
        runId: context.runId,
        mode: 'page-beautify',
        kind: 'page-beautify',
        activityKind: 'page-beautify',
        targetPageId: context.target.pageId,
        targetPageNumber: context.target.pageNumber,
        totalPages: 1,
        previousSessionStatus: context.previousSessionStatus,
        status: 'running'
      })

      const job: ActivePageBeautifyJob = {
        sessionId,
        runId: context.runId,
        lease,
        context,
        targetPageId: context.target.pageId,
        targetPageNumber: context.target.pageNumber,
        targetPagePath: context.target.htmlPath
      }
      this.activeJobs.set(sessionId, job)
      void this.run(job)
      return { success: true, runId: context.runId }
    } catch (error) {
      if (context && jobCreated) await this.settleFailure(context, error, lease.signal.aborted)
      if (context && !jobCreated) {
        await this.ctx.db.updateSessionStatus(
          context.sessionId,
          normalizeRestoredSessionStatus(context.previousSessionStatus)
        )
      }
      this.reservedJobIds.delete(sessionId)
      lease.release()
      throw error
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    const job = this.activeJobs.get(sessionId)
    if (job) {
      return this.coordinator.cancel(job.lease.jobId)
    }
    const jobId = this.reservedJobIds.get(sessionId)
    if (!jobId) return false
    const cancelled = this.coordinator.cancel(jobId)
    if (!cancelled) return false
    try {
      const latest = await this.ctx.db.getLatestSessionJob(sessionId, ['page-beautify'])
      if (latest?.status === 'active') {
        await this.cleanupInterruptedJobFiles(sessionId, latest.target_page_id || null)
        await this.ctx.db.updateSessionJobStatus(latest.id, 'aborted', {
          abortReason: 'cancelled'
        })
        await this.ctx.db.updateGenerationRunStatus(latest.id, 'failed', '生成已取消')
        await this.ctx.db.updateSessionStatus(
          sessionId,
          normalizeRestoredSessionStatus(latest.previous_session_status)
        )
        this.ctx.emitGenerateChunk(sessionId, {
          type: 'run_error',
          payload: {
            runId: latest.id,
            message: '生成已取消',
            cancelled: true,
            activityKind: 'page-beautify'
          }
        })
        this.ctx.emitRuntimeJobTerminal({
          sessionId,
          jobId: latest.id,
          domain: 'edit',
          status: 'cancelled'
        })
      }
    } catch (error) {
      log.warn('[page-beautify:job] cancel cleanup failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    this.reservedJobIds.delete(sessionId)
    return true
  }

  async getState(sessionId: string): Promise<PageBeautifyJobSnapshot> {
    const activeState = this.ctx.sessionRunStates.get(sessionId)
    if (activeState?.activityKind === 'page-beautify') {
      return {
        sessionId,
        runId: activeState.runId,
        status: activeState.status === 'paused' ? 'failed' : activeState.status,
        hasActiveRun: activeState.status === 'queued' || activeState.status === 'running',
        progress: activeState.progress,
        totalPages: 1,
        completedPageCount: activeState.completedPageKeys.length,
        failedPageCount: activeState.failedPageKeys.length,
        outcome: null,
        error: activeState.error,
        startedAt: activeState.startedAt,
        updatedAt: activeState.updatedAt,
        kind: 'page-beautify',
        targetPageId: activeState.targetPageId,
        targetPageNumber: activeState.targetPageNumber
      }
    }

    const job = await this.ctx.db.getLatestSessionJob(sessionId, ['page-beautify'])
    if (!job) return this.idleState(sessionId)
    const run = await this.ctx.db.getGenerationRun(job.id)
    const status =
      job.status === 'active'
        ? 'running'
        : job.status === 'aborted'
          ? 'cancelled'
          : run?.status === 'completed'
            ? 'completed'
            : run?.status === 'failed' || run?.status === 'partial'
              ? 'failed'
              : 'idle'
    const runMetadata =
      typeof run?.metadata === 'string'
        ? (safeParseJson(run.metadata) as { outcome?: 'changed' | 'unchanged' } | null)
        : null
    const outcome =
      status === 'completed'
        ? runMetadata?.outcome === 'unchanged'
          ? 'unchanged'
          : 'changed'
        : null
    return {
      sessionId,
      runId: job.id,
      status,
      hasActiveRun: job.status === 'active',
      progress: status === 'completed' ? 100 : 0,
      totalPages: 1,
      completedPageCount: status === 'completed' ? 1 : 0,
      failedPageCount: status === 'failed' ? 1 : 0,
      outcome,
      error: run?.error || job.abort_reason || null,
      startedAt: job.activated_at || job.created_at,
      updatedAt: job.updated_at,
      kind: 'page-beautify',
      targetPageId: job.target_page_id || undefined,
      targetPageNumber: job.target_page_number || undefined
    }
  }

  async listActive(): Promise<PageBeautifyJobSnapshot[]> {
    const jobs = await this.ctx.db.listActiveSessionJobs(['page-beautify'])
    return Promise.all(jobs.map((job) => this.getState(job.session_id)))
  }

  async abortInterruptedJobs(reason: string): Promise<void> {
    const jobs = await this.ctx.db.listActiveSessionJobs(['page-beautify'])
    for (const job of jobs) {
      if (this.activeJobs.has(job.session_id)) continue
      await this.cleanupInterruptedJobFiles(job.session_id, job.target_page_id || null)
      await this.ctx.db.updateSessionJobStatus(job.id, 'aborted', { abortReason: reason })
      await this.ctx.db.updateGenerationRunStatus(job.id, 'failed', reason)
      await this.ctx.db.updateSessionStatus(
        job.session_id,
        normalizeRestoredSessionStatus(job.previous_session_status)
      )
    }
  }

  // Best-effort: remove any lingering .beautify-tmp file for the target page.
  // Atomic rename in run() means a tmp file only exists if we crashed before the
  // rename; the real page file is untouched in that case.
  private async cleanupInterruptedJobFiles(
    sessionId: string,
    targetPageId: string | null
  ): Promise<void> {
    if (!targetPageId) return
    try {
      const projectDir = await this.ctx.resolveSessionProjectDir(sessionId).catch(() => null)
      if (!projectDir) return
      const pages = await this.ctx.db.listSessionPages(sessionId).catch(() => [])
      const page = pages.find((item) => item.file_slug === targetPageId)
      if (!page) return
      const htmlPath = resolvePageHtmlPath({
        projectDir,
        fileSlug: page.file_slug,
        candidates: [page.html_path]
      })
      await removeTempFile(`${htmlPath}${BEAUTIFY_TMP_SUFFIX}`)
    } catch (error) {
      log.warn('[page-beautify:job] cleanupInterruptedJobFiles failed', {
        sessionId,
        targetPageId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private idleState(sessionId: string): PageBeautifyJobSnapshot {
    return {
      sessionId,
      runId: null,
      status: 'idle',
      hasActiveRun: false,
      progress: 0,
      totalPages: 1,
      completedPageCount: 0,
      failedPageCount: 0,
      outcome: null,
      error: null,
      startedAt: null,
      updatedAt: null,
      kind: 'page-beautify'
    }
  }

  private async run(job: ActivePageBeautifyJob): Promise<void> {
    let snapshots: FileSnapshot[] = []
    let tmpPath: string | null = null
    const startedAt = Date.now()
    const logPayload = {
      sessionId: job.sessionId,
      runId: job.runId,
      pageId: job.targetPageId,
      pageNumber: job.targetPageNumber
    }
    log.info('[page-beautify:job] start', logPayload)
    try {
      snapshots = await captureSnapshots([job.targetPagePath])
      const emit = this.ctx.createDeckProgressEmitter(job.sessionId, job.context.appLocale)
      const isEn = job.context.appLocale === 'en'
      emit({
        type: 'stage_started',
        payload: {
          runId: job.runId,
          stage: 'editing',
          label: isEn
            ? `Preparing to beautify page ${job.targetPageNumber}`
            : `正在准备美化第 ${job.targetPageNumber} 页`,
          progress: 5,
          totalPages: 1
        }
      })

      const originalHtml = snapshots[0]?.content
      if (originalHtml === undefined) throw new Error('一键美化无法读取当前页面')
      const originalFragment = extractPageBeautifyContent(originalHtml)
      emit({
        type: 'llm_status',
        payload: {
          runId: job.runId,
          stage: 'editing',
          label: isEn ? 'Preparing page history baseline' : '正在确认页面历史基线',
          progress: 12,
          totalPages: 1
        }
      })
      await ensureHistoryBaselineSafe(this.ctx.db, job.sessionId, job.context.projectDir)
      emit({
        type: 'llm_status',
        payload: {
          runId: job.runId,
          stage: 'editing',
          label: isEn ? 'Beautifying current page' : '正在美化当前页',
          progress: 20,
          totalPages: 1,
          provider: job.context.provider,
          model: job.context.model
        }
      })
      let persisted: ReturnType<typeof replacePageContentFragment> | null = null
      let retryFeedback: string | undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        log.info('[page-beautify:job] agent started', {
          ...logPayload,
          attempt: attempt + 1,
          provider: job.context.provider,
          model: job.context.model,
          timeoutMs: job.context.modelTimeouts.agent
        })
        const agentStartedAt = Date.now()
        const fragment = await runPageBeautifyAgent({
          provider: job.context.provider,
          apiKey: job.context.apiKey,
          model: job.context.model,
          baseUrl: job.context.providerBaseUrl,
          maxTokens: job.context.maxTokens,
          modelRuntime: job.context.modelRuntime,
          modelTimeoutMs: job.context.modelTimeouts,
          signal: job.lease.signal,
          styleName: job.context.styleName,
          styleKey: job.context.styleKey,
          styleSkillPrompt: job.context.styleSkillPrompt,
          layoutRulesPrompt: job.context.layoutRulesPrompt,
          styleCase: job.context.styleCase,
          slideSize: job.context.slideSize,
          layoutSkillName: job.context.layoutSkillName,
          designContract: job.context.designContract,
          layoutAudit: job.context.layoutAudit,
          targetPageId: job.targetPageId,
          targetPageNumber: job.targetPageNumber,
          targetHtmlPath: job.targetPagePath,
          retryFeedback,
          onProgress: (ratio) => {
            // Map agent's 0..0.82 ratio onto the 20..80 UI range so the bar keeps
            // moving during long model streams without promising completion.
            const progress = Math.max(20, Math.min(80, Math.round(20 + ratio * 73)))
            emit({
              type: 'llm_status',
              payload: {
                runId: job.runId,
                stage: 'editing',
                label: retryFeedback
                  ? isEn
                    ? 'Correcting page from validation feedback'
                    : '正在根据审核反馈修正页面'
                  : isEn
                    ? 'Beautifying current page'
                    : '正在美化当前页',
                progress,
                totalPages: 1,
                provider: job.context.provider,
                model: job.context.model
              }
            })
          }
        })
        log.info('[page-beautify:job] agent returned', {
          ...logPayload,
          attempt: attempt + 1,
          fragmentBytes: fragment.length,
          elapsedMs: Date.now() - agentStartedAt
        })
        emit({
          type: 'llm_status',
          payload: {
            runId: job.runId,
            stage: 'finalizing',
            label: isEn ? 'Validating beautified fragment' : '正在校验美化结果',
            progress: 83,
            totalPages: 1
          }
        })
        try {
          const candidate = replacePageContentFragment({
            originalHtml,
            content: fragment,
            pageId: job.targetPageId
          })
          if (
            candidate.content.trim() !== originalFragment.trim() &&
            !hasMeaningfulPageBeautifyChange(
              originalFragment,
              extractPageBeautifyContent(candidate.html)
            )
          ) {
            throw new Error(
              '未检测到有效的布局改版。不要只修改文字、数字、注释、动画或 data 属性；请重构排版并自行审查版式。'
            )
          }
          persisted = candidate
          break
        } catch (error) {
          if (job.lease.signal.aborted || attempt === 1) throw error
          retryFeedback = error instanceof Error ? error.message : String(error || '')
          log.warn('[page-beautify:job] candidate rejected, retrying with feedback', {
            ...logPayload,
            message: retryFeedback
          })
          emit({
            type: 'llm_status',
            payload: {
              runId: job.runId,
              stage: 'editing',
              label: isEn ? 'Correcting page from validation feedback' : '正在根据审核反馈修正页面',
              progress: 45,
              totalPages: 1,
              provider: job.context.provider,
              model: job.context.model
            }
          })
        }
      }
      if (!persisted) throw new Error('一键美化未通过页面审核，请重试。')
      const html = persisted.html

      // Detect "agent returned the same fragment" before touching disk. This is a
      // completed outcome per design: no rollback, no fake page_updated, but the
      // run is marked completed with outcome='unchanged' so the UI can surface it.
      const isUnchanged = persisted.content.trim() === originalFragment.trim()
      if (isUnchanged) {
        await this.settleUnchanged(job)
        log.info('[page-beautify:job] completed unchanged', {
          ...logPayload,
          elapsedMs: Date.now() - startedAt
        })
        emit({
          type: 'llm_status',
          payload: {
            runId: job.runId,
            stage: 'finalizing',
            label: isEn ? 'Page already looks good' : '当前页已是最优版本',
            progress: 100,
            totalPages: 1,
            provider: job.context.provider,
            model: job.context.model
          }
        })
        emit({
          type: 'run_completed',
          payload: {
            runId: job.runId,
            totalPages: 1,
            outcome: 'unchanged',
            activityKind: 'page-beautify',
            sessionId: job.sessionId
          }
        })
        this.ctx.emitRuntimeJobTerminal({
          sessionId: job.sessionId,
          jobId: job.runId,
          domain: 'edit',
          status: 'completed'
        })
        return
      }

      emit({
        type: 'llm_status',
        payload: {
          runId: job.runId,
          stage: 'finalizing',
          label: isEn ? 'Writing page to disk' : '正在写入页面',
          progress: 87,
          totalPages: 1
        }
      })
      tmpPath = `${job.targetPagePath}${BEAUTIFY_TMP_SUFFIX}`
      await writeTargetHtmlAtomically(job.targetPagePath, html)
      tmpPath = null
      log.info('[page-beautify:job] persisted', {
        ...logPayload,
        htmlBytes: html.length
      })

      emit({
        type: 'llm_status',
        payload: {
          runId: job.runId,
          stage: 'finalizing',
          label: isEn ? 'Committing page history' : '正在提交页面历史',
          progress: 91,
          totalPages: 1
        }
      })
      const allowedPath = toRelativeProjectPath(job.context.projectDir, job.targetPagePath)
      await recordHistoryOperationStrict(this.ctx.db, {
        sessionId: job.sessionId,
        projectDir: job.context.projectDir,
        type: 'edit',
        scope: 'page',
        prompt: job.context.userMessage,
        allowedPaths: [allowedPath],
        metadata: { runId: job.runId, jobType: 'page-beautify', pageId: job.targetPageId }
      })
      log.info('[page-beautify:job] committed', { ...logPayload, allowedPath })

      emit({
        type: 'llm_status',
        payload: {
          runId: job.runId,
          stage: 'finalizing',
          label: isEn ? 'Finalizing session records' : '正在更新会话记录',
          progress: 95,
          totalPages: 1
        }
      })
      await this.ctx.db.upsertGenerationPage({
        runId: job.runId,
        sessionId: job.sessionId,
        pageId: job.targetPageId,
        pageNumber: job.targetPageNumber,
        title: job.context.target.title,
        contentOutline: job.context.target.contentOutline,
        layoutIntent: job.context.target.layoutIntent,
        visualFormat: job.context.target.visualFormat,
        audienceMove: job.context.target.audienceMove,
        layoutId: job.context.target.layoutId,
        htmlPath: job.targetPagePath,
        status: 'completed'
      })
      await this.ctx.db.upsertSessionPage({
        id: job.context.target.id,
        sessionId: job.sessionId,
        legacyPageId:
          job.context.target.legacyPageId ||
          (job.targetPageId.match(/^page-\d+$/) ? job.targetPageId : null),
        fileSlug: job.targetPageId,
        pageNumber: job.targetPageNumber,
        title: job.context.target.title,
        htmlPath: job.targetPagePath,
        status: 'completed',
        error: null
      })
      await this.ctx.db.updateSessionMetadata(job.sessionId, {
        lastRunId: job.runId,
        entryMode: 'multi_page',
        projectId: job.context.projectId
      })
      await this.ctx.db.updateProjectStatus(job.context.projectId, 'draft')
      await this.ctx.db.updateSessionStatus(
        job.sessionId,
        normalizeRestoredSessionStatus(job.context.previousSessionStatus)
      )
      await this.ctx.db.updateGenerationRunStatus(job.runId, 'completed', null)
      await this.ctx.db.updateSessionJobStatus(job.runId, 'finished')
      log.info('[page-beautify:job] completed', {
        ...logPayload,
        outcome: 'changed',
        elapsedMs: Date.now() - startedAt
      })
      emit({
        type: 'page_updated',
        payload: {
          runId: job.runId,
          stage: 'finalizing',
          label: isEn ? 'Beautified' : '美化完成',
          progress: 100,
          currentPage: job.targetPageNumber,
          totalPages: 1,
          id: job.context.target.id,
          pageNumber: job.targetPageNumber,
          title: job.context.target.title,
          html,
          pageId: job.targetPageId,
          htmlPath: job.targetPagePath,
          sourceUrl: this.ctx.getPageSourceUrl(job.targetPagePath)
        }
      })
      emit({ type: 'run_completed', payload: { runId: job.runId, totalPages: 1 } })
      this.ctx.emitRuntimeJobTerminal({
        sessionId: job.sessionId,
        jobId: job.runId,
        domain: 'edit',
        status: 'completed'
      })
    } catch (error) {
      const cancelled =
        job.lease.signal.aborted ||
        isCancellationMessage(error instanceof Error ? error.message : String(error || ''))
      log.error('[page-beautify:job] failed', {
        ...logPayload,
        cancelled,
        message: error instanceof Error ? error.message : String(error || ''),
        elapsedMs: Date.now() - startedAt
      })
      try {
        await restoreSnapshots(snapshots)
      } catch (restoreError) {
        log.error('[page-beautify:job] failed to restore snapshots', {
          sessionId: job.sessionId,
          runId: job.runId,
          message: restoreError instanceof Error ? restoreError.message : String(restoreError || '')
        })
      }
      await this.settleFailure(job.context, error, job.lease.signal.aborted)
    } finally {
      if (tmpPath) await removeTempFile(tmpPath)
      this.activeJobs.delete(job.sessionId)
      this.reservedJobIds.delete(job.sessionId)
      job.lease.release()
    }
  }

  private async settleUnchanged(job: ActivePageBeautifyJob): Promise<void> {
    await this.ctx.db.updateGenerationRunStatus(job.runId, 'completed', null)
    await this.ctx.db
      .updateGenerationRunMetadata(job.runId, { outcome: 'unchanged' })
      .catch(() => {})
    await this.ctx.db.updateSessionStatus(
      job.sessionId,
      normalizeRestoredSessionStatus(job.context.previousSessionStatus)
    )
    await this.ctx.db.updateSessionJobStatus(job.runId, 'finished')
  }

  private async settleFailure(
    context: PageBeautifyContext,
    error: unknown,
    aborted: boolean
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error || '')
    const cancelled = aborted || isCancellationMessage(message)
    const failureMessage = cancelled ? '生成已取消' : message || '一键美化失败'
    try {
      await this.ctx.db.updateGenerationRunStatus(context.runId, 'failed', failureMessage)
      await this.ctx.db.updateSessionStatus(
        context.sessionId,
        cancelled || context.previousSessionStatus !== 'active'
          ? normalizeRestoredSessionStatus(context.previousSessionStatus)
          : 'failed'
      )
      // Cancellation is a user-initiated action; do not leave stray system messages
      // in the page chat. Real failures (guard rejection, model error, etc.) still
      // surface a message so the user can diagnose.
      if (!cancelled) {
        await this.ctx.db.addMessage(context.sessionId, {
          role: 'system',
          content: failureMessage,
          type: 'stream_chunk',
          chat_scope: 'page',
          page_id: context.target.pageId,
          run_model: context.runModel
        })
      }
    } finally {
      await this.ctx.db.updateSessionJobStatus(
        context.runId,
        cancelled ? 'aborted' : 'finished',
        cancelled ? { abortReason: 'cancelled' } : undefined
      )
    }
    this.ctx.emitGenerateChunk(context.sessionId, {
      type: 'run_error',
      payload: { runId: context.runId, message: failureMessage, cancelled }
    })
    this.ctx.emitRuntimeJobTerminal({
      sessionId: context.sessionId,
      jobId: context.runId,
      domain: 'edit',
      status: cancelled ? 'cancelled' : 'failed',
      errorCode: cancelled ? undefined : 'page_beautify_failed',
      errorMessage: cancelled ? undefined : failureMessage
    })
  }
}

export function registerPageBeautifyJobHandlers(
  ctx: IpcContext,
  coordinator: JobCoordinator
): PageBeautifyJobService {
  const service = new PageBeautifyJobService(ctx, coordinator)
  const interruptedReady = service
    .abortInterruptedJobs('应用退出导致页面美化中断，可重试')
    .catch((error) => {
      log.warn('[page-beautify:job] failed to abort interrupted jobs', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
  ipcMain.handle('page-beautify:start', async (event, payload) => {
    await interruptedReady
    return service.start(event, payload)
  })
  ipcMain.handle('page-beautify:cancel', async (_event, rawSessionId) => {
    await interruptedReady
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
    return { success: sessionId ? await service.cancel(sessionId) : true }
  })
  ipcMain.handle('page-beautify:state', async (_event, rawSessionId) => {
    await interruptedReady
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
    if (!sessionId) throw new Error('sessionId 不能为空')
    return service.getState(sessionId)
  })
  ipcMain.handle('page-beautify:listActive', async () => {
    await interruptedReady
    return service.listActive()
  })
  return service
}
