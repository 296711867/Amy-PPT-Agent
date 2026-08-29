import { describe, expect, it } from 'vitest'
import {
  buildDeckAgentSystemPrompt,
  buildSinglePageAgentUserPrompt,
  measurePromptText,
  SOURCE_UNSUPPORTED_CLAIMS
} from '../../../src/main/agent-runtime/prompt'
import { estimateTextTokens } from '../../../src/main/agent-runtime/token-estimate'
import type { SessionDeckGenerationContext } from '../../../src/main/agent-runtime/agent'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const slideSize = resolveSlideSize({ id: 'wide-16-9' })
const sourceDocumentPaths = ['/docs/requirements.md', '/docs/q3-metrics.csv']

type BenchPage = Parameters<typeof buildSinglePageAgentUserPrompt>[0]['page']

// 与 agent-runner 单页运行时相同的上下文形状：deck 级字段恒定，逐页字段只进 user prompt。
const buildSinglePageContext = (page: BenchPage): SessionDeckGenerationContext => ({
  sessionId: 'session-bench',
  projectDir: '/tmp/project',
  indexPath: '/tmp/project/index.html',
  pageFileMap: { [page.pageId]: `/tmp/project/${page.pageId}.html` },
  pageNumbers: { [page.pageId]: page.pageNumber },
  topic: 'Q3 business review',
  deckTitle: 'Q3 Business Review',
  styleId: 'test-style',
  styleSkillPrompt: 'Clean business style with a calm blue palette.',
  userMessage: 'Generate the Q3 review deck from the attached documents.',
  outlineTitles: [page.title],
  outlineItems: [
    {
      title: page.title,
      contentOutline: page.outline,
      layoutIntent: page.layoutIntent,
      layoutId: page.layoutId,
      layoutPrompt: page.layoutPrompt,
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths
    }
  ],
  sourceDocumentPaths,
  slideSize,
  appLocale: 'en',
  mode: 'generate',
  selectedPageId: page.pageId,
  selectedPageNumber: page.pageNumber,
  existingPageIds: [page.pageId],
  allowedPageIds: [page.pageId]
})

const chartLayoutPrompt =
  'Selected layout master: Chart with takeaway (data-chart-side).\nTreat this as a flexible information architecture, not a pixel-for-pixel template.'

const benchPages: BenchPage[] = [
  {
    pageId: 'pg-01-cover',
    pageNumber: 1,
    // 与 deckTitle 刻意不同：deck 级标题合法地留在 system prompt，逐页标题不该出现。
    title: 'Welcome to the Q3 Review',
    outline: 'Open with the quarter thesis and the three headline outcomes.'
  },
  {
    pageId: 'pg-02-toc',
    pageNumber: 2,
    title: 'Agenda',
    outline: 'List the five chapters of the review.'
  },
  {
    pageId: 'pg-03-agenda',
    pageNumber: 3,
    title: 'Chapter 1 · Growth',
    outline: 'Page role: section-agenda\n- Acquisition\n- Retention\n- Expansion'
  },
  {
    pageId: 'pg-04-revenue',
    pageNumber: 4,
    title: 'Q3 Revenue Highlights',
    outline:
      'Revenue grew 18% QoQ to $42.7M.\n- Enterprise +24%\n- SMB +9%\n- Churn down to 1.8%\nSource range: lines 120-180'
  },
  {
    pageId: 'pg-05-funnel',
    pageNumber: 5,
    title: 'Acquisition Funnel',
    outline: 'Visits 1.2M, signups 96K, activated 41K, paid 6.2K.\nCompare against Q2 baselines.',
    layoutId: 'data-chart-side',
    layoutPrompt: chartLayoutPrompt,
    layoutIntent: 'data-focus'
  },
  {
    pageId: 'pg-06-retention',
    pageNumber: 6,
    title: 'Retention Cohorts',
    outline: 'NDR 112%. Top quartile accounts retain 97% at month 12.',
    layoutId: 'data-chart-side',
    layoutPrompt: chartLayoutPrompt,
    layoutIntent: 'data-focus',
    moduleCount: 3,
    contentStructure: 'chart-plus-takeaway',
    visualAspect: 'landscape'
  },
  {
    pageId: 'pg-07-story',
    pageNumber: 7,
    title: 'Customer Story: Northwind',
    outline: 'How Northwind cut onboarding time from 6 weeks to 9 days.',
    layoutId: 'one-text-editorial'
  },
  {
    pageId: 'pg-08-expansion',
    pageNumber: 8,
    title: 'Expansion Plays',
    outline: 'Four plays: security add-ons, SSO tier, data residency, API tier.',
    imageAssetPaths: ['assets/gen/expansion-1.png', 'assets/gen/expansion-2.png']
  },
  {
    pageId: 'pg-09-risks',
    pageNumber: 9,
    title: 'Risks and Mitigations',
    outline: 'Concentration risk, pipeline coverage, hiring lag.',
    layoutId: 'three-cards-row',
    moduleCount: 3
  },
  {
    pageId: 'pg-10-next',
    pageNumber: 10,
    title: 'Next Quarter Plan',
    outline: 'Three commitments with owners and dates.'
  }
]

