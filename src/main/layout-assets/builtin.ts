/**
 * 内置基础版式：随应用分发的 7 个开箱即用版式（resources/layout-assets/builtin）。
 * 首次启动（或版本升级）时播种进用户版式库；槽契约由参数化引擎从 HTML 现场推导，
 * 不手工维护 —— 引擎改规则后 bump BUILTIN_LAYOUTS_VERSION 即可重播。
 */
import fs from 'fs'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'
import { customAlphabet } from 'nanoid'
import type { LayoutAsset, LayoutAssetManifest } from '@shared/layout-asset'
import { buildLayoutAssetFromPageHtml } from './parametrize'

// v2: 骨架补上 data-ppt-guard-root 与 .ppt-page-content 壳层，否则锁定页
// 全部过不了落盘校验而回退自由创作。
export const BUILTIN_LAYOUTS_VERSION = 2

const builtinIdSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

type BuiltinLayoutSpec = {
  file: string
  title: string
  roles: string[]
}

const BUILTIN_LAYOUT_SPECS: readonly BuiltinLayoutSpec[] = [
  { file: 'builtin-cover-1.html', title: '内置 · 简约封面', roles: ['cover'] },
  { file: 'builtin-cover-2.html', title: '内置 · 深色分栏封面', roles: ['cover'] },
  { file: 'builtin-content-3grid.html', title: '内置 · 三栏卡片', roles: ['content'] },
  { file: 'builtin-content-4grid.html', title: '内置 · 四维网格', roles: ['content'] },
  { file: 'builtin-content-2split.html', title: '内置 · 左右对照', roles: ['content'] },
  { file: 'builtin-content-steps.html', title: '内置 · 三步推进', roles: ['content'] },
  { file: 'builtin-ending-1.html', title: '内置 · 结尾页', roles: ['ending'] }
]

export function resolveBuiltinLayoutsSourcePath(): string {
  return is.dev
    ? path.join(process.cwd(), 'resources', 'layout-assets', 'builtin')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'layout-assets', 'builtin')
}

const isBuiltinAsset = (asset: LayoutAsset): boolean => asset.id.startsWith('builtin-')

/**
 * 播种/升级内置版式：清掉旧 builtin 条目，按当前版本重新参数化写入。
 * 追加到调用方传入的 manifest（不落盘，由调用方决定持久化）。
 */
export async function seedBuiltinLayoutAssets(args: {
  manifest: LayoutAssetManifest
  builtinVersion?: number
  libraryRoot: string
  skeletonDir: string
}): Promise<{ seeded: number; skipped: number }> {
  const version = args.builtinVersion ?? BUILTIN_LAYOUTS_VERSION
  const alreadySeeded =
    args.manifest.builtinSeededVersion === version &&
    BUILTIN_LAYOUT_SPECS.every((spec) =>
      args.manifest.assets.some(
        (asset) => isBuiltinAsset(asset) && asset.title === spec.title
      )
    )
  if (alreadySeeded) return { seeded: 0, skipped: BUILTIN_LAYOUT_SPECS.length }

  const sourceDir = resolveBuiltinLayoutsSourcePath()
  const nextAssets = args.manifest.assets.filter((asset) => !isBuiltinAsset(asset))
  let seeded = 0
  let skipped = 0

  for (const spec of BUILTIN_LAYOUT_SPECS) {
    try {
      const html = await fs.promises.readFile(path.join(sourceDir, spec.file), 'utf-8')
      const id = `builtin-${spec.file.replace(/\.html$/, '')}-${builtinIdSuffix()}`
      const asset = buildLayoutAssetFromPageHtml({
        html,
        id,
        title: spec.title,
        roles: spec.roles,
        slideSizeId: 'wide-16-9',
        source: 'authored',
        skeletonPath: `${args.skeletonDir}/${id}.html`
      })
      if (!asset) {
        skipped += 1
        continue
      }
      await fs.promises.writeFile(path.join(args.libraryRoot, asset.skeletonPath), html, 'utf-8')
      nextAssets.push(asset)
      seeded += 1
    } catch (error) {
      skipped += 1
      log.warn('[layout-assets] builtin seed failed', {
        file: spec.file,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  args.manifest.assets = nextAssets
  args.manifest.builtinSeededVersion = version
  log.info('[layout-assets] builtin layouts seeded', { seeded, skipped, version })
  return { seeded, skipped }
}
