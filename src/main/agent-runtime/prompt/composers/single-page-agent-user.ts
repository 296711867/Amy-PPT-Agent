import type { SessionDeckGenerationContext } from '../../agent/types'
import type { VisualFormat } from '@shared/generation'
import {
  describeTemplatePageRole,
  isValidTemplatePageRole
} from '../../../templates/template-page-roles'
import { buildSinglePageGenerationPrompt } from './generation-user'

type OutlineItem = SessionDeckGenerationContext['outlineItems'][number]

export interface SinglePageAgentUserPromptPage {
  pageId: string
  pageNumber: number
  title: string
  outline: string
  layoutIntent?: OutlineItem['layoutIntent']
  contentStructure?: OutlineItem['contentStructure']
  moduleCount?: OutlineItem['moduleCount']
  visualAspect?: OutlineItem['visualAspect']
  contentDensity?: OutlineItem['contentDensity']
  visualFormat?: VisualFormat
  audienceMove?: string
  layoutId?: string
  layoutPrompt?: string
  imageAssetPath?: string
  imageAssetPaths?: string[]
  backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
  templatePageRole?: string
}

/**
 * 单页生成的完整 agent user prompt：运行级附加说明、重试修复指令、模板页
 * 强制读取说明、模板页角色约束、deck 标题带锚点，加上页面级数据 prompt。
 * 逐页变量全部在这里，system prompt 保持 deck 级稳定，便于 provider 端
 * prompt cache 命中。
 */
export function buildSinglePageAgentUserPrompt(args: {
  topic: string
  deckTitle: string
  slideSize: import('@shared/slide-size').SlideSizePreset
  generationMode?: 'generate' | 'retry'
  singlePagePromptAddendum?: string
  pagePromptAddendum?: string
  requireTemplatePageRead?: boolean
  methodLevelFixes?: string[]
  page: SinglePageAgentUserPromptPage
  sourceDocumentPaths?: string[]
  referenceDocumentSnippets?: string
  retryContext?: {
    attempt: number
    maxRetries: number
    previousError: string
  }
  /** 同 deck 已写页面抽出的标题带锚点：重生成/重试页必须复刻该版式。 */
  titleBandAnchor?: {
    pageId: string
    pageNumber: number
    bandHtml: string
  } | null
}): string {
  const { page } = args
  const writeToolName: 'update_single_page_file' | 'update_template_page_file' =
    args.requireTemplatePageRead ? 'update_template_page_file' : 'update_single_page_file'

  return [
    args.singlePagePromptAddendum?.trim() || '',
    args.pagePromptAddendum?.trim() || '',
    args.retryContext
      ? [
          '',
          'Targeted repair instructions (this is a retry):',
          '1. First read the existing page HTML with read_file to see what is already written.',
          '2. Identify the specific violation from the previous error and fix ONLY that issue.',
          '3. Preserve all content, facts, and layout elements that were correct in the previous version.',
          '4. Do not rewrite the entire page from scratch — make surgical fixes to the failing elements.',
          `5. Previous error: ${args.retryContext.previousError}`
        ].join('\n')
      : '',
    args.requireTemplatePageRead
      ? [
          'Template inspection is mandatory before writing.',
          `1. First call read_file(path="/${page.pageId}.html", offset=0, limit=1200) to inspect the copied template page.`,
          '2. Identify every template-skeleton asset and wrapper: background images, texture images, decorative images, masks, overlays, CSS background-image/url(...) references, <img src>, SVG image href, font scale, spacing rhythm, color language, and reusable structural wrappers from that file.',
          '3. These background/decorative assets are not old business content. Do not delete them when replacing text, metrics, logos, or content images.',
          '4. update_template_page_file rebuilds the page from your content fragment and rejects writes that drop template skeleton resources, so the fragment you write must explicitly include the required background/decorative layers or exact local asset references from the template page.',
          '5. Only after reading the file, call update_template_page_file with the new content while preserving the template visual system unless the user explicitly asks for a redesign.',
          '6. Do not call update_single_page_file in this template run.'
        ].join('\n')
      : '',
    isValidTemplatePageRole(page.templatePageRole)
      ? `The template base for this slide was classified as a ${describeTemplatePageRole(page.templatePageRole).en} (${describeTemplatePageRole(page.templatePageRole).zh}). Keep that structural role: preserve the composition and hierarchy of the base (e.g. a cover base stays a cover, a data base keeps chart/table prominence) while replacing the old content.`
      : '',
    args.titleBandAnchor
      ? [
          'Deck title band anchor (hard requirement):',
          `- Pages already written in this deck use the title band markup below (anchor: page ${args.titleBandAnchor.pageNumber}, ${args.titleBandAnchor.pageId}).`,
          '- Reuse this exact band for this page: same element structure, alignment, font-size tier, kicker/rule treatment, colors, margins, and title-to-content gap.',
          "- Replace only the title (and kicker) text with this page's title. Do not invent a new alignment, size, decoration, or position for the title band.",
          'Anchor band markup:',
          args.titleBandAnchor.bandHtml
        ].join('\n')
      : '',
    buildSinglePageGenerationPrompt({
      topic: args.topic,
      deckTitle: args.deckTitle,
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      pageTitle: page.title,
      pageOutline: page.outline,
      slideSize: args.slideSize,
      layoutIntent: page.layoutIntent,
      contentStructure: page.contentStructure,
      moduleCount: page.moduleCount,
      visualAspect: page.visualAspect,
      contentDensity: page.contentDensity,
      visualFormat: page.visualFormat,
      audienceMove: page.audienceMove,
      methodLevelFixes: args.methodLevelFixes?.slice(),
      layoutId: page.layoutId,
      layoutPrompt: page.layoutPrompt,
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      backgroundAsset: page.backgroundAsset,
      sourceDocumentPaths: args.sourceDocumentPaths,
      referenceDocumentSnippets: args.referenceDocumentSnippets,
      isRetryMode: args.generationMode === 'retry',
      writeToolName,
      retryContext: args.retryContext
    })
  ]
    .filter(Boolean)
    .join('\n\n')
}
