/** 文档解析 IPC 注册：参考文档准备、图片参考解析、文档→创建表单计划。 */
import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import type { IpcContext } from '../ipc/context'
import type {
  ParseDocumentPlanPayload,
  ParseImageReferencePayload,
  ParsedDocumentPlanResult,
  PrepareReferenceDocumentPayload,
  PreparedReferenceDocumentResult
} from '@shared/generation'
import { resolveGlobalModelTimeouts, resolveModelConfigForTask } from '../config/model-config-utils'
import { assertImageWasRead } from '../styles/import/image'
import { normalizeGeneratedPlan as normalizeDocumentPlan } from './document-plan-normalizer'
import { estimateOutlinePageCount, scanHasMultipleSlideCandidates } from './document-outline-scan'
import {
  buildDocumentPlanPageSkeleton,
  sanitizeDocumentPlanPageSkeletonContent
} from './document-plan-page-skeleton'
import { MAX_DOCUMENT_FILES, prepareSourceFile, scanPreparedSourceOutline } from './document-source-preparation'
import {
  RetryableDocumentPlanQualityError,
  assertPlanLanguageMatchesSource,
  assertPlanMatchesDocumentOutline,
  formatPageSkeletonBriefText,
  hasOutlinePageCandidateSkeleton,
  isDocumentOutlineQualityError,
  normalizeLightweightGeneratedPlan
} from './document-plan-quality'
import { runSingleShotDocumentPlanModel } from './document-plan-model'
import { summarizePageSkeletonContentInBatches } from './document-page-summaries'
import {
  convertImageReferenceToMarkdown,
  runImageDocumentPlanModel,
  writeImagePlanReferenceFile
} from './document-image-plan'

