/**
 * 版式库：用户级版式资产存储（userData/layout-library）。
 * 模板导入完成后自动把可参数化的页面收进库；结构指纹去重。
 */
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'
import { customAlphabet } from 'nanoid'
import {
  normalizeLayoutAsset,
  type LayoutAsset,
  type LayoutAssetManifest
} from '@shared/layout-asset'
import { allowLocalAssetRoot } from '../io/local-asset-roots'
import { buildLayoutAssetFromPageHtml } from './parametrize'
import { seedBuiltinLayoutAssets } from './builtin'

const layoutIdGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12)

const MANIFEST_FILE = 'manifest.json'
const SKELETON_DIR = 'skeletons'

export function resolveLayoutLibraryPath(): string {
  return path.join(app.getPath('userData'), is.dev ? 'layout-library-dev' : 'layout-library')
}

const manifestPath = (libraryRoot: string): string => path.join(libraryRoot, MANIFEST_FILE)

export async function ensureLayoutLibrary(libraryRoot = resolveLayoutLibraryPath()): Promise<void> {
  await fs.promises.mkdir(path.join(libraryRoot, SKELETON_DIR), { recursive: true })
  if (!fs.existsSync(manifestPath(libraryRoot))) {
    const empty: LayoutAssetManifest = { version: 1, assets: [] }
    await fs.promises.writeFile(
      manifestPath(libraryRoot),
      JSON.stringify(empty, null, 2),
      'utf-8'
    )
  }
  allowLocalAssetRoot(libraryRoot)
  // 播种/升级内置基础版式；任何失败都不阻塞读取（列表仍可用已有 manifest）
  try {
    const manifest = await readLayoutManifest(libraryRoot)
    const result = await seedBuiltinLayoutAssets({
      manifest,
      libraryRoot,
      skeletonDir: SKELETON_DIR
    })
    if (result.seeded > 0) await writeLayoutManifest(libraryRoot, manifest)
  } catch (error) {
    log.warn('[layout-assets] builtin seeding failed; library stays read-only', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function readLayoutManifest(
  libraryRoot = resolveLayoutLibraryPath()
): Promise<LayoutAssetManifest> {
  try {
    const raw = await fs.promises.readFile(manifestPath(libraryRoot), 'utf-8')
    const parsed = JSON.parse(raw) as { assets?: unknown; builtinSeededVersion?: unknown }
    const assets = (Array.isArray(parsed.assets) ? parsed.assets : [])
      .map(normalizeLayoutAsset)
      .filter((asset): asset is LayoutAsset => asset !== null)
    const builtinSeededVersion =
      typeof parsed.builtinSeededVersion === 'number' ? parsed.builtinSeededVersion : undefined
    return { version: 1, assets, ...(builtinSeededVersion !== undefined ? { builtinSeededVersion } : {}) }
  } catch {
    return { version: 1, assets: [] }
  }
}

async function writeLayoutManifest(
  libraryRoot: string,
  manifest: LayoutAssetManifest
): Promise<void> {
  // 注意：这里绝不能回调 ensureLayoutLibrary —— ensure 播种后会写 manifest，
  // 写 manifest 再 ensure 会形成无限递归（曾写满整个磁盘）。
  await fs.promises.writeFile(
    manifestPath(libraryRoot),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  )
}

export type LayoutImportSummary = {
  imported: number
  skipped: number
  duplicated: number
  reason?: string
}

/**
 * 把一个会话的可参数化页面收进版式库。
 * 只读取已有 HTML 文件，纯本地计算；结构指纹与库内重复的跳过。
 */
export async function importLayoutAssetsFromSession(args: {
  sessionId: string
  pages: Array<{ pageId: string; pageNumber: number; title: string; htmlPath: string }>
  projectDir: string
  roles?: (pageNumber: number, total: number) => string[]
}): Promise<LayoutImportSummary> {
  const libraryRoot = resolveLayoutLibraryPath()
  await ensureLayoutLibrary(libraryRoot)
  const manifest = await readLayoutManifest(libraryRoot)
  const knownFingerprints = new Set(manifest.assets.map((asset) => asset.structureFingerprint))

  let imported = 0
  let skipped = 0
  let duplicated = 0
  const total = args.pages.length

  for (const page of args.pages) {
    try {
      const absolutePath = path.resolve(args.projectDir, page.htmlPath)
      const html = await fs.promises.readFile(absolutePath, 'utf-8')
      const slideSizeId =
        html.match(/\bdata-ppt-slide-size-id=["']([^"']+)["']/i)?.[1] || 'wide-16-9'
      const id = `layout-${layoutIdGen()}`
      const asset = buildLayoutAssetFromPageHtml({
        html,
        id,
        title: page.title || `第 ${page.pageNumber} 页`,
        roles: args.roles ? args.roles(page.pageNumber, total) : ['content'],
        slideSizeId,
        source: 'template',
        skeletonPath: `${SKELETON_DIR}/${id}.html`,
        sessionId: args.sessionId,
        pageId: page.pageId
      })
      if (!asset) {
        skipped += 1
        continue
      }
      if (knownFingerprints.has(asset.structureFingerprint)) {
        duplicated += 1
        continue
      }
      knownFingerprints.add(asset.structureFingerprint)
      await fs.promises.writeFile(
        path.join(libraryRoot, asset.skeletonPath),
        html,
        'utf-8'
      )
      manifest.assets.push(asset)
      imported += 1
    } catch (error) {
      skipped += 1
      log.warn('[layout-assets] page parametrize failed', {
        sessionId: args.sessionId,
        pageId: page.pageId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (imported > 0) await writeLayoutManifest(libraryRoot, manifest)
  log.info('[layout-assets] session imported to layout library', {
    sessionId: args.sessionId,
    imported,
    skipped,
    duplicated
  })
  return { imported, skipped, duplicated }
}

export async function deleteLayoutAsset(id: string): Promise<boolean> {
  const libraryRoot = resolveLayoutLibraryPath()
  const manifest = await readLayoutManifest(libraryRoot)
  const target = manifest.assets.find((asset) => asset.id === id)
  if (!target) return false
  manifest.assets = manifest.assets.filter((asset) => asset.id !== id)
  await writeLayoutManifest(libraryRoot, manifest)
  await fs.promises.rm(path.join(libraryRoot, target.skeletonPath), { force: true })
  return true
}

export async function readLayoutSkeleton(asset: LayoutAsset): Promise<string> {
  return fs.promises.readFile(path.join(resolveLayoutLibraryPath(), asset.skeletonPath), 'utf-8')
}
