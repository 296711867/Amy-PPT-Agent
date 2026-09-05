import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { normalizeSession, normalizeMessage } from '../ipc/utils'
import { parseSessionMetadata } from '../generation/metadata-parser'
import type { SessionPageRecord } from '../db/database'
import { getStyleDetail, hasStyleSkill } from '../styles/catalog'
import type { IpcContext } from '../ipc/context'
import { resolveModelConfigForTask } from '../config/model-config-utils'
import { readAppLocale, uiText } from '../config/locale-utils'
import {
  normalizeDeckBackgroundPolicy,
  normalizeFontSelection,
  normalizeGenerationMode,
  normalizeImagePolicy,
  normalizeVisualElementPreferences
} from '@shared/generation'
import { requireSlideSizePreset } from '@shared/slide-size'
import { normalizeSourcePlan } from '../generation/source-plan'
import { ensureSessionRuntimeCompatible } from './runtime-assets'
import { GitHistoryService } from '../history/git-history-service'
import { allowLocalAssetRoot, revokeLocalAssetRootsUnder } from '../io/local-asset-roots'
import { resolveOutlinesForPages } from './page-outline-utils'
import {
  normalizeIndexTransitionConfig,
  parseIndexTransitionConfig,
  patchIndexTransitionConfig,
  validateIndexShellHtml
} from './index-transition'
import { warmSessionFirstPageThumbnails } from './session-thumbnail'
import { createSessionMasterIfMissing } from './master-service'
import { buildAiSessionStyleSnapshot, normalizeAiStyleSelection } from './ai-style'
import {
  hasCompleteSessionPageCoverage,
  recoverUsableSessionPages,
  shouldRecoverSessionPages
} from './page-status-recovery'
import { scopeModelRuntimeToSession } from '../agent-runtime/model'
import { isUntouchedTemplateSeed } from '../templates/template-seed-fingerprint'

const THINKING_ID_RE = /^[a-zA-Z0-9_-]{6,32}$/
const THINKING_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const THINKING_REFERENCE_SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.text', '.csv'])
const THINKING_REFERENCE_THINKING_MD_LINE_OFFSET = 6
const MAX_PAGE_COUNT = 500
const PENDING_DELETE_DIR_RE = /^\..+\.deleting-[0-9a-f-]{36}$/i
const DELETE_COMMITTED_MARKER = '.amy-ppt-delete-committed'
const DELETE_COMMITTED_MARKER_CONTENT = 'amy-ppt-session-delete-committed\n'

export interface SessionLifecycleDependencies {
  suspendSessionWork?: (sessionId: string) => Promise<() => void>
}

const normalizeRequestedPageCount = (value: unknown): number | undefined => {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return undefined
  }
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return undefined
  return Math.max(1, Math.min(MAX_PAGE_COUNT, Math.floor(numberValue)))
}

const isPathInside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

const resolveStorageRoot = async (storagePath: string): Promise<string> =>
  fs.promises.realpath(storagePath).catch(() => path.resolve(storagePath))

const assertDeletableSessionProjectDir = async (
  projectDir: string,
  storageRoot: string
): Promise<string | null> => {
  if (!fs.existsSync(projectDir)) return null
  const stat = await fs.promises.lstat(projectDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('会话项目目录不是受控目录，已停止删除以保护用户文件。')
  }
  const realProjectDir = await fs.promises.realpath(projectDir)
  if (!isPathInside(realProjectDir, storageRoot) || realProjectDir === storageRoot) {
    throw new Error('会话项目目录不在配置存储目录内，已停止删除以保护用户文件。')
  }
  return realProjectDir
}

const removeCreatedSessionProjectDir = async (
  projectDir: string,
  storageRoot: string
): Promise<void> => {
  const realProjectDir = await assertDeletableSessionProjectDir(projectDir, storageRoot)
  if (!realProjectDir) return
  await fs.promises.rm(realProjectDir, { recursive: true, force: true })
}

