/** 计划质量校验：语言匹配、大纲结构断言、轻量计划归一化与骨架 brief 组装。 */
import { extractJsonBlock } from '../agent-runtime/model'
import type { ParsedDocumentPlanResult } from '@shared/generation'
import fs from 'fs'
import {
  estimateOutlinePageCount,
  scanHasMultipleSlideCandidates,
  scanHeadingTitles,
  type DocumentOutlinePageCandidate,
  type DocumentOutlineScan
} from './document-outline-scan'
import type { PreparedSourceFile } from './document-source-preparation'
import type { DocumentPlanPageSkeletonItem } from '@shared/generation'

export const MAX_PAGE_COUNT = 500
export const MAX_PARSE_SOURCE_PREVIEW_CHARS = 20_000
const CJK_PATTERN = /[\u3400-\u9fff]/
const LATIN_WORD_PATTERN = /\b[A-Za-z][A-Za-z'-]{2,}\b/g

export class RetryableDocumentPlanQualityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryableDocumentPlanQualityError'
  }
}
const countCjkChars = (value: string): number =>
  Array.from(value).filter((char) => CJK_PATTERN.test(char)).length

const countLatinWords = (value: string): number => value.match(LATIN_WORD_PATTERN)?.length ?? 0

export const isMostlyEnglishText = (value: string): boolean => {
  const sample = value.slice(0, 30_000)
  const latinWords = countLatinWords(sample)
  const cjkChars = countCjkChars(sample)
  return latinWords >= 30 && cjkChars <= Math.max(10, latinWords * 0.08)
}

export const isMostlyChineseText = (value: string): boolean => {
  const sample = value.slice(0, 30_000)
  const latinWords = countLatinWords(sample)
  const cjkChars = countCjkChars(sample)
  return cjkChars >= 50 && cjkChars > latinWords
}

const ENGLISH_BRIEF_LABEL_PATTERN =
  /(?:^|\n)\s*(?:Presentation\s*goal|Presentationgoal|Audience\s*\/\s*context|Audiencecontext|Core\s*argument|Coreargument|Recommended\s*outline|Recommendedoutline|Per[-\s]*page\s*points|Per-pagepoints|Perpagepoints|Facts\s*\/\s*metrics\s*\/\s*terms\s*to\s*preserve|Facts\/metrics\/termstopreserve|Factsmetricstermstopreserve|Style\s*or\s*expression\s*notes|Styleorexpressionnotes|Page\s*\d{1,2})\s*[:：]/i

export const assertPlanLanguageMatchesSource = async (args: {
  file: PreparedSourceFile
  plan: Pick<ParsedDocumentPlanResult, 'topic' | 'briefText'>
  userText: string
}): Promise<void> => {
  if (args.file.type === 'image') return
  if (countCjkChars(args.userText) >= 6) return

  const sourceText = await fs.promises.readFile(args.file.workspacePath, 'utf-8').catch(() => '')
  const outputText = `${args.plan.topic}\n${args.plan.briefText}`

  if (isMostlyEnglishText(sourceText) && countCjkChars(outputText) >= 12) {
    throw new RetryableDocumentPlanQualityError(
      'The source document is primarily English, but topic/briefText were returned in Chinese. Return topic and briefText in English; do not translate the outline into Chinese.'
    )
  }

  if (isMostlyChineseText(sourceText) && ENGLISH_BRIEF_LABEL_PATTERN.test(args.plan.briefText)) {
    throw new RetryableDocumentPlanQualityError(
      '源文档主要是中文，但 briefText 使用了英文结构标签。请用中文结构标签返回，例如：演示目标、受众/场景、核心观点、建议大纲、每页要点、必须保留的事实/指标/术语、风格/表达要求。不要使用 Presentation goal、Audience/context、Core argument、Recommended outline、Per-page points、Page 1 等英文模板标签。'
    )
  }
}
export const assertPlanMatchesDocumentOutline = (args: {
  scan: DocumentOutlineScan | null
  pageCandidates: DocumentOutlinePageCandidate[]
  plan: Pick<ParsedDocumentPlanResult, 'pageCount' | 'briefText'>
}): void => {
  if (!args.scan || !scanHasMultipleSlideCandidates(args.scan)) return
  if (args.plan.pageCount <= 1) {
    throw new RetryableDocumentPlanQualityError(
      'The source document has multiple Markdown/source sections, but the plan collapsed it to one slide. Rebuild the outline from the document heading structure and infer a multi-slide pageCount.'
    )
  }
  const pageCountEstimate = estimateOutlinePageCount(args.scan, args.pageCandidates)
  if (
    args.pageCandidates.length > 0 &&
    pageCountEstimate &&
    args.plan.pageCount !== pageCountEstimate.preferredPageCount
  ) {
    throw new RetryableDocumentPlanQualityError(
      `The source document scan provided an authoritative page candidate skeleton of ${pageCountEstimate.preferredPageCount} slides, but the plan returned pageCount=${args.plan.pageCount}. Rebuild the outline from the page candidate skeleton without compressing or expanding it.`
    )
  }
  if (
    pageCountEstimate &&
    (args.plan.pageCount < pageCountEstimate.minPageCount ||
      args.plan.pageCount > pageCountEstimate.maxPageCount)
  ) {
    throw new RetryableDocumentPlanQualityError(
      `The source document structure suggests ${pageCountEstimate.preferredPageCount} slides with acceptable range ${pageCountEstimate.minPageCount}-${pageCountEstimate.maxPageCount}, but the plan returned pageCount=${args.plan.pageCount}. Rebuild the outline using the deterministic source-structure page-count estimate.`
    )
  }

  const briefText = args.plan.briefText
  if (hasOutlinePageCandidateSkeleton(args.pageCandidates)) return

  const hasSourceHeadingLabel =
    /源文档结构|来源标题|Source document structure|Source heading/i.test(briefText)
  const headingTitles = scanHeadingTitles(args.scan)
  const mentionedHeadingCount = headingTitles.filter((title) => briefText.includes(title)).length
  if (!hasSourceHeadingLabel && mentionedHeadingCount < Math.min(2, headingTitles.length)) {
    throw new RetryableDocumentPlanQualityError(
      'The source document has a heading structure, but briefText does not preserve source headings. Include a compact source-structure section and source heading for each page entry.'
    )
  }
}

