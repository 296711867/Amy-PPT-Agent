import crypto from 'crypto'
import { desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type { ProjectRecord } from '../records'

export interface CreateProjectInput {
  session_id: string
  title: string
  output_path: string
  root_path?: string | null
}

export type ProjectStatus = ProjectRecord['status']

export class ProjectRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async create(data: CreateProjectInput): Promise<string> {
    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await this.db
      .insert(schema.projects)
      .values({
        id,
        sessionId: data.session_id,
        title: data.title,
        outputPath: data.output_path,
        rootPath: data.root_path || data.output_path,
        fileCount: 0,
        totalSize: 0,
        status: 'draft',
        createdAt: now,
        updatedAt: now
      })
      .run()
    return id
  }

  async getLatestForSession(sessionId: string): Promise<ProjectRecord | undefined> {
    const row = await this.db
      .select({
        id: schema.projects.id,
        session_id: schema.projects.sessionId,
        title: schema.projects.title,
        output_path: schema.projects.outputPath,
        root_path: schema.projects.rootPath,
        file_count: schema.projects.fileCount,
        total_size: schema.projects.totalSize,
        status: schema.projects.status,
        created_at: schema.projects.createdAt,
        updated_at: schema.projects.updatedAt
      })
      .from(schema.projects)
      .where(eq(schema.projects.sessionId, sessionId))
      .orderBy(desc(schema.projects.createdAt))
      .limit(1)
      .get()
    return row as ProjectRecord | undefined
  }

  async updateStatus(projectId: string, status: ProjectStatus): Promise<void> {
    await this.db
      .update(schema.projects)
      .set({ status, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.projects.id, projectId))
      .run()
  }

  async updateTitleForSession(sessionId: string, title: string, updatedAt: number): Promise<void> {
    await this.db
      .update(schema.projects)
      .set({ title, updatedAt })
      .where(eq(schema.projects.sessionId, sessionId))
      .run()
  }
}
