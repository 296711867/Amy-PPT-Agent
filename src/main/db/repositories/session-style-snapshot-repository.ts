import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import { normalizeStyleVersion } from '../../styles'
import * as schema from '../schema'
import type {
  SessionStyleSnapshotInput,
  SessionStyleSnapshotRow,
  StyleRow
} from '../records'

export class SessionStyleSnapshotRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async get(sessionId: string): Promise<SessionStyleSnapshotRow | undefined> {
    const row = await this.db
      .select()
      .from(schema.sessionStyleSnapshots)
      .where(eq(schema.sessionStyleSnapshots.sessionId, sessionId))
      .get()
    return row as SessionStyleSnapshotRow | undefined
  }

  async createFromCatalog(sessionId: string, style: StyleRow): Promise<SessionStyleSnapshotRow> {
    await this.insert({
      sessionId,
      styleId: style.id,
      styleKey: style.style,
      styleName: style.styleName,
      styleNameZh: style.styleNameZh || style.styleName,
      styleNameEn: style.styleNameEn || '',
      description: style.description,
      category: style.category,
      aliases: style.aliases || '[]',
      source: style.source,
      version: style.version,
      styleCase: style.styleCase,
      packageDir: style.packageDir || '',
      styleSkill: style.styleSkill
    })
    const snapshot = await this.get(sessionId)
    if (!snapshot) throw new Error('Session style snapshot was not created')
    return snapshot
  }

  async createCustom(
    sessionId: string,
    input: SessionStyleSnapshotInput
  ): Promise<SessionStyleSnapshotRow> {
    const description = input.description?.trim() || ''
    await this.insert({
      sessionId,
      styleId: input.styleId,
      styleKey: input.styleKey,
      styleName: input.styleName,
      styleNameZh: input.styleNameZh || input.styleName,
      styleNameEn: input.styleNameEn || '',
      description,
      category: input.category || 'custom',
      aliases: input.aliases || '[]',
      source: input.source || 'custom',
      version: input.version || '1.0.0',
      styleCase: input.styleCase || '',
      packageDir: input.packageDir || '',
      styleSkill: input.styleSkill.trim() || description
    })
    const snapshot = await this.get(sessionId)
    if (!snapshot) throw new Error('Custom session style snapshot was not created')
    return snapshot
  }

  async delete(sessionId: string): Promise<void> {
    await this.db
      .delete(schema.sessionStyleSnapshots)
      .where(eq(schema.sessionStyleSnapshots.sessionId, sessionId))
      .run()
  }

  async replaceWithSnapshot(
    targetSessionId: string,
    source: SessionStyleSnapshotRow
  ): Promise<void> {
    await this.delete(targetSessionId)
    await this.insert({
      sessionId: targetSessionId,
      styleId: source.styleId,
      styleKey: source.styleKey,
      styleName: source.styleName,
      styleNameZh: source.styleNameZh || source.styleName,
      styleNameEn: source.styleNameEn || '',
      description: source.description,
      category: source.category,
      aliases: source.aliases,
      source: source.source,
      version: source.version,
      styleCase: source.styleCase,
      packageDir: source.packageDir || '',
      styleSkill: source.styleSkill
    })
  }

  private async insert(data: {
    sessionId: string
    styleId: string
    styleKey: string
    styleName: string
    styleNameZh: string
    styleNameEn: string
    description: string
    category: string
    aliases: string
    source: string
    version: string
    styleCase: string
    packageDir: string
    styleSkill: string
  }): Promise<void> {
    await this.db
      .insert(schema.sessionStyleSnapshots)
      .values({
        id: crypto.randomUUID(),
        ...data,
        version: normalizeStyleVersion(data.version),
        createdAt: Math.floor(Date.now() / 1000)
      })
      .onConflictDoNothing({ target: schema.sessionStyleSnapshots.sessionId })
      .run()
  }
}
