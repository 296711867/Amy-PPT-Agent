import crypto from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import type { HtmlThumbnailResourceType } from '@shared/thumbnail'
import * as schema from '../schema'
import type { ThumbnailRecord, ThumbnailStatus } from '../records'

export interface UpsertThumbnailRecordInput {
  resourceType: HtmlThumbnailResourceType
  resourceId: string
  variant: string
  sourcePath: string
  sourceMtimeMs: number
  signature: string
  thumbnailPath: string
  status: ThumbnailStatus
  error?: string | null
}

const createThumbnailKey = (
  resourceType: HtmlThumbnailResourceType,
  resourceId: string,
  variant: string
): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({ resourceType, resourceId, variant }))
    .digest('hex')
    .slice(0, 32)

export class ThumbnailRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async get(
    resourceType: HtmlThumbnailResourceType,
    resourceId: string,
    variant = 'default'
  ): Promise<ThumbnailRecord | undefined> {
    const row = await this.db
      .select()
      .from(schema.thumbnails)
      .where(
        and(
          eq(schema.thumbnails.resourceType, resourceType),
          eq(schema.thumbnails.resourceId, resourceId),
          eq(schema.thumbnails.variant, variant)
        )
      )
      .get()
    return row as ThumbnailRecord | undefined
  }

  async getMany(
    resourceType: HtmlThumbnailResourceType,
    resourceIds: string[],
    variant = 'default'
  ): Promise<ThumbnailRecord[]> {
    const ids = Array.from(
      new Set(resourceIds.map((id) => String(id || '').trim()).filter(Boolean))
    )
    if (ids.length === 0) return []
    const rows = await this.db
      .select()
      .from(schema.thumbnails)
      .where(
        and(
          eq(schema.thumbnails.resourceType, resourceType),
          inArray(schema.thumbnails.resourceId, ids),
          eq(schema.thumbnails.variant, variant)
        )
      )
      .all()
    return rows as ThumbnailRecord[]
  }

  async upsert(data: UpsertThumbnailRecordInput): Promise<void> {
    const now = Date.now()
    const mutableValues = {
      sourcePath: data.sourcePath,
      sourceMtimeMs: data.sourceMtimeMs,
      signature: data.signature,
      thumbnailPath: data.thumbnailPath,
      status: data.status,
      error: data.error || null,
      updatedAt: now
    }
    await this.db
      .insert(schema.thumbnails)
      .values({
        key: createThumbnailKey(data.resourceType, data.resourceId, data.variant),
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        variant: data.variant,
        ...mutableValues,
        createdAt: now
      })
      .onConflictDoUpdate({ target: schema.thumbnails.key, set: mutableValues })
      .run()
  }

  async failInterruptedTasks(): Promise<void> {
    await this.db
      .update(schema.thumbnails)
      .set({
        status: 'failed',
        error: '应用退出时任务尚未完成',
        updatedAt: Date.now()
      })
      .where(inArray(schema.thumbnails.status, ['queued', 'running']))
      .run()
  }
}
