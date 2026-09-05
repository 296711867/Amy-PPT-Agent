import type { SessionDeckGenerationContext } from '../../agent/types'
import {
  buildLayoutCollisionRules,
  buildPageSemanticStructure,
  buildCanvasConstraints,
  buildCanvasScenarioContentRules,
  buildCanvasScenarioDeliveryGuard,
  buildCanvasScenarioExpansionRules,
  CONTENT_LANGUAGE_RULES,
  CONTENT_WRITING_RULES,
  FRONTEND_CAPABILITIES,
  SOURCE_DOCUMENT_FACT_RULE,
  SOURCE_DOCUMENT_READ_STRATEGY,
  SOURCE_GROUNDED_EXPANSION_RULES,
  STABLE_HTML_FRAGMENT_PROTOCOL,
  STYLE_FIDELITY_RULES,
  buildOutlinePageList,
  buildUserLayoutRulesSection,
  formatDesignContract,
  resolveContextStylePrompt
} from './shared'
import { formatAnimationPreferencesForPageWriting } from './animation-preferences'
import { buildCanvasScenarioBrief, resolveCanvasScenario } from './canvas-scenario'
import { createPromptCatalog } from '../catalog'

import deckSystemTemplate from '../templates/deck-system/system.md?raw'

type DeckSystemTemplateVars = {
  system: {
    pageWriteRequirement: string
    canvasIdentity: string
    pageName: string
    canvasScenarioBrief: string
    canvasScenarioContentRules: string
    contentLanguageRules: string
    templateOrCreativeInstructions: string
    sourceDocumentInstructions: string
    canvasConstraints: string
    layoutCollisionRules: string
    canvasScenarioDeliveryGuard: string
    pageSemanticStructure: string
    canvasScenarioExpansionRules: string
    frontendCapabilities: string
    animationPreferencePromptWithSpacing: string
    contentWritingRules: string
    stableHtmlFragmentProtocol: string
    templateAssetGuards: string
    pageWriteConstraint: string
    executionFlow: string
    topic: string
    deckTitle: string
    slideCount: number
    targetInfo: string
    targetFileLine: string
    pageList: string
    presetLabel: string
    presetId: string
    stylePrompt: string
    designContract: string
    styleFidelityRules: string
    finalWriteToolName: string
  }
}

const deckSystemPromptCatalog = createPromptCatalog<DeckSystemTemplateVars>({
  system: deckSystemTemplate.trimEnd()
})

