import crypto from 'crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import type { AnimationPreferencesPayload } from '@shared/generation'
import * as schema from '../schema'
import type {
  GenerationPageRecord,
  GenerationPageStatus,
  GenerationRunMode,
  GenerationRunRecord,
  GenerationRunStatus,
  SessionJobKind,
  SessionJobRecord,
  SessionJobStatus,
  SessionStatus
} from '../records'

export type GenerationRunCreateData = {
  id?: string
  sessionId: string
  mode: GenerationRunMode
  totalPages: number
  metadata?: unknown
  animationPreferences?: AnimationPreferencesPayload | null
  modelConfigId?: string | null
}

export type SessionJobCreateData = {
  id: string
  sessionId: string
  kind: SessionJobKind
  status: Extract<SessionJobStatus, 'pending' | 'active'>
  previousSessionStatus: SessionStatus
  targetPageId?: string
  targetPageNumber?: number
  selector?: string
  totalPages?: number
}

export type GenerationPageCreateData = {
  pageId: string
  pageNumber: number
  title: string
  contentOutline?: string | null
  layoutIntent?: string | null
  layoutId?: string | null
  imageAssetPath?: string | null
  imageAssetPaths?: string[] | null
  htmlPath?: string | null
  status?: Extract<GenerationPageStatus, 'pending' | 'running'>
  error?: string | null
  retryCount?: number
}

export interface UpsertGenerationPageInput {
  runId: string
  sessionId: string
  pageId: string
  pageNumber: number
  title: string
  contentOutline?: string | null
  layoutIntent?: string | null
  layoutId?: string | null
  imageAssetPath?: string | null
  imageAssetPaths?: string[] | null
  htmlPath?: string | null
  status: GenerationPageStatus
  error?: string | null
  retryCount?: number
}

const normalizeGenerationRunRow = (row: Record<string, unknown>): GenerationRunRecord => {
  return {
    id: String(row.id || ''),
    session_id: String(row.sessionId ?? row.session_id ?? ''),
    mode: String(row.mode || 'generate') as GenerationRunMode,
    status: String(row.status || 'running') as GenerationRunStatus,
    total_pages: Number(row.totalPages ?? row.total_pages ?? 0) || 0,
    error: typeof row.error === 'string' ? String(row.error) : null,
    metadata: typeof row.metadata === 'string' ? String(row.metadata) : null,
    animation_preferences:
      typeof (row.animationPreferences ?? row.animation_preferences) === 'string'
        ? String(row.animationPreferences ?? row.animation_preferences)
        : null,
    model_config_id:
      typeof (row.modelConfigId ?? row.model_config_id) === 'string'
        ? String(row.modelConfigId ?? row.model_config_id)
        : null,
    created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0
  }
}

const normalizeSessionJobRow = (row: Record<string, unknown>): SessionJobRecord => {
  const status = String(row.status || 'pending')
  const kind = String(row.kind || 'standard')
  const previousSessionStatus = String(
    row.previousSessionStatus ?? row.previous_session_status ?? 'active'
  )
  return {
    id: String(row.id || ''),
    session_id: String(row.sessionId ?? row.session_id ?? ''),
    kind: (kind === 'template' ||
    kind === 'retry' ||
    kind === 'add-page' ||
    kind === 'single-page-retry' ||
    kind === 'page-edit' ||
    kind === 'deck-edit' ||
    kind === 'style-switch' ||
    kind === 'page-beautify'
      ? kind
      : 'standard') as SessionJobKind,
    previous_session_status:
      previousSessionStatus === 'completed' ||
      previousSessionStatus === 'failed' ||
      previousSessionStatus === 'archived'
        ? previousSessionStatus
        : 'active',
    target_page_id:
      typeof (row.targetPageId ?? row.target_page_id) === 'string' &&
      String(row.targetPageId ?? row.target_page_id).trim().length > 0
        ? String(row.targetPageId ?? row.target_page_id)
        : null,
    target_page_number:
      typeof (row.targetPageNumber ?? row.target_page_number) === 'number'
        ? Number(row.targetPageNumber ?? row.target_page_number)
        : null,
    selector:
      typeof row.selector === 'string' && row.selector.trim().length > 0 ? row.selector : null,
    total_pages:
      typeof (row.totalPages ?? row.total_pages) === 'number'
        ? Math.max(1, Number(row.totalPages ?? row.total_pages) || 1)
        : null,
    status: (status === 'active' || status === 'finished' || status === 'aborted'
      ? status
      : 'pending') as SessionJobStatus,
    abort_reason:
      typeof (row.abortReason ?? row.abort_reason) === 'string'
        ? String(row.abortReason ?? row.abort_reason)
        : null,
    created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
    activated_at:
      typeof (row.activatedAt ?? row.activated_at) === 'number'
        ? Number(row.activatedAt ?? row.activated_at)
        : null,
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0,
    finished_at:
      typeof (row.finishedAt ?? row.finished_at) === 'number'
        ? Number(row.finishedAt ?? row.finished_at)
        : null
  }
}

