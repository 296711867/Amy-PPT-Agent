import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8')

describe('source-grounded prompt rules', () => {
  it('parse plan uses single-shot model and outline scan', () => {
    const source = readSource('src/main/io/document-parse-handlers.ts')
    const outlineScan = readSource('src/main/io/document-outline-scan.ts')

    expect(source).toContain('single-shot document parsing task')
    expect(source).toContain('You have no filesystem tools in this call')
    expect(source).toContain('bounded source preview')
    expect(source).toContain('MAX_PARSE_SOURCE_PREVIEW_CHARS')
    expect(source).not.toContain('attachProductSkillsBackend')
    expect(source).not.toContain('createDeepAgent')
    expect(source).not.toContain('product_skill_read_file')
    expect(source).toContain('Do not ask to read the file')
    expect(source).toContain('Do not write detailed facts')
    expect(source).toContain('hasOutlinePageCandidateSkeleton')
    expect(source).not.toContain('rawPageCountInput')
    expect(source).not.toContain('requestedPageCount')
    expect(source).not.toContain('userPageCount')
    expect(source).not.toContain('User-provided page count')
    expect(source).toContain('runSingleShotDocumentPlanModel')
    expect(source).toContain('single-shot model invoke')
    expect(source).toContain('sourcePreviewLength')
    expect(source).toContain('[documents:parsePlan] end')
    expect(source).toContain('durationMs')
    expect(source).toContain('csv converted for reading')
    expect(source).toContain('normalized candidate plan')
    expect(source).toContain('document outline page-count estimate')
    expect(source).toContain('deterministic source-structure page-count estimate')
    expect(source).toContain('outline quality check failed after retry, rejecting plan')
    expect(source).toContain('isDocumentOutlineQualityError')
    expect(source).toContain('Source document path for later generation only')
    expect(outlineScan).toContain('Document structure scan')
    expect(outlineScan).toContain('Heading map truncated')
    expect(outlineScan).toContain('Deterministic slide-count estimate')
    expect(outlineScan).toContain('deriveOutlinePageCandidates')
    expect(outlineScan).toContain('Page candidate skeleton')
    expect(source).toContain('page candidate skeleton')
    expect(source).toContain('skeleton count')
    expect(source).toContain('compact page skeleton')
    expect(source).toContain('source line range')
    expect(source).toContain('chapter divider slides')
    expect(source).toContain('页面角色：章节页')
    expect(source).toContain('assertPlanMatchesDocumentOutline')
  })

  it('frontend lets document parse infer pageCount from source structure', () => {
    const sessionCreate = readSource('src/renderer/src/pages/session-create.tsx')
    const templateUseDialog = readSource(
      'src/renderer/src/components/templates/TemplateUseDialog.tsx'
    )
    const sessionParseCall = sessionCreate.slice(
      sessionCreate.indexOf('const result = await ipc.parseDocumentPlan({'),
      sessionCreate.indexOf('const nextSuggestion = {')
    )
    const templateParseCall = templateUseDialog.slice(
      templateUseDialog.indexOf('const result = await ipc.parseDocumentPlan({'),
      templateUseDialog.indexOf('const referenceFile = result.files[0] || attachedReferenceFile')
    )

    expect(sessionParseCall).toContain('ipc.parseDocumentPlan')
    expect(templateParseCall).toContain('ipc.parseDocumentPlan')
    expect(sessionParseCall).not.toContain('pageCount:')
    expect(sessionParseCall).not.toContain('resolvePageCount')
    expect(templateParseCall).not.toContain('pageCount:')
    expect(templateParseCall).not.toContain('resolvePageCount')
  })

  it('template document analysis reuses the shared suggestion dialog', () => {
    const templateUseDialog = readSource(
      'src/renderer/src/components/templates/TemplateUseDialog.tsx'
    )

    expect(templateUseDialog).toContain('SessionCreateSuggestionDialog')
    expect(templateUseDialog).not.toContain('updateDraftSourcePlanItems')
    expect(templateUseDialog).not.toContain('editingOutlineIndex')
    expect(templateUseDialog).not.toContain('suggestionCardClass')
  })

  it('keeps source documents for edits and retries but excludes them from generated add-page', () => {
    const generationContext = readSource('src/main/generation/context.ts')
    const sourceDocuments = readSource('src/main/generation/source-documents.ts')
    const editFlow = readSource('src/main/generation/edit-flow.ts')
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')
    const addPageFlow = readSource('src/main/generation/add-page-flow.ts')
    const retrySinglePageFlow = readSource('src/main/generation/retry-single-page-flow.ts')

    expect(generationContext).toContain(
      "export { resolveSourceDocuments } from './source-documents'"
    )
    expect(sourceDocuments).toContain('appendSourceDocumentPath(resolveExistingSessionDoc')
    expect(sourceDocuments).toContain('appendSourceDocumentPath(`/docs/${safeName}`)')
    expect(generationContext).not.toContain("mode === 'edit') return []")
    expect(generationContext).not.toContain('isFirstDeckGeneration')
    expect(editFlow).toContain('resolveSourceDocuments')
    expect(editFlow).toContain('sourceDocumentPaths: context.sourceDocumentPaths')
    expect(deckAllPageEditFlow).toContain('sourceDocumentPaths: context.sourceDocumentPaths')
    expect(addPageFlow).not.toContain('resolveSourceDocuments')
    expect(addPageFlow).not.toContain('context.sourceDocumentPaths')
    expect(addPageFlow.match(/sourceDocumentPaths: \[\]/g)).toHaveLength(3)
    expect(retrySinglePageFlow).toContain('resolveSourceDocuments')
    expect(retrySinglePageFlow).toContain('sourceDocumentPaths: context.sourceDocumentPaths')
    expect(retrySinglePageFlow).not.toContain('sourceDocumentPaths: []')
  })

  it('deck all-page edit selected page ids only match file slugs', () => {
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')

    expect(deckAllPageEditFlow).toContain('requestedPageIdSet.has(ref.pageId)')
    expect(deckAllPageEditFlow).not.toContain('requestedPageIdSet.has(ref.id)')
  })

  it('main-session deck edit enforces the shared selected-page limit', () => {
    const sharedGeneration = readSource('src/shared/generation.ts')
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')
    const chatPanel = readSource(
      'src/renderer/src/components/session-detail/ai-panel/ChatPanel.tsx'
    )

    expect(sharedGeneration).toContain('export const MAX_SELECTED_PAGES = 50')
    expect(sharedGeneration).toContain('export const MAX_STYLE_SWITCH_PAGES = 500')
    expect(sharedGeneration).not.toContain('.slice(0, 200)')
    expect(deckAllPageEditFlow).toContain(
      'context.resetVisualStyle ? MAX_STYLE_SWITCH_PAGES : MAX_SELECTED_PAGES'
    )
    expect(chatPanel).toContain('effectiveMainPageIds.length >= MAX_SELECTED_PAGES')
    expect(chatPanel).toContain('pageIds.length > MAX_SELECTED_PAGES')
  })

  it('deck edit batch aborts finalize the run before rethrowing', () => {
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')

    expect(deckAllPageEditFlow).toContain('batchResults = await executeDeckEditBatchFlow')
    expect(deckAllPageEditFlow).toContain(
      "await db.updateGenerationRunStatus(context.runId, 'failed', message)"
    )
    expect(deckAllPageEditFlow).toContain("type: 'run_error'")
    expect(deckAllPageEditFlow).toContain('throw error')
  })

  it('deck edit staggers three independent page agents to reduce rate-limit bursts', () => {
    const batchFlow = readSource('src/main/generation/edit-deck-batch-flow.ts')
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')
    const editRunner = readSource('src/main/generation/deck-edit-runner.ts')

    expect(batchFlow).toContain('export const BATCH_EDIT_LAUNCH_STAGGER_MS = 100')
    expect(batchFlow).toContain('import pLimit from')
    expect(batchFlow).toContain('pLimit(BATCH_EDIT_CHUNK_SIZE)')
    expect(batchFlow).toContain('pageIndex % BATCH_EDIT_CHUNK_SIZE')
    expect(batchFlow).toContain('Promise.allSettled')
    expect(deckAllPageEditFlow).toContain('runPageAttempt')
    expect(deckAllPageEditFlow).toContain('selectPageIds: [pageId]')
    expect(deckAllPageEditFlow).toContain('isDeckEditRateLimitRetryableError(error)')
    expect(editRunner).toContain('setPageAgent(args.sessionId, concurrentDeckPageId, editAgent)')
  })

  it('keeps generation progress in the local page surfaces without a modal', () => {
    const chatPanel = readSource(
      'src/renderer/src/components/session-detail/ai-panel/ChatPanel.tsx'
    )
    const previewStage = readSource(
      'src/renderer/src/components/session-detail/preview/PreviewStage.tsx'
    )
    const sessionDetail = readSource('src/renderer/src/pages/session-detail.tsx')

    expect(chatPanel).not.toContain('<Progress value={progress.progress}')
    expect(chatPanel).toContain('(isPageEditing || isDeckEditing)')
    expect(previewStage).not.toContain('useGenerationLoading')
    expect(previewStage).not.toContain('generationLoading')
    expect(previewStage).toContain('pageEditJob && isPageEditing')
    expect(sessionDetail).not.toContain('GenerationActivityDialog')
    expect(sessionDetail).not.toContain('onStyleSwitchCompleted')
    expect(sessionDetail).not.toContain('<PageProgressOverlay')
  })

  it('preserves chat messages when generation is cancelled', () => {
    const sessionStore = readSource('src/renderer/src/store/sessionStore.ts')
    const generationEvents = readSource(
      'src/renderer/src/components/session-detail/hooks/useSessionGenerationEvents.ts'
    )
    const loadSessionSource = sessionStore.slice(
      sessionStore.indexOf('loadSession: async'),
      sessionStore.indexOf('loadMessages: async')
    )

    expect(loadSessionSource).not.toContain('currentMessages: []')
    expect(generationEvents).toContain('if (payload.cancelled)')
    expect(generationEvents).toContain('cancelGeneration(payload.message)')
  })

  it('keeps concurrent deck-page progress on the active page instead of resetting to understanding', () => {
    const deckAllPageEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')
    const batchFlow = readSource('src/main/generation/edit-deck-batch-flow.ts')
    const editRunner = readSource('src/main/generation/deck-edit-runner.ts')

    expect(deckAllPageEditFlow).toContain("'正在准备批量编辑'")
    expect(editRunner).toContain('`正在编辑页面 ${concurrentDeckPageId}`')
    expect(editRunner).toContain("'正在生成并校验当前页面'")
    expect(batchFlow).toContain('`正在编辑 P${args.pageNumber}`')
  })

  it('uses operation-specific progress copy for add-page and failed-page retries', () => {
    const runner = readSource('src/main/generation/agent-runner.ts')
    const generationTypes = readSource('src/main/generation/deck-generation-types.ts')
    const addPageFlow = readSource('src/main/generation/add-page-flow.ts')
    const retrySinglePageFlow = readSource('src/main/generation/retry-single-page-flow.ts')
    const retryFlow = readSource('src/main/generation/retry-flow.ts')

    expect(generationTypes).toContain('renderingLabel?: string')
    expect(runner).toContain(
      "const renderingLabel = args.renderingLabel || progressText(args.appLocale, 'generating')"
    )
    expect(addPageFlow).toContain("'正在规划新增页面'")
    expect(addPageFlow).toContain("'正在生成新增页面'")
    expect(retrySinglePageFlow).toContain('`正在重新生成第 ${context.pageNumber} 页`')
    expect(retryFlow).toContain('`正在重新生成 ${retryPages.length} 个失败页面`')
  })

  it('uses successful edit facts for edit replies instead of raw agent/tool output', () => {
    const deckFlow = readSource('src/main/generation/deck-flow.ts')
    const editFlow = readSource('src/main/generation/edit-flow.ts')
    const batchEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')
    const addPageFlow = readSource('src/main/generation/add-page-flow.ts')
    const retryFlow = readSource('src/main/generation/retry-flow.ts')
    const retrySinglePageFlow = readSource('src/main/generation/retry-single-page-flow.ts')

    expect(deckFlow).toContain('summary.trim() || fallbackCompletionSummary')
    expect(editFlow).toContain('emitSuccessfulEditSummary(context, editSummary, emitAssistant)')
    expect(editFlow).not.toContain('editSummaryFromEngine')
    expect(batchEditFlow).toContain(
      'emitSuccessfulEditSummary(context, fallbackEditSummary, emitAssistant)'
    )
    expect(batchEditFlow).not.toContain('result.summary')
    expect(editFlow.lastIndexOf('await db.updateGenerationRunStatus(')).toBeLessThan(
      editFlow.indexOf('await emitSuccessfulEditSummary(context, editSummary, emitAssistant)')
    )
    expect(batchEditFlow.lastIndexOf('await db.updateGenerationRunStatus(')).toBeLessThan(
      batchEditFlow.indexOf(
        'await emitSuccessfulEditSummary(context, fallbackEditSummary, emitAssistant)'
      )
    )
    expect(addPageFlow).toContain('agentSummary ||')
    expect(retryFlow).toContain('agentSummary.trim() || fallbackCompletionSummary')
    expect(retrySinglePageFlow).toContain('generationResult.summary.trim() ||')
    expect(editFlow).not.toContain('我准备开始调整')
    expect(batchEditFlow).not.toContain('我准备按主会话指令调整')
  })

  it('publishes durable batch page results without stealing preview focus or duplicating summaries', () => {
    const sharedGeneration = readSource('src/shared/generation.ts')
    const generationEvents = readSource(
      'src/renderer/src/components/session-detail/hooks/useSessionGenerationEvents.ts'
    )
    const batchEditFlow = readSource('src/main/generation/edit-deck-allpage-flow.ts')

    expect(sharedGeneration).toContain('focusPage?: boolean')
    expect(generationEvents).toContain('if (payload.focusPage !== false)')
    expect(batchEditFlow).toContain('focusPage: false')
    expect(batchEditFlow).toContain(
      'emitSuccessfulEditSummary(context, fallbackEditSummary, emitAssistant)'
    )
    expect(batchEditFlow.indexOf('await db.upsertSessionPage({')).toBeLessThan(
      batchEditFlow.indexOf("type: isExisting ? 'page_updated' : 'page_generated'")
    )
    expect(batchEditFlow).toContain("status: existing?.status || 'failed'")
    expect(batchEditFlow).toContain('error: existing?.error || null')
    expect(batchEditFlow).toContain('resolveRemainingFailedPageInfo({')
  })

  it('main-session page scope is visible and resets after a successful send', () => {
    const chatPanel = readSource(
      'src/renderer/src/components/session-detail/ai-panel/ChatPanel.tsx'
    )
    const chatController = readSource(
      'src/renderer/src/components/session-detail/hooks/useChatPanelController.ts'
    )

    expect(chatPanel).toContain('mainPageScopeConflictWarning')
    expect(chatPanel).toContain('if (started) setSelectedMainPageIds([])')
    expect(chatController).toContain('mainPageScopeMessagePrefix')
    expect(chatController).toContain('userMessage: scopedMessageContent')
    expect(chatController).toContain('content: scopedMessageContent')
  })

  it('deck edit selected single-page scope still uses deck edit tools', () => {
    const agent = readSource('src/main/agent-runtime/agent/factory.ts')
    const editSystem = readSource('src/main/agent-runtime/prompt/composers/edit-system.ts')
    const deckSystem = readSource('src/main/agent-runtime/prompt/composers/deck-system.ts')
    const deckTools = readSource('src/main/agent-runtime/tools/deck-tools.ts')
    const editTemplates = ['container.md', 'selector.md', 'single-page.md', 'deck.md'].map(
      (fileName) => readSource(`src/main/agent-runtime/prompt/templates/edit-system/${fileName}`)
    )
    const templateSource = editTemplates.join('\n')

    expect(agent).toContain("return context.mode === 'edit'")
    expect(agent).toContain('当前编辑任务禁止使用 write_file')
    expect(editSystem).toContain('createPromptCatalog<EditSystemTemplateVars>')
    expect(templateSource).toContain('仅允许调用 set_index_transition(type, durationMs)')
    expect(templateSource).toContain('read_file target page + grep to locate target → edit_file')
    expect(templateSource).toContain('update_single_page_file(pageId="{{targetPageId}}"')
    expect(templateSource).toContain('For each target page: update_page_file(pageId, content)')
    expect(deckSystem).toContain("context.mode !== 'edit'")
    expect(deckTools).toContain('!isEditMode &&')
  })

  it('deck edit prompt applies UI-selected page ids only to deck scope', () => {
    const editSystem = readSource('src/main/agent-runtime/prompt/composers/edit-system.ts')
    const selectorPromptSource = editSystem.slice(
      editSystem.indexOf('function buildSelectorEditPrompt('),
      editSystem.indexOf('function buildSinglePageEditPrompt(')
    )
    const deckPromptSource = editSystem.slice(editSystem.indexOf('function buildDeckEditPrompt('))

    expect(selectorPromptSource).not.toContain('explicitTargetInfo')
    expect(selectorPromptSource).not.toContain('Selected page ids from UI (hard target)')
    expect(deckPromptSource).toContain('const explicitTargetInfo =')
    expect(deckPromptSource).toContain('context.selectPageIds?.length')
    expect(deckPromptSource).toContain(
      'Selected page ids from UI (hard target): ${context.selectPageIds.join'
    )
    expect(deckPromptSource).toContain("'Target pages: all relevant /<pageId>.html files'")
    expect(deckPromptSource).toContain('    explicitTargetInfo,')
  })

  it('edit prompt injects source document rules', () => {
    const editSystem = readSource('src/main/agent-runtime/prompt/composers/edit-system.ts')

    expect(editSystem).toContain('Source documents (content evidence)')
    expect(editSystem).toContain('SOURCE_DOCUMENT_READ_STRATEGY')
    expect(editSystem).toContain('sourceDocumentPaths:')
    expect(editSystem).toContain('For pure visual/style-only edits')
  })

  it('planNewPage includes source document context', () => {
    const engineGenerate = readSource('src/main/generation/planning/page-planner.ts')

    expect(engineGenerate).toContain('sourceDocumentPaths?: string[]')
    expect(engineGenerate).toContain('Source document context:')
    expect(engineGenerate).toContain('formatUniversalLayoutCatalogPrompt()')
    expect(engineGenerate).toContain(
      'title, keyPoints, layoutIntent, contentStructure, moduleCount, visualAspect, contentDensity, layoutId'
    )
    expect(engineGenerate).toContain('resolveUniversalLayoutId({')
  })

  it('single-slide planning can preserve explicit topic lists', () => {
    const engineGenerate = readSource('src/main/generation/planning/page-planner.ts')
    const generationUser = readSource('src/main/agent-runtime/prompt/composers/generation-user.ts')
    const deckSystemTemplate = readSource(
      'src/main/agent-runtime/prompt/templates/deck-system/system.md'
    )
    const planningComposer = readSource('src/main/agent-runtime/prompt/composers/planning.ts')
    const planningTemplate = readSource(
      'src/main/agent-runtime/prompt/templates/planning/system.md'
    )
    const runtimeUserSource = readSource('src/main/agent-runtime/prompt/composers/runtime-user.ts')

    expect(engineGenerate).toContain('keyPoints must contain 1-10 short phrases')
    expect(engineGenerate).toContain('preserve each listed topic as a separate key point')
    expect(generationUser).not.toContain('final slide should cover all of them')
    // Expansion-selection guardrails are deck-stable rules: they live in the
    // system prompt (shared across pages for provider cache hits), not the
    // per-page user prompt.
    expect(generationUser).not.toContain('not as a checklist')
    expect(deckSystemTemplate).toContain('not as a checklist')
    expect(deckSystemTemplate).toContain('Do not duplicate the same source facts')
    expect(deckSystemTemplate).toContain('group related points')
    expect(deckSystemTemplate).toContain('keep them distinct only where the layout allows')
    expect(planningComposer).toContain('planningPromptCatalog.render')
    expect(planningTemplate).toContain('Provide 1-10 key points per slide')
    expect(runtimeUserSource).toContain('keyPoints must contain 1-10 strings')
  })

  it('blocks generic filler slides during planning', () => {
    const sharedSource = readSource('src/main/agent-runtime/prompt/composers/shared.ts')
    const planningComposer = readSource('src/main/agent-runtime/prompt/composers/planning.ts')
    const planningTemplate = readSource(
      'src/main/agent-runtime/prompt/templates/planning/system.md'
    )
    const runtimeUserSource = readSource('src/main/agent-runtime/prompt/composers/runtime-user.ts')

    expect(planningComposer).toContain('SOURCE_MATERIAL_PLANNING_RULES')
    expect(sharedSource).toContain('Apply these rules only when source documents')
    expect(sharedSource).toContain('Stay source-grounded and avoid creative drift')
    expect(sharedSource).toContain('evidence, not a slide checklist')
    expect(sharedSource).toContain(
      'split into multiple slides when one page would become a data dump'
    )
    expect(sharedSource).toContain('split source-backed sections')
    expect(sharedSource).toContain('deepen each slide from the available material')
    expect(sharedSource).toContain('SOURCE_GROUNDED_EXPANSION_RULES')
    expect(sharedSource).toContain('actively enrich the slide from the material')
    expect(sharedSource).toContain('source-grounded does not mean exhaustive')
    expect(sharedSource).toContain('Do not add generic agenda')
    expect(planningTemplate).toContain('For open-ended topics without source materials')
    expect(planningTemplate).not.toContain('split or merge')
    expect(runtimeUserSource).toContain('hasSourceMaterialCue')
    expect(runtimeUserSource).toContain('hasSourceMaterials?: boolean')
    expect(runtimeUserSource).toContain('args.hasSourceMaterials || hasSourceMaterialCue')
    expect(runtimeUserSource).toContain('SOURCE_MATERIAL_PLANNING_RULES')
    expect(runtimeUserSource).not.toContain(
      'Do not reinterpret the reference document into a new creative storyline'
    )
  })

  it('requires source inspection before source-backed slide generation', () => {
    const sharedSource = readSource('src/main/agent-runtime/prompt/composers/shared.ts')
    const source = readSource('src/main/agent-runtime/prompt/composers/generation-user.ts')
    const sourceReadingSkill = readSource('resources/skills/amy-ppt-source-reading/SKILL.md')

    expect(sharedSource).toContain('SOURCE_READING_SKILL_NAME')
    expect(sharedSource).toContain('Before using source documents')
    expect(sharedSource).toContain('Grounding forbids inventing facts the source lacks')
    expect(sharedSource).not.toContain('Before writing source-backed content')
    expect(sharedSource).not.toContain('Do not read entire long documents into context at once')
    expect(sourceReadingSkill).toContain(
      'Use the DeepAgents filesystem tool `grep(pattern, path, glob)`'
    )
    expect(sourceReadingSkill).toContain('Use the DeepAgents filesystem tool `glob(pattern, path)`')
    expect(sourceReadingSkill).toContain('`pattern` is a literal string')
    expect(sourceReadingSkill).toContain('Use `read_file` only on targeted sections')
    expect(sourceReadingSkill).toContain('repeat grep -> targeted read')
    expect(sourceReadingSkill).toContain('retrieved snippet conflicts with the source passage')
    expect(sourceReadingSkill).toContain('Slide title: "Q3 Revenue Highlights"')
    expect(sourceReadingSkill).toContain('Prefer 50-80 lines around grep matches')
    // Source-grounded expansion moved out of the per-page user prompt; the
    // deduped rule text lives in the shared system-prompt expansion rules.
    expect(source).not.toContain('expansion must be source-grounded')
    expect(sharedSource).toContain('expansion must be source-grounded')
    // Source rules live in the system prompt; the user prompt references them
    // by name rather than re-including the full text (dedup).
    expect(source).toContain('Follow the source-document strategy, fact rules')
    expect(source).toContain('Follow the locate-then-read strategy')
    expect(readSource('src/main/agent-runtime/prompt/composers/deck-system.ts')).toContain(
      'SOURCE_GROUNDED_EXPANSION_RULES'
    )
    expect(readSource('src/main/agent-runtime/prompt/composers/edit-system.ts')).toContain(
      'SOURCE_GROUNDED_EXPANSION_RULES'
    )
    expect(sharedSource).toContain('SOURCE_DOCUMENT_FACT_RULE')
    expect(sharedSource).toContain('examples, risks, decisions, or conclusions')
    expect(source).not.toContain('first use grep or glob')
    expect(source).not.toContain('you do not need to reread')
  })

  it('source-reading skill expands thin pages instead of over-suppressing into sparse slides', () => {
    const sourceReadingSkill = readSource('resources/skills/amy-ppt-source-reading/SKILL.md')

    // The old wording ("build ONLY from inspected passages" / "do not fill gaps")
    // over-suppressed: with a reference doc present the model rendered bare source
    // (chart + a couple facts) and left the page blank, because it read the skill as
    // forbidding any addition. Those over-strict lines are gone.
    expect(sourceReadingSkill).not.toContain('Build slide content only from inspected')
    expect(sourceReadingSkill).not.toContain('Do not fill gaps with plausible-sounding')

    // The skill now tells the model to expand a thin page into a full argument with
    // analytical structure derived from the inspected material.
    expect(sourceReadingSkill).toContain('A half-empty slide is a failure')
    expect(sourceReadingSkill).toContain('Expand the slide into a complete argument')
    expect(sourceReadingSkill).toContain('comparison dimensions')

    // ...while keeping the anti-hallucination core: never invent EXACT facts.
    expect(sourceReadingSkill).toContain('Do not invent exact facts')
  })
})
