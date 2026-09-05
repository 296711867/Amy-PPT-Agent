import { formatLayoutIntentPrompt } from '@shared/layout-intent'
import type { DesignContract } from '@shared/generation'
import type { SessionDeckGenerationContext } from '../../agent/types'
import { requireSlideSize, type SlideSizePreset } from '@shared/slide-size'
import {
  buildCanvasScenarioContentRules,
  buildCanvasScenarioDeliveryGuard,
  buildCanvasScenarioExpansionRules
} from './canvas-scenario'
import {
  CHART_SKILL_NAME,
  DATA_ANIM_SKILL_NAME,
  DIAGRAM_SKILL_NAME,
  LAYOUT_SKILL_NAME,
  RED_LAYOUT_SKILL_NAME,
  SOURCE_READING_SKILL_NAME,
  SQUARE_1_1_LAYOUT_SKILL_NAME,
  STANDARD_4_3_LAYOUT_SKILL_NAME,
  VERTICAL_3_4_LAYOUT_SKILL_NAME,
  VERTICAL_9_16_LAYOUT_SKILL_NAME,
  formatSkillUsageRequirement,
  resolveLayoutSkillName,
  type RequiredProductSkillName,
} from '../../../product-skills/contract'
import { POPULAR_ICONS } from '../../../presentation/icons/icon-registry'

/** 精选高频图标 id 目录（按前缀分组，紧凑），供 prompt 注入。冷门图标靠 search_icons 工具查全集。 */
function buildIconCatalogPrompt(): string {
  const groups = new Map<string, string[]>()
  for (const { id } of POPULAR_ICONS) {
    const prefix = id.split('-')[0]
    const list = groups.get(prefix)
    if (list) list.push(id)
    else groups.set(prefix, [id])
  }
  const lines = [...groups.entries()].map(([prefix, ids]) => `${prefix}: ${ids.join('/')}`)
  return `常用图标 id（按前缀分组，用 <svg data-icon="id" class="w-12 h-12 text-[#色]"/> 引用，系统自动替换成 lucide SVG）：\n${lines.join('\n')}\n上面没有的冷门图标，调用 search_icons 工具用关键词查（全集 1683 个）。`
}

function describeLayoutSkill(skillName: RequiredProductSkillName): string {
  if (skillName === LAYOUT_SKILL_NAME) return '16:9 PPT layout'
  if (skillName === VERTICAL_9_16_LAYOUT_SKILL_NAME) return '9:16 vertical layout'
  if (skillName === STANDARD_4_3_LAYOUT_SKILL_NAME) return '4:3 standard layout'
  if (skillName === SQUARE_1_1_LAYOUT_SKILL_NAME) return '1:1 square card layout'
  if (skillName === VERTICAL_3_4_LAYOUT_SKILL_NAME) return '3:4 vertical poster layout'
  if (skillName === RED_LAYOUT_SKILL_NAME) return '小红书图文笔记 layout'
  return '非 16:9 画布 layout'
}

export function buildPageSemanticStructure(
  input: SlideSizePreset,
  requireLayoutSkillRead = true
): string {
  const layoutSkillName = resolveLayoutSkillName(input)
  return [
    '## 页面语义结构',
    requireLayoutSkillRead
      ? `- The layout source of truth for this canvas is the ${describeLayoutSkill(layoutSkillName)} skill ${layoutSkillName}. Before creating a slide, choosing a composition, or repairing overflow/collision: ${formatSkillUsageRequirement(layoutSkillName)}`
      : '- Template mode: the inspected target template page is the layout source of truth. Do not read a generic layout skill or choose a replacement composition.',
    `- 图标必须用 data-icon 引用（不要手写 path，不要用 emoji）：写 <svg data-icon="{id}" class="w-12 h-12 text-[#你的颜色]"/>，系统落盘时自动替换成统一 24×24 描边 lucide SVG（颜色靠 text-[] 配合 currentColor 跟随文字色）。${buildIconCatalogPrompt()}`,
    '- 写每页 HTML 前，先像设计师想三件事：① 这页的**焦点**是什么（观众先看哪）？② 其余元素怎么摆才**平衡**（视觉重量不偏一边、不堆一角）？③ 每处留白是**刻意的 framing 还是不小心的空缺**——不小心的空缺就重排。想清楚再写。',
    '- If the task is a tiny text/style edit that does not affect layout, do not read the full layout reference.',
    '- 直接输出完整创意页面片段；系统会自动包裹 section[data-page-scaffold]、main[data-role="content"] 和标准 page frame。',
    '- 如果页面有明确标题，可以给第一个标题元素添加 data-role="title"；没有传统标题时不要为了校验硬造标题。',
    '- 主动添加 data-block-id 时保持页面内唯一（kebab-case：metric-1、summary、chart-main）；未添加时系统会自动补齐。'
  ].join('\n')
}