export const cleanupPendingSessionDeletionDirs = async (storagePath: string): Promise<number> => {
  const storageRoot = await resolveStorageRoot(storagePath)
  const entries = await fs.promises.readdir(storageRoot, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !PENDING_DELETE_DIR_RE.test(entry.name)) {
      continue
    }
    const candidate = path.join(storageRoot, entry.name)
    const realCandidate = await fs.promises.realpath(candidate).catch(() => '')
    if (
      !realCandidate ||
      !isPathInside(realCandidate, storageRoot) ||
      realCandidate === storageRoot
    ) {
      continue
    }
    const markerPath = path.join(realCandidate, DELETE_COMMITTED_MARKER)
    const markerContent = await fs.promises.readFile(markerPath, 'utf-8').catch(() => '')
    if (markerContent !== DELETE_COMMITTED_MARKER_CONTENT) continue
    await fs.promises.rm(realCandidate, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

const toSafeAssetName = (value: string): string =>
  value
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image'

const detectThinkingWorkspaceDir = (storageRoot: string, referencePath: string): string | null => {
  if (path.basename(referencePath) !== 'thinking.md') return null
  const thinkingRoot = path.join(storageRoot, 'thinking')
  const dir = path.dirname(referencePath)
  if (!isPathInside(dir, thinkingRoot)) return null
  const thinkingId = path.basename(dir)
  return THINKING_ID_RE.test(thinkingId) ? dir : null
}

const copyThinkingAssetsToSession = async (
  thinkingDir: string,
  projectDir: string
): Promise<
  Array<{ fileName: string; sourcePath: string; targetPath: string; publicPath: string }>
> => {
  const assetsDir = path.join(thinkingDir, 'assets')
  if (!fs.existsSync(assetsDir)) return []
  const imagesDir = path.join(projectDir, 'images')
  await fs.promises.mkdir(imagesDir, { recursive: true })
  allowLocalAssetRoot(imagesDir)

  const entries = await fs.promises.readdir(assetsDir, { withFileTypes: true })
  const copied: Array<{
    fileName: string
    sourcePath: string
    targetPath: string
    publicPath: string
  }> = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!THINKING_IMAGE_EXTENSIONS.has(ext)) continue
    const sourcePath = path.join(assetsDir, entry.name)
    const fileName = toSafeAssetName(entry.name)
    const targetPath = path.join(imagesDir, fileName)
    await fs.promises.copyFile(sourcePath, targetPath)
    copied.push({
      fileName,
      sourcePath,
      targetPath,
      publicPath: `./images/${fileName}`
    })
  }
  return copied
}

const rewriteThinkingSourceForSession = (
  content: string,
  copiedAssets: Array<{
    fileName: string
    sourcePath: string
    targetPath: string
    publicPath: string
  }>
): string => {
  let rewritten = content
  for (const asset of copiedAssets) {
    rewritten = rewritten
      .split(asset.sourcePath)
      .join(asset.targetPath)
      .split(`thinkingPublicPath: assets/${asset.fileName}`)
      .join(`publicPath: ${asset.publicPath}`)
      .split('- sessionAssetPath: (set during generation copy)')
      .join(`- sessionAssetPath: ${asset.targetPath}`)
      .split('- publicPath: (set during generation copy)')
      .join(`- publicPath: ${asset.publicPath}`)
  }
  return rewritten
}

const rewriteThinkingWorkspaceArchiveContent = (
  content: string,
  thinkingDir: string,
  archivedThinkingDir: string
): string =>
  content
    .split(path.resolve(thinkingDir))
    .join(path.resolve(archivedThinkingDir))
    .split(path.join(thinkingDir, 'assets'))
    .join(path.join(archivedThinkingDir, 'assets'))
    .split(path.join(thinkingDir, 'sources'))
    .join(path.join(archivedThinkingDir, 'sources'))

const copyDirectoryIfExists = async (sourceDir: string, targetDir: string): Promise<void> => {
  if (!fs.existsSync(sourceDir)) return
  await fs.promises.mkdir(targetDir, { recursive: true })
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryIfExists(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await fs.promises.copyFile(sourcePath, targetPath)
    }
  }
}

const isRewriteableThinkingArchiveFile = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase()
  return new Set(['.md', '.txt', '.text', '.csv', '.json']).has(ext)
}

const rewriteThinkingWorkspaceArchivePaths = async (
  archiveDir: string,
  thinkingDir: string,
  archivedThinkingDir: string
): Promise<void> => {
  if (!fs.existsSync(archiveDir)) return
  const entries = await fs.promises.readdir(archiveDir, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(archiveDir, entry.name)
      if (entry.isDirectory()) {
        await rewriteThinkingWorkspaceArchivePaths(filePath, thinkingDir, archivedThinkingDir)
        return
      }
      if (!entry.isFile() || !isRewriteableThinkingArchiveFile(filePath)) return
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const rewritten = rewriteThinkingWorkspaceArchiveContent(
        content,
        thinkingDir,
        archivedThinkingDir
      )
      if (rewritten !== content) {
        await fs.promises.writeFile(filePath, rewritten, 'utf-8')
      }
    })
  )
}

