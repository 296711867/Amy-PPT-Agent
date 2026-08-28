import fs from 'node:fs'
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

describe('session AI style snapshot persistence', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  it('creates a custom snapshot without consulting the style catalog and preserves metadata', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ohmyppt-ai-style-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      const sessionId = await db.createSession({
        title: 'PPT: Custom style',
        topic: 'Custom style',
        styleId: 'ai-session-1',
        styleSnapshot: {
          styleId: 'ai-session-1',
          styleKey: 'ai-generated-session',
          styleName: 'AI-generated style',
          styleNameZh: 'AI 自定义风格',
          styleNameEn: 'AI-generated style',
          description: 'calm industrial editorial',
          source: 'custom',
          styleSkill: 'derive typography, palette, shape language, and composition from the prompt'
        },
        pageCount: 3,
        slideSizeId: 'wide-16-9',
        slideWidth: 1600,
        slideHeight: 900,
        provider: 'test',
        model: 'test-model'
      })
      await db.updateSessionMetadata(sessionId, {
        styleSelection: {
          mode: 'ai',
          description: 'calm industrial editorial',
          themeColors: ['#102030']
        }
      })
      await db.updateSessionMetadata(sessionId, { imagePolicy: 'placeholder' })

      await expect(db.getSessionStyleSnapshot(sessionId)).resolves.toMatchObject({
        styleId: 'ai-session-1',
        source: 'custom',
        styleSkill: expect.stringContaining('shape language')
      })
      const session = await db.getSession(sessionId)
      expect(JSON.parse(session?.metadata || '{}')).toMatchObject({
        styleSelection: {
          mode: 'ai',
          description: 'calm industrial editorial',
          themeColors: ['#102030']
        },
        imagePolicy: 'placeholder'
      })
    } finally {
      await db.close()
    }
  })

  it('reconstructs a missing AI snapshot from the persisted selection', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ohmyppt-ai-style-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      const sessionId = await db.createSession({
        title: 'PPT: Rehydrate style',
        topic: 'Rehydrate style',
        pageCount: 1,
        slideSizeId: 'wide-16-9',
        slideWidth: 1600,
        slideHeight: 900,
        provider: 'test',
        model: 'test-model'
      })
      await db.updateSessionMetadata(sessionId, {
        styleSelection: {
          mode: 'ai',
          description: 'warm technical atlas',
          themeColors: ['#A23E48', '#F0EBD8']
        }
      })
      await db.restoreSessionStyleState(sessionId, null)
      await db.backfillSessionStyleSnapshots()

      const snapshot = await db.getOrCreateSessionStyleSnapshot(sessionId)
      expect(snapshot).toMatchObject({
        styleId: `ai-${sessionId}`,
        source: 'custom',
        description: 'warm technical atlas'
      })
      expect(snapshot.styleSkill).toContain('#A23E48, #F0EBD8')
      await expect(db.getSession(sessionId)).resolves.toMatchObject({ styleId: `ai-${sessionId}` })
    } finally {
      await db.close()
    }
  })

  it('copies a custom snapshot over the target session snapshot', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ohmyppt-ai-style-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      const common = {
        pageCount: 1,
        slideSizeId: 'wide-16-9' as const,
        slideWidth: 1600,
        slideHeight: 900,
        provider: 'test',
        model: 'test-model'
      }
      const sourceSessionId = await db.createSession({
        ...common,
        title: 'Source',
        styleId: 'ai-copy-source',
        styleSnapshot: {
          styleId: 'ai-copy-source',
          styleKey: 'ai-copy-style',
          styleName: 'Copied AI style',
          description: 'high contrast technical field guide',
          aliases: '["technical","contrast"]',
          source: 'custom',
          version: '2.3',
          styleSkill: 'preserve the custom technical field-guide language'
        }
      })
      const targetSessionId = await db.createSession({
        ...common,
        title: 'Target'
      })

      await db.copySessionStyleSnapshot(sourceSessionId, targetSessionId)

      await expect(db.getSessionStyleSnapshot(targetSessionId)).resolves.toMatchObject({
        sessionId: targetSessionId,
        styleId: 'ai-copy-source',
        styleKey: 'ai-copy-style',
        description: 'high contrast technical field guide',
        aliases: '["technical","contrast"]',
        source: 'custom',
        version: '2.3.0',
        styleSkill: 'preserve the custom technical field-guide language'
      })
    } finally {
      await db.close()
    }
  })
})
