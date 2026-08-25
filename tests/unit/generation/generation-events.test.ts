import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock electron-log
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { generationBus } from '../../../src/main/generation/generation-events'
import type { GenerationLifecycleEvents } from '../../../src/main/generation/generation-events'

describe('generationBus', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('delivers events to registered listeners', async () => {
    const received: string[] = []
    const dispose = generationBus.on('generate:after-planning', (event) => {
      received.push(`${event.sessionId}:${event.outline.length} pages`)
    }, 'test-plugin')
    disposers.push(dispose)

    await generationBus.emit('generate:after-planning', {
      sessionId: 'sess-1',
      runId: 'run-1',
      outline: [
        { title: 'Page 1', contentOutline: 'A' },
        { title: 'Page 2', contentOutline: 'B' }
      ],
      totalPages: 2,
      usedSourcePlan: false
    })

    expect(received).toEqual(['sess-1:2 pages'])
  })

  it('supports multiple listeners on the same event', async () => {
    const order: string[] = []
    disposers.push(
      generationBus.on('deck:before-finalize', () => {
        order.push('first')
      }, 'plugin-a')
    )
    disposers.push(
      generationBus.on('deck:before-finalize', () => {
        order.push('second')
      }, 'plugin-b')
    )

    await generationBus.emit('deck:before-finalize', {
      sessionId: 's', runId: 'r', totalPages: 5, completedPages: 4, failedPages: 1
    })

    expect(order).toEqual(['first', 'second'])
  })

  it('listener failure does not block other listeners or the pipeline', async () => {
    const order: string[] = []
    disposers.push(
      generationBus.on('generate:after-design', () => {
        throw new Error('listener crashed')
      }, 'bad-plugin')
    )
    disposers.push(
      generationBus.on('generate:after-design', () => {
        order.push('survived')
      }, 'good-plugin')
    )

    // Should not throw
    await generationBus.emit('generate:after-design', {
      sessionId: 's', runId: 'r',
      designContract: { theme: 'test' } as never
    })

    expect(order).toEqual(['survived'])
  })

  it('dispose stops future delivery', async () => {
    let count = 0
    const dispose = generationBus.on('page:after-generate', () => {
      count += 1
    }, 'temp-plugin')

    await generationBus.emit('page:after-generate', {
      sessionId: 's', runId: 'r', pageId: 'p1', pageNumber: 1,
      title: 'T', htmlPath: '/tmp/p1.html', warnings: []
    })
    expect(count).toBe(1)

    dispose()
    await generationBus.emit('page:after-generate', {
      sessionId: 's', runId: 'r', pageId: 'p1', pageNumber: 1,
      title: 'T', htmlPath: '/tmp/p1.html', warnings: []
    })
    expect(count).toBe(1) // no change after dispose
  })

  it('mutating event data is visible to subsequent listeners', async () => {
    const results: string[] = []
    disposers.push(
      generationBus.on('deck:asset-integrity', (event) => {
        event.violations.push({ pageId: 'p1', pageNumber: 1, assetPath: './missing.png', kind: 'missing' })
      }, 'adder-plugin')
    )
    disposers.push(
      generationBus.on('deck:asset-integrity', (event) => {
        results.push(`violations: ${event.violations.length}`)
      }, 'observer-plugin')
    )

    await generationBus.emit('deck:asset-integrity', {
      sessionId: 's', runId: 'r', violations: [], totalReferences: 10
    })

    expect(results).toEqual(['violations: 1'])
  })

  it('tracks registered plugin names', () => {
    disposers.push(
      generationBus.on('generate:after-planning', () => {}, 'my-plugin')
    )
    expect(generationBus.listPlugins()).toContain('my-plugin')
    expect(generationBus.listenerCount('generate:after-planning')).toBeGreaterThan(0)
  })
})
