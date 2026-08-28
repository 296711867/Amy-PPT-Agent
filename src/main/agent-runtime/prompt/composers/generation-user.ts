import type { SessionDeckGenerationContext } from '../../agent/types'
import { formatLayoutIntentPrompt } from '@shared/layout-intent'
import { AMY_IMAGE_PLACEHOLDER_PATH, isSectionAgendaOutline, type VisualFormat } from '@shared/generation'
import {
  CHART_SKILL_NAME,
  DIAGRAM_SKILL_NAME,
  formatSkillUsageRequirement
} from '../../../product-skills/contract'
// 共享规则段（画布约束、语言、语义结构、碰撞规则、HTML 协议、源文档策略等）
// 已统一在 deck-system 系统提示注入，用户提示只带页面级数据。去重后每页省 ~5-7K tokens。
import { SOURCE_UNSUPPORTED_CLAIMS } from './shared'
import { resolveCanvasScenario } from './canvas-scenario'
import { getUniversalLayoutImageAspect } from '@shared/universal-layouts'

/** 规划期决定的视觉表达格式 → 页面生成指令（含技能路由）。 */
function formatVisualFormatPrompt(format: VisualFormat | undefined): string {
  if (!format) return ''
  if (format.startsWith('diagram-')) {
    const kind = format.slice('diagram-'.length)
    return [
      `Planned visual format: ${format} — the deck planner decided this slide is a ${kind} diagram page.`,
      `- Make one inline SVG ${kind} diagram the page's main visual instead of stacking text cards or generic modules; keep a one-line takeaway near the diagram.`,
      `- Diagram geometry (elbow connectors, masked labels, node budgets, accent discipline) follows the ${DIAGRAM_SKILL_NAME} skill. Before drawing: ${formatSkillUsageRequirement(DIAGRAM_SKILL_NAME)}`
    ].join('\n')
  }
  switch (format) {
    case 'chart':
      return [
        'Planned visual format: chart — the deck planner decided this slide is a data-chart page.',
        `- Build the page around one Chart.js chart of the right type (bar/line/pie/...) instead of a diagram or card list. Chart rules live in the ${CHART_SKILL_NAME} skill. Before writing chart code: ${formatSkillUsageRequirement(CHART_SKILL_NAME)}`
      ].join('\n')
    case 'table':
      return 'Planned visual format: table — present the records as a clean scannable table (aligned columns, clear header) rather than splitting them into cards.'
    case 'big-number':
      return 'Planned visual format: big-number — let one or two hero metrics dominate the page with a short supporting line; do not dilute them with many equal-weight modules.'
    case 'quote':
      return 'Planned visual format: quote — build the page around a single statement or judgment in large type with generous whitespace; supporting detail stays minimal.'
    case 'cover':
      return 'Planned visual format: cover — compose a cover page: dominant title, optional subtitle/presenter/date, strong visual anchor, low content density.'
    case 'section-divider':
      return 'Planned visual format: section-divider — announce the chapter/section with a large number or title treatment and minimal supporting text.'
    case 'ending':
      return 'Planned visual format: ending — compose a closing page (thanks / key takeaway / next steps) with a calm, conclusive composition.'
    case 'image-focus':
      return 'Planned visual format: image-focus — let real visuals (image slots or assigned assets) dominate the page; text stays as captions and short labels.'
    case 'card-grid':
      return 'Planned visual format: card-grid — group the parallel points into visually consistent cards within the planned module count; no relational arrows needed.'
    case 'narrative':
      return 'Planned visual format: narrative — lead with prose-style storytelling in a clear reading path; avoid fragmenting the message into many small modules.'
  }
  return ''
}

