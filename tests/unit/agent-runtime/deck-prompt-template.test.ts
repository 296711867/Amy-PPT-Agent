import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildDeckAgentSystemPrompt } from '../../../src/main/agent-runtime/prompt'
import type { SessionDeckGenerationContext } from '../../../src/main/agent-runtime/agent'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const baseContext: SessionDeckGenerationContext = {
  sessionId: 'session-1',
  projectDir: '/tmp/project',
  indexPath: '/tmp/project/index.html',
  pageFileMap: { 'page-1': '/tmp/project/page-1.html' },
  topic: 'Quarterly report',
  deckTitle: 'Quarterly report',
  styleId: 'test-style',
  styleSkillPrompt: 'Use a clean business style.',
  userMessage: 'Create a quarterly report.',
  outlineTitles: ['Overview'],
  outlineItems: [{ title: 'Overview', contentOutline: 'Summarize the quarter.' }],
  slideSize: resolveSlideSize({ id: 'wide-16-9' }),
  appLocale: 'en'
}

describe('deck system prompt template', () => {
  it('renders the static deck contract from Markdown without unresolved placeholders', () => {
    const composer = fs.readFileSync(
      path.resolve('src/main/agent-runtime/prompt/composers/deck-system.ts'),
      'utf8'
    )
    const template = fs.readFileSync(
      path.resolve('src/main/agent-runtime/prompt/templates/deck-system/system.md'),
      'utf8'
    )
    const prompt = buildDeckAgentSystemPrompt('test-style', baseContext)

    expect(composer).toContain("deckSystemTemplate from '../templates/deck-system/system.md?raw'")
    expect(composer).toContain('createPromptCatalog<DeckSystemTemplateVars>')
    expect(template).toContain('## Hard failure avoidance')
    expect(template).toContain('## 最终风格校准（写入前）')
    expect(prompt).toContain('## Hard failure avoidance')
    expect(prompt).toContain('## 最终风格校准（写入前）')
    expect(prompt).not.toMatch(/\{\{[^}]+\}\}/)
  })

  it('keeps template and source-document branches in the typed composer', () => {
    const prompt = buildDeckAgentSystemPrompt('test-style', {
      ...baseContext,
      templatePageReadRequired: true,
      selectedPageId: 'page-1',
      selectedPageNumber: 1,
      sourceDocumentPaths: ['/docs/source.md']
    })

    expect(prompt).toContain('## 模板还原优先')
    expect(prompt).not.toContain('## 创意变化')
    expect(prompt).toContain('## Source documents')
    expect(prompt).toContain('- /docs/source.md')
    expect(prompt).toContain('update_template_page_file')
  })

  it('keeps the single-page system prompt stable across pages in the same deck', () => {
    const pageOnePrompt = buildDeckAgentSystemPrompt('test-style', {
      ...baseContext,
      mode: 'generate',
      selectedPageId: 'page-1',
      selectedPageNumber: 1,
      pageFileMap: { 'page-1': '/tmp/project/page-1.html' },
      outlineTitles: ['Overview'],
      outlineItems: [{ title: 'Overview', contentOutline: 'Summarize the quarter.' }],
      sourceDocumentPaths: ['/docs/source.md']
    })
    const pageTwoPrompt = buildDeckAgentSystemPrompt('test-style', {
      ...baseContext,
      mode: 'generate',
      selectedPageId: 'page-2',
      selectedPageNumber: 2,
      pageFileMap: { 'page-2': '/tmp/project/page-2.html' },
      outlineTitles: ['Forecast'],
      outlineItems: [{ title: 'Forecast', contentOutline: 'Explain the next-quarter forecast.' }],
      sourceDocumentPaths: ['/docs/source.md']
    })

    expect(pageOnePrompt).toBe(pageTwoPrompt)
    expect(pageOnePrompt).not.toContain('page-1')
    expect(pageOnePrompt).not.toContain('Summarize the quarter.')
    expect(pageOnePrompt).toContain('target page identified in the user message')
  })
})
