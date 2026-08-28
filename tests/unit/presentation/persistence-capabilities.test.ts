import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {},
  session: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { requireSlideSizePreset } from '../../../src/shared/slide-size'
import {
  PageWriteValidationError,
  persistPageHtmlFromFragment,
  validatePersistedPageAfterEdit,
  verifyPresentationPageFiles
} from '../../../src/main/presentation/html/page-writer-core'
import {
  persistIndexTransition,
  verifyIndexShellFile
} from '../../../src/main/presentation/html/index-transition'
import { buildProjectIndexHtml } from '../../../src/main/session/template-builder'

const temporaryDirectories: string[] = []

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ohmyppt-presentation-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true }))
  )
})

describe('presentation persistence capabilities', () => {
  it('expands a known data-icon into trusted inline SVG before persistence', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-icon.html')
    const result = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-5xl">Launch plan</h1><p class="text-xl">The delivery sequence is ready for presentation.</p><svg data-icon="rocket" class="w-12 h-12 text-blue-500" aria-label="Launch"></svg></section>',
      pageId: 'page-icon',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })

    expect(result.html).toMatch(/<path[^>]*d="/)
    expect(result.html).toContain('aria-label="Launch"')
    expect(result.html).toContain('text-blue-500')
    expect(result.html).not.toContain('data-icon')
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(result.html)
  })

  it('rejects an unknown data-icon before writing the page file', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-unknown-icon.html')

    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section class="px-24"><h1 class="text-5xl">Launch plan</h1><p class="text-xl">The delivery sequence is ready for presentation.</p><svg data-icon="not-a-real-icon-id" class="w-12 h-12"></svg></section>',
        pageId: 'page-unknown-icon',
        projectDir,
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9')
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'harness-quality' })
    await expect(fs.promises.stat(pagePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('owns page validation, runtime injection, serialized persistence, and verification', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-1.html')
    const result = await persistPageHtmlFromFragment({
      content:
        '<section><h1>Quarterly review</h1><p>Growth is on track across all regions this quarter.</p><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
      pageId: 'page-1',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })

    expect(result.html).toContain('data-ppt-guard-root="1"')
    expect(result.qualityWarnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'safe-area-implicit' })])
    )
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(result.html)
    await expect(
      verifyPresentationPageFiles({
        pageFileMap: { 'page-1': pagePath },
        pageIds: ['page-1', 'missing']
      })
    ).resolves.toEqual([
      {
        pageId: 'page-1',
        filled: true,
        hasContent: true,
        hasRemoteRuntime: false
      },
      {
        pageId: 'missing',
        filled: false,
        hasContent: false,
        hasRemoteRuntime: false
      }
    ])
  })

  it('persists advisory-only pages but blocks deterministic quality errors', async () => {
    const projectDir = await createTemporaryDirectory()
    const advisoryPath = path.join(projectDir, 'page-advisory.html')
    const advisory = await persistPageHtmlFromFragment({
      content:
        '<section><nav><span class="text-lg">Overview</span></nav><h1 class="text-5xl">Product experience</h1><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
      pageId: 'page-advisory',
      projectDir,
      targetPath: advisoryPath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })
    expect(advisory.qualityWarnings.map((warning) => warning.code)).toContain(
      'interactive-ui-controls'
    )
    await expect(fs.promises.readFile(advisoryPath, 'utf-8')).resolves.toContain(
      'Product experience'
    )

    // emoji 图标位仍是确定性错误：拦截、不落盘
    const rejectedPath = path.join(projectDir, 'page-rejected.html')
    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section class="px-24"><h1 class="text-5xl">Emoji icon</h1><div class="w-12 h-12 rounded-full flex items-center justify-center"><span class="text-2xl">🚀</span></div></section>',
        pageId: 'page-rejected',
        projectDir,
        targetPath: rejectedPath,
        slideSize: requireSlideSizePreset('wide-16-9')
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'harness-quality' })
    await expect(fs.promises.stat(rejectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('auto-raises below-floor font sizes instead of rejecting the page', async () => {
    const projectDir = await createTemporaryDirectory()
    const raisedPath = path.join(projectDir, 'page-raised.html')
    const raised = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-xl">Tiny title</h1><p class="text-sm">Tiny body</p><svg viewBox="0 0 24 24"></svg></section>',
      pageId: 'page-raised',
      projectDir,
      targetPath: raisedPath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })
    expect(raised.html).toContain('text-[24px]')
    expect(raised.html).toContain('text-[18px]')
    expect(raised.html).toContain('Tiny title')
    expect(raised.html).not.toContain('text-xl')
    expect(raised.html).not.toContain('text-sm"')
    const written = await fs.promises.readFile(raisedPath, 'utf-8')
    expect(written).toContain('text-[24px]')
    expect(written).toContain('text-[18px]')
  })

  it('rolls back the page when rendered validation rejects the new layout', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-rendered.html')
    const previousHtml = '<!doctype html><html><body>Previous accepted page</body></html>'
    await fs.promises.writeFile(pagePath, previousHtml, 'utf-8')

    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section class="px-24"><h1 class="text-5xl">New layout</h1><p class="text-xl">This page passes static checks before browser validation.</p><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
        pageId: 'page-rendered',
        projectDir,
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9'),
        validateRenderedPage: async () => ({
          available: true,
          violations: [
            {
              code: 'render-text-clipped',
              severity: 'error',
              detail: '正文被容器裁切',
              fix: '增加文本容器高度'
            }
          ]
        })
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'rendered-quality' })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(previousHtml)
  })

  it('keeps the statically valid page when the renderer itself is unavailable', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-renderer-unavailable.html')
    const result = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-5xl">Static fallback</h1><p class="text-xl">The browser process is unavailable, so the page remains reviewable.</p><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
      pageId: 'page-renderer-unavailable',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9'),
      validateRenderedPage: async () => ({
        available: false,
        violations: [],
        unavailableReason: 'Electron app is not ready'
      })
    })

    expect(result.qualityWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rendered-validation-unavailable', severity: 'warn' })
      ])
    )
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(result.html)
  })

  it('rejects an auto-repaired truncated fragment when rendered validation is unavailable', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-truncated.html')
    const previousHtml = '<!doctype html><html><body>Previous accepted page</body></html>'
    await fs.promises.writeFile(pagePath, previousHtml, 'utf-8')

    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section class="px-24"><h1 class="text-5xl">Truncated</h1><p class="text-xl">The closing tags were cut off<svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg>',
        pageId: 'page-truncated',
        projectDir,
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9'),
        validateRenderedPage: async () => ({
          available: false,
          violations: [],
          unavailableReason: 'renderer unavailable'
        })
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'content-validation' })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(previousHtml)
  })

  it('exposes an auto-repair warning when rendered validation confirms the repaired page', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-repaired.html')
    const result = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-5xl">Repaired</h1><p class="text-xl">The closing tags were cut off<svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg>',
      pageId: 'page-repaired',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9'),
      validateRenderedPage: async () => ({ available: true, violations: [] })
    })

    expect(result.qualityWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'creative-fragment-repaired', severity: 'warn' })
      ])
    )
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(result.html)
  })

  it('rolls back an edited page when it introduces a deck-level contract break', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-deck-contract.html')
    const previousHtml = '<!doctype html><html><body>Previous deck-consistent page</body></html>'
    await fs.promises.writeFile(pagePath, previousHtml, 'utf-8')

    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section class="px-24"><h1 class="text-5xl">Edited page</h1><p class="text-xl">This page passes local validation.</p><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
        pageId: 'page-deck-contract',
        projectDir,
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9'),
        validateDeckConsistency: async () => ({
          details: ['deck-font-system-drift: core font changed'],
          message: 'Deck-level quality review found a new font contract break.'
        })
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'deck-quality' })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(previousHtml)
  })

  it('validates selector-edited full pages through the same rendered quality rules', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-selector.html')
    const persisted = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-5xl">Selector edit</h1><p class="text-xl">The edited node remains part of a complete presentation page.</p><svg viewBox="0 0 24 24" class="w-full h-[400px]"><path d="M3 17l6-6 4 4 8-8"/></svg></section>',
      pageId: 'page-selector',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })

    await expect(
      validatePersistedPageAfterEdit({
        pageId: 'page-selector',
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9'),
        validateRenderedPage: async () => ({
          available: true,
          violations: [
            {
              code: 'render-text-overlap',
              severity: 'error',
              detail: '两个文本框明显重叠',
              fix: '重新分配文本框位置'
            }
          ]
        })
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'rendered-quality' })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(persisted.html)
  })

  it('expands known data-icons introduced by selector edits before validation', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-selector-icon.html')
    const persisted = await persistPageHtmlFromFragment({
      content:
        '<section class="px-24"><h1 class="text-5xl">Selector icon</h1><p class="text-xl">The original page is valid before the selector edit.</p><svg viewBox="0 0 24 24" class="w-12 h-12"><path d="M3 12h18"/></svg></section>',
      pageId: 'page-selector-icon',
      projectDir,
      targetPath: pagePath,
      slideSize: requireSlideSizePreset('wide-16-9')
    })
    await fs.promises.writeFile(
      pagePath,
      persisted.html.replace(
        '<svg viewBox="0 0 24 24" class="w-12 h-12"><path d="M3 12h18"></path></svg>',
        '<svg data-icon="rocket" class="w-12 h-12" aria-label="Launch"></svg>'
      ),
      'utf-8'
    )

    await expect(
      validatePersistedPageAfterEdit({
        pageId: 'page-selector-icon',
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9')
      })
    ).resolves.toEqual([])

    const editedHtml = await fs.promises.readFile(pagePath, 'utf-8')
    expect(editedHtml).toMatch(/<path[^>]*d="/)
    expect(editedHtml).toContain('aria-label="Launch"')
    expect(editedHtml).not.toContain('data-icon')
  })

  it('keeps template skeleton validation and index persistence in presentation', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-1.html')
    const templateHtml =
      '<div class="bg-cover" style="background-image: url(./images/template.png)"></div>'
    await fs.promises.writeFile(pagePath, templateHtml, 'utf-8')

    await expect(
      persistPageHtmlFromFragment({
        content:
          '<section><h1>New content</h1><svg viewBox="0 0 24 24" class="w-[200px] h-[200px]"><circle cx="12" cy="12" r="10"/></svg></section>',
        pageId: 'page-1',
        projectDir,
        targetPath: pagePath,
        slideSize: requireSlideSizePreset('wide-16-9'),
        preserveTemplateSkeleton: true
      })
    ).rejects.toMatchObject<PageWriteValidationError>({ kind: 'template-skeleton' })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(templateHtml)

    const indexPath = path.join(projectDir, 'index.html')
    await fs.promises.writeFile(
      indexPath,
      buildProjectIndexHtml(
        'Review',
        [{ pageNumber: 1, pageId: 'page-1', title: 'Overview', htmlPath: 'page-1.html' }],
        requireSlideSizePreset('wide-16-9')
      ),
      'utf-8'
    )
    await expect(verifyIndexShellFile(indexPath)).resolves.toEqual({ status: 'valid' })
    await expect(
      persistIndexTransition({
        indexPath,
        projectDir,
        input: { type: 'fade', durationMs: 420 }
      })
    ).resolves.toMatchObject({ status: 'updated', config: { type: 'fade', durationMs: 420 } })
    await expect(fs.promises.readFile(indexPath, 'utf-8')).resolves.toContain('"durationMs":420')
  })
})