export function buildSinglePageGenerationPrompt(args: {
  topic: string
  deckTitle: string
  pageId: string
  pageNumber: number
  pageTitle: string
  pageOutline: string
  slideSize: import('@shared/slide-size').SlideSizePreset
  layoutIntent?: SessionDeckGenerationContext['outlineItems'][number]['layoutIntent']
  contentStructure?: SessionDeckGenerationContext['outlineItems'][number]['contentStructure']
  moduleCount?: SessionDeckGenerationContext['outlineItems'][number]['moduleCount']
  visualAspect?: SessionDeckGenerationContext['outlineItems'][number]['visualAspect']
  contentDensity?: SessionDeckGenerationContext['outlineItems'][number]['contentDensity']
  visualFormat?: VisualFormat
  audienceMove?: string
  /** 跨页同类错误升级出的方法级修正，注入后续页主动避开。 */
  methodLevelFixes?: string[]
  layoutId?: SessionDeckGenerationContext['outlineItems'][number]['layoutId']
  layoutPrompt?: SessionDeckGenerationContext['outlineItems'][number]['layoutPrompt']
  imageAssetPath?: string
  imageAssetPaths?: string[]
  backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
  sourceDocumentPaths?: string[]
  referenceDocumentSnippets?: string
  isRetryMode?: boolean
  writeToolName?: 'update_single_page_file' | 'update_template_page_file'
  retryContext?: {
    attempt: number
    maxRetries: number
    previousError: string
  }
}): string {
  const writeToolName = args.writeToolName || 'update_single_page_file'
  const previousError = args.retryContext?.previousError || ''
  const shouldMentionChartFix = /chart|canvas|PPT\.createChart/i.test(previousError)
  const shouldMentionWriteToolFix =
    /页面未写入|没有成功调用|not written|update_single_page_file|update_template_page_file|占位|placeholder/i.test(
      previousError
    )
  const shouldMentionTemplateSkeletonFix =
    /模板骨架|skeleton|background\/decorative|背景\/装饰资源|CSS url|SVG image|local asset/i.test(
      previousError
    )
  const shouldMentionHarnessFix =
    /质量校验未通过|harness-quality|emoji-as-icon|padding-below-floor|font-below-floor/i.test(
      previousError
    )
  const isSectionAgendaPage = isSectionAgendaOutline(args.pageOutline || '')
  const retryInstructions = args.retryContext
    ? [
        '',
        'Retry fixes to prioritize:',
        `- This is retry ${args.retryContext.attempt}/${args.retryContext.maxRetries}.`,
        `- Previous failure: ${previousError}`,
        '- Output only a complete creative page fragment. The write tool will add section/main/content semantics when they are missing. Do not output a full document, page shell, or runtime scripts.',
        shouldMentionWriteToolFix
          ? `- The previous attempt did not write the target page. You must call ${writeToolName}(pageId="${args.pageId}", content=...) before any final response; do not only describe the HTML in the final response.`
          : '',
        shouldMentionTemplateSkeletonFix
          ? '- The previous attempt dropped template skeleton resources. Reread the target template page, find the missing local asset references from the error, and include the corresponding background/decorative layers in the next write.'
          : '',
        shouldMentionHarnessFix
          ? '- 上一次是 harness 质量校验未通过。逐条按错误清单修正，不要辩解、不要绕过：图标底托/图标位里的 emoji 必须换成内联 SVG（<svg>…</svg>）；内容区根容器水平 padding 必须达到下限（px-24 或更大，禁用 px-10/px-12/px-16/px-20）；显式字号不得低于当前画布下限（1600×900 画布正文 ≥18px、标题 ≥24px，其余画布按高度等比换算，text-[Npx] 与 text-xs/text-sm 等语义字号同样计入）；页脚/注释/来源/眉标(kicker)等辅助小字必须放入 footer/small/figcaption 或标记 data-ppt-text-role="auxiliary"，且不得小于 12px；标题带 [data-role="title"] 内只有标题元素适用 24px 标题下限，副标题按正文 ≥18px，小于 18px 的眉标必须带辅助标记。修正后重新调用写盘工具。'
          : '',
        '- Before calling the write tool, mentally validate that the main containers are closed and that no tag is left unfinished at the end.',
        '- If the previous issue was unclosed tags, do not patch the broken fragment. Rewrite a simpler, shallower fragment from scratch: one root div, no page shell (section[data-page-scaffold], main[data-role="content"], or runtime frame), grid/flex direct children, aim for 3 nesting levels and avoid exceeding 4, fewer wrappers, fewer modules.',
        '- If the previous issue was page shell structure, do not include .ppt-page-root, .ppt-page-content, .ppt-page-fit-scope, or data-ppt-guard-root anywhere, including CSS selectors, class names, scripts, and comments.',
        shouldMentionChartFix
          ? `- The previous issue involved chart API usage. Before repairing or writing chart code: ${formatSkillUsageRequirement(CHART_SKILL_NAME)}`
          : ''
      ].filter(Boolean)
    : []
  const sourceDocumentInstructions =
    !isSectionAgendaPage && args.sourceDocumentPaths && args.sourceDocumentPaths.length > 0
      ? args.referenceDocumentSnippets && args.referenceDocumentSnippets.trim().length > 0
        ? [
            '',
            args.referenceDocumentSnippets.trim(),
            '',
            'Source document requirements:',
            '- This slide already has program-side retrieved snippets.',
            `- Source document paths: ${args.sourceDocumentPaths.join(', ')}`,
            '- Follow the source-document strategy, fact rules, and grounded expansion rules from the system prompt.',
            args.isRetryMode
              ? '- This is a failed-slide retry. Match source material only around this slide title and content points; do not reconstruct the whole deck outline.'
              : ''
          ].filter(Boolean)
        : [
            '',
            'Source document requirements:',
            `- Source document paths: ${args.sourceDocumentPaths.join(', ')}`,
            '- No retrieved snippets matched this slide.',
            '- Follow the locate-then-read strategy and source fact rules from the system prompt.',
            '- First extract keywords, business objects, time points, system names, and metrics from this slide title and content points; then match relevant source passages.',
            '- Do not copy the whole document indiscriminately.',
            args.isRetryMode
              ? '- This is a failed-slide retry. Match source material only around this slide title and content points; do not reconstruct the whole deck outline.'
              : ''
          ].filter(Boolean)
      : []
  const hasSourceRange = /Source range:\s*lines\s+\d+\s*-\s*\d+/i.test(args.pageOutline || '')
  const canvasScenario = resolveCanvasScenario(args.slideSize)
  const requiredImageAspect = getUniversalLayoutImageAspect(args.layoutId)
  const assignedImagePaths = args.imageAssetPaths?.length
    ? args.imageAssetPaths
    : args.imageAssetPath
      ? [args.imageAssetPath]
      : []
  const sourceRangeInstructions =
    !isSectionAgendaPage &&
    args.sourceDocumentPaths &&
    args.sourceDocumentPaths.length > 0 &&
    hasSourceRange
      ? [
          '',
          'Range-bound source reading:',
          '- Content points include a Source range. Before writing this slide, inspect that source heading/range first through the source-reading skill.',
          '- Use retrieved snippets as an index only. If snippets are missing or broad, the Source range remains the primary content boundary.',
          '- Do not pull facts from unrelated sections just because they match keywords.'
        ]
      : []
  const sectionAgendaInstructions = isSectionAgendaPage
    ? [
        '',
        'Section agenda page requirements:',
        '- This slide is a chapter agenda/table-of-contents page.',
        '- Use only the child topic names already listed in Content points.',
        '- Do not inspect, retrieve, cite, summarize, or expand from the source document for this slide.',
        '- Keep it as a presentation agenda: chapter title plus concise child-topic list.'
      ]
    : []
  return [
    `Generate and write only this ${canvasScenario.pageName}. Do not modify other pages.`,
    '',
    `Topic: ${args.topic}`,
    `Deck title: ${args.deckTitle}`,
    `Target page: ${args.pageId} (slide ${args.pageNumber})`,
    `Slide title: ${args.pageTitle}`,
    `Content points: ${args.pageOutline || 'Expand from the topic with moderate information density.'}`,
    args.layoutIntent ? formatLayoutIntentPrompt(args.layoutIntent) : '',
    formatVisualFormatPrompt(args.visualFormat),
    args.audienceMove
      ? [
          `Planned audience move: ${args.audienceMove}`,
          '- Every visible module on this slide must serve this before → after transition; cut or demote anything that does not move the audience toward the after-state.'
        ].join('\n')
      : '',
    args.methodLevelFixes && args.methodLevelFixes.length > 0
      ? [
          'Method-level corrections from earlier slides (apply proactively, do not wait to fail the same way):',
          ...args.methodLevelFixes.map((fix) => `- ${fix}`)
        ].join('\n')
      : '',
    args.contentStructure
      ? `Planned content structure: ${args.contentStructure}. Planned visible modules: ${args.moduleCount || 'use the selected layout count'}. Content density: ${args.contentDensity || 'standard'}. Visual aspect: ${args.visualAspect || 'auto'}.`
      : '',
    args.layoutId && args.layoutPrompt ? args.layoutPrompt : '',
    args.layoutId
      ? '- The selected layout ID is a hard PPT composition contract. Preserve its exact module count, row/column relationship, alignment system, and image-slot rule.'
      : '',
    args.layoutId
      ? '- Do not create extra equal-weight cards, image frames, columns, or repeated panels beyond the selected module count. Supporting text must stay inside the planned modules or in one concise page-level takeaway.'
      : '',
    requiredImageAspect
      ? `- Image-frame geometry is fixed as ${requiredImageAspect}. Do not convert portrait rows into landscape grids or mixed feature collages. Preserve identical aspect-ratio CSS for equal image slots.`
      : '',
    assignedImagePaths.length > 0 && assignedImagePaths.every((assetPath) => assetPath === AMY_IMAGE_PLACEHOLDER_PATH)
      ? [
          `Image slots for this slide run in placeholder mode (${assignedImagePaths.length} planned slot(s), hard requirement):`,
          '- Render every planned image slot as a semantic placeholder block instead of a real photo.',
          '- Each placeholder: a frame with the exact planned slot geometry and aspect ratio, marked data-role="image-placeholder".',
          '- Inside each frame draw: a subtle themed surface (low-contrast fill or fine dashed border), a small image glyph, ONE line of 语义描述 describing the image this slot wants (subject / framing / mood, same language as the slide), and a short 「替换图片」 hint.',
          '- Placeholders are replaceable containers for later real images: keep them inside the layout image-slot geometry. Do NOT use <img>, do NOT invent file paths, and do NOT fake a photo with CSS illustration.'
        ].join('\n')
      : args.imageAssetPaths?.length
      ? [
          `Assigned image assets (${args.imageAssetPaths.length} distinct slots):`,
          ...args.imageAssetPaths.map(
            (assetPath, index) =>
              `- Slot ${index + 1}: use <img src="${assetPath}"> with object-fit: cover.`
          ),
          '- Use every array entry exactly once and in slot order. AI-generated paths are distinct; the placeholder path may intentionally repeat.',
          '- Keep each image in a replaceable frame. Do not draw CSS-only fake images or invent another image path.'
        ].join('\n')
      : args.imageAssetPath
        ? [
            `Assigned image asset: ${args.imageAssetPath}`,
            `- Use this exact path in an <img src="${args.imageAssetPath}"> inside the layout's image slot.`,
            '- Preserve object-fit and a replaceable image container. Do not draw a CSS-only fake image and do not invent another image path.'
          ].join('\n')
        : '',
    args.backgroundAsset
      ? [
          'Assigned full-canvas PPT background (hard requirement):',
          `- Use <img src="${args.backgroundAsset.path}" data-role="deck-background"> as the first child of the creative root.`,
          '- Position it absolute inset-0 w-full h-full object-cover, behind every other element. The creative root must be position:relative and overflow:hidden.',
          `- Background role: ${args.backgroundAsset.role}. Required text-safe composition: ${args.backgroundAsset.whitespace}.`,
          args.backgroundAsset.whitespace === 'blank-left'
            ? '- Put the primary title and content in the left 55% only. Do not place cards or text over the thematic artwork on the right.'
            : args.backgroundAsset.whitespace === 'blank-right'
              ? '- Put the primary title and content in the right 55% only. Do not place cards or text over the thematic artwork on the left.'
              : args.backgroundAsset.whitespace === 'blank-top-center'
                ? '- Put the title and main content inside the quiet upper-central region. Keep the lower and side artwork visible.'
                : '- Place text only in the visibly calm, low-detail safe area of this assigned background.',
          '- Do not add another full-page gradient, color wash, decorative pattern, or competing background over this asset.',
          '- Light translucent content surfaces are allowed only when needed for readability; do not hide the thematic image.',
          '- This background is not a replaceable content image and must never be placed inside a card, figure, or image slot.'
        ].join('\n')
      : '',
    ...sectionAgendaInstructions,
    ...sourceDocumentInstructions,
    ...sourceRangeInstructions,
    '',
    // 共享规则段（画布、语言、语义结构、约束、碰撞、交付、前端能力、HTML 协议、扩展）
    // 全部在 deck-system 系统提示中一次性注入，用户提示只带页面级数据。
    // 去重后每页 prompt 减少 ~5-7K tokens，且因为系统提示跨页稳定，
    // 同一 deck 内的 provider 端 prompt cache 可命中。
    ...retryInstructions,
    '',
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
    `- Required action: call ${writeToolName}(pageId="${args.pageId}", content=complete creative page fragment).`,
    `- This is not optional. A final text response without a successful ${writeToolName} tool call means the slide is not generated.`,
    '- Do not call update_page_file. In this single-slide run it is intentionally not available.',
    writeToolName === 'update_template_page_file'
      ? '- Do not call update_single_page_file. This template run exposes update_template_page_file instead.'
      : '',
    '- content must be a complete creative page fragment. The tool will wrap it with section[data-page-scaffold], main[data-role="content"], editable data-block-id attributes, and the runtime page frame when needed.',
    '- The content must not contain <!doctype>, <html>, <head>, <body>, .ppt-page-root, .ppt-page-content, .ppt-page-fit-scope, or data-ppt-guard-root.',
    '- The content must be complete and balanced: close your main layout containers and leave no unfinished trailing tags.',
    '- After the tool call succeeds, final response should be a short summary only. Do not paste the HTML in the final response.',
    '- Do not modify other pages.',
    '',
    'Tool context (pre-injected):',
    `- Target file: ${args.pageId}.html (virtual path: /${args.pageId}.html)`,
    '- Agent workspace root: /'
  ].join('\n')
}
