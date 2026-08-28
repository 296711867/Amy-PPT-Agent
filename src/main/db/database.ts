import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { eq, ne, gt, count, max, asc, desc, sql, and, or, isNull, inArray } from 'drizzle-orm'
import * as schema from './schema'
import {
  toInsertValues,
  rowToSessionEvent,
  type SessionEvent
} from '../generation/session-event-log'
import path from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import fs from 'fs'
import crypto from 'crypto'
import { runDatabasePatches } from './patch'
import {
  compareStyleVersion,
  listStylePackageDirectories,
  normalizeStyleVersion,
  readStylePackage,
  styleRowToPackageJson
} from '../styles'
import type {
  ModelUsageByHour,
  ModelUsagePeriod,
  ModelUsageStats,
  ModelUsageTotals
} from '@shared/model-usage'
import { requirePersistedSlideSize } from '@shared/slide-size'
import type { SlideSizePresetId } from '@shared/slide-size'
import type { HtmlThumbnailResourceType } from '@shared/thumbnail'
import {
  HtmlEditorRepository,
  type CreateHtmlEditDocumentInput,
  type CreateHtmlEditDocumentWithVersionInput,
  type CreateHtmlEditMessageInput,
  type CreateHtmlEditVersionInput
} from './repositories/html-editor-repository'
import {
  ConfigRepository,
  type UpsertImageModelConfigInput,
  type UpsertModelConfigInput
} from './repositories/config-repository'
import {
  ImageGenerationHistoryRepository,
  type InsertImageGenerationHistoryInput
} from './repositories/image-generation-history-repository'
import {
  ThumbnailRepository,
  type UpsertThumbnailRecordInput
} from './repositories/thumbnail-repository'
import {
  UserPreferenceRepository,
  type UpsertUserPreferenceInput
} from './repositories/user-preference-repository'
import {
  ProjectRepository,
  type CreateProjectInput,
  type ProjectStatus
} from './repositories/project-repository'
import {
  GenerationRunRepository,
  type GenerationPageCreateData,
  type GenerationRunCreateData,
  type SessionJobCreateData,
  type UpsertGenerationPageInput
} from './repositories/generation-run-repository'
import {
  SessionPageRepository,
  type PersistSessionPageStateInput,
  type ReplaceSourcePageSkeletonsArgs,
  type UpsertSourcePageSkeletonArgs
} from './repositories/session-page-repository'
import { SessionStyleSnapshotRepository } from './repositories/session-style-snapshot-repository'
import { SessionStyleSnapshotService } from './services/session-style-snapshot-service'
import {
  type ChatScope,
  type GenerationPageRecord,
  type GenerationRunRecord,
  type GenerationRunStatus,
  type ImageGenerationHistoryRow,
  type ImageModelConfigRow,
  type Message,
  type MessageRole,
  type MessageType,
  type ModelConfigRow,
  type ProjectRecord,
  type Session,
  type SessionJobKind,
  type SessionJobRecord,
  type SessionJobStatus,
  type SessionOperationPageRecord,
  type SessionOperationRecord,
  type SessionOperationScope,
  type SessionOperationStatus,
  type SessionOperationType,
  type SessionPageInput,
  type SessionPageRecord,
  type SessionPageStatus,
  type SessionStatus,
  type SessionStyleSnapshotInput,
  type SessionStyleSnapshotRow,
  type SessionWithPageCount,
  type SourcePageSkeletonRecord,
  type StyleRow,
  type StyleSource,
  type ThumbnailRecord,
  type UserPreferenceRecord
} from './records'
export * from './records'


interface MemorySummary {
  id: string
  session_id: string
  message_range_start: number
  message_range_end: number
  summary: string
  token_count: number | null
  created_at: number
}


export class PPTDatabase {
  private db: ReturnType<typeof drizzle>
  private client: ReturnType<typeof createClient>
  private _storagePath: string | null = null
  private _initialized = false
  private _stylesCache: StyleRow[] = []
  private htmlEditorRepository: HtmlEditorRepository
  private configRepository: ConfigRepository
  private imageGenerationHistoryRepository: ImageGenerationHistoryRepository
  private thumbnailRepository: ThumbnailRepository
  private userPreferenceRepository: UserPreferenceRepository
  private projectRepository: ProjectRepository
  private generationRunRepository: GenerationRunRepository
  private sessionPageRepository: SessionPageRepository
  private sessionStyleSnapshotRepository: SessionStyleSnapshotRepository
  private sessionStyleSnapshotService: SessionStyleSnapshotService