export const CONTENT_LANGUAGE_RULES = [
  '## Content language',
  '- The language of these instructions is not the output language. Do not imitate the prompt language.',
  '- If the user explicitly requests a language, use that language.',
  "- Otherwise, use the dominant language of the user's latest request and provided source materials.",
  '- If source materials are primarily English, write slide titles, body text, outlines, and user-facing summaries in English. Do not translate them into Chinese.',
  '- If source materials are primarily Chinese, write slide titles, body text, outlines, and user-facing summaries in Chinese.',
  '- For mixed-language materials, prefer the latest user instruction language.',
  '- Preserve proper nouns, brand names, technical terms, quoted source text, and metrics when appropriate.'
].join('\n')

export const SOURCE_UNSUPPORTED_CLAIMS =
  'exact facts, metrics, dates, system names, status claims, examples, risks, decisions, or conclusions'

export const SOURCE_MATERIAL_PLANNING_RULES = [
  '## Source-grounded planning rules',
  '- Apply these rules only when source documents, parsed reference-document outlines, or source-material briefs are present.',
  '- Treat source materials as the primary content authority. Stay source-grounded and avoid creative drift.',
  `- Every source-backed slide title and key point must be traceable to the user requirements or source materials. Do not invent ${SOURCE_UNSUPPORTED_CLAIMS} not present in the source.`,
  '- Preserve source order, hierarchy, terminology, and stated conclusions unless the user explicitly asks for a different structure.',
  '- Dense source tables/lists are evidence, not a slide checklist. Plan them as focused PPT pages: one main message per page, grouped support, and a clear reading path; split into multiple slides when one page would become a data dump.',
  '- If the source material does not naturally fill the target slide count, split source-backed sections into finer-grained slides and deepen each slide from the available material: background/context already implied by the source, comparison dimensions, cause/effect, mechanism, implications, "so what", evidence groupings, or visual explanation modules.',
  '- Do not add generic agenda, data overview, synthesis, next steps, outlook, background, summary, or transition slides unless the user request or source material explicitly contains them.'
].join('\n')

export const SOURCE_DOCUMENT_LOCATE_THEN_READ_RULE = [
  `- Before using source documents: ${formatSkillUsageRequirement(SOURCE_READING_SKILL_NAME)}`,
  '- No retrieved snippets matched. Locate relevant source passages before writing; do not write the slide from the outline alone. Then expand thin pages with analysis derived from the source — grounding forbids invented facts, not analytical structure.'
].join('\n')

export const SOURCE_DOCUMENT_READ_STRATEGY = [
  `- Before using source documents: ${formatSkillUsageRequirement(SOURCE_READING_SKILL_NAME)}`,
  '- Treat retrieved snippets as an index into the source, not as final evidence. Grounding forbids inventing facts the source lacks — not the analytical expansion (comparison, implications, so-what) that fills a thin page from inspected material.'
].join('\n')

export const SOURCE_DOCUMENT_FACT_RULE = [
  `- Do not invent ${SOURCE_UNSUPPORTED_CLAIMS} not present in the source document.`,
  '- Never present an invented number as a fact. When an illustrative scenario figure is unavoidable, make its status visible on the slide (标记为「情景数据」/「示例」/"illustrative") so demo numbers can never read as real KPIs.'
].join('\n')