export function registerDocumentParseHandlers(ctx: IpcContext): void {
  const { resolveStoragePath } = ctx

  ipcMain.handle(
    'documents:prepareReference',
    async (_event, payload: PrepareReferenceDocumentPayload) => {
      const input = payload && typeof payload === 'object' ? payload : { files: [] }
      const files = Array.isArray(input.files) ? input.files.slice(0, MAX_DOCUMENT_FILES) : []
      if (files.length === 0) throw new Error('请先选择要附加的参考文件')

      const docsDir = path.join(await resolveStoragePath(), 'docs')
      await fs.promises.mkdir(docsDir, { recursive: true })
      const preparedFiles = await Promise.all(files.map((file) => prepareSourceFile(file, docsDir)))

      return {
        files: preparedFiles.map(({ name, type, characterCount, workspacePath }) => ({
          name,
          type,
          characterCount,
          path: workspacePath
        }))
      } satisfies PreparedReferenceDocumentResult
    }
  )

  ipcMain.handle(
    'documents:parseImageReference',
    async (_event, payload: ParseImageReferencePayload) => {
      const input: Partial<ParseImageReferencePayload> =
        payload && typeof payload === 'object' ? payload : {}
      const rawFile = input.file && typeof input.file === 'object' ? input.file : null
      if (!rawFile) throw new Error('请先选择要解析的图片')

      const docsDir = path.join(await resolveStoragePath(), 'docs')
      await fs.promises.mkdir(docsDir, { recursive: true })
      const sourceFile = await prepareSourceFile(rawFile, docsDir)
      if (sourceFile.type !== 'image') throw new Error('请选择 png、jpg、jpeg、webp 图片')

      const activeModel = await resolveModelConfigForTask(ctx, {
        modelConfigId: input.modelConfigId,
        purpose: 'documents:parseImageReference'
      })
      const modelTimeouts = await resolveGlobalModelTimeouts(ctx)
      const referenceFile = await convertImageReferenceToMarkdown({
        file: sourceFile,
        provider: activeModel.provider,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
        baseUrl: activeModel.baseUrl,
        maxTokens: activeModel.maxTokens,
        modelRuntime: ctx.modelRuntime,
        modelTimeoutMs: modelTimeouts.document
      })

      return {
        files: [
          {
            name: referenceFile.name,
            type: referenceFile.type,
            characterCount: referenceFile.characterCount,
            path: referenceFile.workspacePath
          }
        ]
      } satisfies PreparedReferenceDocumentResult
    }
  )

  ipcMain.handle('documents:parsePlan', async (_event, payload: ParseDocumentPlanPayload) => {
    const parseStartedAt = Date.now()
    const parseStartedAtIso = new Date(parseStartedAt).toISOString()
    let parseEndStatus: 'success' | 'error' = 'error'
    let parseEndSourceVirtualPath: string | null = null
    let parseEndPageCount: number | null = null
    let parseEndError: string | null = null
    try {
      const input = payload && typeof payload === 'object' ? payload : { files: [] }
      const files = Array.isArray(input.files) ? input.files.slice(0, MAX_DOCUMENT_FILES) : []
      if (files.length === 0) throw new Error('请先选择要解析的文档')
      log.info('[documents:parsePlan] invoke', {
        files: files.map((file) => ({
          name: typeof file.name === 'string' ? file.name : path.basename(String(file.path || '')),
          pathProvided: typeof file.path === 'string' && file.path.trim().length > 0
        })),
        startedAt: parseStartedAtIso
      })

      const docsDir = path.join(await resolveStoragePath(), 'docs')
      await fs.promises.mkdir(docsDir, { recursive: true })
      const preparedFiles = await Promise.all(files.map((file) => prepareSourceFile(file, docsDir)))
      const [sourceFile] = preparedFiles
      if (!sourceFile) throw new Error('请先选择要解析的文档')
      parseEndSourceVirtualPath = sourceFile.virtualPath
      const outlineResult = await scanPreparedSourceOutline(sourceFile)
      const outlineScan = outlineResult?.scan ?? null
      const pageCandidates = outlineResult?.pageCandidates ?? []
      const pageCountEstimate = estimateOutlinePageCount(outlineScan, pageCandidates)
      if (pageCountEstimate) {
        log.info('[documents:parsePlan] document outline page-count estimate', {
          preferredPageCount: pageCountEstimate.preferredPageCount,
          minPageCount: pageCountEstimate.minPageCount,
          maxPageCount: pageCountEstimate.maxPageCount,
          basis: pageCountEstimate.basis,
          sourceVirtualPath: sourceFile.virtualPath
        })
      }

      const activeModel = await resolveModelConfigForTask(ctx, {
        modelConfigId: input.modelConfigId,
        purpose: 'documents:parsePlan'
      })
      const modelTimeouts = await resolveGlobalModelTimeouts(ctx)
      const { provider, model, apiKey } = activeModel
      const baseUrl = activeModel.baseUrl
      const maxTokens = activeModel.maxTokens
      const modelTimeoutMs = modelTimeouts.document

      const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
      const existingBrief =
        typeof input.existingBrief === 'string' ? input.existingBrief.trim() : ''
      const fallbackPlan = {
        topic: topic || path.basename(sourceFile.name, path.extname(sourceFile.name)),
        pageCount: null,
        briefText: existingBrief
      }
      const MAX_ATTEMPTS = 2
      let plan: Pick<ParsedDocumentPlanResult, 'topic' | 'pageCount' | 'briefText'> | null = null
      let lastError: unknown = null
      const useLightweightSourcePlan =
        sourceFile.type !== 'image' && hasOutlinePageCandidateSkeleton(pageCandidates)

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const retryHint = attempt > 1 && lastError instanceof Error ? lastError.message : undefined
        const responseText = (
          sourceFile.type === 'image'
            ? await runImageDocumentPlanModel({
                provider,
                apiKey,
                model,
                baseUrl,
                maxTokens,
                modelRuntime: ctx.modelRuntime,
                modelTimeoutMs,
                file: sourceFile,
                topic,
                existingBrief,
                retryHint
              })
            : await runSingleShotDocumentPlanModel({
                provider,
                apiKey,
                model,
                baseUrl,
                maxTokens,
                modelRuntime: ctx.modelRuntime,
                modelTimeoutMs,
                file: sourceFile,
                outlineScan,
                pageCandidates,
                topic,
                existingBrief,
                retryHint
              })
        ).trim()
        if (!responseText) {
          lastError = new Error('文档解析完成，但模型未返回可用内容')
          log.warn('[documents:parsePlan] empty response', { attempt })
          continue
        }
        log.info('[documents:parsePlan] agent response received', {
          attempt,
          responseLength: responseText.length,
          sourceVirtualPath: sourceFile.virtualPath
        })
        try {
          const candidatePlan = useLightweightSourcePlan
            ? normalizeLightweightGeneratedPlan(responseText, {
                topic: fallbackPlan.topic,
                pageCount: pageCandidates.length
              })
            : normalizeDocumentPlan(responseText, fallbackPlan)
          log.info('[documents:parsePlan] normalized candidate plan', {
            attempt,
            pageCount: candidatePlan.pageCount,
            briefLength: candidatePlan.briefText.length,
            lightweightSourcePlan: useLightweightSourcePlan,
            outlineScanHeadingCount: outlineScan?.headingCount ?? 0,
            scanHasMultipleSlideCandidates: scanHasMultipleSlideCandidates(outlineScan)
          })
          if (sourceFile.type === 'image') {
            assertImageWasRead(`${candidatePlan.topic}\n${candidatePlan.briefText}`)
          }
          await assertPlanLanguageMatchesSource({
            file: sourceFile,
            plan: candidatePlan,
            userText: `${topic}\n${existingBrief}`
          })
          assertPlanMatchesDocumentOutline({
            scan: outlineScan,
            pageCandidates,
            plan: candidatePlan
          })
          plan = candidatePlan
          break
        } catch (error) {
          lastError = error
          if (
            error instanceof RetryableDocumentPlanQualityError &&
            attempt >= MAX_ATTEMPTS &&
            !isDocumentOutlineQualityError(error)
          ) {
            plan = useLightweightSourcePlan
              ? normalizeLightweightGeneratedPlan(responseText, {
                  topic: fallbackPlan.topic,
                  pageCount: pageCandidates.length
                })
              : normalizeDocumentPlan(responseText, fallbackPlan)
            log.warn(
              '[documents:parsePlan] quality check failed after retry, returning editable plan',
              {
                attempt,
                message: error.message,
                responsePreview: responseText.slice(0, 400)
              }
            )
            break
          }
          if (isDocumentOutlineQualityError(error) && attempt >= MAX_ATTEMPTS) {
            log.warn(
              '[documents:parsePlan] outline quality check failed after retry, rejecting plan',
              {
                attempt,
                message: error instanceof Error ? error.message : String(error),
                responsePreview: responseText.slice(0, 400)
              }
            )
          }
          log.warn(
            attempt < MAX_ATTEMPTS
              ? '[documents:parsePlan] normalize failed, will retry'
              : '[documents:parsePlan] normalize failed, no attempts left',
            {
              attempt,
              message: error instanceof Error ? error.message : String(error),
              responsePreview: responseText.slice(0, 400)
            }
          )
        }
      }
      if (!plan) throw lastError || new Error('文档解析完成，但模型未返回可用解析结果')
      const resultFiles =
        sourceFile.type === 'image'
          ? [await writeImagePlanReferenceFile({ file: sourceFile, plan })]
          : preparedFiles

      const pageSkeletonBase = sanitizeDocumentPlanPageSkeletonContent({
        pageSkeleton: buildDocumentPlanPageSkeleton({
          scan: outlineScan,
          pageCandidates,
          pageCount: plan.pageCount
        })
      })
      const pageSkeleton = await summarizePageSkeletonContentInBatches({
        provider,
        apiKey,
        model,
        baseUrl,
        maxTokens,
        modelRuntime: ctx.modelRuntime,
        modelTimeoutMs,
        file: sourceFile,
        topic: plan.topic,
        pageSkeleton: pageSkeletonBase
      })
      const sourcePlan =
        pageSkeleton.length > 0
          ? {
              version: 1 as const,
              confidence: 'high' as const,
              sourceDocumentPath: resultFiles[0]?.virtualPath,
              sourceDocumentName: resultFiles[0]?.name,
              pageSkeleton
            }
          : undefined
      const resultPlan =
        useLightweightSourcePlan && pageSkeleton.length > 0
          ? {
              ...plan,
              briefText: formatPageSkeletonBriefText({
                topic: plan.topic,
                pageSkeleton
              })
            }
          : plan
      const result = {
        ...resultPlan,
        ...(pageSkeleton.length > 0 ? { pageSkeleton } : {}),
        ...(sourcePlan ? { sourcePlan } : {}),
        files: resultFiles.map(({ name, type, characterCount, workspacePath }) => ({
          name,
          type,
          characterCount,
          path: workspacePath
        }))
      } satisfies ParsedDocumentPlanResult
      parseEndStatus = 'success'
      parseEndPageCount = resultPlan.pageCount
      return result
    } catch (error) {
      parseEndError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      const parseEndedAt = Date.now()
      log.info('[documents:parsePlan] end', {
        status: parseEndStatus,
        startedAt: parseStartedAtIso,
        endedAt: new Date(parseEndedAt).toISOString(),
        durationMs: parseEndedAt - parseStartedAt,
        sourceVirtualPath: parseEndSourceVirtualPath,
        pageCount: parseEndPageCount,
        error: parseEndError
      })
    }
  })
}
