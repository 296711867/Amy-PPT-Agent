/** 文档源文件准备：格式校验、docx/csv→markdown 转换、工作区落盘、大纲扫描。 */
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import { createRequire } from 'module'
import { nanoid } from 'nanoid'
import type { ParsedDocumentPlanResult } from '@shared/generation'
import { convertCsvTextToMarkdown } from './document-csv-to-markdown'
import {
  scanDocumentOutline,
  deriveOutlinePageCandidates,
  scanHeadingTitles,
  type DocumentOutlinePageCandidate,
  type DocumentOutlineScan
} from './document-outline-scan'

export type PreparedSourceFile = ParsedDocumentPlanResult['files'][number] & {
  originalPath: string
  workspacePath: string
  virtualPath: string
}
export const MAX_DOCUMENT_FILES = 1
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.text', '.csv', '.docx'])
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}
const NULL_CHAR_PATTERN = new RegExp(String.fromCharCode(0), 'g')
const require = createRequire(import.meta.url)
const mammoth = require('mammoth') as typeof import('mammoth')
const TurndownService = require('turndown') as new (options?: Record<string, unknown>) => {
  use: (plugin: unknown) => void
  turndown: (html: string) => string
}
const { gfm } = require('@joplin/turndown-plugin-gfm') as { gfm: unknown }

export const stripControlChars = (value: string): string =>
  value.replace(NULL_CHAR_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

export const compactText = (value: string): string =>
  stripControlChars(value)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const stripInlineImagesFromHtml = (html: string): string =>
  html.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = tag.match(/\balt=(["'])(.*?)\1/i)?.[2]?.trim()
    return alt ? `<p>[图片：${alt}]</p>` : ''
  })

const stripMarkdownDataImages = (markdown: string): string =>
  markdown.replace(/!\[[^\]]*]\(data:[^)]+\)/gi, '').replace(/!\[[^\]]*]\(\s*\)/g, '')

const convertDocxToMarkdown = async (filePath: string): Promise<string> => {
  const result = await mammoth.convertToHtml({ path: filePath })
  if (result.messages.length > 0) {
    log.info('[documents:parsePlan] mammoth warnings', {
      filePath,
      messages: result.messages.map((message) => message.message)
    })
  }
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced'
  })
  turndown.use(gfm)
  return compactText(
    stripMarkdownDataImages(turndown.turndown(stripInlineImagesFromHtml(result.value)))
  )
}

const toSafeFileName = (value: string): string =>
  value
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'source'