export const SOURCE_GROUNDED_EXPANSION_RULES = [
  '- When source documents are present, expansion must be source-grounded: use the inspected material as the authority for enrichment and summarization.',
  '- First judge whether the inspected reference material is already enough for a readable slide. If it is enough, do not enrich or add support modules; edit, group, and choose the clearest PPT expression.',
  '- If the reference material for a slide is truly thin, you should actively enrich the slide from the material instead of leaving it sparse.',
  '- Expand by adding source-grounded analysis structure: context implied by the source, comparison dimensions, cause/effect, mechanism, implications, "so what", evidence grouping, annotations, or concise explanatory modules.',
  '- If the inspected source material is already dense, source-grounded does not mean exhaustive: summarize, group, and choose the clearest PPT expression instead of reproducing every row, metric, or bullet as visible modules.',
  '- This is expansion of reasoning and presentation structure, not invention of new evidence: do not fabricate unsupported exact facts, metrics, dates, cases, quotes, source names, risks, decisions, or conclusions.'
].join('\n')

export { buildCanvasScenarioContentRules, buildCanvasScenarioDeliveryGuard, buildCanvasScenarioExpansionRules }

export function buildUserLayoutRulesSection(context: SessionDeckGenerationContext): string {
  return context.layoutRulesPrompt?.trim() || ''
}

export const STABLE_HTML_FRAGMENT_PROTOCOL = [
  '## HTML 片段协议',
  '- 只输出正文片段（一个 `<div>` 根节点）；section[data-page-scaffold]、main[data-role="content"]、data-block-id、page frame 由工具自动补，不要手写。',
  '- 片段里不要出现 `<!doctype>/<html>/<head>/<body>`、`<script src=>`、CDN/远程资源，以及系统骨架类 .ppt-page-root/.ppt-page-content/.ppt-page-fit-scope/data-ppt-guard-root（class、CSS、注释里都算）。',
  '- 结构扁平：用 Tailwind 类替代多层 wrapper，目标 3 层、不超 4 层。',
  '- 标签全部成对闭合、末尾完整——这是最常见的失败，写完自检每个 <div>/<section>/<ul>/<li>/<table>。'
].join('\n')

