/** 页面骨架批量摘要：按源行区间抽取段落，分批并发调用模型生成每页简述。 */
import fs from 'fs'
import pLimit from 'p-limit'
import log from 'electron-log/main.js'
import { extractJsonBlock, extractModelText, resolveModel } from '../agent-runtime/model'
import type { ModelRuntimeConfig } from '../agent-runtime/model'
import { isSectionAgendaReason, type DocumentPlanPageSkeletonItem } from '@shared/generation'
import { resolveModelTimeoutMs } from '@shared/model-timeout'
import type { PreparedSourceFile } from './document-source-preparation'
import { sleep, stripControlChars } from './document-source-preparation'

const PAGE_SUMMARY_BATCH_SIZE = 10
const PAGE_SUMMARY_BATCH_CONCURRENCY = 2
const PAGE_SUMMARY_BATCH_START_DELAY_MS = 200
const PAGE_SUMMARY_BATCH_MAX_ATTEMPTS = 3
const MAX_PAGE_SUMMARY_PASSAGE_CHARS = 1_600
const MAX_PAGE_SUMMARY_TOTAL_PAGES = 300
const MAX_PAGE_SUMMARY_CHARS = 80
type PageSummaryTarget = {
  id: string
  item: DocumentPlanPageSkeletonItem
  passage: string
}
const extractSourcePassageByLines = (
  sourceLines: string[],
  item: DocumentPlanPageSkeletonItem
): string => {
  const start = Math.max(1, Math.floor(item.lineStart || 1))
  const end = Math.max(start, Math.floor(item.lineEnd || start))
  const text = sourceLines
    .slice(start - 1, end)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)、．])\s+/, '')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_`~>|]+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join(' ')
    .trim()
  return text.length > MAX_PAGE_SUMMARY_PASSAGE_CHARS
    ? `${text.slice(0, MAX_PAGE_SUMMARY_PASSAGE_CHARS).trim()}\n...[truncated]`
    : text
}

const buildPageSummaryBatchPrompt = (args: {
  topic: string
  targets: PageSummaryTarget[]
  retryHint?: string
}): string =>
  [
    'Summarize source passages for PPT page suggestions.',
    'The host has already selected exact source line ranges for each page. Use only the provided passages.',
    'Return strict JSON only: {"items":[{"id":"page-1","pageNumber":1,"summary":"..."}]}',
    '',
    'Rules:',
    '- Return exactly one non-empty summary for every page listed.',
    '- Preserve each page ID exactly as provided. Do not renumber pages within this batch.',
    '- Write a very brief factual summary for each page, grounded in its source passage when body text is available.',
    `- Each summary must be very concise and at most ${MAX_PAGE_SUMMARY_CHARS} characters.`,
    '- Preserve important facts, metrics, terms, names, and source language.',
    '- Do not invent missing facts. If the passage has no body text beyond a heading, summarize the page role or section based on the page title and source heading instead of returning an empty summary.',
    '- Keep each summary short enough for an editable PPT creation dialog.',
    args.retryHint
      ? `Retry requirement: the previous response was invalid because: ${args.retryHint}. Return all listed IDs exactly once in this attempt.`
      : '',
    '',
    args.topic ? `Deck topic: ${args.topic}` : '',
    '',
    'Pages:',
    ...args.targets.map((target) =>
      [
        `ID: ${target.id}`,
        `Page ${target.item.pageNumber}: ${target.item.title}`,
        `Role: ${target.item.role}`,
        `Source heading: ${target.item.sourceHeading}`,
        `Source lines: ${target.item.lineStart}-${target.item.lineEnd}`,
        `Passage: ${target.passage || '(No body text was extracted for this page.)'}`
      ].join('\n')
    )
  ]
    .filter(Boolean)
    .join('\n\n')

const readPageSummaryItems = (
  responseText: string,
  allowedTargets: Map<string, number>
): Map<number, string> => {
  const parsed = (() => {
    try {
      return JSON.parse(extractJsonBlock(responseText)) as unknown
    } catch {
      return null
    }
  })()
  const rawItems =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).items
      : parsed
  if (!Array.isArray(rawItems)) return new Map()

  const result = new Map<number, string>()
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const record = rawItem as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const pageNumber = id ? allowedTargets.get(id) : undefined
    const summary =
      typeof record.summary === 'string'
        ? record.summary.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_SUMMARY_CHARS).trim()
        : ''
    if (!pageNumber || !summary) continue
    result.set(pageNumber, summary)
  }
  return result
}

const missingPageSummaryIds = (
  batch: PageSummaryTarget[],
  summaries: Map<number, string>
): string[] =>
  batch.filter((target) => !summaries.get(target.item.pageNumber)).map((target) => target.id)

const summarizePageSummaryBatch = async (args: {
  batch: PageSummaryTarget[]
  batchIndex: number
  topic: string
  client: ReturnType<typeof resolveModel>
  modelTimeoutMs: number
  sourceVirtualPath: string
  totalSummaryTargets: number
  waitForBatchStartSlot: () => Promise<void>
}): Promise<Map<number, string>> => {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= PAGE_SUMMARY_BATCH_MAX_ATTEMPTS; attempt += 1) {
    const retryHint = attempt > 1 && lastError instanceof Error ? lastError.message : undefined
    const prompt = buildPageSummaryBatchPrompt({
      topic: args.topic,
      targets: args.batch,
      retryHint
    })
    try {
      await args.waitForBatchStartSlot()
      log.info('[documents:parsePlan] page summary batch invoke', {
        sourceVirtualPath: args.sourceVirtualPath,
        batchIndex: args.batchIndex + 1,
        attempt,
        maxAttempts: PAGE_SUMMARY_BATCH_MAX_ATTEMPTS,
        batchSize: args.batch.length,
        totalSummaryTargets: args.totalSummaryTargets,
        concurrency: PAGE_SUMMARY_BATCH_CONCURRENCY,
        startDelayMs: PAGE_SUMMARY_BATCH_START_DELAY_MS,
        promptLength: prompt.length,
        hasRetryHint: Boolean(retryHint)
      })
      const result = await args.client.invoke(
        [
          {
            role: 'system' as const,
            content:
              'You summarize source passages for PPT page suggestions. Return strict JSON only.'
          },
          {
            role: 'user' as const,
            content: prompt
          }
        ],
        {
          signal: AbortSignal.timeout(resolveModelTimeoutMs(args.modelTimeoutMs, 'document'))
        }
      )
      const batchSummaries = readPageSummaryItems(
        extractModelText(result),
        new Map(args.batch.map((target) => [target.id, target.item.pageNumber]))
      )
      const missingIds = missingPageSummaryIds(args.batch, batchSummaries)
      if (missingIds.length === 0) return batchSummaries
      throw new Error(`模型摘要返回缺少页面 ID: ${missingIds.join(', ')}`)
    } catch (error) {
      lastError = error
      log.warn('[documents:parsePlan] page summary batch attempt failed', {
        sourceVirtualPath: args.sourceVirtualPath,
        batchIndex: args.batchIndex + 1,
        attempt,
        maxAttempts: PAGE_SUMMARY_BATCH_MAX_ATTEMPTS,
        batchSize: args.batch.length,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  throw lastError || new Error('模型摘要批次失败')
}

export const summarizePageSkeletonContentInBatches = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  maxTokens: number | undefined
  modelRuntime: ModelRuntimeConfig
  modelTimeoutMs: number
  file: PreparedSourceFile
  topic: string
  pageSkeleton: DocumentPlanPageSkeletonItem[]
}): Promise<DocumentPlanPageSkeletonItem[]> => {
  if (args.file.type === 'image' || args.pageSkeleton.length === 0) return args.pageSkeleton
  const sourceText = await fs.promises.readFile(args.file.workspacePath, 'utf-8')
  const sourceLines = stripControlChars(sourceText).split('\n')
  const summaryTargets = args.pageSkeleton
    .filter((item) => !isSectionAgendaReason(item.reason))
    .slice(0, MAX_PAGE_SUMMARY_TOTAL_PAGES)
    .map((item) => ({
      id: item.id || `page-${item.pageNumber}`,
      item,
      passage: extractSourcePassageByLines(sourceLines, item)
    }))
    .sort((a, b) => a.item.pageNumber - b.item.pageNumber)
  if (summaryTargets.length === 0) return args.pageSkeleton

  const client = resolveModel(
    args.provider,
    args.apiKey,
    args.model,
    args.baseUrl,
    0.1,
    args.maxTokens,
    args.modelRuntime
  )
  const summaries = new Map<number, string>()
  const batches: PageSummaryTarget[][] = []

  for (let index = 0; index < summaryTargets.length; index += PAGE_SUMMARY_BATCH_SIZE) {
    batches.push(summaryTargets.slice(index, index + PAGE_SUMMARY_BATCH_SIZE))
  }

  const limit = pLimit(PAGE_SUMMARY_BATCH_CONCURRENCY)
  let nextBatchStartAt = Date.now()
  const waitForBatchStartSlot = async (): Promise<void> => {
    const now = Date.now()
    const waitMs = Math.max(0, nextBatchStartAt - now)
    nextBatchStartAt = Math.max(now, nextBatchStartAt) + PAGE_SUMMARY_BATCH_START_DELAY_MS
    if (waitMs > 0) await sleep(waitMs)
  }

  await Promise.all(
    batches.map((batch, batchIndex) =>
      limit(async () => {
        try {
          const batchSummaries = await summarizePageSummaryBatch({
            batch,
            batchIndex,
            topic: args.topic,
            client,
            modelTimeoutMs: args.modelTimeoutMs,
            sourceVirtualPath: args.file.virtualPath,
            totalSummaryTargets: summaryTargets.length,
            waitForBatchStartSlot
          })
          batchSummaries.forEach((summary, pageNumber) => summaries.set(pageNumber, summary))
        } catch (error) {
          log.warn('[documents:parsePlan] page summary batch failed, keeping existing summaries', {
            sourceVirtualPath: args.file.virtualPath,
            batchIndex: batchIndex + 1,
            maxAttempts: PAGE_SUMMARY_BATCH_MAX_ATTEMPTS,
            batchSize: batch.length,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    )
  )

  if (args.pageSkeleton.length > summaryTargets.length) {
    log.info('[documents:parsePlan] page summary target capped', {
      sourceVirtualPath: args.file.virtualPath,
      summarizedPages: summaryTargets.length,
      totalPages: args.pageSkeleton.length
    })
  }

  return args.pageSkeleton.map((item) => ({
    ...item,
    reason: summaries.get(item.pageNumber) || item.reason || item.title
  }))
}