export function buildDeckAgentSystemPrompt(
  styleId: string | null | undefined,
  context: SessionDeckGenerationContext
): string {
  void styleId
  const { presetLabel, presetId, stylePrompt } = resolveContextStylePrompt(context)
  const pageList = buildOutlinePageList(context)
  const statusLanguage = context.appLocale === 'en' ? 'English' : 'Simplified Chinese'

  const targetInfo = context.selectedPageId
    ? `This run may only modify: ${context.selectedPageId}`
    : context.selectPageIds?.length
      ? `This run may only modify selected pages: ${context.selectPageIds.join(', ')}`
      : 'This run may modify all pages.'
  const targetPagePath =
    context.selectedPageId && context.pageFileMap[context.selectedPageId]
      ? `/${context.selectedPageId}.html`
      : undefined
  const isSinglePageTask =
    context.mode !== 'edit' &&
    (Boolean(context.selectedPageId) ||
      (Array.isArray(context.selectPageIds) && context.selectPageIds.length === 1) ||
      (Array.isArray(context.allowedPageIds) && context.allowedPageIds.length === 1) ||
      context.outlineTitles.length === 1)
  const isTemplateGeneration = context.templatePageReadRequired === true
  const singlePageWriteToolName = isTemplateGeneration
    ? 'update_template_page_file'
    : 'update_single_page_file'
  const step3Instruction = isSinglePageTask
    ? context.templatePageReadRequired
      ? '3. Required: after reading the target template page with read_file, call update_template_page_file(pageId=target page, content). A final text response without the read_file + update_template_page_file sequence is a failed generation.'
      : '3. Required: call update_single_page_file(pageId=target page, content). A final text response without this tool call is a failed generation.'
    : '3. Call update_page_file(content) page by page. For multi-page generation, write each target page file in order. You may pass pageId to override automatic targeting.'
  const sourceDocumentPaths = (context.sourceDocumentPaths || []).filter(Boolean)
  const isRetryMode = context.mode === 'retry'
  const animationPreferencePrompt = formatAnimationPreferencesForPageWriting(
    context.animationPreferences
  )
  const canvasScenario = resolveCanvasScenario(context.slideSize)
  const sourceDocumentInstructions =
    sourceDocumentPaths.length > 0
      ? `\n\n${[
          '## Source documents (highest-priority content evidence)',
          'This session comes from user-uploaded documents. Generated content must prioritize source-document facts; do not rely only on the summary or page outline.',
          'Single-page prompts may include program-side retrieved snippets.',
          SOURCE_DOCUMENT_READ_STRATEGY,
          'If snippets are insufficient, conflicting, or missing key facts, follow the source-reading skill against these source documents:',
          ...sourceDocumentPaths.map((docPath) => `- ${docPath}`),
          SOURCE_DOCUMENT_FACT_RULE,
          SOURCE_GROUNDED_EXPANSION_RULES,
          isRetryMode
            ? '- This is a failed-slide retry. Match source material only around the failed slide title and outline; do not reconstruct the whole deck outline.'
            : "- This is initial page generation. Follow the established page outline slide by slide; do not prematurely insert other slides' material.",
          'If the source document conflicts with additional user requirements, follow the user requirements. If the page outline conflicts with source details, follow source-document facts.'
        ].join('\n')}`
      : ''
  const templateOrCreativeInstructions = isTemplateGeneration
    ? [
          '## 模板还原优先',
          '- 当前是模板生成，不追求重新设计、视觉惊喜或主动变化。',
          '- 每页先继承目标模板页的页面角色、版式骨架、背景/装饰层、留白节奏、字体尺度、组件形状和配色关系。',
          '- 只替换旧业务内容：标题、正文、指标、图表数据、案例、结论和与新主题冲突的内容素材。',
          '- 为适配新内容可以做局部微调，但不能把模板页改成另一套构图或另一套视觉系统。',
          '- 如果内容放不下，优先压缩文案/合并模块，不要通过新增大量卡片或重排整页来破坏模板。'
        ].join('\n')
    : [
          '## 创意变化',
          '- 在统一风格内制造每页的视觉惊喜：变化主视觉位置、信息节奏、留白比例或局部装饰语言。',
          '- 每页至少有一个清晰的视觉焦点，可以是关键数字、图表、概念符号、时间节点或一句核心判断。',
          '- 惊喜感服务于内容理解；不要为了变化加入无关装饰、复杂嵌套、遮挡文字或难以维护的结构。',
          `- 同一套 ${canvasScenario.sequenceName} 内变化的是主视觉位置、卡片网格和背景分区；常规内容页的标题带（对齐、字号档位、kicker/装饰形态、标题-内容间距）整套统一，不得逐页更换标题位置。`
        ].join('\n')
  const templateAssetGuards = isTemplateGeneration
      ? [
          '- In template generation, dropping inspected background images, decorative layers, CSS url(...) references, masks, overlays, or the containers that render them is a failed generation unless the user explicitly requested removal.',
          '- Because page write tools rebuild the slide from your submitted fragment, include the required template background/decorative layers or exact local asset references inside that fragment.',
          ''
        ].join('\n')
      : ''
    const pageWriteConstraint = isSinglePageTask
      ? `- 不要调用 edit_file / write_file / update_page_file${
          isTemplateGeneration ? ' / update_single_page_file' : ''
        }；单页任务必须调用 ${singlePageWriteToolName}(pageId, content) 并成功落盘后才能最终回复`
      : '- 不要调用 edit_file / write_file 直接覆盖页面文件，统一用 update_page_file(content)'
  const executionFlow = isSinglePageTask
      ? context.templatePageReadRequired
        ? [
            '1. Mandatory first action: call read_file(path="/<pageId>.html", offset=0, limit=1200) using the target pageId from the user message to inspect the copied template page before writing.',
            '2. Preserve the inspected page visual system: background images, texture images, decorative assets, masks, overlays, CSS background-image/url(...) references, <img src>, SVG image href, font scale, spacing rhythm, color language, and structural wrappers unless the user explicitly asks to remove them.',
            '   Background/decorative assets are template skeleton, not stale business content; replacing facts and text must not remove the visual shell.',
            `   The content fragment you pass to ${singlePageWriteToolName} must explicitly carry those required layers or exact local asset references.`,
            '3. Follow the page-specific source instructions in the user message. If that message marks the page as a section agenda, do not inspect source documents.',
            step3Instruction,
            '4. Send a short summary as your final response.'
          ].join('\n')
        : [
            '1. Analyze the slide requirements and follow the page-specific source instructions in the user message. If that message marks the page as a section agenda, do not inspect source documents.',
            step3Instruction,
            '3. Send a short summary as your final response.'
          ].join('\n')
      : [
          '1. get_session_context — read the session context and constraints',
          sourceDocumentPaths.length > 0
            ? `2. Use retrieved source-document snippets as an index, follow the source-reading skill for targeted source inspection (${sourceDocumentPaths.join(', ')}), then call report_generation_status('Analyzing request', ...)`
            : "2. report_generation_status('Analyzing request', ...) — report start",
          `   report_generation_status labels and details must be written in ${statusLanguage}, because they are application UI logs.`,
          '   This status/log language is independent from deck content language. Deck content must still follow the Content language rules.',
          '   progress must be a numeric literal such as 10, 35, or 88. Do not pass strings such as "10".',
          '   Progress must be detailed and monotonic. Suggested ranges: Analyzing request (8-18) / Reading context (18-30) / Writing pages (30-88, linear by page) / Verifying (88-96) / Completed (98-100).',
          '   Report once for each major action so the UI does not stay silent for too long.',
          step3Instruction,
          '4. verify_completion() — check whether target pages are filled',
          "5. If pages are still empty, continue filling them, then report_generation_status('Generation completed', ...)"
        ].join('\n')
  const prompt = deckSystemPromptCatalog.render('system', {
      pageWriteRequirement: isTemplateGeneration
        ? 'You MUST call update_template_page_file to write the current template page.'
        : 'You MUST call update_single_page_file (single-page) or update_page_file (multi-page) to write every page.',
      canvasIdentity: canvasScenario.identity,
      pageName: canvasScenario.pageName,
      canvasScenarioBrief: buildCanvasScenarioBrief(context.slideSize),
      canvasScenarioContentRules: buildCanvasScenarioContentRules(context.slideSize),
      contentLanguageRules: CONTENT_LANGUAGE_RULES,
      templateOrCreativeInstructions,
      sourceDocumentInstructions,
      canvasConstraints: buildCanvasConstraints(context.slideSize, !isTemplateGeneration),
      layoutCollisionRules: buildLayoutCollisionRules(context.slideSize, !isTemplateGeneration),
      canvasScenarioDeliveryGuard: buildCanvasScenarioDeliveryGuard(context.slideSize),
      pageSemanticStructure: buildPageSemanticStructure(context.slideSize, !isTemplateGeneration),
      canvasScenarioExpansionRules: buildCanvasScenarioExpansionRules(context.slideSize),
      frontendCapabilities: FRONTEND_CAPABILITIES,
      animationPreferencePromptWithSpacing: animationPreferencePrompt
        ? `${animationPreferencePrompt}\n\n`
        : '',
      contentWritingRules: CONTENT_WRITING_RULES,
      stableHtmlFragmentProtocol: STABLE_HTML_FRAGMENT_PROTOCOL,
      templateAssetGuards,
      pageWriteConstraint,
      executionFlow,
      topic: context.topic,
      deckTitle: context.deckTitle,
      slideCount: context.outlineTitles.length,
      targetInfo: isSinglePageTask
        ? 'This run may modify only the target page identified in the user message.'
        : targetInfo,
      targetFileLine: isSinglePageTask
        ? 'Target file: use /<pageId>.html from the user message.'
        : targetPagePath
          ? `Target file: ${targetPagePath}`
          : '',
      pageList: isSinglePageTask
        ? 'The page title, content points, layout intent, assets, and target pageId are provided in the user message.'
        : pageList,
      presetLabel,
      presetId,
      stylePrompt,
      designContract: formatDesignContract(context.designContract),
      styleFidelityRules: STYLE_FIDELITY_RULES,
      finalWriteToolName: isTemplateGeneration
        ? 'update_template_page_file'
        : 'update_single_page_file (or update_page_file)'
  })
  return [prompt, buildUserLayoutRulesSection(context)].filter(Boolean).join('\n\n')
}
