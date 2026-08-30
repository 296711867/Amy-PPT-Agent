import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { ensurePageShell, fillLayoutAsset } from '../../../src/main/layout-assets/fill'
import type { LayoutAsset } from '@shared/layout-asset'

const BARE_SKELETON = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>Bare</title></head>
<body>
<main class="ppt-page-root" data-ppt-slide-size-id="wide-16-9" data-ppt-width="1600" data-ppt-height="900">
  <section data-block-id="title" style="position:absolute;left:160px;top:240px;width:1100px;height:110px">演示文稿主标题</section>
</main>
</body>
</html>`

describe('ensurePageShell', () => {
  it('adds the guard root marker and content wrapper to a bare skeleton', () => {
    const shelled = ensurePageShell(BARE_SKELETON)
    expect(shelled).toContain('data-ppt-guard-root="1"')
    expect(shelled).toContain('<div class="ppt-page-content">')
    // 原有区块保留在包裹层内
    expect(shelled.indexOf('ppt-page-content')).toBeLessThan(shelled.indexOf('data-block-id="title"'))
    expect(shelled.indexOf('data-block-id="title"')).toBeLessThan(shelled.lastIndexOf('</main>'))
  })

  it('is idempotent for skeletons that already carry the shell', () => {
    const once = ensurePageShell(BARE_SKELETON)
    expect(ensurePageShell(once)).toBe(once)
  })

  it('leaves skeletons without a page root untouched', () => {
    const fragment = '<div><section data-block-id="title">标题</section></div>'
    expect(ensurePageShell(fragment)).toBe(fragment)
  })

  it('shells every builtin layout skeleton shipped with the app', () => {
    // 锁定版式快速通道直接把骨架落盘，缺壳会被 validatePersistedPageHtml 判死。
    const dir = path.resolve(__dirname, '../../../resources/layout-assets/builtin')
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(dir, file), 'utf8')
      expect(html.includes('data-ppt-guard-root="1"'), file).toBe(true)
      expect(html.includes('ppt-page-content'), file).toBe(true)
    }
  })
})

describe('fillLayoutAsset clone placement', () => {
  it('keeps cloned list items inside the page root', () => {
    const asset = {
      id: 'asset-test',
      title: 'test',
      roles: ['content'],
      slideSizeId: 'wide-16-9',
      source: 'authored',
      skeletonPath: 'skeletons/asset-test.html',
      slots: [
        {
          kind: 'list',
          slotId: 'list',
          label: '要点',
          itemSlotIds: ['list-item-1', 'list-item-2'],
          minItems: 1,
          maxItems: 3
        }
      ]
    } as unknown as LayoutAsset
    const skeleton = ensurePageShell(`<!doctype html>
<html><head></head><body>
<main class="ppt-page-root" data-ppt-slide-size-id="wide-16-9" data-ppt-width="1600" data-ppt-height="900">
  <section data-block-id="list-item-1" style="position:absolute;left:100px;top:400px;width:300px;height:60px">要点一</section>
  <section data-block-id="list-item-2" style="position:absolute;left:500px;top:400px;width:300px;height:60px">要点二</section>
</main>
</body></html>`)
    const filled = fillLayoutAsset(asset, skeleton, { listItems: ['A', 'B', 'C'] })
    const rootClose = filled.lastIndexOf('</main>')
    const bodyClose = filled.lastIndexOf('</body>')
    expect(rootClose).toBeGreaterThan(0)
    // 克隆项必须落在 root 闭合标签之前，否则渲染快照与编辑器都看不到它们
    expect(filled.indexOf('list-item-1-item-3')).toBeLessThan(rootClose)
    expect(filled.indexOf('list-item-1-item-3')).toBeLessThan(bodyClose)
  })
})