// 优化前 user prompt 尾部被删除的静态规则段（与当时 generation-user.ts 逐字一致，
// SOURCE_UNSUPPORTED_CLAIMS 按原样插值）。保留它只是为了和老版本做同口径对比。
const legacyRemovedStaticText = [
  'Required content enrichment decision before writing:',
  '- First use the Canvas scenario rules (in the system prompt) to decide the page form and focal message; then use the scenario expansion rules (also in the system prompt) only to decide whether the content itself needs enrichment or optimization.',
  '- If the content points are only a title, one short sentence, or 1-2 seed phrases, the page is thin: enrich the warranted structure before writing the final content.',
  '- If the content points already contain enough facts, the page is not thin: group and compress instead of adding more visible modules.',
  '- This content decision happens before animation and final HTML; animation is downstream only and must follow the current canvas scenario, source grounding, and warranted content enrichment.',
  '',
  'Expansion selection guardrails:',
  '- Treat content points as short seed phrases, not as a checklist that must become one visible card/row per point. Decide which points are primary, grouped support, compact annotations, or lower-priority detail based on the slide title, source range, and available space.',
  '- When source documents are present, expansion must be source-grounded: if inspected material is thin, enrich the slide from inspected material; if it is dense, summarize and group.',
  `- Do not add generic industry framing, unsupported ${SOURCE_UNSUPPORTED_CLAIMS}, or polished-sounding conclusions that are absent from the source document.`,
  '- Do not duplicate the same source facts in multiple large modules. If a fact appears in a timeline/table/chart, do not repeat it again as a separate summary card unless it is the single hero message of the slide.',
  '- When there are many same-level points, preserve the main meaning by grouping related points and surfacing only the amount that fits a real slide with breathing room.',
  '- When the user provided an explicit list of same-level topics, keep them distinct only where the layout allows; otherwise group under shared headings instead of creating equal-weight modules for every item.',
  '- Prefer visualization-friendly expression. When points involve trends, comparisons, or proportions, use charts or data cards when appropriate.',
  '',
  'Single-slide tool constraints:',
  '- This is not optional. A final text response without a successful write-tool call means the slide is not generated.',
  '- Do not call update_page_file. In this single-slide run it is intentionally not available.',
  '- content must be a complete creative page fragment. The tool will wrap it with section[data-page-scaffold], main[data-role="content"], editable data-block-id attributes, and the runtime page frame when needed.',
  '- The content must not contain <!doctype>, <html>, <head>, <body>, .ppt-page-root, .ppt-page-content, .ppt-page-fit-scope, or data-ppt-guard-root.',
  '- The content must be complete and balanced: close your main layout containers and leave no unfinished trailing tags.',
  '- After the tool call succeeds, final response should be a short summary only. Do not paste the HTML in the final response.',
  '- Do not modify other pages.',
  '',
  'Tool context (pre-injected):',
  '- Agent workspace root: /'
].join('\n')

