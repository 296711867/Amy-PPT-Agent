import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPageRecord } from '../../../src/main/db/database'
import {
  hasCompleteSessionPageCoverage,
  recoverUsableSessionPages,
  shouldRecoverSessionPages
} from '../../../src/main/session/page-status-recovery'

const temporaryDirectories: string[] = []

const validPageHtml = (pageId: string): string => `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <main class="ppt-page-root" data-ppt-guard-root="1" data-ppt-slide-size-id="wide-16-9" data-ppt-width="1600" data-ppt-height="900">
      <section class="ppt-page-content" data-block-id="content-${pageId}"><h1 data-role="title">Recovered page</h1></section>
    </main>
  </body>
</html>`

const sessionPage = (args: {
  id: string
  pageId: string
  pageNumber: number
  status: 'completed' | 'failed' | 'pending'
  error?: string | null
}): SessionPageRecord =>
  ({
    id: args.id,
    session_id: 'session-1',
    legacy_page_id: null,
    file_slug: args.pageId,
    page_number: args.pageNumber,
    title: `Page ${args.pageNumber}`,
    html_path: `${args.pageId}.html`,
    status: args.status,
    error: args.error || null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null
  }) as SessionPageRecord

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true })
    )
  )
})

describe('session page status recovery', () => {
  it('only recovers sessions that already started a generation run and are not running', () => {
    // 从模板创建、尚未开始生成的会话：pending + 已落盘模板页是设计状态，不能恢复。
    expect(
      shouldRecoverSessionPages({ hasActiveRun: false, hasGenerationHistory: false })
    ).toBe(false)
    // 正在运行的会话交给运行态本身，不做恢复。
    expect(shouldRecoverSessionPages({ hasActiveRun: true, hasGenerationHistory: true })).toBe(
      false
    )
    // 中断过生成的会话（存在 generation run/job）才允许恢复可用页面。
    expect(shouldRecoverSessionPages({ hasActiveRun: false, hasGenerationHistory: true })).toBe(
      true
    )
  })

  it('requires unique completed coverage for every expected page number', () => {
    const completed = [1, 2, 3, 4, 5, 6].map((pageNumber) =>
      sessionPage({
        id: `page-${pageNumber}`,
        pageId: `page-${pageNumber}`,
        pageNumber,
        status: 'completed'
      })
    )

    expect(hasCompleteSessionPageCoverage(completed, 6)).toBe(true)
    expect(hasCompleteSessionPageCoverage(completed.slice(0, 2), 6)).toBe(false)
    expect(
      hasCompleteSessionPageCoverage(
        [completed[0], { ...completed[1], page_number: 1 }, ...completed.slice(2)],
        6
      )
    ).toBe(false)
  })

  it('recovers valid pages interrupted before their completed status was finalized', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-page-recovery-'))
    temporaryDirectories.push(projectDir)
    const pending = sessionPage({
      id: 'pending-1',
      pageId: 'page-pending',
      pageNumber: 1,
      status: 'pending'
    })
    const blocked = sessionPage({
      id: 'blocked-2',
      pageId: 'page-blocked',
      pageNumber: 2,
      status: 'failed',
      error: "浏览器渲染验收不可用：ERR_BLOCKED_BY_CLIENT (-20) loading 'file:///page-2.html'"
    })
    await fs.promises.writeFile(
      path.join(projectDir, pending.html_path),
      validPageHtml(pending.file_slug),
      'utf-8'
    )
    await fs.promises.writeFile(
      path.join(projectDir, blocked.html_path),
      validPageHtml(blocked.file_slug),
      'utf-8'
    )
    const upsertSessionPage = vi.fn(async () => undefined)

    const result = await recoverUsableSessionPages({
      db: { upsertSessionPage } as never,
      sessionId: 'session-1',
      pages: [pending, blocked],
      resolveHtmlPath: (page) => path.join(projectDir, page.html_path)
    })

    expect(result.recoveredPageIds).toEqual(['page-pending', 'page-blocked'])
    expect(result.pages.map((page) => page.status)).toEqual(['completed', 'completed'])
    expect(upsertSessionPage).toHaveBeenCalledTimes(2)
  })

  it('never recovers an untouched template seed page even with run history (I-15 blind spot)', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-seed-recovery-'))
    temporaryDirectories.push(projectDir)
    const seed = sessionPage({
      id: 'seed-1',
      pageId: 'page-seed',
      pageNumber: 1,
      status: 'pending'
    })
    const rewritten = sessionPage({
      id: 'rewritten-2',
      pageId: 'page-rewritten',
      pageNumber: 2,
      status: 'pending'
    })
    const seedHtml = validPageHtml(seed.file_slug)
    const rewrittenHtml = validPageHtml(rewritten.file_slug).replace(
      'Recovered page',
      'Generated page'
    )
    await fs.promises.writeFile(path.join(projectDir, seed.html_path), seedHtml, 'utf-8')
    await fs.promises.writeFile(path.join(projectDir, rewritten.html_path), rewrittenHtml, 'utf-8')
    const upsertSessionPage = vi.fn(async () => undefined)

    const result = await recoverUsableSessionPages({
      db: { upsertSessionPage } as never,
      sessionId: 'session-1',
      pages: [seed, rewritten],
      resolveHtmlPath: (page) => path.join(projectDir, page.html_path),
      isUntouchedSeed: (page, html) => page.file_slug === 'page-seed' && html === seedHtml
    })

    // 种子页保持 pending（从未被生成改写）；真正写过的页面照常恢复
    expect(result.recoveredPageIds).toEqual(['page-rewritten'])
    expect(result.pages.map((page) => page.status)).toEqual(['pending', 'completed'])
    expect(upsertSessionPage).toHaveBeenCalledTimes(1)
  })

  it('keeps real generation failures and placeholder pages retryable', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-page-recovery-'))
    temporaryDirectories.push(projectDir)
    const modelFailure = sessionPage({
      id: 'failed-1',
      pageId: 'page-failed',
      pageNumber: 1,
      status: 'failed',
      error: 'model request failed'
    })
    const cancelledPlaceholder = sessionPage({
      id: 'cancelled-2',
      pageId: 'page-placeholder',
      pageNumber: 2,
      status: 'failed',
      error: '生成已取消'
    })
    await fs.promises.writeFile(
      path.join(projectDir, modelFailure.html_path),
      validPageHtml(modelFailure.file_slug),
      'utf-8'
    )
    await fs.promises.writeFile(
      path.join(projectDir, cancelledPlaceholder.html_path),
      validPageHtml(cancelledPlaceholder.file_slug).replace(
        '<section class="ppt-page-content"',
        '<section class="ppt-page-content" data-placeholder-page="1"'
      ),
      'utf-8'
    )
    const upsertSessionPage = vi.fn(async () => undefined)

    const result = await recoverUsableSessionPages({
      db: { upsertSessionPage } as never,
      sessionId: 'session-1',
      pages: [modelFailure, cancelledPlaceholder],
      resolveHtmlPath: (page) => path.join(projectDir, page.html_path)
    })

    expect(result.recoveredPageIds).toEqual([])
    expect(result.pages.map((page) => page.status)).toEqual(['failed', 'failed'])
    expect(upsertSessionPage).not.toHaveBeenCalled()
  })
})