export function buildCanvasConstraints(
  input: SlideSizePreset,
  requireLayoutSkillRead = true
): string {
  const slideSize = requireSlideSize(input)
  const layoutSkillName = resolveLayoutSkillName(slideSize)
  const isPortrait = slideSize.height > slideSize.width
  const ratioGuidance =
    slideSize.id === 'xiaohongshu-note'
      ? `- 小红书画布按图文笔记组织：强化标题、视觉锚点与信息层级，优先上下模块栈和分段叙事；不要套用 16:9 PPT 骨架，必须使用 ${RED_LAYOUT_SKILL_NAME}。`
      : isPortrait
        ? `- 这是非 PPT 竖版画布：优先顶部标题 + 中部主体 + 底部结论（仅当总结句设置允许时）的纵向叙事或上下模块栈，不要照搬横向三列；必须使用 ${layoutSkillName}。`
        : slideSize.id === 'square-1-1'
          ? `- 这是 1:1 方形画布：围绕中心焦点、四象限/上下两段/中心主体 + 周边支撑组织，避免套用宽屏 PPT 骨架；必须使用 ${layoutSkillName}。`
        : slideSize.id === 'standard-4-3'
          ? `- 这是非 16:9 的 4:3 画布：减少横向密集信息，图表和卡片按更方正的区域组织；不要套用 16:9 PPT skeleton，必须使用 ${layoutSkillName}。`
          : '- 这是横版画布：可以使用左右分栏、横向时间线和宽表格，但仍需围绕单一视觉焦点。'

  // 内容区水平 padding 硬下限：按画布宽度 6% 计算，并换算成 Tailwind px-N class，给 LLM 具体红线
  const minPadPx = Math.round(slideSize.width * 0.06)
  const minPadTw = Math.max(6, Math.ceil(minPadPx / 4))

  return [
    `## 画布与技法（${slideSize.label} / ${slideSize.width}×${slideSize.height}）`,
    requireLayoutSkillRead
      ? `- 版式细节（密度、pattern、高度预算、防重叠）在 ${describeLayoutSkill(layoutSkillName)} skill ${layoutSkillName}，写前先读：${formatSkillUsageRequirement(layoutSkillName)}`
      : '- 模板模式直接沿用目标模板页的密度、空间预算与分区，不另读通用 layout skill，不重新选版式。',
    `- 根容器不带默认 padding，用 Tailwind grid/flex；背景可铺满 ${slideSize.width}×${slideSize.height}。内容区水平 padding 是版面留白的硬下限：不得低于画布宽度的 6%（当前画布 ${slideSize.width}px → 至少 ${minPadPx}px，对应 Tailwind px-${minPadTw} 或更大的值；任何 px-N 里 N 小于 ${minPadTw} 的水平 padding 都属违规，常见的 px-10/px-12/px-16/px-20 不允许出现在内容区根容器或主内容栏）。垂直方向同理，不得低于画布高度的 6%。如果存在 User Layout Profile，则其按画布计算的文字安全区优先，只有背景、满版图片和纯装饰可以越过安全区。写入前自检 padding class：低于下限必须放大 padding 或压缩内容，绝不靠贴边塞下更多模块。`,
    `- 已有内容在画布上占稳、对齐、按构图需要合理伸展，让版面协调——目标是平衡，不是把每寸塞满。对应逻辑画布宽 ${slideSize.width}px、高 ${slideSize.height}px；不为填满而新增卡片/注释/第二行模块，也不能溢出画布。`,
    ratioGuidance,
    '- 密度由内容决定：氛围/叙事页低密度，多数页中密度，表格/多指标对比才高密度；内容够了就不扩展，只压缩、归并、换表达。',
    `- 内容过多先总结再布局：如果标题 + 图表/表格/列表/卡片会超出 ${slideSize.height}px 或显得过密，必须先重写信息架构（主旨、分组、优先级、紧凑表达）再写 HTML；不要靠缩小字号、增加卡片、堆更多行或把所有事实等权上屏来硬塞。`,
    '- 图表高度：注释里写 `@ppt-chart-height=N`，且 N 与 class 的 `h-[Npx]` 一致（写 560 就配 h-[560px]）。',
    '- 字号下限：正文、普通标签和卡片说明不小于 `text-lg`(18px)；任何标题不小于 `text-2xl`(24px)，标题、封面文案和重点数字应按语义层级放大，并优先使用 User Layout Profile 的字号目标。注释、页脚、页码、来源/出处等辅助信息可以小于 18px，但不得小于 12px；使用 `<footer>` / `<small>` / `<figcaption>`，或显式标记 `data-ppt-text-role="auxiliary"`。空间紧时调密度与层级，不靠缩小正文或标题硬塞；用 grid/flex 解决，不用 100vw/100vh/w-screen/h-screen/iframe。'
  ].join('\n')
}

export function buildLayoutCollisionRules(
  input: SlideSizePreset,
  requireLayoutSkillRead = true
): string {
  const layoutSkillName = resolveLayoutSkillName(input)
  return [
    '## 布局防重叠',
    requireLayoutSkillRead
      ? `- Full collision guide for this canvas is in the ${describeLayoutSkill(layoutSkillName)} skill ${layoutSkillName}. ${formatSkillUsageRequirement(layoutSkillName)}`
      : '- Template mode: preserve the inspected template positions and spacing; resolve collisions with local text shortening or small in-place adjustments.',
    '- 正文内容用 grid/flex 正常文档流。absolute/fixed 仅用于背景装饰、连接线。正文卡片不得用 absolute/fixed。'
  ].join('\n')
}

