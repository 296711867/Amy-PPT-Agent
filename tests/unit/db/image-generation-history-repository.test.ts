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

describe('image generation history repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  it('serializes image paths and lists only the requested page in newest-first order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-image-history-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      const base = {
        sessionId: 'session-1',
        pageId: 'page-1',
        modelConfigId: 'image-model-1',
        provider: 'seedream',
        model: 'seedream-4'
      }
      await db.insertImageGenerationHistory({
        ...base,
        id: 'history-1',
        prompt: 'first image',
        imagePaths: ['images/first.png'],
        createdAt: 10
      })
      await db.insertImageGenerationHistory({
        ...base,
        id: 'history-2',
        prompt: 'second image',
        imagePaths: ['images/second.png', 'images/second-alt.png'],
        createdAt: 20
      })
      await db.insertImageGenerationHistory({
        ...base,
        id: 'other-page-history',
        pageId: 'page-2',
        prompt: 'other page',
        imagePaths: ['images/other.png'],
        createdAt: 30
      })

      await expect(db.listImageGenerationHistories('session-1', 'page-1')).resolves.toEqual([
        expect.objectContaining({
          id: 'history-2',
          imagePaths: '["images/second.png","images/second-alt.png"]'
        }),
        expect.objectContaining({
          id: 'history-1',
          imagePaths: '["images/first.png"]'
        })
      ])
      await expect(db.listImageGenerationHistories('session-2', 'page-1')).resolves.toEqual([])
    } finally {
      await db.close()
    }
  })
})
