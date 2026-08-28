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

describe('project repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  it('creates a draft project and defaults its root path to the output path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-project-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      const projectId = await db.createProject({
        session_id: 'session-1',
        title: 'Demo',
        output_path: path.join(root, 'output')
      })

      await expect(db.getProject('session-1')).resolves.toMatchObject({
        id: projectId,
        title: 'Demo',
        output_path: path.join(root, 'output'),
        root_path: path.join(root, 'output'),
        file_count: 0,
        total_size: 0,
        status: 'draft'
      })
    } finally {
      await db.close()
    }
  })

  it('updates project status and keeps the project title synchronized with its session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-project-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()

    try {
      await db.createSession({
        id: 'session-2',
        title: 'Before',
        provider: 'openai',
        model: 'test-model',
        slideSizeId: 'wide-16-9',
        slideWidth: 1600,
        slideHeight: 900
      })
      const projectId = await db.createProject({
        session_id: 'session-2',
        title: 'Before',
        output_path: path.join(root, 'output'),
        root_path: path.join(root, 'workspace')
      })

      await db.updateProjectStatus(projectId, 'exported')
      await db.updateSessionTitle('session-2', 'After')

      await expect(db.getProject('session-2')).resolves.toMatchObject({
        title: 'After',
        root_path: path.join(root, 'workspace'),
        status: 'exported'
      })
      await expect(db.getSession('session-2')).resolves.toMatchObject({ title: 'After' })
    } finally {
      await db.close()
    }
  })
})
