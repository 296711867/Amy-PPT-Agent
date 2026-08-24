/**
 * 媒体文件规范化：上传图片时自动降采样（长边 ≤ maxDim）、
 * 内容哈希去重（同一图片不重复存储）。
 * 参考 dashi 的 stage-media.mjs 思路，但集成到 Electron 主进程。
 */
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import log from 'electron-log/main.js'

const MAX_LONG_EDGE = 2048
const RASTER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export type StagedMedia = {
  relativePath: string
  absolutePath: string
  hash: string
  sizeBytes: number
  downscaled: boolean
}

const fileHash = (filePath: string): string => {
  const content = fs.readFileSync(filePath)
  return createHash('sha256').update(content).digest('hex').slice(0, 24)
}

/**
 * 规范化一张图片：如果超过 maxDim 长边则降采样；返回相对路径。
 * 纯 Node 实现（不依赖 sharp/canvas），只做复制 + 哈希；
 * 降采样由渲染进程的 canvas 在需要时执行（此函数只做去重和路径规范化）。
 */
export function stageMediaFile(args: {
  sourcePath: string
  targetDir: string
  maxDim?: number
}): StagedMedia {
  const maxDim = args.maxDim ?? MAX_LONG_EDGE
  const source = path.resolve(args.sourcePath)
  const ext = path.extname(source).toLowerCase()

  if (!fs.existsSync(source)) {
    throw new Error(`媒体文件不存在: ${source}`)
  }

  const hash = fileHash(source)
  const stat = fs.statSync(source)
  const isRaster = RASTER_EXTS.has(ext)

  // 哈希去重：同名哈希已存在则直接复用
  const targetDir = args.targetDir
  fs.mkdirSync(targetDir, { recursive: true })
  const hashBasedName = `${hash}${ext}`
  const hashBasedPath = path.join(targetDir, hashBasedName)

  if (fs.existsSync(hashBasedPath)) {
    return {
      relativePath: `./${path.relative(path.dirname(targetDir), hashBasedPath)}`.replace(/\\/g, '/'),
      absolutePath: hashBasedPath,
      hash,
      sizeBytes: stat.size,
      downscaled: false
    }
  }

  // 复制到目标目录（用哈希命名实现去重）
  fs.copyFileSync(source, hashBasedPath)

  log.info('[media-stage] staged', {
    source: path.basename(source),
    hash,
    sizeKB: Math.round(stat.size / 1024),
    isRaster,
    maxDim
  })

  return {
    relativePath: `./${path.relative(path.dirname(targetDir), hashBasedPath)}`.replace(/\\/g, '/'),
    absolutePath: hashBasedPath,
    hash,
    sizeBytes: stat.size,
    downscaled: false
  }
}

/**
 * 批量规范化：返回成功列表，跳过不支持的文件。
 */
export function stageMediaFiles(args: {
  sourcePaths: string[]
  targetDir: string
}): { staged: StagedMedia[]; skipped: Array<{ path: string; reason: string }> } {
  const staged: StagedMedia[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const sourcePath of args.sourcePaths) {
    try {
      staged.push(stageMediaFile({ sourcePath, targetDir: args.targetDir }))
    } catch (error) {
      skipped.push({
        path: sourcePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { staged, skipped }
}
