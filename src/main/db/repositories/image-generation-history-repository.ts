import crypto from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type { ImageGenerationHistoryRow } from '../records'

export interface InsertImageGenerationHistoryInput {
  id?: string
  sessionId: string
  pageId: string
  prompt: string
  imagePaths: string[]
  modelConfigId: string
  provider: string
  model: string
  createdAt?: number
}

export class ImageGenerationHistoryRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async listByPage(sessionId: string, pageId: string): Promise<ImageGenerationHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(schema.imageGenerationHistories)
      .where(
        and(
          eq(schema.imageGenerationHistories.sessionId, sessionId),
          eq(schema.imageGenerationHistories.pageId, pageId)
        )
      )
      .orderBy(desc(schema.imageGenerationHistories.createdAt))
      .limit(50)
      .all()
    return rows as ImageGenerationHistoryRow[]
  }

  async insert(data: InsertImageGenerationHistoryInput): Promise<string> {
    const id = data.id || crypto.randomUUID()
    await this.db
      .insert(schema.imageGenerationHistories)
      .values({
        id,
        sessionId: data.sessionId,
        pageId: data.pageId,
        prompt: data.prompt,
        imagePaths: JSON.stringify(data.imagePaths),
        modelConfigId: data.modelConfigId,
        provider: data.provider,
        model: data.model,
        createdAt: data.createdAt || Math.floor(Date.now() / 1000)
      })
      .run()
    return id
  }
}
