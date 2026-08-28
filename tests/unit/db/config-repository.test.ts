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

describe('database config repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  it('round-trips structured settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-settings-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.setSetting('test-options', { enabled: true, retries: 2 })

      await expect(db.getSetting('test-options')).resolves.toEqual({ enabled: true, retries: 2 })
      await expect(db.getAllSettings()).resolves.toMatchObject({
        'test-options': { enabled: true, retries: 2 }
      })
    } finally {
      await db.close()
    }
  })

  it('normalizes model defaults and keeps only the selected model active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-model-configs-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.upsertModelConfig({
        id: 'model-1',
        name: 'First',
        provider: 'openai',
        model: 'gpt-first',
        apiKey: 'key-1',
        baseUrl: '',
        active: true
      })
      await db.upsertModelConfig({
        id: 'model-2',
        name: 'Second',
        provider: 'openai',
        model: 'gpt-second',
        apiKey: 'key-2',
        baseUrl: '',
        thinkingParameterMode: 'invalid-mode'
      })
      await db.setActiveModelConfig('model-2')

      await expect(db.getActiveModelConfig()).resolves.toMatchObject({
        id: 'model-2',
        maxTokens: 4096,
        thinkingParameterMode: 'auto'
      })
      await expect(db.listModelConfigs()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'model-1', active: 0 }),
          expect.objectContaining({ id: 'model-2', active: 1 })
        ])
      )
      await expect(db.setActiveModelConfig('missing')).rejects.toThrow(
        'Model config does not exist'
      )
    } finally {
      await db.close()
    }
  })

  it('switches the active image model without changing its serialized config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-image-model-configs-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.upsertImageModelConfig({
        id: 'image-1',
        name: 'First image model',
        provider: 'seedream',
        modelConfig: '{"model":"first"}',
        active: true
      })
      await db.upsertImageModelConfig({
        id: 'image-2',
        name: 'Second image model',
        provider: 'gemini',
        modelConfig: '{"model":"second"}'
      })
      await db.setActiveImageModelConfig('image-2')

      await expect(db.getActiveImageModelConfig()).resolves.toMatchObject({
        id: 'image-2',
        modelConfig: '{"model":"second"}'
      })
      await expect(db.getImageModelConfig('image-1')).resolves.toMatchObject({ active: 0 })
    } finally {
      await db.close()
    }
  })
})
