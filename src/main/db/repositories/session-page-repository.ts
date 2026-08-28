import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type {
  SessionPageInput,
  SessionPageRecord,
  SessionPageStatus,
  SourcePageSkeletonConfidence,
  SourcePageSkeletonRecord,
  SourcePageSkeletonRole
} from '../records'

export interface ReplaceSourcePageSkeletonsArgs {
  sessionId: string
  sourceDocumentPath: string
  sourceDocumentName?: string | null
  confidence?: SourcePageSkeletonConfidence
  items: Array<{
    pageNumber: number
    title: string
    role: SourcePageSkeletonRole
    sourceHeading: string
    headingLevel: number
    lineStart: number
    lineEnd: number
    reason?: string | null
    layoutIntent?: string | null
    layoutId?: string | null
  }>
}

export interface UpsertSourcePageSkeletonArgs {
  sessionId: string
  pageNumber: number
  title: string
  role?: SourcePageSkeletonRole
  sourceDocumentPath: string
  sourceDocumentName?: string | null
  sourceHeading: string
  headingLevel?: number
  lineStart?: number
  lineEnd?: number
  reason?: string | null
  layoutIntent?: string | null
  layoutId?: string | null
  confidence?: SourcePageSkeletonConfidence
}

export interface PersistSessionPageStateInput {
  sessionId: string
  pages: Array<{ id: string; pageNumber: number }>
  deletedPageIds?: string[]
  metadata: object
}

const normalizeSessionPageRow = (row: Record<string, unknown>): SessionPageRecord => {
  return {
    id: String(row.id || ''),
    session_id: String(row.sessionId ?? row.session_id ?? ''),
    legacy_page_id:
      typeof (row.legacyPageId ?? row.legacy_page_id) === 'string'
        ? String(row.legacyPageId ?? row.legacy_page_id)
        : null,
    file_slug: String(row.fileSlug ?? row.file_slug ?? ''),
    page_number: Number(row.pageNumber ?? row.page_number ?? 0) || 0,
    title: String(row.title || ''),
    html_path: String(row.htmlPath ?? row.html_path ?? ''),
    status: String(row.status || 'pending') as SessionPageStatus,
    error: typeof row.error === 'string' ? row.error : null,
    created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0,
    deleted_at:
      typeof (row.deletedAt ?? row.deleted_at) === 'number'
        ? Number(row.deletedAt ?? row.deleted_at)
        : null
  }
}

const normalizeSourcePageSkeletonRow = (row: Record<string, unknown>): SourcePageSkeletonRecord => {
  return {
    id: String(row.id || ''),
    session_id: String(row.sessionId ?? row.session_id ?? ''),
    page_number: Number(row.pageNumber ?? row.page_number ?? 0) || 0,
    title: String(row.title || ''),
    role: String(row.role || 'content') === 'chapter-divider' ? 'chapter-divider' : 'content',
    source_document_path: String(row.sourceDocumentPath ?? row.source_document_path ?? ''),
    source_document_name:
      typeof (row.sourceDocumentName ?? row.source_document_name) === 'string'
        ? String(row.sourceDocumentName ?? row.source_document_name)
        : null,
    source_heading: String(row.sourceHeading ?? row.source_heading ?? ''),
    heading_level: Number(row.headingLevel ?? row.heading_level ?? 0) || 1,
    line_start: Number(row.lineStart ?? row.line_start ?? 0) || 1,
    line_end: Number(row.lineEnd ?? row.line_end ?? 0) || 1,
    reason:
      typeof row.reason === 'string' && row.reason.trim().length > 0 ? String(row.reason) : null,
    layout_intent:
      typeof (row.layoutIntent ?? row.layout_intent) === 'string'
        ? String(row.layoutIntent ?? row.layout_intent)
        : null,
    layout_id:
      typeof (row.layoutId ?? row.layout_id) === 'string'
        ? String(row.layoutId ?? row.layout_id)
        : null,
    confidence: row.confidence === 'medium' || row.confidence === 'low' ? row.confidence : 'high',
    created_at: Number(row.createdAt ?? row.created_at ?? 0) || 0,
    updated_at: Number(row.updatedAt ?? row.updated_at ?? 0) || 0
  }
}

