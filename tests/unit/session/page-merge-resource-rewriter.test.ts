import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  collectMergedPageResourceKeys,
  collectUnsafeMergedPageResourceReferences,
  extractMergePageFontProfile,
  isMergePathInside,
  resolveMergeFileInside,
  rewriteMergedPageHtml
} from '../../../src/main/session/page-merge-rewriter'
import { validatePersistedPageHtml } from '../../../src/main/presentation/html/html-utils'

const targetFontHtml = `<html><head>
  <style data-ppt-fonts="google">@font-face{font-family:"Target Title";src:url("./assets/fonts/google-fonts/Target-Title/title.woff2") format("woff2")}</style>
  <style data-ppt-fonts="google">@font-face{font-family:"Target Body";src:url("./assets/fonts/google-fonts/Target-Body/body.woff2") format("woff2")}</style>
  <style data-ppt-fonts="1">:root{--ppt-title-font:"Target Title";--ppt-body-font:"Target Body"}</style>
</head><body></body></html>`

const targetFontProfile = extractMergePageFontProfile(targetFontHtml)!

describe('page merge resource rewriter', () => {
  it('rewrites page identity and local resource attributes', () => {
    const html = `<!doctype html>
<html>
  <head>
    <style>.hero{background-image:url('./images/bg.png?x=1')}</style>
  </head>
  <body data-page-id="page-old">
    <div data-page-id="page-old" style="background:url(./images/pattern.svg#mask)">
      <img src="./images/a.png" srcset="./images/a.png 1x, ./images/a@2x.png 2x">
      <img src="./images/page-old.png">
      <video src="./videos/demo.mp4" poster="./images/poster.jpg"></video>
      <svg>
        <image href="./images/vector.svg" />
        <image xlink:href="./images/vector-legacy.svg" />
      </svg>
    </div>
    <script>window.pageId = 'page-old'</script>
  </body>
</html>`
    const resourcePathMap = new Map([
      ['images/bg.png', './assets/merged-pages/batch/page-new/images/bg.png'],
      ['images/pattern.svg', './assets/merged-pages/batch/page-new/images/pattern.svg'],
      ['images/a.png', './assets/merged-pages/batch/page-new/images/a.png'],
      ['images/a@2x.png', './assets/merged-pages/batch/page-new/images/a@2x.png'],
      ['images/page-old.png', './assets/merged-pages/batch/page-new/images/page-old.png'],
      ['videos/demo.mp4', './assets/merged-pages/batch/page-new/videos/demo.mp4'],
      ['images/poster.jpg', './assets/merged-pages/batch/page-new/images/poster.jpg'],
      ['images/vector.svg', './assets/merged-pages/batch/page-new/images/vector.svg'],
      ['images/vector-legacy.svg', './assets/merged-pages/batch/page-new/images/vector-legacy.svg']
    ])

    const rewritten = rewriteMergedPageHtml({
      html,
      oldPageId: 'page-old',
      nextPageId: 'page-new',
      resourcePathMap,
      targetFontProfile
    })

    expect(rewritten).toContain('data-page-id="page-new"')
    expect(rewritten).toContain("window.pageId = 'page-new'")
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/a.png')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/a@2x.png 2x')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/page-old.png')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/videos/demo.mp4')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/bg.png?x=1')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/pattern.svg#mask')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/vector.svg')
    expect(rewritten).toContain('./assets/merged-pages/batch/page-new/images/vector-legacy.svg')
  })

  it('collects local resources and ignores external or unsafe references', () => {
    const html = `
      <img src="./images/a.png">
      <img src="https://example.com/remote.png">
      <img src="data:image/png;base64,abc">
      <img src="../outside.png">
      <video src="./videos/demo.mp4#t=1"></video>
      <script src="./assets/ppt-runtime.js"></script>
      <div style="background:url('./images/bg.png')"></div>
    `

    expect(collectMergedPageResourceKeys(html)).toEqual([
      'assets/ppt-runtime.js',
      'images/a.png',
      'images/bg.png',
      'videos/demo.mp4'
    ])
  })

  it('reports unsafe non-font resource references', () => {
    expect(
      collectUnsafeMergedPageResourceReferences(`
        <img src="../outside.png">
        <div style="background:url('%2e%2e/encoded.png')"></div>
        <style>@font-face{src:url('../fonts/font.woff2')}</style>
      `)
    ).toEqual(['%2e%2e/encoded.png', '../outside.png'])
  })

  it('keeps resources that are not present in the rewrite map', () => {
    const html = `
      <body data-page-id="page-a">
        <script src="./assets/ppt-runtime.js"></script>
        <img src="https://example.com/image.png">
      </body>
    `
    const rewritten = rewriteMergedPageHtml({
      html,
      oldPageId: 'page-a',
      nextPageId: 'page-b',
      resourcePathMap: new Map(),
      targetFontProfile
    })

    expect(rewritten).toContain('./assets/ppt-runtime.js')
    expect(rewritten).toContain('https://example.com/image.png')
  })

  it('rejects paths that escape the source project root', () => {
    expect(isMergePathInside('/sessions/source/images/a.png', '/sessions/source')).toBe(true)
    expect(isMergePathInside('/sessions/source', '/sessions/source')).toBe(true)
    expect(isMergePathInside('/sessions/source-other/a.png', '/sessions/source')).toBe(false)
    expect(isMergePathInside('/sessions/outside.png', '/sessions/source')).toBe(false)
  })

  it('rejects symlinks that resolve outside the source project root', async (ctx) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-merge-path-'))
    const sourceRoot = path.join(root, 'source')
    const outsidePath = path.join(root, 'outside.png')
    await fs.promises.mkdir(sourceRoot, { recursive: true })
    await fs.promises.writeFile(outsidePath, 'outside')
    const linkedPath = path.join(sourceRoot, 'linked.png')
    try {
      await fs.promises.symlink(outsidePath, linkedPath)
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        ctx.skip('Windows without developer mode cannot create symlinks')
        return
      }
      throw error
    }

    try {
      await expect(resolveMergeFileInside(linkedPath, sourceRoot)).resolves.toBeNull()
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true })
    }
  })

  it('replaces source font injection with the target template fonts', () => {
    const html = `<html><head>
      <style data-ppt-fonts="google">@font-face{font-family:"Source Title";src:url("./assets/fonts/google-fonts/Source-Title/title.woff2") format("woff2")}</style>
      <style data-ppt-fonts="google">@font-face{font-family:"Source Body";src:url("./assets/fonts/google-fonts/Source-Body/body.woff2") format("woff2")}</style>
      <style data-ppt-fonts="1">:root{--ppt-title-font:"Source Title";--ppt-body-font:"Source Body"}</style>
      <style>@font-face{font-family:"Legacy Font";src:url("./legacy.woff2")}.title{font-family:"Source Title"}.body{font-family:Source Body}.legacy{font-family:"Legacy Font"}</style>
    </head><body data-page-id="page-source"><p style="font-family:'Source Body'">Text</p></body></html>`

    const rewritten = rewriteMergedPageHtml({
      html,
      oldPageId: 'page-source',
      nextPageId: 'page-target',
      resourcePathMap: new Map(),
      targetFontProfile
    })

    expect(rewritten).not.toContain('Source Title')
    expect(rewritten).not.toContain('Source Body')
    expect(rewritten).not.toContain('Source-Title')
    expect(rewritten).not.toContain('Legacy Font')
    expect(rewritten).not.toContain('@font-face{font-family:"Legacy Font"')
    expect(rewritten).toContain('--ppt-title-font:"Target Title"')
    expect(rewritten).toContain('--ppt-body-font:"Target Body"')
    expect(rewritten).toContain('./assets/fonts/google-fonts/Target-Title/title.woff2')
    expect(rewritten).not.toContain('assets/merged-pages')
    expect(
      validatePersistedPageHtml(rewritten, 'page-target').errors.filter((error) =>
        error.includes('字体')
      )
    ).toEqual([])
  })
})
