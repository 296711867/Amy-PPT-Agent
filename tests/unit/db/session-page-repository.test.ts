import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmWithRetry } from '../../helpers/rm-retry'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(os.tmpdir(), 'ohmyppt-test-user-data')) }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { PPTDatabase } from '../../../src/main/db/database'

describe('session page repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  async function createDatabase(): Promise<PPTDatabase> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-session-page-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()
    await db.createSession({
      id: 'session-pages',
      title: 'Page Session',
      provider: 'openai',
      model: 'test-model',
      slideSizeId: 'wide-16-9',
      slideWidth: 1600,
      slideHeight: 900
    })
    return db
  }

  const pageInput = (id: string, pageNumber: number, title: string) => ({
    id,
    sessionId: 'session-pages',
    fileSlug: `slug-${id}`,
    pageNumber,
    title,
    htmlPath: `pages/${id}.html`,
    status: 'completed' as const
  })

  it('upserts pages, hides soft-deleted rows unless requested', async () => {
    const db = await createDatabase()

    try {
      await db.upsertSessionPage(pageInput('page-1', 1, 'Cover'))
      await db.upsertSessionPage(pageInput('page-2', 2, 'Agenda'))
      await db.upsertSessionPage(pageInput('page-3', 3, 'Summary'))

      await db.softDeleteSessionPages('session-pages', ['page-2'])

      const visible = await db.listSessionPages('session-pages')
      expect(visible.map((page) => page.id)).toEqual(['page-1', 'page-3'])

      const withDeleted = await db.listSessionPages('session-pages', { includeDeleted: true })
      expect(withDeleted.map((page) => page.id)).toEqual(['page-1', 'page-2', 'page-3'])
      expect(withDeleted.find((page) => page.id === 'page-2')?.deleted_at).toEqual(
        expect.any(Number)
      )

      await db.upsertSessionPage(pageInput('page-2', 2, 'Agenda restored'))
      expect((await db.listSessionPages('session-pages')).map((page) => page.id)).toHaveLength(3)

      await db.hardDeleteSessionPages('session-pages', ['page-3'])
      expect(
        (await db.listSessionPages('session-pages', { includeDeleted: true })).map(
          (page) => page.id
        )
      ).not.toContain('page-3')
    } finally {
      await db.close()
    }
  })

  it('reorders pages and persists page state with deletions and session metadata', async () => {
    const db = await createDatabase()

    try {
      await db.upsertSessionPage(pageInput('page-1', 1, 'Cover'))
      await db.upsertSessionPage(pageInput('page-2', 2, 'Agenda'))
      await db.upsertSessionPage(pageInput('page-3', 3, 'Summary'))

      await db.replaceSessionPageOrder('session-pages', [
        { id: 'page-3', pageNumber: 1 },
        { id: 'page-1', pageNumber: 2 },
        { id: 'page-2', pageNumber: 3 }
      ])
      await expect(
        db.listSessionPages('session-pages').then((pages) => pages.map((page) => page.id))
      ).resolves.toEqual(['page-3', 'page-1', 'page-2'])

      await db.persistSessionPageState({
        sessionId: 'session-pages',
        pages: [
          { id: 'page-1', pageNumber: 1 },
          { id: 'page-3', pageNumber: 2 }
        ],
        deletedPageIds: ['page-2'],
        metadata: { reordered: true }
      })

      await expect(
        db.listSessionPages('session-pages').then((pages) =>
          pages.map((page) => [page.id, page.page_number])
        )
      ).resolves.toEqual([
        ['page-1', 1],
        ['page-3', 2]
      ])
      await expect(db.getSession('session-pages')).resolves.toMatchObject({
        metadata: '{"reordered":true}'
      })
    } finally {
      await db.close()
    }
  })

  it('replaces, upserts, and prunes source page skeletons', async () => {
    const db = await createDatabase()

    try {
      await db.replaceSourcePageSkeletons({
        sessionId: 'session-pages',
        sourceDocumentPath: 'docs/source.md',
        sourceDocumentName: 'source.md',
        confidence: 'high',
        items: [
          {
            pageNumber: 1,
            title: 'Cover',
            role: 'content',
            sourceHeading: '# Cover',
            headingLevel: 1,
            lineStart: 1,
            lineEnd: 3
          },
          {
            pageNumber: 2,
            title: 'Chapter',
            role: 'chapter-divider',
            sourceHeading: '## Chapter',
            headingLevel: 2,
            lineStart: 4,
            lineEnd: 9
          },
          {
            pageNumber: 3,
            title: 'Blank heading',
            role: 'content',
            sourceHeading: '   ',
            headingLevel: 2,
            lineStart: 10,
            lineEnd: 12
          }
        ]
      })

      let skeletons = await db.listSourcePageSkeletons('session-pages')
      expect(skeletons.map((item) => item.page_number)).toEqual([1, 2])
      expect(skeletons[1]).toMatchObject({ role: 'chapter-divider', confidence: 'high' })

      await db.upsertSourcePageSkeleton({
        sessionId: 'session-pages',
        pageNumber: 2,
        title: 'Chapter Updated',
        sourceDocumentPath: 'docs/source.md',
        sourceHeading: '## Chapter Two',
        headingLevel: 2,
        lineStart: 4,
        lineEnd: 11,
        confidence: 'medium'
      })
      skeletons = await db.listSourcePageSkeletons('session-pages')
      expect(skeletons).toHaveLength(2)
      expect(skeletons[1]).toMatchObject({
        title: 'Chapter Updated',
        confidence: 'medium'
      })

      await db.deleteSourcePageSkeleton('session-pages', 1)
      await expect(
        db.listSourcePageSkeletons('session-pages').then((items) => items.map((i) => i.page_number))
      ).resolves.toEqual([2])

      await db.deleteSourcePageSkeletons('session-pages', [])
      await expect(db.listSourcePageSkeletons('session-pages')).resolves.toHaveLength(1)
    } finally {
      await db.close()
    }
  })
})
