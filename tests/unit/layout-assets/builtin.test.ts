import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { buildLayoutAssetFromPageHtml } from '../../../src/main/layout-assets/parametrize'
import { fillLayoutAsset } from '../../../src/main/layout-assets/fill'
import {
  BUILTIN_LAYOUTS_VERSION,
  seedBuiltinLayoutAssets
} from '../../../src/main/layout-assets/builtin'
import type { LayoutAsset, LayoutAssetManifest } from '../../../src/shared/layout-asset'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const builtinDir = path.join(process.cwd(), 'resources', 'layout-assets', 'builtin')

const BUILTIN_FILES = [
  { file: 'builtin-cover-1.html', roles: ['cover'], expectList: false },
  { file: 'builtin-cover-2.html', roles: ['cover'], expectList: false },
  { file: 'builtin-content-3grid.html', roles: ['content'], expectList: true },
  { file: 'builtin-content-4grid.html', roles: ['content'], expectList: true },
  { file: 'builtin-content-2split.html', roles: ['content'], expectList: true },
  { file: 'builtin-content-steps.html', roles: ['content'], expectList: true },
  { file: 'builtin-ending-1.html', roles: ['ending'], expectList: false }
]

describe('builtin layout derivation', () => {
  it('parametrizes every bundled builtin into a usable layout asset', () => {
    for (const spec of BUILTIN_FILES) {
      const html = fs.readFileSync(path.join(builtinDir, spec.file), 'utf-8')
      const asset = buildLayoutAssetFromPageHtml({
        html,
        id: `test-${spec.file}`,
        title: spec.file,
        roles: spec.roles,
        slideSizeId: 'wide-16-9',
        source: 'authored',
        skeletonPath: `skeletons/${spec.file}`
      })
      expect(asset, `${spec.file} should parametrize`).toBeTruthy()
      expect(asset!.roles).toEqual(spec.roles)
      expect(asset!.slots.some((slot) => slot.kind === 'title'), `${spec.file} needs a title slot`).toBe(true)
      const hasList = asset!.slots.some((slot) => slot.kind === 'list')
      expect(hasList, `${spec.file} list expectation`).toBe(spec.expectList)
    }
  })

  it('fills a builtin content grid with planned key points end to end', () => {
    const html = fs.readFileSync(path.join(builtinDir, 'builtin-content-3grid.html'), 'utf-8')
    const asset = buildLayoutAssetFromPageHtml({
      html,
      id: 'test-fill',
      title: 'fill',
      roles: ['content'],
      slideSizeId: 'wide-16-9',
      source: 'authored',
      skeletonPath: 'skeletons/fill.html'
    })!
    const filled = fillLayoutAsset(asset, html, {
      title: '伺服电机三大增长引擎',
      body: '下游需求持续拉动高端产能。',
      listItems: ['能效标准趋严', '国产替代加速', '机器人放量']
    })
    expect(filled).toContain('伺服电机三大增长引擎')
    expect(filled).toContain('能效标准趋严')
    expect(filled).toContain('机器人放量')
    expect(filled).not.toContain('第一个模块的核心观点')
  })
})

describe('seedBuiltinLayoutAssets', () => {
  it('seeds all builtins once and skips when the version matches', async () => {
    const manifest: LayoutAssetManifest = { version: 1, assets: [] }
    const seededPaths: string[] = []
    // 用真实 bundle 目录 + 临时库目录；skeleton 写入重定向到内存记录
    const libraryRoot = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.tmp-builtin-'))
    fs.mkdirSync(path.join(libraryRoot, 'skeletons'), { recursive: true })
    try {
      const first = await seedBuiltinLayoutAssets({
        manifest,
        libraryRoot,
        skeletonDir: 'skeletons'
      })
      expect(first.seeded).toBe(7)
      expect(manifest.assets.every((asset) => asset.id.startsWith('builtin-'))).toBe(true)
      expect(manifest.builtinSeededVersion).toBe(BUILTIN_LAYOUTS_VERSION)
      for (const asset of manifest.assets as LayoutAsset[]) {
        seededPaths.push(asset.skeletonPath)
      }
      expect(new Set(seededPaths).size).toBe(7)

      const second = await seedBuiltinLayoutAssets({
        manifest,
        libraryRoot,
        skeletonDir: 'skeletons'
      })
      expect(second.seeded).toBe(0)
      expect(manifest.assets).toHaveLength(7)
    } finally {
      fs.rmSync(libraryRoot, { recursive: true, force: true })
    }
  })
})