export const FRONTEND_CAPABILITIES = [
  '## Runtime capability contract',
  'Available in every /<pageId>.html:',
  '- Tailwind CSS, anime.js, Chart.js, ppt-runtime.js, and KaTeX are already loaded from local assets.',
  '- Do not add CDN links, remote scripts, duplicate runtime tags, or iframe content.',
  '',
  'Fonts:',
  '- Use var(--ppt-title-font) for the page/section title, var(--ppt-subtitle-font) for h2/h3/card headings, and var(--ppt-body-font) for body text.',
  '- Do not declare @font-face or import external font/icon libraries.',
  '',
  'Charts:',
  `- Chart details are in the skill ${CHART_SKILL_NAME}. ${formatSkillUsageRequirement(CHART_SKILL_NAME)}`,
  '- Before writing a chart, call the search_chart_patterns tool with a short content description (e.g. "conversion funnel", "季度营收对比") to recall the matching Chart.js pattern and config skeleton instead of guessing the chart type.',
  '- Wrap in document.addEventListener("DOMContentLoaded", function() { PPT.createChart(...) }). Do not use ppt-ready/ppt-rendered or other custom events.',
  '',
  'Diagrams:',
  `- When the content is a process, structure, or relationship (flow, architecture, timeline, cycle, pyramid, quadrant, comparison) instead of a numeric series, draw an inline SVG diagram rather than stacking bullet lists or generic cards. Diagram rules are in the skill ${DIAGRAM_SKILL_NAME}. ${formatSkillUsageRequirement(DIAGRAM_SKILL_NAME)}`,
  '',
  'Animations:',
  `- Animation rules are in the skill ${DATA_ANIM_SKILL_NAME}. ${formatSkillUsageRequirement(DATA_ANIM_SKILL_NAME)}`,
  '- Prefer `data-anim-stagger="N"` over embedding `stagger(N)` in delay strings for new content.',
  '- Prefer `data-anim-sequence="with|after"` over overloading `data-anim-trigger` when you only need load-order composition.',
  '- Use `data-anim-click-group="name"` only for contiguous click-triggered elements that should reveal on the same click step.',
  '- Prefer bounded emphasis labels such as `pulse-soft|pulse|pulse-strong` and `grow-shrink-soft|grow-shrink|grow-shrink-strong` over ad hoc scale choreography.',
  '- Use `data-anim="path"` only with an inline linear path string such as `M 0 0 L 120 30`; do not use selector-based SVG path choreography in normal generated pages.',
  '- Do not use `data-anim-easing`, `data-anim-repeat`, or `data-anim-direction` in normal generated pages; those are runtime-only compatibility knobs and are not preserved by the editable PPTX lane.',
  '- Keep the editable lane focused on whole-element motion. Do not use split-text/per-letter effects, SVG morph/draw helpers, or arbitrary path choreography in normal generated pages.',
  '- Treat those richer anime capabilities as preview-only concepts until a dedicated non-editable lane exists.',
  '',
  'Validation:',
  '- Use \\( \\) or $$ $$ for math; do not use single-dollar inline math.'
].join('\n')

export const CONTENT_WRITING_RULES = [
  '## 内容与视觉',
  '- 用真实文案与数据填模块；图标、装饰锚点、序号底托、分类标记**优先用 <svg data-icon="id" class="..."/> 引用图标库**（系统自动注入 lucide SVG，全集 1683 个，不确定 id 时调 search_icons 工具查），不要凭记忆手写 path；禁止用 emoji、贴纸、字符符号（如 ★→✓）充当图标；emoji 只允许出现在用户原文引用、品牌名或必要的人物/产品名称里，绝不作为页面的视觉图标元素。',
  '- 内容天然是流程、结构或关系时（步骤、阶段、系统组成、循环、分层、对比矩阵、时间线），优先画一张内联 SVG 图示而不是罗列卡片/项目符号——图示规范见技能 amy-ppt-diagram（肘形连线、节点预算、标注遮罩）。',
  '- 精确数字必须有出处（用户输入或源文档）；示例性、假设性的演示数字必须可见标注（如「示例数据」「情景数据」），绝不冒充真实指标。',
  '- 布局靠 grid/flex 文档流：items-center/justify-* 的父节点配 flex 或 grid，正文卡片留在文档流里，absolute/fixed 只给背景装饰与连接线。',
  '- 装饰块保持扁平（单层绝对定位 div / 几个并列 div / 一个 SVG）。',
  '- 模块占稳各自位置、彼此对齐，形成均衡版面与干净间距——不堆在顶部，也不塞到溢出。',
  '- 内容超载时按这个优先级解决：(1) 总结精简——用更少的字表达同等信息量（长描述压成短句、词组、单一数据点），不丢信息只去水分 → (2) 合并/归并相关点为一个带共享标签的块 → (3) 把长清单重写成一个 hero 指标 + 一句解释 → (4) 换更紧凑的 pattern（如对比矩阵/ranking/2x2）。绝不靠缩字号到下限以下、也不靠超出画布高度来解决——竖版/小红书/方图本来就是低密度载体，内容多时模型必须更狠地总结精简，不是把 16:9 的信息量硬塞进来。'
].join('\n')

