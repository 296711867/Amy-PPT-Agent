import { desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../schema'
import type { HtmlEditDocument, HtmlEditMessage, HtmlEditVersion } from '../schema'

export interface CreateHtmlEditDocumentInput {
  id: string
  title: string
  sourcePath?: string | null
  htmlPath: string
  designWidth: number
  createdAt: number
  updatedAt: number
}

export interface CreateHtmlEditMessageInput {
  id: string
  docId: string
  role: 'user' | 'assistant'
  content: string
  intent?: string | null
  planJson?: string | null
  requiresConfirmation?: boolean
  selectedElement?: {
    selector: string
    label?: string
    elementTag?: string
    elementText?: string
  } | null
  createdAt: number
}

export interface CreateHtmlEditVersionInput {
  id: string
  docId: string
  commitSha: string
  message: string
  createdAt: number
}

export interface CreateHtmlEditDocumentWithVersionInput {
  document: CreateHtmlEditDocumentInput
  version: Omit<CreateHtmlEditVersionInput, 'docId'>
}

export class HtmlEditorRepository {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}

  async createDocument(data: CreateHtmlEditDocumentInput): Promise<void> {
    await this.db.insert(schema.htmlEditDocuments).values({
      ...data,
      sourcePath: data.sourcePath ?? null
    })
  }

  async touchDocument(docId: string, updatedAt: number): Promise<void> {
    await this.db
      .update(schema.htmlEditDocuments)
      .set({ updatedAt })
      .where(eq(schema.htmlEditDocuments.id, docId))
  }

  async createMessage(data: CreateHtmlEditMessageInput): Promise<void> {
    const selectedElement = data.selectedElement?.selector ? data.selectedElement : null
    await this.db
      .insert(schema.htmlEditMessages)
      .values({
        id: data.id,
        docId: data.docId,
        role: data.role,
        content: data.content,
        intent: data.intent ?? null,
        planJson: data.planJson ?? null,
        requiresConfirmation: data.requiresConfirmation ? 1 : 0,
        selectedSelector: selectedElement?.selector.slice(0, 2_000) ?? null,
        selectedLabel: selectedElement?.label?.slice(0, 500) ?? null,
        selectedElementTag: selectedElement?.elementTag?.slice(0, 80) ?? null,
        selectedElementText: selectedElement?.elementText?.slice(0, 2_000) ?? null,
        createdAt: data.createdAt
      })
      .run()
  }

  async listMessages(docId: string, limit = 100): Promise<HtmlEditMessage[]> {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500))
    const rows = await this.db
      .select()
      .from(schema.htmlEditMessages)
      .where(eq(schema.htmlEditMessages.docId, docId))
      .orderBy(desc(schema.htmlEditMessages.createdAt))
      .limit(safeLimit)
      .all()
    return rows.reverse()
  }

  async clearMessages(docId: string): Promise<void> {
    await this.db
      .delete(schema.htmlEditMessages)
      .where(eq(schema.htmlEditMessages.docId, docId))
      .run()
  }

  async createVersion(data: CreateHtmlEditVersionInput): Promise<void> {
    await this.db.insert(schema.htmlEditVersions).values(data)
  }

  async createDocumentWithVersion(data: CreateHtmlEditDocumentWithVersionInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.htmlEditDocuments).values({
        ...data.document,
        sourcePath: data.document.sourcePath ?? null
      })
      await tx.insert(schema.htmlEditVersions).values({
        ...data.version,
        docId: data.document.id
      })
    })
  }

  async createVersionAndTouch(data: CreateHtmlEditVersionInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.htmlEditVersions).values(data)
      await tx
        .update(schema.htmlEditDocuments)
        .set({ updatedAt: data.createdAt })
        .where(eq(schema.htmlEditDocuments.id, data.docId))
    })
  }

  async listVersions(docId: string): Promise<HtmlEditVersion[]> {
    return this.db
      .select()
      .from(schema.htmlEditVersions)
      .where(eq(schema.htmlEditVersions.docId, docId))
      .orderBy(desc(schema.htmlEditVersions.createdAt))
  }

  async getVersion(versionId: string): Promise<HtmlEditVersion | undefined> {
    const rows = await this.db
      .select()
      .from(schema.htmlEditVersions)
      .where(eq(schema.htmlEditVersions.id, versionId))
      .limit(1)
    return rows[0]
  }

  async listDocuments(): Promise<HtmlEditDocument[]> {
    return this.db
      .select()
      .from(schema.htmlEditDocuments)
      .orderBy(desc(schema.htmlEditDocuments.updatedAt))
  }

  async getDocument(docId: string): Promise<HtmlEditDocument | undefined> {
    const rows = await this.db
      .select()
      .from(schema.htmlEditDocuments)
      .where(eq(schema.htmlEditDocuments.id, docId))
      .limit(1)
    return rows[0]
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.db.delete(schema.htmlEditVersions).where(eq(schema.htmlEditVersions.docId, docId))
    await this.db.delete(schema.htmlEditDocuments).where(eq(schema.htmlEditDocuments.id, docId))
  }
}
