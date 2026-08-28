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

describe('user preference repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  it('merges source sessions, updates values, and caps accumulated confidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-preferences-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.upsertPreference('visual-style', {
        value: { style: 'minimal' },
        confidence: 0.8,
        sourceSessions: ['session-1']
      })
      await db.upsertPreference('visual-style', {
        value: { style: 'editorial' },
        confidence: 0.8,
        sourceSessions: ['session-1', 'session-2']
      })

      await expect(db.getActiveUserPreferences()).resolves.toEqual([
        expect.objectContaining({
          key: 'visual-style',
          value: { style: 'editorial' },
          confidence: 1,
          source_sessions: ['session-1', 'session-2']
        })
      ])
    } finally {
      await db.close()
    }
  })

  it('decays active preferences and removes preferences at the cleanup threshold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-preferences-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.upsertPreference('kept', { value: 'yes', confidence: 0.8 })
      await db.upsertPreference('removed', { value: 'no', confidence: 0.1 })

      await db.decayPreferences()
      await db.upsertPreference('removed', { value: 'recreated' })

      await expect(db.getActiveUserPreferences()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'kept', confidence: 0.76 }),
          expect.objectContaining({ key: 'removed', value: 'recreated', confidence: 0.5 })
        ])
      )
    } finally {
      await db.close()
    }
  })
})