const normalizeGenerationPageRow = (row: Record<string, unknown>): GenerationPageRecord => {
  return {
    id: String(row.id || ''),
    run_id: String(row.runId ?? row.run_id ?? ''),
    session_id: String(row.sessionId ?? row.session_id ?? ''),
    page_id: String(row.pageId ?? row.page_id ?? ''),
    page_number: Number(row.pageNumber ?? row.page_number ?? 0) || 0,
    title: String(row.title || ''),
    content_outline:
      typeof (row.contentOutline ?? row.content_outline) === 'string'
        ? String(row.contentOutline ?? row.content_outline)
        : null,
    layout_intent:
      typeof (row.layoutIntent ?? row.layout_intent) === 'string'
        ? String(row.layoutIntent ?? row.layout_intent)
        : null,
    layout_id:
      typeof (row.layoutId ?? row.layout_id) === 'string'
        ? String(row.layoutId ?? row.layout_id)
        : null,
    image_asset_path:
      typeof (row.imageAssetPath ?? row.image_asset_path) === 'string'
        ? String(row.imageAssetPath ?? row.image_asset_path)
        : null,
    image_asset_paths: (() => {
      const value = row.imageAssetPaths ?? row.image_asset_paths
      if (Array.isArray(value))
        return value.filter((item): item is string => typeof item === 'string')
      if (typeof value !== 'string' || !value.trim()) return []
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string')
          : []
      } catch {
        return []
      }
    })(),
    html_path:
      typeof (row.htmlPath ?? row.html_path) === 'string'
        ? String(row.htmlPath ?? row.html_path)
        : null,
    status: String(row.status || 'pending') as GenerationPageStatus,
    error: typeof row.error === 'string' ? String(row.error) : null,
    retry_count: Number(row.retryCount ?? row.retry_count ?? 0) || 0,
    created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0
  }
}

