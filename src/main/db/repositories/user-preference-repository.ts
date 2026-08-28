import { desc, eq, gt, lte, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type { UserPreferenceRecord } from '../records'

export interface UpsertUserPreferenceInput {
  value: unknown
  confidence?: number
  sourceSessions?: string[]
}

export class UserPreferenceRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async listActive(): Promise<UserPreferenceRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.userPreferences)
      .where(gt(schema.userPreferences.confidence, 0.3))
      .orderBy(desc(schema.userPreferences.confidence), desc(schema.userPreferences.lastUsedAt))
      .limit(10)
      .all()

    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value),
      confidence: row.confidence,
      source_sessions: row.sourceSessions ? JSON.parse(row.sourceSessions) : [],
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      last_used_at: row.lastUsedAt
    })) as UserPreferenceRecord[]
  }

  async upsert(key: string, data: UpsertUserPreferenceInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const existing = await this.db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.key, key))
      .get()

    if (!existing) {
      await this.db
        .insert(schema.userPreferences)
        .values({
          key,
          value: JSON.stringify(data.value),
          confidence: data.confidence || 0.5,
          sourceSessions: JSON.stringify(data.sourceSessions || []),
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now
        })
        .run()
      return
    }

    const existingSources: string[] = existing.sourceSessions
      ? JSON.parse(existing.sourceSessions)
      : []
    const sourceSessions = data.sourceSessions
      ? [...new Set([...existingSources, ...data.sourceSessions])]
      : existingSources
    const confidence = Math.min(
      1,
      (existing.confidence ?? 0.5) + (data.confidence ?? 0.5) * 0.3
    )
    await this.db
      .update(schema.userPreferences)
      .set({
        value: JSON.stringify(data.value),
        confidence,
        sourceSessions: JSON.stringify(sourceSessions),
        updatedAt: now,
        lastUsedAt: now
      })
      .where(eq(schema.userPreferences.key, key))
      .run()
  }

  async decay(): Promise<void> {
    await this.db
      .update(schema.userPreferences)
      .set({ confidence: sql`${schema.userPreferences.confidence} * 0.95` })
      .where(gt(schema.userPreferences.confidence, 0.1))
      .run()
    await this.db
      .delete(schema.userPreferences)
      .where(lte(schema.userPreferences.confidence, 0.1))
      .run()
  }
}
