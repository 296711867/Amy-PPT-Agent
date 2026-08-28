import crypto from 'crypto'
import { desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import { normalizeThinkingParameterMode } from '@shared/model-config'
import * as schema from '../schema'
import type { ImageModelConfigRow, ModelConfigRow } from '../records'

export interface UpsertModelConfigInput {
  id?: string
  name: string
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  maxTokens?: number
  disableTemperature?: boolean
  thinkingParameterMode?: string
  active?: boolean
}

export interface UpsertImageModelConfigInput {
  id?: string
  name: string
  provider: string
  modelConfig: string
  active?: boolean
}

const readSettingValue = <T>(value: string): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return value as T
  }
}

export class ConfigRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async getSetting<T>(key: string): Promise<T | undefined> {
    const result = await this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get()
    return result ? readSettingValue<T>(result.value) : undefined
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const serialized = JSON.stringify(value)
    await this.db
      .insert(schema.settings)
      .values({ key, value: serialized, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: serialized, updatedAt: now }
      })
      .run()
  }

  async getAllSettings(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(schema.settings).all()
    return Object.fromEntries(rows.map((row) => [row.key, readSettingValue(row.value)]))
  }

  async listModelConfigs(): Promise<ModelConfigRow[]> {
    const rows = await this.db
      .select()
      .from(schema.modelConfigs)
      .orderBy(desc(schema.modelConfigs.active), desc(schema.modelConfigs.updatedAt))
      .all()
    return rows as ModelConfigRow[]
  }

  async getActiveModelConfig(): Promise<ModelConfigRow | undefined> {
    return this.getModelConfigBy(schema.modelConfigs.active, 1)
  }

  async getModelConfig(id: string): Promise<ModelConfigRow | undefined> {
    return this.getModelConfigBy(schema.modelConfigs.id, id)
  }

  private async getModelConfigBy(
    column: typeof schema.modelConfigs.active | typeof schema.modelConfigs.id,
    value: number | string
  ): Promise<ModelConfigRow | undefined> {
    const row = await this.db
      .select()
      .from(schema.modelConfigs)
      .where(eq(column, value))
      .limit(1)
      .get()
    return row as ModelConfigRow | undefined
  }

  async upsertModelConfig(data: UpsertModelConfigInput): Promise<string> {
    const id = data.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const values = {
      name: data.name,
      provider: data.provider,
      model: data.model,
      apiKey: data.apiKey,
      baseUrl: data.baseUrl,
      maxTokens: data.maxTokens || 4096,
      disableTemperature: data.disableTemperature ? 1 : 0,
      thinkingParameterMode: normalizeThinkingParameterMode(data.thinkingParameterMode),
      active: data.active ? 1 : 0,
      updatedAt: now
    }
    if (data.active) await this.deactivateModelConfigs(now)
    await this.db
      .insert(schema.modelConfigs)
      .values({ id, ...values, createdAt: now })
      .onConflictDoUpdate({ target: schema.modelConfigs.id, set: values })
      .run()
    return id
  }

  async setActiveModelConfig(id: string): Promise<void> {
    const existing = await this.getModelConfig(id)
    if (!existing) throw new Error('Model config does not exist')
    const now = Math.floor(Date.now() / 1000)
    await this.deactivateModelConfigs(now)
    await this.db
      .update(schema.modelConfigs)
      .set({ active: 1, updatedAt: now })
      .where(eq(schema.modelConfigs.id, id))
      .run()
  }

  private async deactivateModelConfigs(updatedAt: number): Promise<void> {
    await this.db
      .update(schema.modelConfigs)
      .set({ active: 0, updatedAt })
      .where(eq(schema.modelConfigs.active, 1))
      .run()
  }

  async deleteModelConfig(id: string): Promise<void> {
    if (!(await this.getModelConfig(id))) throw new Error('Model config does not exist')
    await this.db.delete(schema.modelConfigs).where(eq(schema.modelConfigs.id, id)).run()
  }

  async listImageModelConfigs(): Promise<ImageModelConfigRow[]> {
    const rows = await this.db
      .select()
      .from(schema.imageModelConfigs)
      .orderBy(desc(schema.imageModelConfigs.active), desc(schema.imageModelConfigs.updatedAt))
      .all()
    return rows as ImageModelConfigRow[]
  }

  async getActiveImageModelConfig(): Promise<ImageModelConfigRow | undefined> {
    return this.getImageModelConfigBy(schema.imageModelConfigs.active, 1)
  }

  async getImageModelConfig(id: string): Promise<ImageModelConfigRow | undefined> {
    return this.getImageModelConfigBy(schema.imageModelConfigs.id, id)
  }

  private async getImageModelConfigBy(
    column: typeof schema.imageModelConfigs.active | typeof schema.imageModelConfigs.id,
    value: number | string
  ): Promise<ImageModelConfigRow | undefined> {
    const row = await this.db
      .select()
      .from(schema.imageModelConfigs)
      .where(eq(column, value))
      .limit(1)
      .get()
    return row as ImageModelConfigRow | undefined
  }

  async upsertImageModelConfig(data: UpsertImageModelConfigInput): Promise<string> {
    const id = data.id || crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const values = {
      name: data.name,
      provider: data.provider,
      modelConfig: data.modelConfig,
      active: data.active ? 1 : 0,
      updatedAt: now
    }
    if (data.active) await this.deactivateImageModelConfigs(now)
    await this.db
      .insert(schema.imageModelConfigs)
      .values({ id, ...values, createdAt: now })
      .onConflictDoUpdate({ target: schema.imageModelConfigs.id, set: values })
      .run()
    return id
  }

  async setActiveImageModelConfig(id: string): Promise<void> {
    const existing = await this.getImageModelConfig(id)
    if (!existing) throw new Error('Image model config does not exist')
    const now = Math.floor(Date.now() / 1000)
    await this.deactivateImageModelConfigs(now)
    await this.db
      .update(schema.imageModelConfigs)
      .set({ active: 1, updatedAt: now })
      .where(eq(schema.imageModelConfigs.id, id))
      .run()
  }

  private async deactivateImageModelConfigs(updatedAt: number): Promise<void> {
    await this.db
      .update(schema.imageModelConfigs)
      .set({ active: 0, updatedAt })
      .where(eq(schema.imageModelConfigs.active, 1))
      .run()
  }

  async deleteImageModelConfig(id: string): Promise<void> {
    if (!(await this.getImageModelConfig(id))) throw new Error('Image model config does not exist')
    await this.db.delete(schema.imageModelConfigs).where(eq(schema.imageModelConfigs.id, id)).run()
  }
}