export class SessionPageRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async listSessionPages(
    sessionId: string,
    options?: { includeDeleted?: boolean }
  ): Promise<SessionPageRecord[]> {
    const conditions = [eq(schema.sessionPages.sessionId, sessionId)]
    if (!options?.includeDeleted) {
      conditions.push(isNull(schema.sessionPages.deletedAt))
    }
    const rows = await this.db
      .select()
      .from(schema.sessionPages)
      .where(and(...conditions))
      .orderBy(asc(schema.sessionPages.pageNumber))
      .all()
    return rows.map((row) => normalizeSessionPageRow(row as Record<string, unknown>))
  }

  async replaceSourcePageSkeletons(args: ReplaceSourcePageSkeletonsArgs): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .delete(schema.sourcePageSkeletons)
      .where(eq(schema.sourcePageSkeletons.sessionId, args.sessionId))
      .run()
    const values = args.items
      .filter((item) => item.sourceHeading.trim().length > 0)
      .map((item) => {
        const pageNumber = Math.max(1, Math.floor(item.pageNumber))
        const lineStart = Math.max(1, Math.floor(item.lineStart || 1))
        const lineEnd = Math.max(lineStart, Math.floor(item.lineEnd || lineStart))
        return {
          id: `${args.sessionId}:${pageNumber}`,
          sessionId: args.sessionId,
          pageNumber,
          title: item.title.trim() || `Slide ${pageNumber}`,
          role: item.role === 'chapter-divider' ? 'chapter-divider' : 'content',
          sourceDocumentPath: args.sourceDocumentPath,
          sourceDocumentName: args.sourceDocumentName || null,
          sourceHeading: item.sourceHeading,
          headingLevel: Math.max(1, Math.floor(item.headingLevel || 1)),
          lineStart,
          lineEnd,
          reason: item.reason || null,
          layoutIntent: item.layoutIntent || null,
          layoutId: item.layoutId || null,
          confidence: args.confidence || 'high',
          createdAt: now,
          updatedAt: now
        }
      })
    if (values.length === 0) return
    await this.db.insert(schema.sourcePageSkeletons).values(values).run()
  }

  async upsertSourcePageSkeleton(args: UpsertSourcePageSkeletonArgs): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const pageNumber = Math.max(1, Math.floor(args.pageNumber))
    const lineStart = Math.max(1, Math.floor(args.lineStart || pageNumber))
    const lineEnd = Math.max(lineStart, Math.floor(args.lineEnd || lineStart))
    const value = {
      id: `${args.sessionId}:${pageNumber}`,
      sessionId: args.sessionId,
      pageNumber,
      title: args.title.trim() || `Slide ${pageNumber}`,
      role: args.role === 'chapter-divider' ? 'chapter-divider' : 'content',
      sourceDocumentPath: args.sourceDocumentPath,
      sourceDocumentName: args.sourceDocumentName || null,
      sourceHeading: args.sourceHeading.trim(),
      headingLevel: Math.max(1, Math.floor(args.headingLevel || 1)),
      lineStart,
      lineEnd,
      reason: args.reason || null,
      layoutIntent: args.layoutIntent || null,
      layoutId: args.layoutId || null,
      confidence: args.confidence || 'medium',
      createdAt: now,
      updatedAt: now
    }
    if (!value.sourceHeading) return
    await this.db
      .insert(schema.sourcePageSkeletons)
      .values(value)
      .onConflictDoUpdate({
        target: schema.sourcePageSkeletons.id,
        set: {
          title: value.title,
          role: value.role,
          sourceDocumentPath: value.sourceDocumentPath,
          sourceDocumentName: value.sourceDocumentName,
          sourceHeading: value.sourceHeading,
          headingLevel: value.headingLevel,
          lineStart: value.lineStart,
          lineEnd: value.lineEnd,
          reason: value.reason,
          layoutIntent: value.layoutIntent,
          layoutId: value.layoutId,
          confidence: value.confidence,
          updatedAt: now
        }
      })
      .run()
  }

  async deleteSourcePageSkeleton(sessionId: string, pageNumber: number): Promise<void> {
    await this.db
      .delete(schema.sourcePageSkeletons)
      .where(
        and(
          eq(schema.sourcePageSkeletons.sessionId, sessionId),
          eq(schema.sourcePageSkeletons.pageNumber, pageNumber)
        )
      )
      .run()
  }

  async deleteSourcePageSkeletons(sessionId: string, pageNumbers: number[]): Promise<void> {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) return
    await this.db
      .delete(schema.sourcePageSkeletons)
      .where(
        and(
          eq(schema.sourcePageSkeletons.sessionId, sessionId),
          inArray(schema.sourcePageSkeletons.pageNumber, pageNumbers)
        )
      )
      .run()
  }

  async listSourcePageSkeletons(sessionId: string): Promise<SourcePageSkeletonRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.sourcePageSkeletons)
      .where(eq(schema.sourcePageSkeletons.sessionId, sessionId))
      .orderBy(asc(schema.sourcePageSkeletons.pageNumber))
      .all()
    return rows.map((row) => normalizeSourcePageSkeletonRow(row as Record<string, unknown>))
  }

  async upsertSessionPage(page: SessionPageInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .insert(schema.sessionPages)
      .values({
        id: page.id,
        sessionId: page.sessionId,
        legacyPageId: page.legacyPageId || null,
        fileSlug: page.fileSlug,
        pageNumber: page.pageNumber,
        title: page.title,
        htmlPath: page.htmlPath,
        status: page.status || 'pending',
        error: page.error || null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      })
      .onConflictDoUpdate({
        target: schema.sessionPages.id,
        set: {
          legacyPageId: page.legacyPageId || null,
          fileSlug: page.fileSlug,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: page.htmlPath,
          status: page.status || 'pending',
          error: page.error || null,
          deletedAt: null,
          updatedAt: now
        }
      })
      .run()
  }

  async replaceSessionPageOrder(
    sessionId: string,
    pages: Array<{ id: string; pageNumber: number }>
  ): Promise<void> {
    if (pages.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    const pageIds = pages.map((page) => page.id)
    const caseWhenFragments = pages.map(
      (page) => sql`WHEN ${schema.sessionPages.id} = ${page.id} THEN ${page.pageNumber}`
    )
    const pageNumberExpr = sql<number>`CASE ${sql.join(caseWhenFragments, sql` `)} ELSE ${schema.sessionPages.pageNumber} END`
    await this.db
      .update(schema.sessionPages)
      .set({
        pageNumber: pageNumberExpr,
        updatedAt: now
      })
      .where(
        and(eq(schema.sessionPages.sessionId, sessionId), inArray(schema.sessionPages.id, pageIds))
      )
      .run()
  }

  async persistSessionPageState(data: PersistSessionPageStateInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.db.transaction(async (tx) => {
      if (data.deletedPageIds?.length) {
        await tx
          .update(schema.sessionPages)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.sessionPages.sessionId, data.sessionId),
              inArray(schema.sessionPages.id, data.deletedPageIds)
            )
          )
          .run()
      }
      if (data.pages.length > 0) {
        const pageIds = data.pages.map((page) => page.id)
        const caseWhenFragments = data.pages.map(
          (page) => sql`WHEN ${schema.sessionPages.id} = ${page.id} THEN ${page.pageNumber}`
        )
        const pageNumberExpr = sql<number>`CASE ${sql.join(caseWhenFragments, sql` `)} ELSE ${schema.sessionPages.pageNumber} END`
        await tx
          .update(schema.sessionPages)
          .set({ pageNumber: pageNumberExpr, updatedAt: now })
          .where(
            and(
              eq(schema.sessionPages.sessionId, data.sessionId),
              inArray(schema.sessionPages.id, pageIds)
            )
          )
          .run()
      }
      await tx
        .update(schema.sessions)
        .set({ metadata: JSON.stringify(data.metadata), updatedAt: now })
        .where(eq(schema.sessions.id, data.sessionId))
        .run()
    })
  }

  async softDeleteSessionPages(sessionId: string, ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .update(schema.sessionPages)
      .set({
        deletedAt: now,
        updatedAt: now
      })
      .where(
        and(eq(schema.sessionPages.sessionId, sessionId), inArray(schema.sessionPages.id, ids))
      )
      .run()
  }

  async hardDeleteSessionPages(sessionId: string, ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) return
    await this.db
      .delete(schema.sessionPages)
      .where(
        and(eq(schema.sessionPages.sessionId, sessionId), inArray(schema.sessionPages.id, ids))
      )
      .run()
  }
}