  constructor(dbPath?: string) {
    const defaultPath = is.dev
      ? path.join(process.cwd(), 'amy-ppt.dev.db')
      : path.join(app.getPath('userData'), 'amy-ppt.db')
    const resolvedPath = dbPath || defaultPath

    const dir = path.dirname(resolvedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const url = resolvedPath.startsWith('file:') ? resolvedPath : `file:${resolvedPath}`

    this.client = createClient({ url })
    this.db = drizzle(this.client, { schema })
    this.htmlEditorRepository = new HtmlEditorRepository(this.db)
    this.configRepository = new ConfigRepository(this.db)
    this.imageGenerationHistoryRepository = new ImageGenerationHistoryRepository(this.db)
    this.thumbnailRepository = new ThumbnailRepository(this.db)
    this.userPreferenceRepository = new UserPreferenceRepository(this.db)
    this.projectRepository = new ProjectRepository(this.db)
    this.generationRunRepository = new GenerationRunRepository(this.db)
    this.sessionPageRepository = new SessionPageRepository(this.db)
    this.sessionStyleSnapshotRepository = new SessionStyleSnapshotRepository(this.db)
    this.sessionStyleSnapshotService = new SessionStyleSnapshotService({
      repository: this.sessionStyleSnapshotRepository,
      getSession: (sessionId) => this.getSession(sessionId),
      resolveCatalogStyle: (styleId) => this.resolveSnapshotStyleRow(styleId)
    })
    this._storagePath = null
  }

  async init(): Promise<void> {
    if (this._initialized) return
    await runDatabasePatches({
      client: this.client,
      db: this.db,
      resolveStoragePath: async () =>
        (await this.getSetting<string>('storage_path').catch(() => '')) || ''
    })
    await this._refreshStylesCache()
    this._initialized = true
  }

  getStoragePath(): string {
    return this._storagePath || ''
  }

  async setStoragePath(storagePath: string): Promise<void> {
    await this.setSetting('storage_path', storagePath)
    this._storagePath = storagePath
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true })
    }
  }

  async close(): Promise<void> {
    await this.client.close()
    this._initialized = false
  }

  // ========== HTML Editor ==========

  async createHtmlEditDocument(data: CreateHtmlEditDocumentInput): Promise<void> {
    return this.htmlEditorRepository.createDocument(data)
  }

  async touchHtmlEditDocument(docId: string, updatedAt: number): Promise<void> {
    return this.htmlEditorRepository.touchDocument(docId, updatedAt)
  }

  async createHtmlEditMessage(data: CreateHtmlEditMessageInput): Promise<void> {
    return this.htmlEditorRepository.createMessage(data)
  }

  async listHtmlEditMessages(docId: string, limit = 100) {
    return this.htmlEditorRepository.listMessages(docId, limit)
  }

  async clearHtmlEditMessages(docId: string): Promise<void> {
    return this.htmlEditorRepository.clearMessages(docId)
  }

  async createHtmlEditVersion(data: CreateHtmlEditVersionInput): Promise<void> {
    return this.htmlEditorRepository.createVersion(data)
  }

  async createHtmlEditDocumentWithVersion(
    data: CreateHtmlEditDocumentWithVersionInput
  ): Promise<void> {
    return this.htmlEditorRepository.createDocumentWithVersion(data)
  }

  async createHtmlEditVersionAndTouch(data: CreateHtmlEditVersionInput): Promise<void> {
    return this.htmlEditorRepository.createVersionAndTouch(data)
  }

  async listHtmlEditVersions(docId: string) {
    return this.htmlEditorRepository.listVersions(docId)
  }

  async getHtmlEditVersion(versionId: string) {
    return this.htmlEditorRepository.getVersion(versionId)
  }

  async listHtmlEditDocuments() {
    return this.htmlEditorRepository.listDocuments()
  }

  async getHtmlEditDocument(docId: string) {
    return this.htmlEditorRepository.getDocument(docId)
  }

  /** 删除文档的数据库记录（含版本行）。不删磁盘文件——文件留存供审计/恢复。 */
  async deleteHtmlEditDocument(docId: string): Promise<void> {
    return this.htmlEditorRepository.deleteDocument(docId)
  }

  // ========== Session ==========

  async createSession(data: {
    id?: string
    title: string
    topic?: string
    styleId?: string
    styleSnapshot?: SessionStyleSnapshotInput
    pageCount?: number
    slideSizeId?: SlideSizePresetId
    slideWidth?: number
    slideHeight?: number
    referenceDocumentPath?: string | null
    provider: string
    model: string
  }): Promise<string> {
    const id = data.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    const slideSize = requirePersistedSlideSize({
      id: data.slideSizeId,
      width: data.slideWidth,
      height: data.slideHeight
    })

    await this.db
      .insert(schema.sessions)
      .values({
        id,
        title: data.title,
        topic: data.topic || null,
        styleId: data.styleId || data.styleSnapshot?.styleId || null,
        pageCount: data.pageCount || null,
        slideSizeId: slideSize.id,
        slideWidth: slideSize.width,
        slideHeight: slideSize.height,
        referenceDocumentPath: data.referenceDocumentPath || null,
        status: 'active',
        provider: data.provider,
        model: data.model,
        createdAt: now,
        updatedAt: now,
        metadata: null
      })
      .run()

    if (data.styleSnapshot) {
      await this.createCustomSessionStyleSnapshot(id, data.styleSnapshot)
    } else if (this._stylesCache.length > 0) {
      await this.createSessionStyleSnapshot(id, data.styleId)
    }

    return id
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const result = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get()
    return result as unknown as Session | undefined
  }

  async updateSessionHistoryPointer(args: {
    sessionId: string
    operationId: string | null
    commit: string | null
  }): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({
        currentOperationId: args.operationId,
        currentCommit: args.commit,
        updatedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.sessions.id, args.sessionId))
      .run()
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .update(schema.sessions)
      .set({ status, updatedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run()
  }

  async updateSessionMetadata(sessionId: string, metadata: object): Promise<void> {
    const existing = await this.db
      .select({ metadata: schema.sessions.metadata })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get()
    let previous: Record<string, unknown> = {}
    if (existing?.metadata) {
      try {
        const parsed = JSON.parse(existing.metadata) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          previous = parsed as Record<string, unknown>
        }
      } catch {
        // Preserve the new metadata when an older session contains malformed JSON.
      }
    }
    await this.db
      .update(schema.sessions)
      .set({
        metadata: JSON.stringify({ ...previous, ...metadata }),
        updatedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.sessions.id, sessionId))
      .run()
  }

  async restoreSessionMetadata(sessionId: string, metadata: string | null): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ metadata, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.sessions.id, sessionId))
      .run()
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const updatedAt = Math.floor(Date.now() / 1000)
    await this.db
      .update(schema.sessions)
      .set({ title, updatedAt })
      .where(eq(schema.sessions.id, sessionId))
      .run()
    await this.projectRepository.updateTitleForSession(sessionId, title, updatedAt)
  }

  async updateSessionStyleId(sessionId: string, styleId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .update(schema.sessions)
      .set({ styleId, updatedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run()
    if (this._stylesCache.length > 0) {
      await this.replaceSessionStyleSnapshot(sessionId, styleId)
    }
  }

  async restoreSessionStyleState(
    sessionId: string,
    styleId: string | null,
    snapshot?: SessionStyleSnapshotRow
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.sessions)
        .set({ styleId, updatedAt: now })
        .where(eq(schema.sessions.id, sessionId))
        .run()
      await tx
        .delete(schema.sessionStyleSnapshots)
        .where(eq(schema.sessionStyleSnapshots.sessionId, sessionId))
        .run()
      if (!snapshot) return
      await tx
        .insert(schema.sessionStyleSnapshots)
        .values({
          id: snapshot.id,
          sessionId,
          styleId: snapshot.styleId,
          styleKey: snapshot.styleKey,
          styleName: snapshot.styleName,
          styleNameZh: snapshot.styleNameZh,
          styleNameEn: snapshot.styleNameEn,
          description: snapshot.description,
          category: snapshot.category,
          aliases: snapshot.aliases,
          source: snapshot.source,
          version: snapshot.version,
          styleCase: snapshot.styleCase,
          packageDir: snapshot.packageDir,
          styleSkill: snapshot.styleSkill,
          createdAt: snapshot.createdAt
        })
        .run()
    })
  }

  async updateSessionDesignContract(sessionId: string, designContract: unknown): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({
        designContract: designContract ? JSON.stringify(designContract) : null,
        updatedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.sessions.id, sessionId))
      .run()
  }

  async listSessions(limit = 50, offset = 0): Promise<Session[]> {
    const results = await this.db
      .select({
        session: schema.sessions,
        totalTokens: sql<number | null>`CASE
          WHEN COUNT(${schema.modelUsageEvents.id}) = 0 THEN NULL
          ELSE COALESCE(SUM(${schema.modelUsageEvents.totalTokens}), 0)
        END`
      })
      .from(schema.sessions)
      .leftJoin(
        schema.modelUsageEvents,
        eq(schema.modelUsageEvents.sessionId, schema.sessions.id)
      )
      .where(ne(schema.sessions.status, 'archived'))
      .groupBy(schema.sessions.id)
      .orderBy(desc(schema.sessions.updatedAt))
      .limit(limit)
      .offset(offset)
      .all()

    return results.map((row) => ({
      ...(row.session as unknown as Session),
      totalTokens: row.totalTokens === null ? null : Number(row.totalTokens)
    }))
  }

  async listSessionsWithPageCounts(limit = 50, offset = 0): Promise<SessionWithPageCount[]> {
    const rows = await this.db
      .select({
        session: schema.sessions,
        pageCount: count(schema.sessionPages.id)
      })
      .from(schema.sessions)
      .leftJoin(
        schema.sessionPages,
        and(
          eq(schema.sessionPages.sessionId, schema.sessions.id),
          isNull(schema.sessionPages.deletedAt)
        )
      )
      .where(ne(schema.sessions.status, 'archived'))
      .groupBy(schema.sessions.id)
      .orderBy(desc(schema.sessions.updatedAt))
      .limit(limit)
      .offset(offset)
      .all()

    return rows.map((row) => ({
      session: row.session as unknown as Session,
      pageCount: Number(row.pageCount || 0)
    }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.sessionOperationPages)
        .where(eq(schema.sessionOperationPages.sessionId, sessionId))
        .run()
      await tx
        .delete(schema.sessionOperations)
        .where(eq(schema.sessionOperations.sessionId, sessionId))
        .run()
      await tx
        .delete(schema.sourcePageSkeletons)
        .where(eq(schema.sourcePageSkeletons.sessionId, sessionId))
        .run()
      await tx.delete(schema.sessionPages).where(eq(schema.sessionPages.sessionId, sessionId)).run()
      await tx
        .delete(schema.imageGenerationHistories)
        .where(eq(schema.imageGenerationHistories.sessionId, sessionId))
        .run()
      await tx
        .delete(schema.memorySummaries)
        .where(eq(schema.memorySummaries.sessionId, sessionId))
        .run()
      await tx.delete(schema.messages).where(eq(schema.messages.sessionId, sessionId)).run()
      await tx
        .delete(schema.generationPages)
        .where(eq(schema.generationPages.sessionId, sessionId))
        .run()
      await tx
        .delete(schema.generationRuns)
        .where(eq(schema.generationRuns.sessionId, sessionId))
        .run()
      await tx.delete(schema.projects).where(eq(schema.projects.sessionId, sessionId)).run()
      await tx.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run()
    })
  }

  // ── 会话事件日志（append-only，支持审计/回放/时间旅行） ──────

  async appendSessionEvent(data: {
    sessionId: string
    runId?: string | null
    eventType: string
    payload?: Record<string, unknown>
    actor?: string
  }): Promise<number> {
    const values = toInsertValues({
      sessionId: data.sessionId,
      runId: data.runId,
      eventType: data.eventType as never,
      payload: data.payload,
      actor: data.actor as never
    })
    const result = await this.db
      .insert(schema.sessionEvents)
      .values(values)
      .returning({ id: schema.sessionEvents.id })
    return result[0]?.id ?? 0
  }

  async listSessionEvents(
    sessionId: string,
    options: { eventType?: string; limit?: number } = {}
  ): Promise<SessionEvent[]> {
    const conditions = [eq(schema.sessionEvents.sessionId, sessionId)]
    if (options.eventType) {
      conditions.push(eq(schema.sessionEvents.eventType, options.eventType))
    }
    const rows = await this.db
      .select()
      .from(schema.sessionEvents)
      .where(and(...conditions))
      .orderBy(asc(schema.sessionEvents.sequence))
      .limit(Math.min(options.limit || 200, 1000))
    return rows.map((row) =>
      rowToSessionEvent({
        id: row.id,
        sessionId: row.sessionId,
        runId: row.runId,
        sequence: row.sequence,
        eventType: row.eventType,
        payload: row.payload,
        actor: row.actor,
        createdAt: row.createdAt
      })
    )
  }

  async getSessionEventCount(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.sessionEvents)
      .where(eq(schema.sessionEvents.sessionId, sessionId))
    return result[0]?.count ?? 0
  }

  // ========== Generation Runs / Jobs / Pages（仓库委托） ==========

  async createGenerationRun(data: GenerationRunCreateData): Promise<string> {
    return this.generationRunRepository.createGenerationRun(data)
  }

  async createGenerationRunWithSessionJob(data: {
    run: GenerationRunCreateData & { id: string }
    job: SessionJobCreateData
  }): Promise<void> {
    return this.generationRunRepository.createGenerationRunWithSessionJob(data)
  }

  async createGenerationRunWithSessionJobAndPages(data: {
    run: GenerationRunCreateData & { id: string }
    job: SessionJobCreateData
    pages: GenerationPageCreateData[]
  }): Promise<void> {
    return this.generationRunRepository.createGenerationRunWithSessionJobAndPages(data)
  }

  async updateSessionJobStatus(
    jobId: string,
    status: SessionJobStatus,
    options?: { abortReason?: string | null }
  ): Promise<void> {
    return this.generationRunRepository.updateSessionJobStatus(jobId, status, options)
  }

  async getSessionJob(jobId: string): Promise<SessionJobRecord | undefined> {
    return this.generationRunRepository.getSessionJob(jobId)
  }

  async getLatestSessionJob(
    sessionId: string,
    kinds?: readonly SessionJobKind[]
  ): Promise<SessionJobRecord | undefined> {
    return this.generationRunRepository.getLatestSessionJob(sessionId, kinds)
  }

  async listActiveSessionJobs(kinds?: readonly SessionJobKind[]): Promise<SessionJobRecord[]> {
    return this.generationRunRepository.listActiveSessionJobs(kinds)
  }

  async updateGenerationRunStatus(
    runId: string,
    status: GenerationRunStatus,
    error?: string | null
  ): Promise<void> {
    return this.generationRunRepository.updateGenerationRunStatus(runId, status, error)
  }

  async updateGenerationRunMetadata(runId: string, metadata: unknown): Promise<void> {
    return this.generationRunRepository.updateGenerationRunMetadata(runId, metadata)
  }

  async getGenerationRun(runId: string): Promise<GenerationRunRecord | undefined> {
    return this.generationRunRepository.getGenerationRun(runId)
  }

  async getLatestGenerationRun(sessionId: string): Promise<GenerationRunRecord | undefined> {
    return this.generationRunRepository.getLatestGenerationRun(sessionId)
  }

  async upsertGenerationPage(data: UpsertGenerationPageInput): Promise<void> {
    return this.generationRunRepository.upsertGenerationPage(data)
  }

  async listGenerationPages(runId: string): Promise<GenerationPageRecord[]> {
    return this.generationRunRepository.listGenerationPages(runId)
  }

  async listLatestFailedGenerationPages(sessionId: string): Promise<GenerationPageRecord[]> {
    return this.generationRunRepository.listLatestFailedGenerationPages(sessionId)
  }

  async listLatestGenerationPageSnapshot(sessionId: string): Promise<GenerationPageRecord[]> {
    return this.generationRunRepository.listLatestGenerationPageSnapshot(sessionId)
  }

  // ========== Session Pages / Source Skeletons（仓库委托） ==========

  async listSessionPages(
    sessionId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<SessionPageRecord[]> {
    return this.sessionPageRepository.listSessionPages(sessionId, options)
  }

  async replaceSourcePageSkeletons(args: ReplaceSourcePageSkeletonsArgs): Promise<void> {
    return this.sessionPageRepository.replaceSourcePageSkeletons(args)
  }

  async upsertSourcePageSkeleton(args: UpsertSourcePageSkeletonArgs): Promise<void> {
    return this.sessionPageRepository.upsertSourcePageSkeleton(args)
  }

  async deleteSourcePageSkeleton(sessionId: string, pageNumber: number): Promise<void> {
    return this.sessionPageRepository.deleteSourcePageSkeleton(sessionId, pageNumber)
  }

  async deleteSourcePageSkeletons(sessionId: string, pageNumbers: number[]): Promise<void> {
    return this.sessionPageRepository.deleteSourcePageSkeletons(sessionId, pageNumbers)
  }

  async listSourcePageSkeletons(sessionId: string): Promise<SourcePageSkeletonRecord[]> {
    return this.sessionPageRepository.listSourcePageSkeletons(sessionId)
  }

  async upsertSessionPage(page: SessionPageInput): Promise<void> {
    return this.sessionPageRepository.upsertSessionPage(page)
  }

  async replaceSessionPageOrder(
    sessionId: string,
    pages: Array<{ id: string; pageNumber: number }>
  ): Promise<void> {
    return this.sessionPageRepository.replaceSessionPageOrder(sessionId, pages)
  }

  async persistSessionPageState(data: PersistSessionPageStateInput): Promise<void> {
    return this.sessionPageRepository.persistSessionPageState(data)
  }

  async softDeleteSessionPages(sessionId: string, ids: string[]): Promise<void> {
    return this.sessionPageRepository.softDeleteSessionPages(sessionId, ids)
  }

  async hardDeleteSessionPages(sessionId: string, ids: string[]): Promise<void> {
    return this.sessionPageRepository.hardDeleteSessionPages(sessionId, ids)
  }

  // ========== Session History ==========

  private normalizeSessionOperationRow(row: Record<string, unknown>): SessionOperationRecord {
    return {
      id: String(row.id || ''),
      session_id: String(row.sessionId ?? row.session_id ?? ''),
      type: String(row.type || 'edit') as SessionOperationType,
      status: String(row.status || 'completed') as SessionOperationStatus,
      scope:
        typeof (row.scope ?? row.scope) === 'string'
          ? (String(row.scope) as SessionOperationScope)
          : null,
      prompt:
        typeof row.prompt === 'string' && row.prompt.trim().length > 0 ? String(row.prompt) : null,
      parent_operation_id:
        typeof (row.parentOperationId ?? row.parent_operation_id) === 'string'
          ? String(row.parentOperationId ?? row.parent_operation_id)
          : null,
      before_commit:
        typeof (row.beforeCommit ?? row.before_commit) === 'string'
          ? String(row.beforeCommit ?? row.before_commit)
          : null,
      after_commit:
        typeof (row.afterCommit ?? row.after_commit) === 'string'
          ? String(row.afterCommit ?? row.after_commit)
          : null,
      target_operation_id:
        typeof (row.targetOperationId ?? row.target_operation_id) === 'string'
          ? String(row.targetOperationId ?? row.target_operation_id)
          : null,
      target_commit:
        typeof (row.targetCommit ?? row.target_commit) === 'string'
          ? String(row.targetCommit ?? row.target_commit)
          : null,
      changed_files_json: String(row.changedFilesJson ?? row.changed_files_json ?? '[]'),
      changed_pages_json: String(row.changedPagesJson ?? row.changed_pages_json ?? '[]'),
      tracked_files_json: String(row.trackedFilesJson ?? row.tracked_files_json ?? '[]'),
      metadata_json: String(row.metadataJson ?? row.metadata_json ?? '{}'),
      created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
      completed_at:
        typeof (row.completedAt ?? row.completed_at) === 'number'
          ? Number(row.completedAt ?? row.completed_at)
          : null
    }
  }

  private normalizeSessionOperationPageRow(
    row: Record<string, unknown>
  ): SessionOperationPageRecord {
    return {
      id: String(row.id || ''),
      operation_id: String(row.operationId ?? row.operation_id ?? ''),
      session_id: String(row.sessionId ?? row.session_id ?? ''),
      page_id: String(row.pageId ?? row.page_id ?? ''),
      legacy_page_id:
        typeof (row.legacyPageId ?? row.legacy_page_id) === 'string'
          ? String(row.legacyPageId ?? row.legacy_page_id)
          : null,
      file_slug: String(row.fileSlug ?? row.file_slug ?? ''),
      page_number: Number(row.pageNumber ?? row.page_number ?? 0) || 0,
      title: String(row.title || ''),
      html_path: String(row.htmlPath ?? row.html_path ?? ''),
      status: String(row.status || 'pending') as SessionPageStatus,
      error: typeof row.error === 'string' ? String(row.error) : null,
      created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
      updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0
    }
  }

  async createSessionOperation(data: {
    id: string
    sessionId: string
    type: SessionOperationType
    status?: SessionOperationStatus
    scope?: SessionOperationScope | null
    prompt?: string | null
    parentOperationId?: string | null
    beforeCommit?: string | null
    targetOperationId?: string | null
    targetCommit?: string | null
    metadata?: unknown
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .insert(schema.sessionOperations)
      .values({
        id: data.id,
        sessionId: data.sessionId,
        type: data.type,
        status: data.status || 'committing',
        scope: data.scope || null,
        prompt: data.prompt || null,
        parentOperationId: data.parentOperationId || null,
        beforeCommit: data.beforeCommit || null,
        afterCommit: null,
        targetOperationId: data.targetOperationId || null,
        targetCommit: data.targetCommit || null,
        changedFilesJson: '[]',
        changedPagesJson: '[]',
        trackedFilesJson: '[]',
        metadataJson: data.metadata ? JSON.stringify(data.metadata) : '{}',
        createdAt: now,
        completedAt: null
      })
      .run()
  }

  async completeSessionOperation(data: {
    id: string
    status: 'completed' | 'noop' | 'failed'
    afterCommit?: string | null
    changedFiles?: unknown[]
    changedPages?: unknown[]
    trackedFiles?: string[]
    metadata?: unknown
  }): Promise<void> {
    await this.db
      .update(schema.sessionOperations)
      .set({
        status: data.status,
        afterCommit: data.afterCommit || null,
        changedFilesJson: JSON.stringify(data.changedFiles || []),
        changedPagesJson: JSON.stringify(data.changedPages || []),
        trackedFilesJson: JSON.stringify(data.trackedFiles || []),
        metadataJson: JSON.stringify(data.metadata || {}),
        completedAt: Math.floor(Date.now() / 1000)
      })
      .where(eq(schema.sessionOperations.id, data.id))
      .run()
  }

  async updateSessionOperationMetadata(
    operationId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.db
      .update(schema.sessionOperations)
      .set({ metadataJson: JSON.stringify(metadata) })
      .where(eq(schema.sessionOperations.id, operationId))
      .run()
  }

  async getSessionOperation(operationId: string): Promise<SessionOperationRecord | undefined> {
    const row = await this.db
      .select()
      .from(schema.sessionOperations)
      .where(eq(schema.sessionOperations.id, operationId))
      .get()
    return row ? this.normalizeSessionOperationRow(row as Record<string, unknown>) : undefined
  }

  async hasAnyOperationPageSnapshots(sessionId: string): Promise<boolean> {
    const row = await this.db
      .select({ id: schema.sessionOperationPages.id })
      .from(schema.sessionOperationPages)
      .where(eq(schema.sessionOperationPages.sessionId, sessionId))
      .limit(1)
      .get()
    return !!row
  }

  async cleanupSessionOperations(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ id: schema.sessionOperations.id })
      .from(schema.sessionOperations)
      .where(eq(schema.sessionOperations.sessionId, sessionId))
      .all()
    if (rows.length === 0) {
      await this.updateSessionHistoryPointer({ sessionId, operationId: null, commit: null })
      return 0
    }
    const ids = rows.map((r) => r.id)
    await this.db
      .delete(schema.sessionOperationPages)
      .where(inArray(schema.sessionOperationPages.operationId, ids))
      .run()
    await this.db
      .delete(schema.sessionOperations)
      .where(inArray(schema.sessionOperations.id, ids))
      .run()
    await this.updateSessionHistoryPointer({ sessionId, operationId: null, commit: null })
    return ids.length
  }

  async listSessionOperations(
    sessionId: string,
    options?: { limit?: number; includeNoop?: boolean }
  ): Promise<SessionOperationRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.sessionOperations)
      .where(eq(schema.sessionOperations.sessionId, sessionId))
      .orderBy(desc(schema.sessionOperations.createdAt))
      .limit(Math.max(1, Math.min(200, Math.floor(options?.limit || 50))))
      .all()
    return rows
      .map((row) => this.normalizeSessionOperationRow(row as Record<string, unknown>))
      .filter((row) =>
        options?.includeNoop
          ? row.status === 'completed' || row.status === 'noop'
          : row.status === 'completed'
      )
  }

  async replaceSessionOperationPages(
    operationId: string,
    sessionId: string,
    pages: Array<{
      pageId: string
      legacyPageId?: string | null
      fileSlug: string
      pageNumber: number
      title: string
      htmlPath: string
      status?: SessionPageStatus
      error?: string | null
    }>
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .delete(schema.sessionOperationPages)
      .where(eq(schema.sessionOperationPages.operationId, operationId))
      .run()
    for (const page of pages) {
      await this.db
        .insert(schema.sessionOperationPages)
        .values({
          id: `${operationId}:${page.pageId}`,
          operationId,
          sessionId,
          pageId: page.pageId,
          legacyPageId: page.legacyPageId || null,
          fileSlug: page.fileSlug,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: page.htmlPath,
          status: page.status || 'pending',
          error: page.error || null,
          createdAt: now,
          updatedAt: now
        })
        .run()
    }
  }

  async listSessionOperationPages(operationId: string): Promise<SessionOperationPageRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.sessionOperationPages)
      .where(eq(schema.sessionOperationPages.operationId, operationId))
      .orderBy(asc(schema.sessionOperationPages.pageNumber))
      .all()
    return rows.map((row) => this.normalizeSessionOperationPageRow(row as Record<string, unknown>))
  }

  // ========== Messages ==========

  async getSessionMessages(
    sessionId: string,
    options?: {
      chatScope?: ChatScope
      pageId?: string
    }
  ): Promise<Message[]> {
    const chatScope = options?.chatScope ?? 'main'
    const normalizedPageId =
      typeof options?.pageId === 'string' && options.pageId.trim().length > 0
        ? options.pageId.trim()
        : null
    if (chatScope === 'page' && !normalizedPageId) {
      return []
    }
    if (chatScope === 'page' && normalizedPageId) {
      // Rollback / page-management may switch between canonical id and fileSlug.
      // Query messages by all known aliases to keep page chat continuous.
      const aliases = new Set<string>([normalizedPageId])
      const directRows = await this.db
        .select({
          id: schema.sessionPages.id,
          fileSlug: schema.sessionPages.fileSlug,
          legacyPageId: schema.sessionPages.legacyPageId
        })
        .from(schema.sessionPages)
        .where(
          and(
            eq(schema.sessionPages.sessionId, sessionId),
            or(
              eq(schema.sessionPages.id, normalizedPageId),
              eq(schema.sessionPages.fileSlug, normalizedPageId),
              eq(schema.sessionPages.legacyPageId, normalizedPageId)
            )
          )
        )
        .all()
      const matchedSlugs = Array.from(
        new Set(
          directRows
            .map((row) => String(row.fileSlug || '').trim())
            .filter((item) => item.length > 0)
        )
      )
      if (matchedSlugs.length > 0) {
        const relatedRows = await this.db
          .select({
            id: schema.sessionPages.id,
            fileSlug: schema.sessionPages.fileSlug,
            legacyPageId: schema.sessionPages.legacyPageId
          })
          .from(schema.sessionPages)
          .where(
            and(
              eq(schema.sessionPages.sessionId, sessionId),
              inArray(schema.sessionPages.fileSlug, matchedSlugs)
            )
          )
          .all()
        for (const row of relatedRows) {
          if (typeof row.id === 'string' && row.id.trim().length > 0) aliases.add(row.id.trim())
          if (typeof row.fileSlug === 'string' && row.fileSlug.trim().length > 0)
            aliases.add(row.fileSlug.trim())
          if (typeof row.legacyPageId === 'string' && row.legacyPageId.trim().length > 0)
            aliases.add(row.legacyPageId.trim())
        }
      }
      const results = await this.db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.sessionId, sessionId),
            eq(schema.messages.chatScope, 'page'),
            inArray(schema.messages.pageId, Array.from(aliases))
          )
        )
        .orderBy(asc(schema.messages.createdAt))
        .all()
      return results.map((message) => this.normalizeMessageRow(message as Record<string, unknown>))
    }
    const whereClause = and(
      eq(schema.messages.sessionId, sessionId),
      eq(schema.messages.chatScope, 'main')
    )
    const results = await this.db
      .select()
      .from(schema.messages)
      .where(whereClause)
      .orderBy(asc(schema.messages.createdAt))
      .all()

    return results.map((message) => this.normalizeMessageRow(message as Record<string, unknown>))
  }

  private normalizeAssetPaths(value: unknown, prefix: './images/' | './videos/'): string[] | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) return null
      const valid = parsed
        .map((item) => String(item || '').trim())
        .filter((item) => item.startsWith(prefix))
        .slice(0, 10)
      return valid.length > 0 ? valid : null
    } catch {
      return null
    }
  }

  private normalizeMessageRow(message: Record<string, unknown>): Message {
    const rawImagePaths = message.imagePaths ?? message.image_paths ?? null
    const rawVideoPaths = message.videoPaths ?? message.video_paths ?? null
    const imagePaths = this.normalizeAssetPaths(rawImagePaths, './images/')
    const videoPaths = this.normalizeAssetPaths(rawVideoPaths, './videos/')
    return {
      id: String(message.id || ''),
      session_id: String(message.sessionId ?? message.session_id ?? ''),
      chat_scope: message.chatScope === 'page' || message.chat_scope === 'page' ? 'page' : 'main',
      page_id:
        typeof (message.pageId ?? message.page_id) === 'string'
          ? String(message.pageId ?? message.page_id)
          : null,
      selector:
        typeof message.selector === 'string' && message.selector.trim().length > 0
          ? message.selector.trim()
          : null,
      image_paths: imagePaths,
      video_paths: videoPaths,
      role: String(message.role || 'system') as MessageRole,
      content: String(message.content || ''),
      type: String(message.type || 'text') as MessageType,
      tool_name:
        typeof (message.toolName ?? message.tool_name) === 'string'
          ? String(message.toolName ?? message.tool_name)
          : null,
      tool_call_id:
        typeof (message.toolCallId ?? message.tool_call_id) === 'string'
          ? String(message.toolCallId ?? message.tool_call_id)
          : null,
      token_count:
        typeof (message.tokenCount ?? message.token_count) === 'number'
          ? Number(message.tokenCount ?? message.token_count)
          : null,
      run_model:
        typeof (message.runModel ?? message.run_model) === 'string'
          ? String(message.runModel ?? message.run_model)
          : null,
      created_at:
        typeof (message.createdAt ?? message.created_at) === 'number'
          ? Number(message.createdAt ?? message.created_at)
          : Math.floor(Date.now() / 1000)
    }
  }

  async addMessage(
    sessionId: string,
    message: {
      role: MessageRole
      content: string
      type?: MessageType
      tool_name?: string | null
      tool_call_id?: string | null
      token_count?: number | null
      chat_scope?: ChatScope
      page_id?: string | null
      selector?: string | null
      image_paths?: string[] | null
      video_paths?: string[] | null
      run_model?: string | null
      id?: string
    }
  ): Promise<string> {
    const id = message.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const chatScope = message.chat_scope === 'page' ? 'page' : 'main'
    const pageId =
      chatScope === 'page' &&
      typeof message.page_id === 'string' &&
      message.page_id.trim().length > 0
        ? message.page_id.trim()
        : null
    const selector =
      chatScope === 'page' &&
      typeof message.selector === 'string' &&
      message.selector.trim().length > 0
        ? message.selector.trim()
        : null
    const imagePathsRaw = Array.isArray(message.image_paths) ? message.image_paths : []
    const imagePaths =
      imagePathsRaw.length > 0
        ? imagePathsRaw
            .map((item) => String(item || '').trim())
            .filter((item) => item.startsWith('./images/'))
            .slice(0, 10)
        : []
    const videoPathsRaw = Array.isArray(message.video_paths) ? message.video_paths : []
    const videoPaths =
      videoPathsRaw.length > 0
        ? videoPathsRaw
            .map((item) => String(item || '').trim())
            .filter((item) => item.startsWith('./videos/'))
            .slice(0, 10)
        : []
    const imagePathsJson = imagePaths.length > 0 ? JSON.stringify(imagePaths) : null
    const videoPathsJson = videoPaths.length > 0 ? JSON.stringify(videoPaths) : null
    if (chatScope === 'page' && !pageId) {
      throw new Error('page chat message requires page_id')
    }

    await this.db
      .insert(schema.messages)
      .values({
        id,
        sessionId,
        chatScope,
        pageId,
        selector,
        imagePaths: imagePathsJson,
        videoPaths: videoPathsJson,
        role: message.role,
        content: message.content,
        type: message.type || 'text',
        toolName: message.tool_name || null,
        toolCallId: message.tool_call_id || null,
        tokenCount: message.token_count || null,
        runModel:
          typeof message.run_model === 'string' && message.run_model.trim().length > 0
            ? message.run_model
            : null,
        createdAt: now
      })
      .run()

    await this.db
      .update(schema.sessions)
      .set({ updatedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run()

    return id
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .get()
    return result?.count ?? 0
  }

  async getRecentMessages(sessionId: string, count: number): Promise<Message[]> {
    const results = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(count)
      .all()

    return results.map((message) => this.normalizeMessageRow(message as Record<string, unknown>))
  }

  // ========== Memory ==========

  async getLastSummary(sessionId: string): Promise<MemorySummary | undefined> {
    const result = await this.db
      .select()
      .from(schema.memorySummaries)
      .where(eq(schema.memorySummaries.sessionId, sessionId))
      .orderBy(desc(schema.memorySummaries.messageRangeEnd))
      .limit(1)
      .get()

    return result as MemorySummary | undefined
  }

  async saveSummary(
    sessionId: string,
    data: {
      rangeStart: number
      rangeEnd: number
      summary: string
      tokenCount?: number
    }
  ): Promise<string> {
    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    await this.db
      .insert(schema.memorySummaries)
      .values({
        id,
        sessionId,
        messageRangeStart: data.rangeStart,
        messageRangeEnd: data.rangeEnd,
        summary: data.summary,
        tokenCount: data.tokenCount || null,
        createdAt: now
      })
      .run()

    return id
  }

  async getLastCompressedIndex(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ maxIndex: max(schema.memorySummaries.messageRangeEnd) })
      .from(schema.memorySummaries)
      .where(eq(schema.memorySummaries.sessionId, sessionId))
      .get()
    return result?.maxIndex ?? 0
  }

  async getMessagesForCompression(
    sessionId: string,
    batchSize: number
  ): Promise<(Message & { idx: number })[]> {
    const lastCompressedIndex = await this.getLastCompressedIndex(sessionId)

    const results = await this.db
      .select({
        id: schema.messages.id,
        sessionId: schema.messages.sessionId,
        chatScope: schema.messages.chatScope,
        pageId: schema.messages.pageId,
        role: schema.messages.role,
        content: schema.messages.content,
        type: schema.messages.type,
        toolName: schema.messages.toolName,
        toolCallId: schema.messages.toolCallId,
        tokenCount: schema.messages.tokenCount,
        runModel: schema.messages.runModel,
        createdAt: schema.messages.createdAt
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.sessionId, sessionId),
          gt(schema.messages.createdAt, lastCompressedIndex)
        )
      )
      .orderBy(asc(schema.messages.createdAt))
      .limit(batchSize)
      .all()

    let idx = lastCompressedIndex + 1
    return results.map((r) => ({
      ...this.normalizeMessageRow(r as Record<string, unknown>),
      idx: idx++
    }))
  }

  // ========== Settings ==========

  async recordModelUsage(data: {
    provider: string
    model: string
    modelConfigId?: string
    sessionId?: string | null
    inputTokens: number
    outputTokens: number
    totalTokens: number
    source: 'provider' | 'estimated'
  }): Promise<void> {
    await this.db
      .insert(schema.modelUsageEvents)
      .values({
        id: crypto.randomUUID(),
        provider: data.provider,
        model: data.model,
        modelConfigId: data.modelConfigId || null,
        sessionId:
          typeof data.sessionId === 'string' && data.sessionId.trim().length > 0
            ? data.sessionId.trim()
            : null,
        inputTokens: Math.max(0, Math.floor(data.inputTokens)),
        outputTokens: Math.max(0, Math.floor(data.outputTokens)),
        totalTokens: Math.max(0, Math.floor(data.totalTokens)),
        usageSource: data.source,
        createdAt: Math.floor(Date.now() / 1000)
      })
      .run()
  }

  async getModelUsageStats(period: ModelUsagePeriod): Promise<ModelUsageStats> {
    const now = new Date()
    let startedAt: number | null = null
    if (period === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      startedAt = Math.floor(start.getTime() / 1000)
    } else if (period !== 'all') {
      const days = period === '7d' ? 7 : 30
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
      startedAt = Math.floor(start.getTime() / 1000)
    }
    const whereSql = startedAt === null ? '' : ' WHERE created_at >= ?'
    const args = startedAt === null ? [] : [startedAt]
    const totalsResult = await this.client.execute({
      sql: `
        SELECT
          COUNT(*) AS call_count,
          SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS exact_call_count,
          SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_call_count,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_usage_events${whereSql}
      `,
      args
    })
    const byModelResult = await this.client.execute({
      sql: `
        SELECT
          provider,
          model,
          COUNT(*) AS call_count,
          SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS exact_call_count,
          SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_call_count,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_usage_events${whereSql}
        GROUP BY provider, model
        ORDER BY total_tokens DESC
      `,
      args
    })
    const byDayResult = await this.client.execute({
      sql: `
        SELECT
          date(created_at, 'unixepoch', 'localtime') AS date,
          COUNT(*) AS call_count,
          SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS exact_call_count,
          SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_call_count,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_usage_events${whereSql}
        GROUP BY date
        ORDER BY date ASC
      `,
      args
    })

    const byHourResult =
      period === 'today'
        ? await this.client.execute({
            sql: `
              SELECT
                CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS call_count,
                SUM(CASE WHEN usage_source = 'provider' THEN 1 ELSE 0 END) AS exact_call_count,
                SUM(CASE WHEN usage_source = 'estimated' THEN 1 ELSE 0 END) AS estimated_call_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
              FROM model_usage_events${whereSql}
              GROUP BY hour
              ORDER BY hour ASC
            `,
            args
          })
        : null

    const readTotals = (row: Record<string, unknown> | undefined): ModelUsageTotals => ({
      callCount: Number(row?.call_count || 0),
      exactCallCount: Number(row?.exact_call_count || 0),
      estimatedCallCount: Number(row?.estimated_call_count || 0),
      inputTokens: Number(row?.input_tokens || 0),
      outputTokens: Number(row?.output_tokens || 0),
      totalTokens: Number(row?.total_tokens || 0)
    })

    const byHour: ModelUsageByHour[] = []
    if (byHourResult) {
      const hourMap = new Map<number, ModelUsageTotals>()
      for (const row of byHourResult.rows) {
        const hour = Number((row as Record<string, unknown>).hour || 0)
        hourMap.set(hour, readTotals(row as Record<string, unknown>))
      }
      for (let hour = 0; hour < 24; hour += 1) {
        byHour.push({ hour, ...(hourMap.get(hour) || readTotals(undefined)) })
      }
    }

    return {
      period,
      startedAt,
      totals: readTotals(totalsResult.rows[0] as Record<string, unknown> | undefined),
      byModel: byModelResult.rows.map((row) => ({
        provider: String(row.provider || ''),
        model: String(row.model || ''),
        ...readTotals(row as Record<string, unknown>)
      })),
      byDay: byDayResult.rows.map((row) => ({
        date: String(row.date || ''),
        ...readTotals(row as Record<string, unknown>)
      })),
      byHour
    }
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.configRepository.getSetting<T>(key)
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    return this.configRepository.setSetting(key, value)
  }

  async getAllSettings(): Promise<Record<string, unknown>> {
    return this.configRepository.getAllSettings()
  }

  // ========== Model Configs ==========

  async listModelConfigs(): Promise<ModelConfigRow[]> {
    return this.configRepository.listModelConfigs()
  }

  async getActiveModelConfig(): Promise<ModelConfigRow | undefined> {
    return this.configRepository.getActiveModelConfig()
  }

  async getModelConfig(id: string): Promise<ModelConfigRow | undefined> {
    return this.configRepository.getModelConfig(id)
  }

  async upsertModelConfig(data: UpsertModelConfigInput): Promise<string> {
    return this.configRepository.upsertModelConfig(data)
  }

  async setActiveModelConfig(id: string): Promise<void> {
    return this.configRepository.setActiveModelConfig(id)
  }

  async deleteModelConfig(id: string): Promise<void> {
    return this.configRepository.deleteModelConfig(id)
  }

  // ========== Image Model Configs ==========

  async listImageModelConfigs(): Promise<ImageModelConfigRow[]> {
    return this.configRepository.listImageModelConfigs()
  }

  async getActiveImageModelConfig(): Promise<ImageModelConfigRow | undefined> {
    return this.configRepository.getActiveImageModelConfig()
  }

  async getImageModelConfig(id: string): Promise<ImageModelConfigRow | undefined> {
    return this.configRepository.getImageModelConfig(id)
  }

  async upsertImageModelConfig(data: UpsertImageModelConfigInput): Promise<string> {
    return this.configRepository.upsertImageModelConfig(data)
  }

  async setActiveImageModelConfig(id: string): Promise<void> {
    return this.configRepository.setActiveImageModelConfig(id)
  }

  async deleteImageModelConfig(id: string): Promise<void> {
    return this.configRepository.deleteImageModelConfig(id)
  }

  // ========== Image Generation Histories ==========

  async listImageGenerationHistories(
    sessionId: string,
    pageId: string
  ): Promise<ImageGenerationHistoryRow[]> {
    return this.imageGenerationHistoryRepository.listByPage(sessionId, pageId)
  }

  async insertImageGenerationHistory(data: InsertImageGenerationHistoryInput): Promise<string> {
    return this.imageGenerationHistoryRepository.insert(data)
  }

  // ========== Preferences ==========

  async getActiveUserPreferences(): Promise<UserPreferenceRecord[]> {
    return this.userPreferenceRepository.listActive()
  }

  async upsertPreference(
    key: string,
    data: UpsertUserPreferenceInput
  ): Promise<void> {
    return this.userPreferenceRepository.upsert(key, data)
  }

  async decayPreferences(): Promise<void> {
    return this.userPreferenceRepository.decay()
  }

  // ========== Projects ==========

  async createProject(data: CreateProjectInput): Promise<string> {
    return this.projectRepository.create(data)
  }

  async getProject(sessionId: string): Promise<ProjectRecord | undefined> {
    return this.projectRepository.getLatestForSession(sessionId)
  }

  async updateProjectStatus(
    projectId: string,
    status: ProjectStatus
  ): Promise<void> {
    return this.projectRepository.updateStatus(projectId, status)
  }

  // ========== Styles ==========

  async countStyles(): Promise<number> {
    const result = await this.db.select({ count: count() }).from(schema.styles).get()
    return result?.count ?? 0
  }

  async syncInstalledStylesToDatabase(installedRootPath: string): Promise<void> {
    const systemPath = path.join(installedRootPath, 'system')
    const userPath = path.join(installedRootPath, 'user')
    await this._refreshStylesCache()

    const syncDirectory = async (root: string, scope: 'system' | 'user'): Promise<void> => {
      if (!fs.existsSync(root)) return
      const packageNames = await listStylePackageDirectories(root)
      for (const packageName of packageNames) {
        try {
          const stylePackage = await readStylePackage(path.join(root, packageName))
          const item = stylePackage.json
          const existing = this._stylesCache.find((row) => row.style === item.style)
          const source: StyleSource =
            scope === 'system' ? 'builtin' : item.source === 'override' ? 'override' : 'custom'
          const packageDir = path.posix.join(scope, packageName)

          if (!existing) {
            await this.createStyleRow({
              id: scope === 'user' ? packageName : undefined,
              style: item.style,
              styleName: item.name.zh,
              styleNameZh: item.name.zh,
              styleNameEn: item.name.en,
              description: item.description,
              category: item.category,
              aliases: item.aliases,
              source,
              styleSkill: stylePackage.skillMarkdown,
              version: item.version,
              styleCase: item.styleCase,
              packageDir
            })
            continue
          }

          if (scope === 'system') {
            if (existing.source === 'builtin') {
              await this.updateStyleRow(existing.id, {
                styleName: item.name.zh,
                styleNameZh: item.name.zh,
                styleNameEn: item.name.en,
                description: item.description,
                category: item.category,
                aliases: item.aliases,
                styleSkill: stylePackage.skillMarkdown,
                version: item.version,
                styleCase: item.styleCase,
                packageDir
              })
              continue
            }
            if (
              existing.source === 'override' &&
              compareStyleVersion(item.version, existing.version) > 0
            ) {
              await this.updateStyleRow(existing.id, { version: item.version })
            }
            continue
          }
          await this.updateStyleRow(existing.id, {
            styleName: item.name.zh,
            styleNameZh: item.name.zh,
            styleNameEn: item.name.en,
            description: item.description,
            category: item.category,
            aliases: item.aliases,
            source,
            styleSkill: stylePackage.skillMarkdown,
            version: item.version,
            styleCase: item.styleCase,
            packageDir
          })
        } catch (error) {
          console.warn('[db] failed to sync installed style package', {
            path: path.join(root, packageName),
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }

    await syncDirectory(systemPath, 'system')
    await syncDirectory(userPath, 'user')
    await this.deactivateOrphanedBuiltinStyles(systemPath)
    await this._refreshStylesCache()
  }

  /**
   * 内置风格包随版本下线后，同步停用仍指向 system 目录的 DB 行，
   * 避免已删除的风格继续出现在风格列表里。用户 override（packageDir
   * 指向 user 目录）不受影响。
   */
  private async deactivateOrphanedBuiltinStyles(systemPath: string): Promise<void> {
    const existingSystemDirs = new Set(
      fs.existsSync(systemPath)
        ? await fs.promises
            .readdir(systemPath, { withFileTypes: true })
            .then((entries) =>
              entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
            )
        : []
    )
    const orphans = this._stylesCache.filter(
      (row) =>
        row.active !== false &&
        row.source === 'builtin' &&
        (row.packageDir || `system/${row.style}`).startsWith('system/') &&
        !existingSystemDirs.has((row.packageDir || `system/${row.style}`).slice('system/'.length))
    )
    for (const row of orphans) {
      await this.updateStyleRow(row.id, { active: false })
      console.warn('[db] deactivated builtin style without installed package', {
        style: row.style
      })
    }
  }

  private async _refreshStylesCache(): Promise<void> {
    const results = await this.db
      .select()
      .from(schema.styles)
      .orderBy(asc(schema.styles.style))
      .all()
    this._stylesCache = (results as unknown as StyleRow[]).map((row) => ({
      ...row,
      version: normalizeStyleVersion(row.version)
    }))
  }

  /** Synchronous read from in-memory cache. Used by prompt builders. */
  listStyleRowsSync(): StyleRow[] {
    return this._stylesCache
  }

  /** Synchronous cache lookup. */
  getStyleRowSync(styleId: string): StyleRow | undefined {
    return this._stylesCache.find((r) => r.id === styleId)
  }

  /** Synchronous cache lookup by style key. */
  getStyleRowByStyleSync(style: string): StyleRow | undefined {
    return this._stylesCache.find((r) => r.style === style)
  }

  async listStyleRows(): Promise<StyleRow[]> {
    const results = await this.db
      .select()
      .from(schema.styles)
      .orderBy(asc(schema.styles.style))
      .all()
    return (results as unknown as StyleRow[]).map((row) => ({
      ...row,
      version: normalizeStyleVersion(row.version)
    }))
  }

  async getStyleRow(styleId: string): Promise<StyleRow | undefined> {
    const result = await this.db
      .select()
      .from(schema.styles)
      .where(eq(schema.styles.id, styleId))
      .get()
    return result
      ? ({
          ...(result as unknown as StyleRow),
          version: normalizeStyleVersion((result as unknown as StyleRow).version)
        } as StyleRow)
      : undefined
  }

  async getStyleRowByStyle(style: string): Promise<StyleRow | undefined> {
    const result = await this.db
      .select()
      .from(schema.styles)
      .where(eq(schema.styles.style, style))
      .get()
    return result
      ? ({
          ...(result as unknown as StyleRow),
          version: normalizeStyleVersion((result as unknown as StyleRow).version)
        } as StyleRow)
      : undefined
  }

  async createStyleRow(data: {
    id?: string
    style: string
    styleName: string
    styleNameZh?: string
    styleNameEn?: string
    description?: string
    category?: string
    aliases?: string[]
    source?: StyleSource
    styleSkill?: string
    version?: string | number
    styleCase?: string
    packageDir?: string
  }): Promise<string> {
    const id = data.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .insert(schema.styles)
      .values({
        id,
        style: data.style,
        styleName: data.styleName,
        styleNameZh: data.styleNameZh || data.styleName,
        styleNameEn: data.styleNameEn || '',
        description: data.description || '',
        category: data.category || '',
        aliases: JSON.stringify(data.aliases || []),
        source: data.source || 'custom',
        styleSkill: data.styleSkill || '',
        version: normalizeStyleVersion(data.version),
        styleCase: data.styleCase || '',
        packageDir: data.packageDir || '',
        createdAt: now,
        updatedAt: now
      })
      .run()
    await this._refreshStylesCache()
    return id
  }

  async updateStyleRow(
    styleId: string,
    data: {
      styleName?: string
      styleNameZh?: string
      styleNameEn?: string
      description?: string
      category?: string
      aliases?: string[]
      source?: StyleSource
      styleSkill?: string
      version?: string | number
      styleCase?: string
      packageDir?: string
      active?: boolean
    }
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const set: Record<string, unknown> = { updatedAt: now }
    if (data.styleName !== undefined) set.styleName = data.styleName
    if (data.styleNameZh !== undefined) set.styleNameZh = data.styleNameZh
    if (data.styleNameEn !== undefined) set.styleNameEn = data.styleNameEn
    if (data.description !== undefined) set.description = data.description
    if (data.category !== undefined) set.category = data.category
    if (data.aliases !== undefined) set.aliases = JSON.stringify(data.aliases)
    if (data.source !== undefined) set.source = data.source
    if (data.styleSkill !== undefined) set.styleSkill = data.styleSkill
    if (data.version !== undefined) set.version = normalizeStyleVersion(data.version)
    if (data.styleCase !== undefined) set.styleCase = data.styleCase
    if (data.packageDir !== undefined) set.packageDir = data.packageDir
    if (data.active !== undefined) set.active = data.active
    await this.db.update(schema.styles).set(set).where(eq(schema.styles.id, styleId)).run()
    await this._refreshStylesCache()
  }

  async setStyleFavorite(styleId: string, favoriteAt: number | null): Promise<number | null> {
    const existing = await this.getStyleRow(styleId)
    if (!existing) {
      throw new Error(`Style not found: ${styleId}`)
    }
    await this.db
      .update(schema.styles)
      .set({ favoriteAt })
      .where(eq(schema.styles.id, styleId))
      .run()
    await this._refreshStylesCache()
    return favoriteAt
  }

  async deleteStyleRow(styleId: string): Promise<boolean> {
    const existing = await this.getStyleRow(styleId)
    if (!existing) return false
    await this.db.delete(schema.styles).where(eq(schema.styles.id, styleId)).run()
    await this._refreshStylesCache()
    return true
  }

  async getThumbnailRecord(
    resourceType: HtmlThumbnailResourceType,
    resourceId: string,
    variant = 'default'
  ): Promise<ThumbnailRecord | undefined> {
    return this.thumbnailRepository.get(resourceType, resourceId, variant)
  }

  async getThumbnailRecords(
    resourceType: HtmlThumbnailResourceType,
    resourceIds: string[],
    variant = 'default'
  ): Promise<ThumbnailRecord[]> {
    return this.thumbnailRepository.getMany(resourceType, resourceIds, variant)
  }

  async upsertThumbnailRecord(data: UpsertThumbnailRecordInput): Promise<void> {
    return this.thumbnailRepository.upsert(data)
  }

  async failInterruptedThumbnailTasks(): Promise<void> {
    return this.thumbnailRepository.failInterruptedTasks()
  }

  async getSessionStyleSnapshot(sessionId: string): Promise<SessionStyleSnapshotRow | undefined> {
    return this.sessionStyleSnapshotRepository.get(sessionId)
  }

  async createSessionStyleSnapshot(
    sessionId: string,
    styleId?: string | null
  ): Promise<SessionStyleSnapshotRow> {
    return this.sessionStyleSnapshotService.createFromCatalog(sessionId, styleId)
  }

  /**
   * Persist a session-scoped style that does not exist in the installed catalog.
   * The row is intentionally stored only in the session snapshot table so retries,
   * edits, and save-as-new sessions keep the exact same generated style contract.
   */
  async createCustomSessionStyleSnapshot(
    sessionId: string,
    input: SessionStyleSnapshotInput
  ): Promise<SessionStyleSnapshotRow> {
    return this.sessionStyleSnapshotService.createCustom(sessionId, input)
  }

  async replaceSessionStyleSnapshot(
    sessionId: string,
    styleId?: string | null
  ): Promise<SessionStyleSnapshotRow> {
    return this.sessionStyleSnapshotService.replaceFromCatalog(sessionId, styleId)
  }

  async getOrCreateSessionStyleSnapshot(sessionId: string): Promise<SessionStyleSnapshotRow> {
    return this.sessionStyleSnapshotService.getOrCreate(sessionId)
  }

  async copySessionStyleSnapshot(sourceSessionId: string, targetSessionId: string): Promise<void> {
    return this.sessionStyleSnapshotService.copy(sourceSessionId, targetSessionId)
  }

  async backfillSessionStyleSnapshots(): Promise<{
    scanned: number
    created: number
    fallback: number
    failed: number
  }> {
    const rows = await this.db
      .select({ session: schema.sessions })
      .from(schema.sessions)
      .leftJoin(
        schema.sessionStyleSnapshots,
        eq(schema.sessionStyleSnapshots.sessionId, schema.sessions.id)
      )
      .where(isNull(schema.sessionStyleSnapshots.id))
      .all()

    let created = 0
    let fallback = 0
    let failed = 0
    for (const row of rows) {
      const session = row.session as unknown as Session
      try {
        const snapshot = await this.getOrCreateSessionStyleSnapshot(session.id)
        if (!session.styleId || session.styleId !== snapshot.styleId) {
          fallback += 1
          await this.db
            .update(schema.sessions)
            .set({ styleId: snapshot.styleId, updatedAt: Math.floor(Date.now() / 1000) })
            .where(eq(schema.sessions.id, session.id))
            .run()
        }
        created += 1
      } catch (error) {
        failed += 1
        console.warn('[db] failed to backfill session style snapshot', {
          sessionId: session.id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return { scanned: rows.length, created, fallback, failed }
  }

  styleRowToPackageJson(styleId: string): ReturnType<typeof styleRowToPackageJson> {
    const row = this.getStyleRowSync(styleId)
    if (!row) throw new Error('style 不存在：' + styleId)
    return styleRowToPackageJson({
      style: row.style,
      styleName: row.styleName,
      styleNameZh: row.styleNameZh || row.styleName,
      styleNameEn: row.styleNameEn || '',
      description: row.description,
      category: row.category,
      aliases: row.aliases,
      source: row.source,
      version: row.version,
      styleCase: row.styleCase
    })
  }

  private resolveSnapshotStyleRow(styleId?: string | null): StyleRow {
    if (styleId) {
      const byId = this._stylesCache.find((row) => row.id === styleId)
      if (byId) return byId
      const byStyle = this._stylesCache.find((row) => row.style === styleId)
      if (byStyle) return byStyle
    }
    const activeRows = this._stylesCache.filter((row) => row.active !== false)
    const fallback =
      activeRows.find((row) => row.style === 'minimal-white') ||
      this._stylesCache.find((row) => row.style === 'minimal-white') ||
      activeRows[0] ||
      this._stylesCache[0]
    if (!fallback) throw new Error('No style rows available for session snapshot')
    return fallback
  }
}
