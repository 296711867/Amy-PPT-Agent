import { describe, expect, it } from 'vitest'
import { buildDeckAgentSystemPrompt, buildEditAgentSystemPrompt } from '../../../src/main/agent-runtime/prompt'
import type { SessionDeckGenerationContext } from '../../../src/main/agent-runtime/agent'
import { buildLayoutRulesPrompt } from '../../../src/shared/layout-rules'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const layoutRulesPrompt = buildLayoutRulesPrompt({
  preset: 'consulting',
  compositionMode: 'native-ppt',
  enabledPatterns: ['staircase-strips', 'trend-exhibit'],
  expertMarkdown: '## Team layout rule\n- Lead with the conclusion.'
})

const baseContext: SessionDeckGenerationContext = {
  sessionId: 'session-layout-rules',
  projectDir: '/tmp/project',
  indexPath: '/tmp/project/index.html',
  pageFileMap: { 'page-1': '/tmp/project/page-1.html' },
  topic: 'Quarterly report',
  deckTitle: 'Quarterly report',
  styleId: 'test-style',
  styleSkillPrompt: 'Use a clean business style.',
  layoutRulesPrompt,
  userMessage: 'Create the report.',
  outlineTitles: ['Overview'],
  outlineItems: [{ title: 'Overview', contentOutline: 'Summarize the quarter.' }],
  slideSize: resolveSlideSize({ id: 'wide-16-9' }),
  appLocale: 'en'
}

describe('layout rules prompt injection', () => {
  it('injects the profile into deck generation', () => {
    const prompt = buildDeckAgentSystemPrompt('test-style', baseContext)

    expect(prompt).toContain('## User PPT Composition Profile')
    expect(prompt).toContain('dashboard shells')
    expect(prompt).toContain('trend-exhibit, staircase-strips')
    expect(prompt).toContain('### Web-layout failure check')
    expect(prompt).toContain('## Team layout rule')
    expect(prompt).toContain('system safety/canvas/export hard rules > explicit current edit request')
  })

  it('promotes the title band to a deck-level hard contract', () => {
    const prompt = buildLayoutRulesPrompt(
      {
        preset: 'consulting',
        compositionMode: 'native-ppt',
        enabledPatterns: ['staircase-strips']
      },
      resolveSlideSize({ id: 'wide-16-9' })
    )

    expect(prompt).toContain('- 标题带基准：')
    expect(prompt).toContain('对齐统一')
    expect(prompt).toContain('字号统一为 slide title 档')
    expect(prompt).toContain('要么整套都有、要么整套都没有')
    expect(prompt).toContain('不得更换标题位置、对齐或装饰形态')
    expect(prompt).not.toContain('标题位置和主视觉方向')
  })

  it('injects the profile into every edit scope', () => {
    const contexts: SessionDeckGenerationContext[] = [
      { ...baseContext, mode: 'edit', editScope: 'presentation-container' },
      {
        ...baseContext,
        mode: 'edit',
        editScope: 'page',
        selectedPageId: 'page-1',
        selectedSelector: '.metric'
      },
      {
        ...baseContext,
        mode: 'edit',
        editScope: 'page',
        selectedPageId: 'page-1'
      },
      { ...baseContext, mode: 'edit', editScope: 'deck', selectPageIds: ['page-1'] }
    ]

    for (const context of contexts) {
      const prompt = buildEditAgentSystemPrompt('test-style', context)
      expect(prompt).toContain('## User PPT Composition Profile')
      expect(prompt).toContain('## Team layout rule')
    }
  })

  it('does not add an empty profile section', () => {
    const prompt = buildDeckAgentSystemPrompt('test-style', {
      ...baseContext,
      layoutRulesPrompt: ''
    })

    expect(prompt).not.toContain('## User PPT Composition Profile')
  })
})
