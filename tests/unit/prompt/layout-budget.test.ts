import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildCanvasConstraints } from '../../../src/main/agent-runtime/prompt'
import { resolveSlideSize } from '../../../src/shared/slide-size'

const projectRoot = process.cwd()

const readProjectFile = (filePath: string) =>
  readFileSync(path.join(projectRoot, filePath), 'utf-8')

describe('layout prompt budget guardrails', () => {
  it('keeps fullscreen backgrounds separate from conservative content budget', () => {
    const sharedPrompt = buildCanvasConstraints(resolveSlideSize({ id: 'wide-16-9' }))
    const layoutSkill = readProjectFile('resources/skills/amy-ppt-layout/SKILL.md')

    expect(sharedPrompt).toContain('背景可铺满 1600×900')
    expect(sharedPrompt).toContain('User Layout Profile')
    expect(sharedPrompt).toContain('文字安全区优先')
    expect(layoutSkill).toContain('Full-bleed backgrounds may use the entire 1600×900 canvas')
    expect(layoutSkill).toContain('safe area supplied by the User Layout Profile')
  })

  it('emits concrete padding floor and Tailwind class red line per canvas width', () => {
    const wide = buildCanvasConstraints(resolveSlideSize({ id: 'wide-16-9' }))
    // 1600px 宽 → 6% = 96px → Tailwind px-24
    expect(wide).toContain('至少 96px')
    expect(wide).toContain('px-24 或更大的值')
    expect(wide).toContain('N 小于 24 的水平 padding 都属违规')
    expect(wide).toContain('px-10/px-12/px-16/px-20 不允许')
    expect(wide).toContain('写入前自检 padding class')
  })

  it('prevents overpacked chart slides with two-row support grids', () => {
    const layoutSkill = readProjectFile('resources/skills/amy-ppt-layout/SKILL.md')
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')

    expect(layoutSkill).toContain('Overpacked chart slide guardrails')
    expect(layoutSkill).toContain('Do not create two-row bottom card grids below a tall chart')
    expect(layoutSkill).toContain('support modules are capped at 1-2 compact blocks')
    expect(layoutSkill).toContain('Content expansion does not override density')
    expect(chartSkill).toContain('Do not pair a standard/tall chart with a two-row bottom card grid')
    expect(chartReference).toContain('Never place a two-row bottom card grid under a standard/tall chart')
    expect(chartReference).toContain('0-2 compact blocks')
  })

  it('budgets axis-heavy charts instead of squeezing labels into nearby modules', () => {
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')
    const checklist = readProjectFile('resources/skills/amy-ppt-layout/references/checklist.md')
    const combined = [chartSkill, chartReference, checklist].join('\n')

    expect(combined).toContain('Axis-heavy')
    expect(combined).toContain('6+ categories')
    expect(combined).toContain('negative+positive')
    expect(combined).toContain('40-60px')
    expect(combined).toContain('layout.padding.bottom')
    expect(checklist).toContain('axis-heavy chart has no tick/label reserve')
  })

  it('keeps chart data semantically valid and interpreted', () => {
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')
    const combined = [chartSkill, chartReference].join('\n')

    expect(combined).toContain('one value axis = one unit/meaning')
    expect(combined).toContain('Do not mix counts, percentages, money')
    expect(combined).toContain('Do not put HTML')
    expect(combined).toContain('string-array labels')
    expect(combined).toContain('Chart slides need interpretation')
    expect(combined).toContain('one visible takeaway sentence')
    expect(combined).toContain('Do not repeat every category as equal-weight cards')
  })

  it('checklist gates the slide thesis at delivery time', () => {
    const checklist = readProjectFile('resources/skills/amy-ppt-layout/references/checklist.md')
    // Soul delivery gate: the self-check asks for the one memorable sentence,
    // so the thesis decided at planning is re-tested before the page ships.
    expect(checklist).toContain('single memorable message')
    expect(checklist).toContain('load-bearing structure')
  })

  it('delivery guard blocks top-heavy half-screen layouts across rewrite-capable paths', () => {
const scenarioPrompt = readProjectFile('src/main/agent-runtime/prompt/composers/canvas-scenario.ts')
const deckSystem = readProjectFile('src/main/agent-runtime/prompt/composers/deck-system.ts')
const generationUser = readProjectFile('src/main/agent-runtime/prompt/composers/generation-user.ts')
const editSystem = readProjectFile('src/main/agent-runtime/prompt/composers/edit-system.ts')

    expect(scenarioPrompt).toContain('buildCanvasScenarioDeliveryGuard')
    expect(scenarioPrompt).toContain('形服务于魂')
    expect(scenarioPrompt).toContain('3 秒可读的主旨')
    expect(scenarioPrompt).toContain('正文不能全部停在上半屏')
    expect(scenarioPrompt).toContain('220–280px')
    expect(scenarioPrompt).toContain('视觉重心可以略高于几何中心')
    expect(scenarioPrompt).toContain('首屏必须有吸引点')
    expect(scenarioPrompt).toContain('收藏价值')

    expect(deckSystem).toContain('buildCanvasScenarioDeliveryGuard')
    // Shared rules live in the system prompt only; user prompt is deduplicated.
    expect(generationUser).not.toContain('buildCanvasScenarioDeliveryGuard')

    const containerEdit = editSystem.slice(
      editSystem.indexOf('function buildContainerEditPrompt('),
      editSystem.indexOf('function buildSelectorEditPrompt(')
    )
    const selectorEdit = editSystem.slice(
      editSystem.indexOf('function buildSelectorEditPrompt('),
      editSystem.indexOf('function buildSinglePageEditPrompt(')
    )
    const singlePageEdit = editSystem.slice(
      editSystem.indexOf('function buildSinglePageEditPrompt('),
      editSystem.indexOf('function buildDeckEditPrompt(')
    )
    const deckEdit = editSystem.slice(editSystem.indexOf('function buildDeckEditPrompt('))

    expect(singlePageEdit).toContain('buildCanvasScenarioDeliveryGuard')
    expect(deckEdit).toContain('buildCanvasScenarioDeliveryGuard')
    expect(selectorEdit).not.toContain('buildCanvasScenarioDeliveryGuard')
    expect(containerEdit).not.toContain('buildCanvasScenarioDeliveryGuard')
  })

  it('keeps layout guidance density-driven and requires a pre-write size self-check', () => {
    const sharedPrompt = readProjectFile('src/main/agent-runtime/prompt/composers/shared.ts')
    const scenarioPrompt = readProjectFile('src/main/agent-runtime/prompt/composers/canvas-scenario.ts')
    const layoutSkill = readProjectFile('resources/skills/amy-ppt-layout/SKILL.md')
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')

    expect(layoutSkill).toContain('Self-check width/height')
    expect(layoutSkill).toContain('Width must fit 1600px and height must fit 900px')
    expect(layoutSkill).toContain('Do not mechanically reuse the same card grid')
    // Designer-mentality sketch (focal point / balance / intentional whitespace) +
    // the mechanics canvas block (distribute EXISTING content, no fill, density by content).
    expect(sharedPrompt).toContain('观众先看哪')
    expect(sharedPrompt).toContain('让版面协调')
    expect(sharedPrompt).toContain('对应逻辑画布宽 ${slideSize.width}px、高 ${slideSize.height}px')
    expect(sharedPrompt).toContain('不为填满而新增')
    expect(sharedPrompt).toContain('密度由内容决定')
    expect(sharedPrompt).toContain('内容够了就不扩展')
    expect(scenarioPrompt).toContain('过密先自我总结')
    expect(sharedPrompt).toContain('内容过多先总结再布局')
    expect(sharedPrompt).toContain('不要靠缩小字号、增加卡片、堆更多行')
    expect(layoutSkill).toContain('presentation-like breathing room')
    expect(layoutSkill).toContain('Source material is evidence; the slide is an edited message')
    expect(layoutSkill).toContain('not by mirroring the document')
    expect(layoutSkill).toContain('avoid repeating the same fact again as equal-weight summary cards')
    expect(layoutSkill).toContain('pause before writing HTML and self-summarize')
    expect(layoutSkill).toContain('do not turn every fact into a visible card')
    expect(layoutSkill).toContain('Before expanding, decide whether the page is truly sparse')
    expect(layoutSkill).toMatch(/do \*\*not\*\* add more cards or a second summary layer/i)
    // Chart height marker contract stays in the always-on canvas block; the
    // column-width / chart-slot calc detail lives in the chart skill (asserted below).
    expect(sharedPrompt).toContain('@ppt-chart-height=N')
    expect(layoutSkill).toMatch(/Pair a modest chart with right-sized support/i)
    expect(layoutSkill).toContain('Supplement lightly from the source material')
    expect(layoutSkill).toContain('columns share width, not height')
    expect(layoutSkill).toContain('@ppt-chart-height=N')
    expect(chartSkill).toContain('redesign the chart/support relationship')
    expect(chartSkill).toContain('do not subtract a left metric rail from a right-column chart height')
    expect(chartSkill).toContain('Never put `@ppt-chart-height=...` as visible text')
    expect(chartSkill).toContain('Do not calculate a 600+ slot and then choose 340px')
    expect(chartSkill).toContain('@ppt-chart-height=N')
    expect(chartReference).toContain('redesign the chart/support relationship')
    expect(chartReference).toContain('do not subtract a left metric rail from a right-column chart height')
    expect(chartReference).toContain('Never put `@ppt-chart-height=...` as visible text')
    expect(chartReference).toContain('Do not calculate a 600+ slot and then choose 340px')
    expect(chartReference).toContain('@ppt-chart-height=N')

    const combinedPrompt = [sharedPrompt, layoutSkill, chartSkill, chartReference].join('\n')
    expect(combinedPrompt).not.toContain('cut content')
    expect(combinedPrompt).not.toContain('move support modules to another slide')
    expect(combinedPrompt).not.toContain('split the content')
    expect(combinedPrompt).not.toContain('放不下就减模块')
    expect(combinedPrompt).not.toContain('每个模块（图表/表格/卡片行/列表）都要填满')
  })

  it('chart skill avoids tiny charts without forcing dense support content', () => {
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')
    const combined = [chartSkill, chartReference].join('\n')
    // The old calc told the model to cap the chart at the role range and
    // "leave the spare space empty" — that is what produced half-empty chart
    // pages (e.g. a 692px slot capped at 400px, 292px left empty).
    expect(combined).not.toMatch(/simply leave it empty/i)
    expect(combined).not.toMatch(/min\([^)]*cap\)/i)
    expect(combined).not.toMatch(/340.?420/)
    // Hero/main charts still have room to be dominant.
    expect(combined).toMatch(/380.?560/)
    expect(combined).toMatch(/primary evidence/i)
    expect(combined).toContain('support the content actually needs')
    expect(combined).toContain('0-2 support items')
    // Two distinct terms: content slot (chart + support area) vs chart slot
    // (content slot − support). The final h-[Npx] must equal the chart slot, so
    // the model does not fill the content slot and then add support on top.
    expect(combined).toMatch(/content slot/i)
    expect(combined).toMatch(/chart slot/i)
    expect(combined).toMatch(/equal the chart slot/i)
    // Real failure observed in generated pages: the comment calculated a hero
    // chart height, but the actual frame class was written back to h-[240px].
    expect(combined).toMatch(/chart height = 420/i)
    expect(combined).toMatch(/h-\[240px\]/i)
  })

  it('keeps body and heading font floors semantic while exempting auxiliary text', () => {
    const sharedPrompt = readProjectFile('src/main/agent-runtime/prompt/composers/shared.ts')
    const layoutSkill = readProjectFile('resources/skills/amy-ppt-layout/SKILL.md')
    const checklist = readProjectFile('resources/skills/amy-ppt-layout/references/checklist.md')
    const combined = [sharedPrompt, layoutSkill, checklist].join('\n')

    expect(combined).toContain('text-lg')
    expect(combined).toContain('18px')
    expect(combined).toContain('text-2xl')
    expect(combined).toContain('24px')
    expect(combined).toContain('data-ppt-text-role="auxiliary"')
    expect(layoutSkill).toContain('this is a floor, not a fixed heading size')
    expect(layoutSkill).toContain('Decorative chips, badges, status tags')
    expect(sharedPrompt).toContain('优先使用 User Layout Profile 的字号目标')
    expect(checklist).toContain('may be 12–17px')
    expect(combined).toContain('auxiliary text below 12px')
    expect(combined).not.toContain('text-base(16px)')
    expect(combined).not.toContain('text-base` (16px) is the floor')
  })

  it('every canonical copy-this chart example carries @ppt-chart-height matching its h-[Npx]', () => {
    const chartSkill = readProjectFile('resources/skills/amy-ppt-chart/SKILL.md')
    const chartReference = readProjectFile('resources/skills/amy-ppt-chart/references/chart.md')

    // The model copies these examples verbatim, so a canonical example that omits
    // the marker (or whose marker disagrees with the class) silently breaks the
    // marker↔class contract the validator enforces. Match a marker comment that
    // sits directly above an h-[Npx] frame, and require marker N == class N.
    const cases: Array<[string, string]> = [
      ['SKILL.md', chartSkill],
      ['chart.md', chartReference]
    ]
    for (const [name, source] of cases) {
      const match = source.match(
        /@ppt-chart-height=(\d+)[^\n]*\n\s*<div class="ppt-chart-frame[^"]*h-\[(\d+)px\]/
      )
      expect(
        match,
        `${name} canonical example must carry @ppt-chart-height directly above its h-[Npx] frame`
      ).not.toBeNull()
      expect(
        match![1],
        `${name} canonical example marker value must equal its h-[Npx] class`
      ).toBe(match![2])
    }
  })
})