export class GenerationRunRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async createGenerationRun(data: GenerationRunCreateData): Promise<string> {
    const id = data.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const animationPreferences = data.animationPreferences
      ? JSON.stringify(data.animationPreferences)
      : null
    await this.db
      .insert(schema.generationRuns)
      .values({
        id,
        sessionId: data.sessionId,
        mode: data.mode,
        status: 'running',
        totalPages: Math.max(0, Math.floor(data.totalPages || 0)),
        error: null,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        animationPreferences,
        modelConfigId:
          typeof data.modelConfigId === 'string' && data.modelConfigId.trim().length > 0
            ? data.modelConfigId.trim()
            : null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: schema.generationRuns.id,
        set: {
          sessionId: data.sessionId,
          mode: data.mode,
          status: 'running',
          totalPages: Math.max(0, Math.floor(data.totalPages || 0)),
          error: null,
          metadata: data.metadata ? JSON.stringify(data.metadata) : null,
          animationPreferences,
          modelConfigId:
            typeof data.modelConfigId === 'string' && data.modelConfigId.trim().length > 0
              ? data.modelConfigId.trim()
              : null,
          updatedAt: now
        }
      })
      .run()
    return id
  }

  async createGenerationRunWithSessionJob(data: {
    run: GenerationRunCreateData & { id: string }
    job: SessionJobCreateData
  }): Promise<void> {
    await this.createGenerationRunWithSessionJobAndPages({ ...data, pages: [] })
  }

  async createGenerationRunWithSessionJobAndPages(data: {
    run: GenerationRunCreateData & { id: string }
    job: SessionJobCreateData
    pages: GenerationPageCreateData[]
  }): Promise<void> {
    if (data.run.id !== data.job.id) {
      throw new Error('generation run and session job must share the same id')
    }
    if (data.run.sessionId !== data.job.sessionId) {
      throw new Error('generation run and session job must belong to the same session')
    }

    const now = Math.floor(Date.now() / 1000)
    const animationPreferences = data.run.animationPreferences
      ? JSON.stringify(data.run.animationPreferences)
      : null
    const runTotalPages = Math.max(0, Math.floor(data.run.totalPages || 0))
    const modelConfigId =
      typeof data.run.modelConfigId === 'string' && data.run.modelConfigId.trim().length > 0
        ? data.run.modelConfigId.trim()
        : null
    const jobTotalPages =
      typeof data.job.totalPages === 'number' && Number.isFinite(data.job.totalPages)
        ? Math.max(1, Math.floor(data.job.totalPages))
        : null

    await this.db.transaction(async (tx) => {
      await tx.insert(schema.generationRuns).values({
        id: data.run.id,
        sessionId: data.run.sessionId,
        mode: data.run.mode,
        status: 'running',
        totalPages: runTotalPages,
        error: null,
        metadata: data.run.metadata ? JSON.stringify(data.run.metadata) : null,
        animationPreferences,
        modelConfigId,
        createdAt: now,
        updatedAt: now
      })
      await tx.insert(schema.sessionJobs).values({
        id: data.job.id,
        sessionId: data.job.sessionId,
        kind: data.job.kind,
        previousSessionStatus: data.job.previousSessionStatus,
        targetPageId: data.job.targetPageId || null,
        targetPageNumber: data.job.targetPageNumber ?? null,
        selector: data.job.selector || null,
        totalPages: jobTotalPages,
        status: data.job.status,
        abortReason: null,
        createdAt: now,
        activatedAt: data.job.status === 'active' ? now : null,
        updatedAt: now,
        finishedAt: null
      })

      if (data.pages.length === 0) return
      await tx.insert(schema.generationPages).values(
        data.pages.map((page) => ({
          id: `${data.run.id}:${page.pageId}`,
          runId: data.run.id,
          sessionId: data.run.sessionId,
          pageId: page.pageId,
          pageNumber: Math.max(1, Math.floor(page.pageNumber)),
          title: page.title,
          contentOutline: page.contentOutline || null,
          layoutIntent: page.layoutIntent || null,
          layoutId: page.layoutId || null,
          imageAssetPath: page.imageAssetPath || null,
          imageAssetPaths: page.imageAssetPaths?.length
            ? JSON.stringify(page.imageAssetPaths)
            : null,
          htmlPath: page.htmlPath || null,
          status: page.status || 'pending',
          error: page.error || null,
          retryCount: Math.max(0, Math.floor(page.retryCount || 0)),
          createdAt: now,
          updatedAt: now
        }))
      )
    })
  }

  async updateSessionJobStatus(
    jobId: string,
    status: SessionJobStatus,
    options?: { abortReason?: string | null }
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const set: Record<string, unknown> = {
      status,
      updatedAt: now
    }
    if (status === 'active') {
      set.activatedAt = now
      set.finishedAt = null
      set.abortReason = null
    }
    if (status === 'finished') {
      set.finishedAt = now
      set.abortReason = null
    }
    if (status === 'aborted') {
      set.finishedAt = now
      set.abortReason = options?.abortReason || null
    }
    await this.db.update(schema.sessionJobs).set(set).where(eq(schema.sessionJobs.id, jobId)).run()
  }

  async getSessionJob(jobId: string): Promise<SessionJobRecord | undefined> {
    const row = await this.db
      .select()
      .from(schema.sessionJobs)
      .where(eq(schema.sessionJobs.id, jobId))
      .get()
    return row ? normalizeSessionJobRow(row as Record<string, unknown>) : undefined
  }

  async getLatestSessionJob(
    sessionId: string,
    kinds?: readonly SessionJobKind[]
  ): Promise<SessionJobRecord | undefined> {
    const where =
      kinds && kinds.length > 0
        ? and(
            eq(schema.sessionJobs.sessionId, sessionId),
            inArray(schema.sessionJobs.kind, [...kinds])
          )
        : eq(schema.sessionJobs.sessionId, sessionId)
    const row = await this.db
      .select()
      .from(schema.sessionJobs)
      .where(where)
      .orderBy(desc(schema.sessionJobs.updatedAt), desc(schema.sessionJobs.createdAt))
      .limit(1)
      .get()
    return row ? normalizeSessionJobRow(row as Record<string, unknown>) : undefined
  }

  async listActiveSessionJobs(kinds?: readonly SessionJobKind[]): Promise<SessionJobRecord[]> {
    const where =
      kinds && kinds.length > 0
        ? and(
            inArray(schema.sessionJobs.status, ['pending', 'active']),
            inArray(schema.sessionJobs.kind, [...kinds])
          )
        : inArray(schema.sessionJobs.status, ['pending', 'active'])
    const rows = await this.db
      .select()
      .from(schema.sessionJobs)
      .where(where)
      .orderBy(asc(schema.sessionJobs.createdAt))
      .all()
    return rows.map((row) => normalizeSessionJobRow(row as Record<string, unknown>))
  }

  async updateGenerationRunStatus(
    runId: string,
    status: GenerationRunStatus,
    error?: string | null
  ): Promise<void> {
    await this.db
      .update(schema.generationRuns)
      .set({
        status,
        error: error || null,
        updatedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.generationRuns.id, runId))
      .run()
  }

  async updateGenerationRunMetadata(runId: string, metadata: unknown): Promise<void> {
    await this.db
      .update(schema.generationRuns)
      .set({
        metadata: metadata ? JSON.stringify(metadata) : null,
        updatedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.generationRuns.id, runId))
      .run()
  }

  async getGenerationRun(runId: string): Promise<GenerationRunRecord | undefined> {
    const row = await this.db
      .select()
      .from(schema.generationRuns)
      .where(eq(schema.generationRuns.id, runId))
      .get()
    return row ? normalizeGenerationRunRow(row as Record<string, unknown>) : undefined
  }

  async getLatestGenerationRun(sessionId: string): Promise<GenerationRunRecord | undefined> {
    const row = await this.db
      .select()
      .from(schema.generationRuns)
      .where(eq(schema.generationRuns.sessionId, sessionId))
      .orderBy(desc(schema.generationRuns.createdAt))
      .limit(1)
      .get()
    return row ? normalizeGenerationRunRow(row as Record<string, unknown>) : undefined
  }

  async upsertGenerationPage(data: UpsertGenerationPageInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const id = `${data.runId}:${data.pageId}`
    const values = {
      id,
      runId: data.runId,
      sessionId: data.sessionId,
      pageId: data.pageId,
      pageNumber: data.pageNumber,
      title: data.title,
      contentOutline: data.contentOutline || null,
      layoutIntent: data.layoutIntent || null,
      layoutId: data.layoutId || null,
      imageAssetPath: data.imageAssetPath || null,
      imageAssetPaths: data.imageAssetPaths?.length ? JSON.stringify(data.imageAssetPaths) : null,
      htmlPath: data.htmlPath || null,
      status: data.status,
      error: data.error || null,
      retryCount: Math.max(0, Math.floor(data.retryCount || 0)),
      createdAt: now,
      updatedAt: now
    }
    await this.db
      .insert(schema.generationPages)
      .values(values)
      .onConflictDoUpdate({
        target: schema.generationPages.id,
        set: {
          pageNumber: values.pageNumber,
          title: values.title,
          contentOutline: values.contentOutline,
          layoutIntent: values.layoutIntent,
          layoutId: values.layoutId,
          imageAssetPath: values.imageAssetPath,
          imageAssetPaths: values.imageAssetPaths,
          htmlPath: values.htmlPath,
          status: values.status,
          error: values.error,
          retryCount: values.retryCount,
          updatedAt: now
        }
      })
      .run()
  }

  async listGenerationPages(runId: string): Promise<GenerationPageRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.generationPages)
      .where(eq(schema.generationPages.runId, runId))
      .orderBy(asc(schema.generationPages.pageNumber))
      .all()
    return rows.map((row) => normalizeGenerationPageRow(row as Record<string, unknown>))
  }

  async listLatestFailedGenerationPages(sessionId: string): Promise<GenerationPageRecord[]> {
    const run = await this.getLatestGenerationRun(sessionId)
    if (!run) return []
    return (await this.listGenerationPages(run.id)).filter((page) => page.status === 'failed')
  }

  async listLatestGenerationPageSnapshot(sessionId: string): Promise<GenerationPageRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.generationPages)
      .where(eq(schema.generationPages.sessionId, sessionId))
      .orderBy(desc(schema.generationPages.updatedAt), desc(schema.generationPages.createdAt))
      .all()
    const latestByPageId = new Map<string, GenerationPageRecord>()
    for (const row of rows) {
      const page = normalizeGenerationPageRow(row as Record<string, unknown>)
      if (!page.page_id || latestByPageId.has(page.page_id)) continue
      latestByPageId.set(page.page_id, page)
    }
    return Array.from(latestByPageId.values()).sort((a, b) => a.page_number - b.page_number)
  }
}