export const prepareSourceFile = async (
  file: { path?: unknown; name?: unknown },
  workspaceDir: string
): Promise<PreparedSourceFile> => {
  const rawPath = typeof file.path === 'string' ? file.path.trim() : ''
  if (!rawPath) throw new Error('无法读取文档路径')
  const filePath = path.resolve(rawPath)
  const stat = await fs.promises.stat(filePath)
  if (!stat.isFile()) throw new Error(`文档不是文件: ${filePath}`)
  if (stat.size > MAX_DOCUMENT_SIZE) throw new Error('单个文档不能超过 10MB')

  const ext = path.extname(filePath).toLowerCase()
  const isImage = SUPPORTED_IMAGE_EXTENSIONS.has(ext)
  if (!SUPPORTED_EXTENSIONS.has(ext) && !isImage) {
    throw new Error('暂只支持 md、txt、csv、docx 文档，以及 png、jpg、jpeg、webp 图片')
  }
  log.info('[documents:parsePlan] read source file', {
    fileName: path.basename(filePath),
    extension: ext,
    size: stat.size
  })

  const name =
    typeof file.name === 'string' && file.name.trim().length > 0
      ? file.name.trim()
      : path.basename(filePath)
  let type: PreparedSourceFile['type'] = isImage
    ? 'image'
    : ext === '.docx'
      ? 'docx'
      : ext === '.md'
        ? 'markdown'
        : ext === '.csv'
          ? 'csv'
          : 'text'

  const safeBaseName = toSafeFileName(path.basename(name, ext))
  const stamp = Date.now()
  const uniqueId = nanoid(8)
  const workspaceName =
    ext === '.docx' || ext === '.csv'
      ? `${stamp}-${uniqueId}-${safeBaseName || 'source'}.md`
      : `${stamp}-${uniqueId}-${safeBaseName}${ext}`
  const workspacePath = path.join(workspaceDir, workspaceName)
  let characterCount = stat.size

  if (isImage) {
    if (path.resolve(filePath) !== path.resolve(workspacePath)) {
      await fs.promises.copyFile(filePath, workspacePath)
    }
    log.info('[documents:parsePlan] image source prepared for vision', {
      originalName: name,
      workspaceName,
      size: stat.size
    })
  } else if (ext === '.docx') {
    const markdown = await convertDocxToMarkdown(filePath)
    if (!markdown) throw new Error(`${name} 未解析出可用文本`)
    await fs.promises.writeFile(
      workspacePath,
      [
        `# ${path.basename(name, ext)}`,
        '',
        '> Converted from Word .docx for agent reading. Inline images were omitted; image alt text may be preserved when available.',
        '',
        markdown
      ].join('\n'),
      'utf-8'
    )
    characterCount = markdown.length
    log.info('[documents:parsePlan] docx converted for reading', {
      originalName: name,
      workspaceName,
      characterCount
    })
  } else if (ext === '.csv') {
    const csvText = await fs.promises.readFile(filePath, 'utf-8')
    const markdown = convertCsvTextToMarkdown(csvText, {
      title: path.basename(name, ext)
    })
    if (!markdown) throw new Error(`${name} 未解析出可用文本`)
    await fs.promises.writeFile(workspacePath, markdown, 'utf-8')
    type = 'markdown'
    characterCount = markdown.length
    log.info('[documents:parsePlan] csv converted for reading', {
      originalName: name,
      workspaceName,
      characterCount
    })
  } else {
    if (path.resolve(filePath) !== path.resolve(workspacePath)) {
      await fs.promises.copyFile(filePath, workspacePath)
    }
    log.info('[documents:parsePlan] text source prepared for reading', {
      originalName: name,
      workspaceName,
      characterCount
    })
  }

  return {
    name,
    type,
    characterCount,
    path: workspacePath,
    originalPath: filePath,
    workspacePath,
    virtualPath: `/${workspaceName}`
  }
}

const resolveOutlineScanFormat = (file: PreparedSourceFile): DocumentOutlineScan['format'] => {
  if (file.type === 'csv') return 'csv'
  if (file.type === 'text') return 'text'
  return 'markdown'
}

export const scanPreparedSourceOutline = async (
  file: PreparedSourceFile
): Promise<{
  scan: DocumentOutlineScan
  pageCandidates: DocumentOutlinePageCandidate[]
} | null> => {
  if (file.type === 'image') {
    log.info('[documents:parsePlan] document outline scan skipped', {
      sourceVirtualPath: file.virtualPath,
      reason: 'image-source'
    })
    return null
  }
  const content = await fs.promises.readFile(file.workspacePath, 'utf-8').catch((error) => {
    log.warn('[documents:parsePlan] document outline scan read failed', {
      sourceVirtualPath: file.virtualPath,
      message: error instanceof Error ? error.message : String(error)
    })
    return ''
  })
  if (!content.trim()) {
    log.info('[documents:parsePlan] document outline scan skipped', {
      sourceVirtualPath: file.virtualPath,
      reason: 'empty-source'
    })
    return null
  }
  const scan = scanDocumentOutline(content, resolveOutlineScanFormat(file))
  const pageCandidates = deriveOutlinePageCandidates(scan)
  log.info('[documents:parsePlan] document outline scanned', {
    sourceVirtualPath: file.virtualPath,
    format: scan.format,
    headingCount: scan.headingCount,
    topLevelTitle: scan.topLevelTitle,
    pageCandidateCount: pageCandidates.length,
    splitHintCount: scan.recommendedSplitHints.length,
    headingPreview: scanHeadingTitles(scan).slice(0, 15),
    splitHintsPreview: scan.recommendedSplitHints.slice(0, 5)
  })
  return { scan, pageCandidates }
}
