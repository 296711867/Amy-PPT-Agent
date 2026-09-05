import fs from 'fs'
import log from 'electron-log/main.js'
import type { GenerateChunkEvent } from '@shared/generation'
import type { SlideSizePreset } from '@shared/slide-size'
import { progressText } from '@shared/progress'
import { extractJsonBlock, resolveModel, runWithModelTemperatureControl } from '../agent-runtime/model'
import type { GenerationModelControl } from './context'
import {
  enqueueHtmlThumbnail,
  waitForHtmlThumbnailTask
} from '../io/thumbnails/html-thumbnail-service'

const uiText = (locale: 'zh' | 'en', zh: string, en: string): string =>
  locale === 'en' ? en : zh

/**
 * 渲染级视觉自检（改编自 ppt-master 的 visual-review 阶段）：
 * 生成完成后把每页渲染成截图，按固定 rubric（Hard/Soft 规则）分批评审，
 * 结果作为信息性提示推送——v1 不改写页面、不阻断流程。
 *
 * 安全约束：
 * - 整体 try/catch，任何失败只降级为日志与一条跳过提示，绝不让生成收尾失败；
 * - 首批评审失败（典型如模型不支持图片输入）即停止后续批次，避免无谓重试；
 * - 通过 settings 的 visual_review=off 可整体关断。
 */

export type VisualReviewVerdict = 'pass' | 'soft' | 'hard'

export interface VisualReviewIssue {
  rule: string
  detail: string
}

export interface VisualReviewPageResult {
  pageId: string
  pageNumber: number
  verdict: VisualReviewVerdict
  issues: VisualReviewIssue[]
}

export interface VisualReviewPageRef {
  pageId: string
  pageNumber: number
  title: string
  htmlPath: string
}

const REVIEW_BATCH_SIZE = 3
const REVIEW_MAX_PAGES = 30
const REVIEW_IMAGE_MAX_WIDTH = 1024
const CAPTURE_TIMEOUT_MS = 30_000

export const VISUAL_REVIEW_RUBRIC = [
  'Hard rules (verdict "hard" when any applies):',
  '- H1 text-clipping: text is cut off, truncated, or overlaps other text/elements',
  '- H2 canvas-overflow: content overflows the canvas or is squeezed against the edges with no breathing margin',
  '- H3 unreadable-text: text too small to read when projected, or too low-contrast against its own background',
  '- H4 blank-page: the page is blank, near-blank, or still an unfilled placeholder',
  '- H5 broken-visual: blank chart canvas, missing-image placeholders, or visibly distorted images',
  'Soft rules (verdict "soft" when any applies and no hard rule does):',
  '- S1 unbalanced-composition: content crowds one region while large zones sit accidentally empty',
  '- S2 inconsistent-system: typography scale, colors, or component language visibly deviates from the other slides in this batch',
  '- S3 decoration-conflict: decorative elements cross through or compete with text',
  '- S4 icon-misuse: emoji used as icons or obviously hand-drawn icon paths',
  'Verdict "pass" when no rule applies.'
].join('\n')

export function buildVisualReviewRubricPrompt(batch: VisualReviewPageRef[]): string {
  const roster = batch
    .map((page) => `- pageNumber ${page.pageNumber}, pageId ${page.pageId}: "${page.title}"`)
    .join('\n')
  return [
    'You are reviewing rendered PPT slide screenshots for visual quality.',
    'Images are provided in the same order as this roster:',
    roster,
    '',
    VISUAL_REVIEW_RUBRIC,
    '',
    'Return ONLY a JSON array with exactly one object per roster entry, in roster order:',
    '[{"pageNumber":1,"pageId":"page-x","verdict":"pass|soft|hard","issues":[{"rule":"H1","detail":"one short sentence"}]}]',
    'Every issue must cite its rule id (H1-H5 or S1-S4). Use an empty issues array for "pass". Do not add explanations outside the JSON.'
  ].join('\n')
}