const copyThinkingWorkspaceToSession = async (
  thinkingDir: string,
  projectDir: string
): Promise<void> => {
  const targetDir = path.join(projectDir, 'thinking')
  if (fs.existsSync(targetDir)) {
    await fs.promises.rm(targetDir, { recursive: true, force: true })
  }
  await fs.promises.mkdir(targetDir, { recursive: true })
  await copyDirectoryIfExists(thinkingDir, targetDir)
  await rewriteThinkingWorkspaceArchivePaths(targetDir, thinkingDir, targetDir)
}

const offsetSourcePlanLineRanges = (
  items: Array<{
    pageNumber: number
    title: string
    role: 'chapter-divider' | 'content'
    sourceHeading: string
    headingLevel: number
    lineStart: number
    lineEnd: number
    reason?: string | null
  }>,
  offset: number
): typeof items =>
  items.map((item) => ({
    ...item,
    lineStart: item.lineStart + offset,
    lineEnd: item.lineEnd + offset
  }))

const createThinkingReferenceDocument = async (args: {
  thinkingDir: string
  projectDir: string
  docsDir: string
  thinkingMdPath: string
}): Promise<string> => {
  const thinkingMd = await fs.promises.readFile(args.thinkingMdPath, 'utf-8')
  await copyThinkingWorkspaceToSession(args.thinkingDir, args.projectDir)
  const copiedAssets = await copyThinkingAssetsToSession(args.thinkingDir, args.projectDir)

  // Inline all source content so the generation agent gets everything in one read
  const sourceSections: string[] = []
  const sourcesDir = path.join(args.thinkingDir, 'sources')
  if (fs.existsSync(sourcesDir)) {
    const entries = await fs.promises.readdir(sourcesDir, { withFileTypes: true })
    for (const entry of entries) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!entry.isFile() || !THINKING_REFERENCE_SOURCE_EXTENSIONS.has(ext)) continue
      const sourcePath = path.join(sourcesDir, entry.name)
      const content = await fs.promises.readFile(sourcePath, 'utf-8')
      sourceSections.push(
        [
          `## Source: ${entry.name}`,
          '',
          rewriteThinkingSourceForSession(content, copiedAssets)
        ].join('\n')
      )
    }
  }

  const assetSection =
    copiedAssets.length > 0
      ? [
          '## Available Image Assets',
          '',
          'These images are available as an asset library. Use them only when the page brief needs an uploaded image. Do not infer style, palette, layout, or visual direction from these assets; the deck style must follow the selected system style preset.',
          '',
          ...copiedAssets.map(
            (asset, index) =>
              `${index + 1}. ${asset.publicPath}\n   - sessionAssetPath: ${asset.targetPath}`
          )
        ].join('\n')
      : ''

  const referenceContent = [
    '# Thinking Reference',
    '',
    'This file was prepared from the exploration workspace. Use the page text as the generation brief. Use available image assets as a library when relevant, but keep visual style governed by the selected system style preset.',
    '',
    '## Final Thinking Document',
    '',
    thinkingMd,
    '',
    assetSection,
    '',
    sourceSections.length > 0 ? '# Source Notes' : '',
    '',
    ...sourceSections
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')

  const targetPath = path.join(args.docsDir, 'thinking-reference.md')
  await fs.promises.writeFile(targetPath, referenceContent, 'utf-8')
  return '/docs/thinking-reference.md'
}

