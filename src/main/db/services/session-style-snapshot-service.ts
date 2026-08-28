import type {
  SessionStyleSnapshotInput,
  SessionStyleSnapshotRow,
  StyleRow
} from '../records'
import type { SessionStyleSnapshotRepository } from '../repositories/session-style-snapshot-repository'

interface SnapshotSession {
  id: string
  styleId: string | null
  metadata: string | null
}

interface SessionStyleSnapshotServiceDependencies {
  repository: SessionStyleSnapshotRepository
  getSession: (sessionId: string) => Promise<SnapshotSession | undefined>
  resolveCatalogStyle: (styleId?: string | null) => StyleRow
}

const parseSessionMetadata = (value: string | null | undefined): Record<string, unknown> => {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export const buildAiStyleSnapshotInput = (
  sessionId: string,
  session: Pick<SnapshotSession, 'styleId' | 'metadata'> | undefined
): SessionStyleSnapshotInput | null => {
  const selection = parseSessionMetadata(session?.metadata).styleSelection
  if (
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    (selection as Record<string, unknown>).mode !== 'ai'
  ) {
    return null
  }

  const record = selection as Record<string, unknown>
  const description = String(record.description || '').trim()
  if (!description) return null
  const themeColors = Array.isArray(record.themeColors)
    ? record.themeColors.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const styleKeySuffix = sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'session'

  return {
    styleId: session?.styleId || `ai-${sessionId}`,
    styleKey: `ai-generated-${styleKeySuffix}`,
    styleName: 'AI-generated style',
    styleNameZh: 'AI 自定义风格',
    styleNameEn: 'AI-generated style',
    description,
    category: 'ai-generated',
    aliases: JSON.stringify(['ai', 'custom']),
    source: 'custom',
    version: '1.0.0',
    styleSkill: [
      '# Session-specific AI-generated visual style',
      `User style direction: ${description}`,
      `Theme color anchors: ${themeColors.join(', ') || 'derive from the direction and content.'}`,
      'Derive typography, palette roles, shape language, image direction, composition, whitespace, charts, and decoration from the current topic, prompt, content, requirements, and reference/template. Keep this exact session style consistent across generation, retries, and edits. Do not replace it with a built-in preset.'
    ].join('\n')
  }
}

export class SessionStyleSnapshotService {
  constructor(private readonly dependencies: SessionStyleSnapshotServiceDependencies) {}

  async createFromCatalog(
    sessionId: string,
    styleId?: string | null
  ): Promise<SessionStyleSnapshotRow> {
    return this.dependencies.repository.createFromCatalog(
      sessionId,
      this.dependencies.resolveCatalogStyle(styleId)
    )
  }

  async createCustom(
    sessionId: string,
    input: SessionStyleSnapshotInput
  ): Promise<SessionStyleSnapshotRow> {
    return this.dependencies.repository.createCustom(sessionId, input)
  }

  async replaceFromCatalog(
    sessionId: string,
    styleId?: string | null
  ): Promise<SessionStyleSnapshotRow> {
    await this.dependencies.repository.delete(sessionId)
    return this.createFromCatalog(sessionId, styleId)
  }

  async getOrCreate(sessionId: string): Promise<SessionStyleSnapshotRow> {
    const existing = await this.dependencies.repository.get(sessionId)
    if (existing) return existing
    const session = await this.dependencies.getSession(sessionId)
    const aiInput = buildAiStyleSnapshotInput(sessionId, session)
    return aiInput
      ? this.dependencies.repository.createCustom(sessionId, aiInput)
      : this.createFromCatalog(sessionId, session?.styleId)
  }

  async copy(sourceSessionId: string, targetSessionId: string): Promise<void> {
    const source = await this.getOrCreate(sourceSessionId)
    await this.dependencies.repository.replaceWithSnapshot(targetSessionId, source)
  }
}