describe('deck prompt cost benchmark', () => {
  it('keeps the system prompt byte-identical across every page of one deck', () => {
    const prompts = benchPages.map((page) => buildDeckAgentSystemPrompt('test-style', buildSinglePageContext(page)))
    const fingerprints = prompts.map((prompt) => measurePromptText(prompt).fingerprint)

    expect(new Set(fingerprints).size).toBe(1)
    expect(new Set(prompts).size).toBe(1)
    // 逐页变量绝不进 system prompt（pageId / 标题 / 大纲 / 目标文件路径）。
    for (const page of benchPages) {
      const systemPrompt = prompts[0]
      expect(systemPrompt).not.toContain(page.pageId)
      expect(systemPrompt).not.toContain(page.title)
      expect(systemPrompt).not.toContain(page.outline)
      expect(systemPrompt).not.toContain(`${page.pageId}.html`)
    }
    // 章节目录页豁免源文档读取的规则在 system，判定依据在 user prompt。
    expect(prompts[0]).toContain('section agenda, do not inspect source documents')
  })

  it('keeps template-mode runs equally stable per deck', () => {
    const templateContexts = benchPages.slice(0, 6).map((page) => ({
      ...buildSinglePageContext(page),
      templatePageReadRequired: true
    }))
    const prompts = templateContexts.map((context) =>
      buildDeckAgentSystemPrompt('test-style', context)
    )
    const fingerprints = prompts.map((prompt) => measurePromptText(prompt).fingerprint)

    expect(new Set(fingerprints).size).toBe(1)
    expect(prompts[0]).toContain('update_template_page_file')
  })

  it('still fingerprints distinctly per style content so the metric is sensitive', () => {
    const page = benchPages[3]
    const a = measurePromptText(
      buildDeckAgentSystemPrompt('test-style', {
        ...buildSinglePageContext(page),
        styleSkillPrompt: 'Clean business style with a calm blue palette.'
      })
    ).fingerprint
    const b = measurePromptText(
      buildDeckAgentSystemPrompt('test-style', {
        ...buildSinglePageContext(page),
        styleSkillPrompt: 'Warm editorial style with a serif display face.'
      })
    ).fingerprint

    expect(a).not.toBe(b)
  })

  it('quantifies the user-prompt savings of the dedup pass', () => {
    const removedTokens = estimateTextTokens(legacyRemovedStaticText)
    const rows = benchPages.map((page) => {
      const userPrompt = buildSinglePageAgentUserPrompt({
        topic: 'Q3 business review',
        deckTitle: 'Q3 Business Review',
        slideSize,
        page,
        // 章节目录页与源文档路径的过滤在 runner 侧完成，user prompt 收到的已是过滤结果。
        sourceDocumentPaths: page.pageId === 'pg-03-agenda' ? [] : sourceDocumentPaths,
        referenceDocumentSnippets:
          page.pageId === 'pg-04-revenue'
            ? 'Retrieved reference snippets:\n- L122: Revenue reached $42.7M, up 18% QoQ...\n- L131: Enterprise segment grew 24%.'
            : ''
      })
      const newTokens = measurePromptText(userPrompt).estimatedTokens
      return { pageId: page.pageId, newTokens, legacyTokens: newTokens + removedTokens }
    })

    // 优化前的静态尾部 ≈700 tokens；对每个页面它都是纯删除项。
    expect(removedTokens).toBeGreaterThanOrEqual(300)
    for (const row of rows) {
      const savings = 1 - row.newTokens / row.legacyTokens
      expect(savings, `${row.pageId} user prompt savings`).toBeGreaterThanOrEqual(0.15)
    }

    const systemTokens = measurePromptText(
      buildDeckAgentSystemPrompt('test-style', buildSinglePageContext(benchPages[0]))
    ).estimatedTokens
    const newUserTotal = rows.reduce((acc, row) => acc + row.newTokens, 0)
    const legacyUserTotal = rows.reduce((acc, row) => acc + row.legacyTokens, 0)

    // eslint-disable-next-line no-console
    console.log(
      '[prompt-cost-bench]',
      JSON.stringify({
        pages: rows.length,
        systemTokens,
        systemPromptsPerDeck: 1,
        newUserTokensPerDeck: newUserTotal,
        legacyUserTokensPerDeck: legacyUserTotal,
        userTokensSaved: legacyUserTotal - newUserTotal,
        userSavingsRatio: Number((1 - newUserTotal / legacyUserTotal).toFixed(3)),
        // system 跨页字节一致 → 同 deck 内 provider prompt cache 可命中，
        // 未命中时需要重发的 system tokens 为 (pages-1) * systemTokens。
        systemTokensCacheable: (rows.length - 1) * systemTokens
      })
    )
  })
})