export function registerSessionHandlers(
  ctx: IpcContext,
  lifecycle: SessionLifecycleDependencies = {}
): void {
  const {
    db,
    agentManager,
    resolveStoragePath,
    ensureSessionAssets,
    buildSessionGenerationSnapshot,
    getPageSourceUrl,
    resolveSessionProjectDir
  } = ctx

  void resolveStoragePath()
    .then((storagePath) => cleanupPendingSessionDeletionDirs(storagePath))
    .then((removed) => {
      if (removed > 0) log.info('[session:delete] cleaned pending project directories', { removed })
    })
    .catch((error) => {
      log.warn('[session:delete] pending project cleanup failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    })

  const resolvePageHtmlPath = (
    projectDir: string,
    fileSlug: string,
    candidatePath?: string | null
  ): string => {
    const projectRoot = path.resolve(projectDir)
    const fallbackPath = path.resolve(projectRoot, `${fileSlug}.html`)
    const rawCandidate = typeof candidatePath === 'string' ? candidatePath.trim() : ''
    if (!rawCandidate) return fallbackPath
    const resolvedCandidate = path.isAbsolute(rawCandidate)
      ? path.resolve(rawCandidate)
      : path.resolve(projectRoot, rawCandidate)
    const relative = path.relative(projectRoot, resolvedCandidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return fallbackPath
    return fs.existsSync(resolvedCandidate) ? resolvedCandidate : fallbackPath
  }

  ipcMain.handle('session:getIndexTransition', async (_event, payload: unknown) => {
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const sessionId =
      typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
        ? record.sessionId.trim()
        : ''
    if (!sessionId) throw new Error('缺少 sessionId')
    const projectDir = await resolveSessionProjectDir(sessionId)
    const indexPath = path.join(projectDir, 'index.html')
    if (!fs.existsSync(indexPath)) return parseIndexTransitionConfig('')
    const html = await fs.promises.readFile(indexPath, 'utf-8')
    return parseIndexTransitionConfig(html)
  })

  ipcMain.handle('session:setIndexTransition', async (_event, payload: unknown) => {
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const sessionId =
      typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
        ? record.sessionId.trim()
        : ''
    if (!sessionId) throw new Error('缺少 sessionId')
    const session = await db.getSession(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    const projectDir = await resolveSessionProjectDir(sessionId)
    const indexPath = path.join(projectDir, 'index.html')
    if (!fs.existsSync(indexPath)) throw new Error(`index.html 缺失：${indexPath}`)

    await new GitHistoryService(db).ensureBaseline(sessionId, projectDir).catch((error) => {
      log.warn('[session:setIndexTransition] ensure history baseline failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      })
    })
    await ensureSessionRuntimeCompatible(ctx, projectDir)
    const config = normalizeIndexTransitionConfig({
      type: record.type,
      durationMs: record.durationMs
    })
    const current = await fs.promises.readFile(indexPath, 'utf-8')
    const next = patchIndexTransitionConfig(current, config)
    const indexErrors = validateIndexShellHtml(next)
    if (indexErrors.length > 0) {
      throw new Error(`index.html 验证失败: ${indexErrors.join('; ')}`)
    }
    if (next !== current) {
      await fs.promises.writeFile(indexPath, next, 'utf-8')
      await new GitHistoryService(db).recordOperation({
        sessionId,
        projectDir,
        type: 'edit',
        scope: 'shell',
        prompt:
          config.type === 'none'
            ? '关闭切页动画'
            : `配置切页动画：${config.type} ${config.durationMs}ms`,
        metadata: {
          transition: config,
          action: 'setIndexTransition'
        }
      })
    }
    return { ok: true, transition: config }
  })

  ipcMain.handle('session:create', async (_event, payload) => {
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const selectionRecord =
      record.styleSelection &&
      typeof record.styleSelection === 'object' &&
      !Array.isArray(record.styleSelection)
        ? (record.styleSelection as Record<string, unknown>)
        : null
    const aiStyleSelection = normalizeAiStyleSelection(
      selectionRecord?.mode === 'ai'
        ? selectionRecord
        : record.styleMode === 'ai'
          ? {
              mode: 'ai',
              description: record.styleDescription,
              themeColors: record.themeColors
            }
          : null
    )
    const requestedAiMode = selectionRecord?.mode === 'ai' || record.styleMode === 'ai'
    const { topic } = record
    const requestedStyleId =
      (typeof record.styleId === 'string' ? record.styleId : undefined) ||
      (typeof selectionRecord?.styleId === 'string' ? selectionRecord.styleId : undefined)
    const pageCount = normalizeRequestedPageCount(record.pageCount)
    const slideSize = requireSlideSizePreset(record.slideSizeId)
    const fontSelection = normalizeFontSelection(record.fontSelection)
    const imagePolicy = normalizeImagePolicy(record.imagePolicy)
    const generationMode = normalizeGenerationMode(record.generationMode)
    const visualElementPreferences = normalizeVisualElementPreferences(
      record.visualElementPreferences
    )
    const deckBackgroundPolicy = normalizeDeckBackgroundPolicy(record.deckBackgroundPolicy)
    const sourcePlan = normalizeSourcePlan(record.sourcePlan)
    const referenceDocumentPath =
      typeof record.referenceDocumentPath === 'string' ? record.referenceDocumentPath.trim() : ''
    const locale = await readAppLocale(ctx)
    const storagePath = await resolveStoragePath()
    const modelConfigId =
      typeof record.modelConfigId === 'string' ? record.modelConfigId.trim() : undefined
    const activeModel = await resolveModelConfigForTask(ctx, {
      modelConfigId,
      purpose: 'session:create'
    })
    const { provider, model } = activeModel
    const baseUrl = activeModel.baseUrl
    const normalizedTopic = typeof topic === 'string' && topic.trim() ? topic.trim() : 'Untitled'
    const normalizedStyleId = typeof requestedStyleId === 'string' ? requestedStyleId.trim() : ''
    if (requestedAiMode && !aiStyleSelection) {
      throw new Error(
        uiText(
          locale,
          '创建会话失败：AI 自定义风格描述不能为空。',
          'Failed to create session: an AI style description is required.'
        )
      )
    }
    if (!aiStyleSelection && !normalizedStyleId) {
      throw new Error(
        uiText(
          locale,
          '创建会话失败：styleId 不能为空。',
          'Failed to create session: styleId is required.'
        )
      )
    }
    if (!aiStyleSelection && !hasStyleSkill(normalizedStyleId)) {
      throw new Error(
        uiText(
          locale,
          `创建会话失败：styleId 不存在 ${normalizedStyleId}`,
          `Failed to create session: styleId does not exist: ${normalizedStyleId}`
        )
      )
    }
    let validatedReferenceSourcePath: string | null = null
    const storageRoot = await resolveStorageRoot(storagePath)
    if (referenceDocumentPath) {
      const sourcePath = path.resolve(referenceDocumentPath)
      if (!fs.existsSync(sourcePath)) {
        throw new Error(
          uiText(
            locale,
            '解析后的文档不存在，请重新解析文档',
            'The parsed document no longer exists. Parse the document again.'
          )
        )
      }
      const sourceRealPath = await fs.promises.realpath(sourcePath)
      const relativeToStorage = path.relative(storageRoot, sourceRealPath)
      if (relativeToStorage.startsWith('..') || path.isAbsolute(relativeToStorage)) {
        throw new Error(
          uiText(
            locale,
            '文档路径不在用户配置目录内，请重新解析文档',
            'The document path is outside the configured storage folder. Parse the document again.'
          )
        )
      }
      validatedReferenceSourcePath = sourceRealPath
    }
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(storageRoot, sessionId)
    if (!isPathInside(projectDir, storageRoot) || projectDir === storageRoot) {
      throw new Error('会话项目目录路径不合法')
    }
    if (fs.existsSync(projectDir)) {
      throw new Error('会话项目目录已存在，已停止创建以保护已有数据。')
    }

    await fs.promises.mkdir(projectDir, { recursive: true })
    let sessionRecordCreated = false
    let databaseStateUncertain = false
    try {
      await ensureSessionAssets(projectDir)
      await createSessionMasterIfMissing(projectDir)
      let isThinkingSource = false
      const copyReferenceDocumentToSession = async (): Promise<string | null> => {
        if (!validatedReferenceSourcePath) return null
        const docsDir = path.join(projectDir, 'docs')
        await fs.promises.mkdir(docsDir, { recursive: true })
        const thinkingDir = detectThinkingWorkspaceDir(storageRoot, validatedReferenceSourcePath)
        if (thinkingDir) {
          isThinkingSource = true
          return createThinkingReferenceDocument({
            thinkingDir,
            projectDir,
            docsDir,
            thinkingMdPath: validatedReferenceSourcePath
          })
        }
        const ext = path.extname(validatedReferenceSourcePath).toLowerCase() || '.md'
        const fileName = `${Date.now()}${ext}`
        const targetPath = path.join(docsDir, fileName)
        await fs.promises.copyFile(validatedReferenceSourcePath, targetPath)
        return `/docs/${fileName}`
      }
      const sessionReferenceDocumentPath = await copyReferenceDocumentToSession()

      const customStyleSnapshot = aiStyleSelection
        ? buildAiSessionStyleSnapshot({
            sessionId,
            selection: aiStyleSelection,
            topic: normalizedTopic,
            sourcePlan,
            referenceDocumentPath: sessionReferenceDocumentPath
          })
        : undefined
      const effectiveStyleId = customStyleSnapshot?.styleId || normalizedStyleId
      const styleDetail = customStyleSnapshot
        ? {
            styleKey: customStyleSnapshot.styleKey,
            label: customStyleSnapshot.styleNameZh || customStyleSnapshot.styleName
          }
        : getStyleDetail(normalizedStyleId)
      log.info('[session:create] style selected', {
        sessionId,
        styleId: effectiveStyleId,
        styleKey: styleDetail.styleKey,
        styleLabel: styleDetail.label,
        mode: customStyleSnapshot ? 'ai' : 'preset'
      })

      try {
        await db.createSession({
          id: sessionId,
          title: `PPT: ${normalizedTopic}`,
          topic: normalizedTopic,
          styleId: effectiveStyleId,
          styleSnapshot: customStyleSnapshot,
          pageCount,
          slideSizeId: slideSize.id,
          slideWidth: slideSize.width,
          slideHeight: slideSize.height,
          referenceDocumentPath: sessionReferenceDocumentPath,
          provider,
          model: model.trim()
        })
        sessionRecordCreated = true
      } catch (error) {
        try {
          const partiallyCreated = await db.getSession(sessionId)
          sessionRecordCreated = Boolean(partiallyCreated)
        } catch (lookupError) {
          databaseStateUncertain = true
          throw new AggregateError(
            [error, lookupError],
            `会话创建失败，且无法确认数据库状态；项目目录已保留以便恢复：${projectDir}`
          )
        }
        throw error
      }

      agentManager.ensureSession({
        sessionId,
        provider,
        model,
        baseUrl,
        projectDir,
        modelRuntime: scopeModelRuntimeToSession(ctx.modelRuntime, sessionId)
      })
      if (sourcePlan && sessionReferenceDocumentPath) {
        const sourcePlanItems = isThinkingSource
          ? offsetSourcePlanLineRanges(
              sourcePlan.pageSkeleton,
              THINKING_REFERENCE_THINKING_MD_LINE_OFFSET
            )
          : sourcePlan.pageSkeleton
        await db.replaceSourcePageSkeletons({
          sessionId,
          sourceDocumentPath: sessionReferenceDocumentPath,
          sourceDocumentName: isThinkingSource
            ? path.basename(sessionReferenceDocumentPath)
            : sourcePlan.sourceDocumentName || path.basename(sessionReferenceDocumentPath),
          confidence: sourcePlan.confidence,
          items: sourcePlanItems
        })
      }
      await db.updateSessionMetadata(sessionId, {
        ...(aiStyleSelection ? { styleSelection: aiStyleSelection } : {}),
        fontSelection,
        imagePolicy,
        generationMode,
        visualElementPreferences,
        deckBackgroundPolicy,
        ...(isThinkingSource ? { source: 'thinking' } : {})
      })

      await db.createProject({
        session_id: sessionId,
        title: normalizedTopic,
        output_path: projectDir,
        root_path: projectDir
      })

      return { sessionId }
    } catch (error) {
      agentManager.removeSession(sessionId)
      if (databaseStateUncertain) throw error
      if (sessionRecordCreated) {
        try {
          await db.deleteSession(sessionId)
        } catch (cleanupError) {
          log.error('[session:create] database cleanup failed', {
            sessionId,
            message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          })
          throw new AggregateError(
            [error, cleanupError],
            `会话创建失败，且数据库补偿失败；项目目录已保留以便恢复：${projectDir}`
          )
        }
      }
      revokeLocalAssetRootsUnder(projectDir)
      try {
        await removeCreatedSessionProjectDir(projectDir, storageRoot)
      } catch (cleanupError) {
        log.error('[session:create] project cleanup failed', {
          sessionId,
          projectDir,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        })
        throw new AggregateError(
          [error, cleanupError],
          `会话创建失败，且项目目录补偿失败：${projectDir}`
        )
      }
      throw error
    }
  })

  ipcMain.handle('session:list', async () => {
    const sessions = await db.listSessions()
    const snapshots = await Promise.all(
      sessions.map(async (session) => ({
        session,
        snapshot: await buildSessionGenerationSnapshot(
          session as unknown as Record<string, unknown>,
          {
            includeHtml: false
          }
        )
      }))
    )
    const thumbnailMap = await warmSessionFirstPageThumbnails(
      snapshots.map(({ session, snapshot }) => ({
        sessionId: session.id,
        pageId: snapshot.pages[0]?.pageId,
        sourcePath: snapshot.pages[0]?.htmlPath,
        width: session.slideWidth,
        height: session.slideHeight
      }))
    )
    const enrichedSessions = await Promise.all(
      snapshots.map(async ({ session, snapshot }) => {
        const enriched = snapshot.session || (session as unknown as Record<string, unknown>)
        enriched.thumbnailPath = thumbnailMap.get(session.id) ?? null
        const run = await db.getLatestGenerationRun(session.id)
        if (run && run.updated_at > run.created_at) {
          enriched.generation_duration_sec = run.updated_at - run.created_at
        }
        return enriched
      })
    )
    return enrichedSessions.map((session) =>
      normalizeSession(session as unknown as Record<string, unknown>)
    )
  })

  ipcMain.handle('session:updateTitle', async (_event, payload: unknown) => {
    const locale = await readAppLocale(ctx)
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (!sessionId) throw new Error(uiText(locale, '会话 ID 不能为空', 'Session ID is required.'))
    if (!title) throw new Error(uiText(locale, '会话名称不能为空', 'Session title is required.'))
    if (title.length > 120) {
      throw new Error(
        uiText(locale, '会话名称不能超过 120 个字符', 'Session title cannot exceed 120 characters.')
      )
    }
    const existingSession = await db.getSession(sessionId)
    if (!existingSession) {
      throw new Error(
        uiText(locale, '会话不存在或已被删除', 'The session does not exist or has been deleted.')
      )
    }
    await db.updateSessionTitle(sessionId, title)
    return { ok: true }
  })

  ipcMain.handle('session:get', async (_event, sessionId) => {
    const session = await db.getSession(sessionId)
    if (!session) {
      return {
        session: normalizeSession(undefined),
        messages: [],
        generatedPages: []
      }
    }
    const messages = await db.getSessionMessages(sessionId, { chatScope: 'main' })
    const generatedPages: Array<{
      id: string
      pageNumber: number
      title: string
      contentOutline?: string | null
      html: string
      htmlPath?: string
      pageId?: string
      sourceUrl?: string
      status?: string
      error?: string | null
    }> = []
    let sessionPages = await db.listSessionPages(sessionId)
    if (sessionPages.length === 0) {
      return {
        session: normalizeSession({
          ...(session as unknown as Record<string, unknown>),
          page_count: 0,
          generated_count: 0,
          failed_count: 0
        }),
        messages: messages.map((message) =>
          normalizeMessage(message as unknown as Record<string, unknown>)
        ),
        generatedPages: []
      }
    }
    const projectDir = await resolveSessionProjectDir(sessionId)
    allowLocalAssetRoot(projectDir)
    await ensureSessionRuntimeCompatible(ctx, projectDir)
    const [latestRun, latestJob] = await Promise.all([
      db.getLatestGenerationRun(sessionId),
      db.getLatestSessionJob(sessionId)
    ])
    const inMemoryRun = ctx.sessionRunStates.get(sessionId)
    const hasActiveRun =
      inMemoryRun?.status === 'queued' ||
      inMemoryRun?.status === 'running' ||
      latestJob?.status === 'pending' ||
      latestJob?.status === 'active'
    // 模板会话的种子页指纹：HTML 与创建时一致的页面从未被生成改写，不能恢复。
    const sessionMetaRecord = parseSessionMetadata(String(session.metadata ?? ''))
    const seedFingerprints =
      sessionMetaRecord.source === 'template' &&
      sessionMetaRecord.templateSeedFingerprints &&
      typeof sessionMetaRecord.templateSeedFingerprints === 'object'
        ? (sessionMetaRecord.templateSeedFingerprints as Record<string, string>)
        : null
    const isUntouchedSeedPage = seedFingerprints
      ? (page: SessionPageRecord, html: string): boolean => {
          const fingerprint = seedFingerprints[page.file_slug]
          if (!fingerprint) return false
          return isUntouchedTemplateSeed(html, fingerprint)
        }
      : undefined
    const recovered = shouldRecoverSessionPages({
      hasActiveRun,
      hasGenerationHistory: Boolean(latestRun || latestJob)
    })
      ? await recoverUsableSessionPages({
          db,
          sessionId,
          pages: sessionPages,
          resolveHtmlPath: (page) =>
            resolvePageHtmlPath(projectDir, page.file_slug, page.html_path),
          isUntouchedSeed: isUntouchedSeedPage
        })
      : { pages: sessionPages, recoveredPageIds: [] }
    sessionPages = recovered.pages
    const expectedPageCount = Math.max(
      Number(session.page_count) || 0,
      Number(latestRun?.total_pages) || 0
    )
    const recoveredAllPages = hasCompleteSessionPageCoverage(sessionPages, expectedPageCount)
    if (recovered.recoveredPageIds.length > 0) {
      log.info('[session:get] recovered usable interrupted pages', {
        sessionId,
        recoveredPageIds: recovered.recoveredPageIds,
        recoveredAllPages
      })
      if (recoveredAllPages) await db.updateSessionStatus(sessionId, 'completed')
    }
    const outlineBySessionPageId = await resolveOutlinesForPages(db, sessionId, sessionPages)
    if (!(await db.hasAnyOperationPageSnapshots(sessionId))) {
      await new GitHistoryService(db).ensureBaseline(sessionId, projectDir).catch((error) => {
        log.warn('[session:get] ensure history baseline failed', {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }
    for (const sp of sessionPages) {
      const htmlPath = resolvePageHtmlPath(projectDir, sp.file_slug, sp.html_path)
      let html = ''
      try {
        if (htmlPath && fs.existsSync(htmlPath)) {
          html = fs.readFileSync(htmlPath, 'utf-8')
        }
      } catch {
        html = ''
      }
      generatedPages.push({
        id: sp.id,
        pageNumber: sp.page_number,
        title: sp.title,
        contentOutline: outlineBySessionPageId.get(sp.id) || null,
        html,
        htmlPath,
        pageId: sp.file_slug,
        sourceUrl: getPageSourceUrl(htmlPath),
        status: sp.status,
        error: sp.error
      })
    }
    const completedCount = generatedPages.filter((page) => page.status === 'completed').length
    const failedCount = generatedPages.filter((page) => page.status === 'failed').length

    return {
      session: normalizeSession({
        ...(session as unknown as Record<string, unknown>),
        ...(recoveredAllPages ? { status: 'completed' } : {}),
        page_count: generatedPages.length,
        generated_count: completedCount,
        failed_count: failedCount
      }),
      messages: messages.map((message) =>
        normalizeMessage(message as unknown as Record<string, unknown>)
      ),
      generatedPages
    }
  })

  ipcMain.handle(
    'session:getMessages',
    async (_event, payload: { sessionId: string; chatType?: 'main' | 'page'; pageId?: string }) => {
      const chatType = payload?.chatType === 'page' ? 'page' : 'main'
      const pageId =
        chatType === 'page' &&
        typeof payload?.pageId === 'string' &&
        payload.pageId.trim().length > 0
          ? payload.pageId.trim()
          : undefined
      const messages = await db.getSessionMessages(payload.sessionId, {
        chatScope: chatType,
        pageId
      })
      return messages.map((message) =>
        normalizeMessage(message as unknown as Record<string, unknown>)
      )
    }
  )

  ipcMain.handle('session:delete', async (_event, sessionId) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) throw new Error('sessionId 不能为空')

    const existingSession = await db.getSession(normalizedSessionId)
    if (!existingSession) {
      return { success: true, alreadyDeleted: true }
    }

    const releaseSessionWork = lifecycle.suspendSessionWork
      ? await lifecycle.suspendSessionWork(normalizedSessionId)
      : () => undefined

    try {
      const project = await db.getProject(normalizedSessionId)
      let stagedProjectDir: string | null = null
      let originalProjectDir: string | null = null
      if (project?.root_path) {
        const storageRoot = await resolveStorageRoot(await resolveStoragePath())
        const projectDir = path.resolve(project.root_path)
        const realProjectDir = await assertDeletableSessionProjectDir(projectDir, storageRoot)
        if (realProjectDir) {
          originalProjectDir = realProjectDir
          stagedProjectDir = path.join(
            path.dirname(realProjectDir),
            `.${path.basename(realProjectDir)}.deleting-${crypto.randomUUID()}`
          )
          await fs.promises.rename(realProjectDir, stagedProjectDir)
        }
      }

      let dbCommitted = false
      try {
        await db.deleteSession(normalizedSessionId)
        dbCommitted = true
        agentManager.removeSession(normalizedSessionId)
        if (originalProjectDir) revokeLocalAssetRootsUnder(originalProjectDir)
        if (stagedProjectDir) {
          try {
            await fs.promises.writeFile(
              path.join(stagedProjectDir, DELETE_COMMITTED_MARKER),
              DELETE_COMMITTED_MARKER_CONTENT,
              'utf-8'
            )
            await fs.promises.rm(stagedProjectDir, { recursive: true, force: true })
          } catch (error) {
            log.warn('[session:delete] project cleanup pending after database commit', {
              sessionId: normalizedSessionId,
              stagedProjectDir,
              message: error instanceof Error ? error.message : String(error)
            })
            return { success: true, cleanupPending: true }
          }
        }
        return { success: true }
      } catch (error) {
        if (
          !dbCommitted &&
          stagedProjectDir &&
          originalProjectDir &&
          fs.existsSync(stagedProjectDir)
        ) {
          try {
            await fs.promises.rename(stagedProjectDir, originalProjectDir)
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `会话删除失败，且项目目录恢复失败：${stagedProjectDir}`
            )
          }
        }
        throw error
      }
    } finally {
      releaseSessionWork()
    }
  })
}