export function partitionVisualReviewBatches<T>(items: T[], batchSize = REVIEW_BATCH_SIZE): T[][] {
  const size = Math.max(1, Math.floor(batchSize))
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

/** 页数超过上限时等距抽样（保留首尾），控制评审成本。 */
export function sampleVisualReviewPages<T extends { pageNumber: number }>(
  pages: T[],
  maxPages = REVIEW_MAX_PAGES
): T[] {
  if (pages.length <= maxPages) return pages
  const keep = new Set<number>()
  keep.add(0)
  keep.add(pages.length - 1)
  const step = pages.length / maxPages
  for (let index = 1; index < maxPages - 1; index += 1) {
    keep.add(Math.min(pages.length - 2, Math.round(index * step)))
  }
  return pages.filter((_, index) => keep.has(index))
}

export function supportsVisualReviewInput(baseUrl: string): boolean {
  return !/\/api\/coding\/paas(?:\/|$)/i.test(baseUrl)
}

export function parseVisualReviewVerdicts(
  responseText: string,
  expectedPages: VisualReviewPageRef[]
): VisualReviewPageResult[] {
  const jsonText = extractJsonBlock(responseText)
  const parsed = JSON.parse(jsonText)
  if (!Array.isArray(parsed)) throw new Error('visual review response is not a JSON array')
  const expectedById = new Map(expectedPages.map((page) => [page.pageId, page]))
  const results: VisualReviewPageResult[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const pageId = String(record.pageId || '').trim()
    const page = expectedById.get(pageId)
    if (!page) continue
    const verdict =
      record.verdict === 'hard' || record.verdict === 'soft' ? record.verdict : 'pass'
    const issues: VisualReviewIssue[] = Array.isArray(record.issues)
      ? (record.issues as Array<Record<string, unknown>>)
          .map((issue) => ({
            rule: String(issue?.rule || '').trim().toUpperCase(),
            detail: String(issue?.detail || '').trim()
          }))
          .filter((issue) => issue.rule && issue.detail)
          .slice(0, 6)
      : []
    results.push({ pageId, pageNumber: page.pageNumber, verdict, issues })
  }
  return results
}

const defaultCapturePageImage = async (
  page: VisualReviewPageRef,
  args: { sessionId: string; slideSize: SlideSizePreset }
): Promise<string | null> => {
  const scale = Math.min(1, REVIEW_IMAGE_MAX_WIDTH / Math.max(1, args.slideSize.width))
  const width = Math.round(args.slideSize.width * scale)
  const height = Math.round(args.slideSize.height * scale)
  await enqueueHtmlThumbnail(
    {
      resourceType: 'session',
      resourceId: `${args.sessionId}:${page.pageId}`,
      variant: 'visual-review',
      sourcePath: page.htmlPath,
      pageId: page.pageId,
      captureWidth: args.slideSize.width,
      captureHeight: args.slideSize.height,
      thumbnailWidth: width,
      thumbnailHeight: height
    },
    { force: true }
  )
  const task = await waitForHtmlThumbnailTask(
    'session',
    `${args.sessionId}:${page.pageId}`,
    'visual-review',
    CAPTURE_TIMEOUT_MS
  )
  if (!task.thumbnailPath || !fs.existsSync(task.thumbnailPath)) return null
  const buffer = await fs.promises.readFile(task.thumbnailPath)
  return buffer.toString('base64')
}

export async function runVisualDeckReview(args: {
  sessionId: string
  runId?: string
  slideSize: SlideSizePreset
  pages: VisualReviewPageRef[]
  model: {
    provider: string
    apiKey: string
    model: string
    baseUrl: string
    maxTokens?: number
    modelRuntime?: Parameters<typeof resolveModel>[6]
    modelControl?: GenerationModelControl
    timeoutMs?: number
  }
  appLocale: 'zh' | 'en'
  isEnabled?: () => Promise<boolean>
  emit?: (chunk: GenerateChunkEvent) => void
  signal?: AbortSignal
  capturePageImage?: (
    page: VisualReviewPageRef,
    context: { sessionId: string; slideSize: SlideSizePreset }
  ) => Promise<string | null>
}): Promise<void> {
  const emitStatus = (detail: string, extra: Record<string, unknown> = {}): void => {
    args.emit?.({
      type: 'llm_status',
      payload: {
        runId: args.runId || '',
        stage: 'validation',
        label: progressText(args.appLocale, 'completed'),
        progress: 95,
        detail,
        ...extra
      }
    })
  }

  try {
    if (args.pages.length === 0) return
    if (args.isEnabled && !(await args.isEnabled())) return
    if (args.signal?.aborted) return
    if (!supportsVisualReviewInput(args.model.baseUrl)) {
      emitStatus(
        uiText(
          args.appLocale,
          '视觉自检已跳过：当前 Coding 接口仅接受文本输入',
          'Visual review skipped: the current Coding endpoint accepts text input only'
        )
      )
      return
    }

    const reviewedPages = sampleVisualReviewPages(
      [...args.pages].sort((a, b) => a.pageNumber - b.pageNumber)
    )
    if (reviewedPages.length === 0) {
      emitStatus(
        uiText(
          args.appLocale,
          '视觉自检已跳过：没有可供评审的页面',
          'Visual review skipped: there were no pages available to review'
        ),
        { totalPages: args.pages.length, reviewedPages: 0 }
      )
      return
    }
    emitStatus(
      uiText(
        args.appLocale,
        `视觉自检：正在评审 ${reviewedPages.length} 页渲染截图`,
        `Visual review: inspecting rendered screenshots of ${reviewedPages.length} slides`
      ),
      { totalPages: args.pages.length, reviewedPages: 0 }
    )

    const capturePageImage = args.capturePageImage || defaultCapturePageImage
    const batches = partitionVisualReviewBatches(reviewedPages)
    let reviewed = 0
    let passCount = 0
    let softCount = 0
    let hardCount = 0
    const reviewedPageIds = new Set<string>()
    let unavailableCaptureCount = 0

    for (const batch of batches) {
      if (args.signal?.aborted) break
      const images: Array<{ page: VisualReviewPageRef; base64: string }> = []
      for (const page of batch) {
        try {
          const base64 = await capturePageImage(page, {
            sessionId: args.sessionId,
            slideSize: args.slideSize
          })
          if (base64) images.push({ page, base64 })
          else unavailableCaptureCount += 1
        } catch (error) {
          unavailableCaptureCount += 1
          log.warn('[visual-review] page screenshot unavailable', {
            sessionId: args.sessionId,
            pageId: page.pageId,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (images.length === 0) continue

      const client = args.model.modelControl
        ? runWithModelTemperatureControl(args.model.modelControl, () =>
            resolveModel(
              args.model.provider,
              args.model.apiKey,
              args.model.model,
              args.model.baseUrl,
              0,
              args.model.maxTokens,
              args.model.modelRuntime
            )
          )
        : resolveModel(
            args.model.provider,
            args.model.apiKey,
            args.model.model,
            args.model.baseUrl,
            0,
            args.model.maxTokens,
            args.model.modelRuntime
          )
      const response = await client.invoke([
        {
          role: 'user',
          content: [
            { type: 'text', text: buildVisualReviewRubricPrompt(images.map((item) => item.page)) },
            ...images.map(
              (item) =>
                ({
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${item.base64}` }
                }) as const
            )
          ]
        }
      ])
      const responseText =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .map((part) =>
                  part && typeof part === 'object' && 'text' in part
                    ? String((part as { text?: string }).text || '')
                    : ''
                )
                .join('')
            : ''
      const verdicts = parseVisualReviewVerdicts(
        responseText,
        images.map((item) => item.page)
      )

      for (const verdict of verdicts) {
        if (reviewedPageIds.has(verdict.pageId)) continue
        reviewedPageIds.add(verdict.pageId)
        reviewed += 1
        if (verdict.verdict === 'pass') {
          passCount += 1
          continue
        }
        if (verdict.verdict === 'hard') hardCount += 1
        else softCount += 1
        const issueText = verdict.issues
          .map((issue) => `${issue.rule}: ${issue.detail}`)
          .join('；')
        emitStatus(
          uiText(
            args.appLocale,
            `第 ${verdict.pageNumber} 页视觉自检${verdict.verdict === 'hard' ? '存在严重问题' : '有优化建议'}：${issueText}`,
            `Slide ${verdict.pageNumber} visual review ${verdict.verdict === 'hard' ? 'flagged a hard issue' : 'suggests an improvement'}: ${issueText}`
          ),
          { currentPage: verdict.pageNumber, totalPages: args.pages.length }
        )
      }
    }

    if (reviewed === reviewedPages.length) {
      emitStatus(
        uiText(
          args.appLocale,
          `视觉自检完成：${passCount} 页通过，${softCount} 页有优化建议，${hardCount} 页存在严重视觉问题（可在编辑器中手动修复）`,
          `Visual review finished: ${passCount} passed, ${softCount} with suggestions, ${hardCount} with hard issues (fix them manually in the editor)`
        ),
        { totalPages: args.pages.length, reviewedPages: reviewed }
      )
    } else if (reviewed > 0) {
      emitStatus(
        uiText(
          args.appLocale,
          `视觉自检未完成：仅获得 ${reviewed}/${reviewedPages.length} 页评审结果${unavailableCaptureCount > 0 ? `，${unavailableCaptureCount} 页截图不可用` : ''}`,
          `Visual review incomplete: received verdicts for ${reviewed}/${reviewedPages.length} slides${unavailableCaptureCount > 0 ? `; screenshots unavailable for ${unavailableCaptureCount}` : ''}`
        ),
        { totalPages: args.pages.length, reviewedPages: reviewed }
      )
    } else {
      emitStatus(
        uiText(
          args.appLocale,
          '视觉自检已跳过：未能获得可用的页面评审结果',
          'Visual review skipped: no usable page verdicts were available'
        ),
        { totalPages: args.pages.length, reviewedPages: 0 }
      )
    }
  } catch (error) {
    // 非阻塞：视觉自检的任何失败都不影响生成结果。
    log.warn('[visual-review] skipped after failure', {
      sessionId: args.sessionId,
      message: error instanceof Error ? error.message : String(error)
    })
    emitStatus(
      uiText(
        args.appLocale,
        '视觉自检已跳过（模型可能不支持图片输入或渲染暂不可用）',
        'Visual review skipped (the model may not accept image input, or rendering is unavailable)'
      )
    )
  }
}
