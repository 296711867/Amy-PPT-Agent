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

describe('generation run repository facade', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rmWithRetry(root)
  })

  async function createDatabase(): Promise<PPTDatabase> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ohmyppt-generation-run-'))
    roots.push(root)
    const db = new PPTDatabase(path.join(root, 'test.db'))
    await db.init()
    await db.createSession({
      id: 'session-run',
      title: 'Run Session',
      provider: 'openai',
      model: 'test-model',
      slideSizeId: 'wide-16-9',
      slideWidth: 1600,
      slideHeight: 900
    })
    return db
  }

  it('creates a run with session job and pages atomically and rejects mismatched ids', async () => {
    const db = await createDatabase()

    try {
      await expect(
        db.createGenerationRunWithSessionJobAndPages({
          run: { id: 'run-1', sessionId: 'session-run', mode: 'generate', totalPages: 2 },
          job: {
            id: 'job-other',
            sessionId: 'session-run',
            kind: 'standard',
            status: 'active',
            previousSessionStatus: 'active'
          },
          pages: []
        })
      ).rejects.toThrow('must share the same id')

      await expect(
        db.createGenerationRunWithSessionJobAndPages({
          run: { id: 'run-1', sessionId: 'session-run', mode: 'generate', totalPages: 2 },
          job: {
            id: 'run-1',
            sessionId: 'session-other',
            kind: 'standard',
            status: 'active',
            previousSessionStatus: 'active'
          },
          pages: []
        })
      ).rejects.toThrow('must belong to the same session')

      await db.createGenerationRunWithSessionJobAndPages({
        run: { id: 'run-1', sessionId: 'session-run', mode: 'generate', totalPages: 2 },
        job: {
          id: 'run-1',
          sessionId: 'session-run',
          kind: 'standard',
          status: 'active',
          previousSessionStatus: 'active',
          totalPages: 3
        },
        pages: [
          {
            pageId: 'page-a',
            pageNumber: 1,
            title: 'Page A',
            status: 'pending'
          },
          {
            pageId: 'page-b',
            pageNumber: 2,
            title: 'Page B',
            status: 'pending'
          }
        ]
      })

      await expect(db.getGenerationRun('run-1')).resolves.toMatchObject({
        id: 'run-1',
        session_id: 'session-run',
        mode: 'generate',
        status: 'running',
        total_pages: 2
      })
      await expect(db.getSessionJob('run-1')).resolves.toMatchObject({
        id: 'run-1',
        kind: 'standard',
        status: 'active',
        total_pages: 3
      })
      await expect(db.listGenerationPages('run-1')).resolves.toHaveLength(2)
    } finally {
      await db.close()
    }
  })

  it('tracks job status transitions and active job listings', async () => {
    const db = await createDatabase()

    try {
      const createJob = (id: string, status: 'pending' | 'active') =>
        db.createGenerationRunWithSessionJob({
          run: { id, sessionId: 'session-run', mode: 'generate', totalPages: 1 },
          job: {
            id,
            sessionId: 'session-run',
            kind: 'style-switch',
            status,
            previousSessionStatus: 'active'
          }
        })

      await createJob('job-pending', 'pending')
      await createJob('job-active', 'active')
      await createJob('job-done', 'active')
      await db.updateSessionJobStatus('job-done', 'finished')
      await db.updateSessionJobStatus('job-active', 'aborted', { abortReason: 'user-cancel' })

      await expect(db.getSessionJob('job-active')).resolves.toMatchObject({
        status: 'aborted',
        abort_reason: 'user-cancel',
        finished_at: expect.any(Number)
      })
      await expect(db.getSessionJob('job-done')).resolves.toMatchObject({
        status: 'finished',
        abort_reason: null
      })

      const activeIds = (await db.listActiveSessionJobs()).map((job) => job.id)
      expect(activeIds).toContain('job-pending')
      expect(activeIds).not.toContain('job-active')
      expect(activeIds).not.toContain('job-done')

      const styleSwitchJobs = await db.listActiveSessionJobs(['style-switch'])
      expect(styleSwitchJobs.map((job) => job.id)).toContain('job-pending')

      await expect(db.getLatestSessionJob('session-run')).resolves.toMatchObject({
        id: 'job-active'
      })
    } finally {
      await db.close()
    }
  })

  it('upserts generation pages and snapshots the latest row per page across runs', async () => {
    const db = await createDatabase()

    try {
      for (const runId of ['run-first', 'run-second']) {
        await db.createGenerationRun({
          id: runId,
          sessionId: 'session-run',
          mode: 'generate',
          totalPages: 2
        })
      }

      await db.upsertGenerationPage({
        runId: 'run-first',
        sessionId: 'session-run',
        pageId: 'page-a',
        pageNumber: 1,
        title: 'Page A old',
        status: 'failed',
        error: 'boom'
      })
      await db.upsertGenerationPage({
        runId: 'run-first',
        sessionId: 'session-run',
        pageId: 'page-a',
        pageNumber: 1,
        title: 'Page A old',
        status: 'failed',
        error: 'boom again',
        retryCount: 1
      })
      await db.upsertGenerationPage({
        runId: 'run-second',
        sessionId: 'session-run',
        pageId: 'page-a',
        pageNumber: 1,
        title: 'Page A new',
        visualFormat: 'chart',
        audienceMove: 'sees metrics → understands the trend',
        status: 'completed'
      })

      const runFirstPages = await db.listGenerationPages('run-first')
      expect(runFirstPages).toHaveLength(1)
      expect(runFirstPages[0]).toMatchObject({
        retry_count: 1,
        error: 'boom again'
      })

      const failed = await db.listLatestFailedGenerationPages('session-run')
      expect(failed).toHaveLength(0)

      const snapshot = await db.listLatestGenerationPageSnapshot('session-run')
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]).toMatchObject({
        title: 'Page A new',
        visual_format: 'chart',
        audience_move: 'sees metrics → understands the trend',
        status: 'completed'
      })

      await db.updateGenerationRunStatus('run-second', 'failed', 'model error')
      await db.upsertGenerationPage({
        runId: 'run-second',
        sessionId: 'session-run',
        pageId: 'page-a',
        pageNumber: 1,
        title: 'Page A new',
        status: 'failed',
        error: 'font-below-floor'
      })
      const failedAfterRetry = await db.listLatestFailedGenerationPages('session-run')
      expect(failedAfterRetry).toHaveLength(1)
      expect(failedAfterRetry[0]).toMatchObject({ error: 'font-below-floor' })

      await db.updateGenerationRunMetadata('run-second', { attempts: 2 })
      await expect(db.getGenerationRun('run-second')).resolves.toMatchObject({
        status: 'failed',
        error: 'model error',
        metadata: '{"attempts":2}'
      })
    } finally {
      await db.close()
    }
  })
})