export const STYLE_FIDELITY_RULES = [
  '## 尺寸布局与风格合成闸门',
  '- 当前画布尺寸与已注入的 layout skill/catalog 是页面结构的唯一来源：由它们决定阅读路径、分区、列数、密度和空间预算。',
  '- 当前风格规则是视觉语言的唯一来源：颜色、字体气质、圆角/线条/阴影、背景、装饰符号、图表质感都必须从当前 style 与 design contract 派生。',
  '- 先依据 layout skill/catalog 选择适合当前尺寸的页面结构，再把 style 的视觉语言应用到这些结构区域；layout 不提供新的审美，style 不替代尺寸结构。',
  '- style 中出现的左右分栏、固定列数、横向色带或固定位置只表达视觉构图倾向；必须在当前尺寸与 layout pattern 中重新表达，不能直接作为页面骨架。',
  '- size-aware layoutMotif 负责连接当前尺寸与 style 的构图气质，但不能覆盖当前画布尺寸或 layout skill/catalog。',
  '- 单页生成也必须像整套 deck 一样遵守当前 style。可以变化构图和节奏，但不能自创无关配色、组件语言、插画/装饰风格或字体气质。',
  '- 写入前做一次 style check：如果把当前 style 名字遮住，页面仍应能从配色、形状、字体和装饰语言上看出属于同一套演示。'
].join('\n')

export function resolveContextStylePrompt(context: SessionDeckGenerationContext): {
  presetLabel: string
  presetId: string
  stylePrompt: string
} {
  const presetLabel = context.styleName?.trim() || context.styleKey?.trim() || context.styleId || 'Session style'
  const presetId = context.styleKey?.trim() || context.styleId || 'session-style'
  const stylePrompt = context.styleSkillPrompt?.trim()
  if (!stylePrompt) {
    throw new Error('Session style snapshot is missing styleSkillPrompt.')
  }
  return {
    presetLabel,
    presetId,
    stylePrompt
  }
}

export function buildOutlinePageList(context: SessionDeckGenerationContext): string {
  return context.outlineItems
    .map((item, i) => {
      const layoutIntent = item.layoutIntent
        ? `\n   ${formatLayoutIntentPrompt(item.layoutIntent).replace(/\n/g, '\n   ')}`
        : ''
      const visualFormat = item.visualFormat ? `\n   Planned visual format: ${item.visualFormat}` : ''
      const audienceMove = item.audienceMove ? `\n   Audience move: ${item.audienceMove}` : ''
      const layoutMaster =
        item.layoutId && item.layoutPrompt
          ? `\n   ${item.layoutPrompt.replace(/\n/g, '\n   ')}`
          : ''
      return `${i + 1}. ${item.title}\n   Content points: ${item.contentOutline}${layoutIntent}${visualFormat}${audienceMove}${layoutMaster}`
    })
    .join('\n')
}

export function formatDesignContract(contract?: DesignContract): string {
  if (!contract) return 'Not provided. Keep pages visually consistent according to the style rules.'
  const lines = [
    '- Treat this as a flexible visual contract, not a fixed template. Preserve coherence while varying composition, density, and emphasis per slide.',
    `- Visual theme: ${contract.theme}`,
    `- Canvas background: ${contract.background}`,
    `- Palette: ${contract.palette.join(', ')}`,
    `- Title style: ${contract.titleStyle}`,
    `- Size-adapted composition motif: ${contract.layoutMotif}`,
    '- Apply this motif within the current canvas layout rules. Keep pages varied within the motif instead of repeating one template.',
    `- Chart style: ${contract.chartStyle}`,
    `- Shape language: ${contract.shapeLanguage}`
  ]
  lines.push(
    `- Title font: ${contract.titleFont} (use var(--ppt-title-font) for titles)`,
    `- Subtitle font: ${contract.subtitleFont} (use var(--ppt-subtitle-font) for h2/h3, card headings, and secondary labels)`,
    `- Body font: ${contract.bodyFont} (use var(--ppt-body-font) for body)`
  )
  return lines.join('\n')
}