export const isDocumentOutlineQualityError = (error: unknown): boolean =>
  error instanceof RetryableDocumentPlanQualityError &&
  /multiple Markdown\/source sections|heading structure|source-structure page-count estimate|page candidate skeleton/i.test(
    error.message
  )

export const hasOutlinePageCandidateSkeleton = (pageCandidates: DocumentOutlinePageCandidate[]): boolean =>
  pageCandidates.length > 0

export const formatLightweightPageCandidateSkeletonForPrompt = (args: {
  scan: DocumentOutlineScan | null
  pageCandidates: DocumentOutlinePageCandidate[]
}): string => {
  if (!args.scan || args.pageCandidates.length === 0) return ''
  return [
    'Document structure scan:',
    `- Format: ${args.scan.format}`,
    `- Markdown headings detected: ${args.scan.headingCount}`,
    args.scan.topLevelTitle ? `- Top-level title: ${args.scan.topLevelTitle}` : '',
    `- Authoritative page candidate skeleton: ${args.pageCandidates.length} slides.`,
    ...args.pageCandidates.map(
      (candidate, index) =>
        `  ${index + 1}. [${candidate.role}] ${candidate.sourceHeading} (lines ${candidate.lineStart}-${candidate.lineEnd})`
    )
  ]
    .filter(Boolean)
    .join('\n')
}

export const normalizeLightweightGeneratedPlan = (
  rawText: string,
  fallback: {
    topic: string
    pageCount: number
  }
): Pick<ParsedDocumentPlanResult, 'topic' | 'pageCount' | 'briefText'> => {
  const parsed = (() => {
    try {
      return JSON.parse(extractJsonBlock(rawText)) as unknown
    } catch {
      return null
    }
  })()
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const topic =
    typeof record.topic === 'string' && record.topic.trim() ? record.topic.trim() : fallback.topic
  const rawPageCount = Number(record.pageCount ?? record.page_count ?? fallback.pageCount)
  const pageCount = Number.isFinite(rawPageCount)
    ? Math.min(MAX_PAGE_COUNT, Math.max(1, Math.round(rawPageCount)))
    : fallback.pageCount
  if (!topic) throw new Error('文档解析完成，但模型未返回 topic')
  return {
    topic,
    pageCount,
    briefText: ''
  }
}

export const formatPageSkeletonBriefText = (args: {
  topic: string
  pageSkeleton: DocumentPlanPageSkeletonItem[]
}): string => {
  const useChineseLabels = CJK_PATTERN.test(
    `${args.topic}\n${args.pageSkeleton.map((item) => `${item.title}\n${item.reason}`).join('\n')}`
  )
  const outlineLabel = useChineseLabels ? '建议大纲' : 'Recommended outline'
  const summaryLabel = useChineseLabels ? '简要总结' : 'Brief summary'
  const pageLabel = useChineseLabels ? '第' : 'Page'
  const pageSuffix = useChineseLabels ? ' 页' : ''

  return [
    `## ${outlineLabel}`,
    ...args.pageSkeleton.map(
      (item) =>
        `### ${pageLabel} ${item.pageNumber}${pageSuffix}: ${item.title}\n\n- **${summaryLabel}:** ${item.reason || item.title}`
    )
  ].join('\n\n')
}
