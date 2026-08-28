import type { SessionStyleSnapshotInput } from '../db/records'

export interface AiStyleSelection {
  mode: 'ai'
  description: string
  themeColors: string[]
}

const MAX_DESCRIPTION_LENGTH = 4000
const MAX_THEME_COLORS = 8
const MAX_THEME_COLOR_LENGTH = 80

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const normalizeThemeColors = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return Array.from(
    new Set(
      values
        .map((item) =>
          String(item || '')
            .trim()
            .slice(0, MAX_THEME_COLOR_LENGTH)
        )
        .filter(Boolean)
    )
  ).slice(0, MAX_THEME_COLORS)
}

export const buildAiStyleKey = (sessionId: string): string => {
  const suffix = sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'session'
  return `ai-generated-${suffix}`
}

/** Normalize untrusted IPC data without making the renderer the source of truth. */
export const normalizeAiStyleSelection = (value: unknown): AiStyleSelection | null => {
  const record = asRecord(value)
  if (!record || record.mode !== 'ai') return null
  const description =
    typeof record.description === 'string'
      ? record.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : ''
  if (!description) return null
  return {
    mode: 'ai',
    description,
    themeColors: normalizeThemeColors(record.themeColors ?? record.colors)
  }
}

const formatSourcePlan = (sourcePlan: unknown): string => {
  const record = asRecord(sourcePlan)
  const pages = record && Array.isArray(record.pageSkeleton) ? record.pageSkeleton : []
  if (pages.length === 0) return 'No parsed source outline was supplied.'
  return pages
    .slice(0, 100)
    .map((page, index) => {
      const item = asRecord(page) || {}
      const title = String(item.title || `Page ${index + 1}`).trim()
      const role = String(item.role || '').trim()
      const reason = String(item.reason || '').trim()
      return `${index + 1}. ${title}${role ? ` [${role}]` : ''}${reason ? ` - ${reason}` : ''}`
    })
    .join('\n')
}

export const buildAiStylePrompt = (args: {
  selection: AiStyleSelection
  topic: string
  sourcePlan?: unknown
  referenceDocumentPath?: string | null
}): string => {
  const colors =
    args.selection.themeColors.length > 0
      ? args.selection.themeColors.join(', ')
      : 'No fixed colors; derive a restrained palette from the direction and content.'
  const reference = args.referenceDocumentPath
    ? `A reference/template document is available in the session at ${args.referenceDocumentPath}.`
    : 'No separate reference/template document was supplied.'

  return [
    '# Session-specific AI-generated visual style',
    'This session uses an original visual system synthesized for this presentation. It is not a fixed catalog preset and must not be replaced by a generic preset.',
    '',
    '## Inputs',
    `User style direction: ${args.selection.description}`,
    `Theme color anchors: ${colors}`,
    `Presentation topic: ${args.topic || 'Untitled'}`,
    reference,
    'Parsed source outline (content and requirements):',
    formatSourcePlan(args.sourcePlan),
    '',
    '## Derivation rules',
    'Use the inputs above together with the current user prompt, page content, requirements, source materials, and any reference/template pages to invent one coherent design system for this session.',
    'Derive and keep consistent: title, subtitle, and body typography; palette roles, contrast, and accessible text colors; background treatment; shape and border language; image subject, crop, and treatment; page grid and composition; whitespace rhythm; chart/table treatment; and restrained decorative motifs.',
    'Treat a reference/template as visual and structural evidence, not as a source of text to copy. Let the topic and page meaning determine imagery and layout while preserving the requested style direction.',
    'Use the supplied theme colors as anchors when present, adding supporting neutrals or accents only when needed for contrast and hierarchy. Prefer a small intentional palette over arbitrary colors.',
    'The resulting design contract is the source of truth for every page, including retries and edits. Maintain visual continuity while allowing page-specific layouts that serve the content.',
    '',
    '## Output guidance',
    'When describing or applying the style, be concrete and implementation-oriented. State exact font character, color roles, shape language, image art direction, composition rules, and decoration limits. Do not mention or select a built-in style by name.'
  ].join('\n')
}

export const buildAiSessionStyleSnapshot = (args: {
  sessionId: string
  selection: AiStyleSelection
  topic: string
  sourcePlan?: unknown
  referenceDocumentPath?: string | null
}): SessionStyleSnapshotInput => ({
  styleId: `ai-${args.sessionId}`,
  styleKey: buildAiStyleKey(args.sessionId),
  styleName: 'AI-generated style',
  styleNameZh: 'AI 自定义风格',
  styleNameEn: 'AI-generated style',
  description: args.selection.description,
  category: 'ai-generated',
  aliases: JSON.stringify(['ai', 'custom']),
  source: 'custom',
  version: '1.0.0',
  styleCase: '',
  packageDir: '',
  styleSkill: buildAiStylePrompt(args)
})
