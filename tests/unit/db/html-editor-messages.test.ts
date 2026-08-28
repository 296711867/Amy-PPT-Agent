import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmWithRetry } from '../../helpers/rm-retry'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'ohmyppt-test-user-data'))
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true }
}))

import { PPTDatabase } from '../../../src/main/db/database'

describe('HTML editor message history', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rmWithRetry(root)
    }
  })

  it('persists messages and plan metadata by document id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-html-editor-messages-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.createHtmlEditDocument({
        id: 'hedit-1',
        title: 'Demo',
        htmlPath: path.join(root, 'current.html'),
        designWidth: 1280,
        createdAt: 1,
        updatedAt: 1
      })
      await db.createHtmlEditMessage({
        id: 'message-1',
        docId: 'hedit-1',
        role: 'user',
        content: '把这个改为蓝色',
        selectedElement: {
          selector: 'body[data-page-id="hedit-1"] [data-block-id="title"]',
          label: '页面标题',
          elementTag: 'h1',
          elementText: 'Demo'
        },
        createdAt: 2
      })
      await db.createHtmlEditMessage({
        id: 'message-2',
        docId: 'hedit-1',
        role: 'assistant',
        content: '已完成 HTML 改造。',
        intent: 'style',
        planJson: '{"intent":"style"}',
        requiresConfirmation: false,
        createdAt: 3
      })

      await expect(db.listHtmlEditMessages('hedit-1')).resolves.toMatchObject([
        {
          id: 'message-1',
          role: 'user',
          content: '把这个改为蓝色',
          selectedSelector: 'body[data-page-id="hedit-1"] [data-block-id="title"]',
          selectedLabel: '页面标题',
          selectedElementTag: 'h1'
        },
        {
          id: 'message-2',
          role: 'assistant',
          intent: 'style',
          planJson: '{"intent":"style"}'
        }
      ])
    } finally {
      await db.close()
    }
  })

  it('clears messages without affecting the document', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-html-editor-messages-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.createHtmlEditDocument({
        id: 'hedit-2',
        title: 'Demo',
        htmlPath: path.join(root, 'current.html'),
        designWidth: 1280,
        createdAt: 1,
        updatedAt: 1
      })
      await db.createHtmlEditMessage({
        id: 'message-3',
        docId: 'hedit-2',
        role: 'user',
        content: '测试',
        createdAt: 2
      })

      await db.clearHtmlEditMessages('hedit-2')

      await expect(db.listHtmlEditMessages('hedit-2')).resolves.toEqual([])
      await expect(db.getHtmlEditDocument('hedit-2')).resolves.toMatchObject({ title: 'Demo' })
    } finally {
      await db.close()
    }
  })

  it('creates documents with versions and touches the document when appending a version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-html-editor-versions-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.createHtmlEditDocumentWithVersion({
        document: {
          id: 'hedit-3',
          title: 'Versioned Demo',
          htmlPath: path.join(root, 'current.html'),
          designWidth: 1280,
          createdAt: 10,
          updatedAt: 10
        },
        version: {
          id: 'version-1',
          commitSha: 'commit-1',
          message: 'Initial import',
          createdAt: 10
        }
      })
      await db.createHtmlEditVersionAndTouch({
        id: 'version-2',
        docId: 'hedit-3',
        commitSha: 'commit-2',
        message: 'Edit title',
        createdAt: 20
      })

      await expect(db.listHtmlEditVersions('hedit-3')).resolves.toMatchObject([
        { id: 'version-2', commitSha: 'commit-2' },
        { id: 'version-1', commitSha: 'commit-1' }
      ])
      await expect(db.getHtmlEditVersion('version-2')).resolves.toMatchObject({
        docId: 'hedit-3',
        message: 'Edit title'
      })
      await expect(db.getHtmlEditDocument('hedit-3')).resolves.toMatchObject({ updatedAt: 20 })
    } finally {
      await db.close()
    }
  })
})
