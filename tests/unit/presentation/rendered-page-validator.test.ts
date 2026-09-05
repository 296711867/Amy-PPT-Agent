import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isReady: () => false },
  BrowserWindow: class BrowserWindow {}
}))

import {
  classifyRenderedPageSnapshot,
  type RenderedPageSnapshot
} from '../../../src/main/presentation/html/rendered-page-validator'

const snapshot = (overrides: Partial<RenderedPageSnapshot> = {}): RenderedPageSnapshot => ({
  scale: 1,
  canvas: { x: 0, y: 0, width: 1600, height: 900 },
  texts: [],
  ...overrides
})

describe('rendered page validator', () => {
  it('accepts a readable layout and tolerates minor fit scaling', () => {
    const violations = classifyRenderedPageSnapshot(
      snapshot({
        scale: 0.95,
        texts: [
          {
            id: 'title',
            groupId: 'title',
            text: 'Quarterly review',
            rect: { x: 100, y: 80, width: 460, height: 64 },
            clipped: false
          },
          {
            id: 'body',
            groupId: 'body',
            text: 'Growth is on track across all regions.',
            rect: { x: 100, y: 190, width: 620, height: 34 },
            clipped: false
          }
        ]
      })
    )

    expect(violations).toEqual([])
  })

  it('reports excessive fit scaling, canvas overflow, and clipped text', () => {
    const violations = classifyRenderedPageSnapshot(
      snapshot({
        scale: 0.84,
        texts: [
          {
            id: 'outside',
            groupId: 'outside',
            text: 'This conclusion falls outside the slide',
            rect: { x: 1510, y: 820, width: 180, height: 50 },
            clipped: false
          },
          {
            id: 'clipped',
            groupId: 'clipped',
            text: 'This paragraph is clipped by its container',
            rect: { x: 120, y: 260, width: 420, height: 76 },
            clipped: true
          }
        ]
      })
    )

    expect(violations.map((violation) => violation.code)).toEqual([
      'render-scale-too-small',
      'render-text-outside-canvas',
      'render-text-clipped'
    ])
  })

  it('reports substantial overlap but ignores same-element and incidental overlap', () => {
    const violations = classifyRenderedPageSnapshot(
      snapshot({
        texts: [
          {
            id: 'left',
            groupId: 'left',
            text: 'First independent text box',
            rect: { x: 100, y: 100, width: 300, height: 80 },
            clipped: false
          },
          {
            id: 'right',
            groupId: 'right',
            text: 'Second independent text box',
            rect: { x: 220, y: 120, width: 300, height: 80 },
            clipped: false
          },
          {
            id: 'same-parent-line-one',
            groupId: 'same-parent',
            text: 'Wrapped line one',
            rect: { x: 700, y: 100, width: 220, height: 28 },
            clipped: false
          },
          {
            id: 'same-parent-line-two',
            groupId: 'same-parent',
            text: 'Wrapped line two',
            rect: { x: 700, y: 120, width: 220, height: 28 },
            clipped: false
          },
          {
            id: 'incidental',
            groupId: 'incidental',
            text: 'Only touches an edge',
            rect: { x: 398, y: 100, width: 180, height: 80 },
            clipped: false
          }
        ]
      })
    )

    expect(violations).toEqual([
      expect.objectContaining({ code: 'render-text-overlap', severity: 'error' })
    ])
  })
})

describe('render validation timeout resilience (source contract)', () => {
  it('raises the per-step timeout and retries once on timeout with a fresh window', () => {
    const fs = require('fs')
    const source = fs.readFileSync('src/main/presentation/html/rendered-page-validator.ts', 'utf8')

    // 实测事故：高负载机器上 10s 冷启动超时导致整套 6/6 页被误判失败。
    expect(source).toContain('VALIDATION_TIMEOUT_MS = 25_000')
    expect(source).toContain('VALIDATION_TIMEOUT_ATTEMPTS = 2')
    expect(source).toContain("error.message.includes('render validation timeout')")
    expect(source).toContain('retrying once')
    expect(source).toContain('RENDER_TIMEOUT_COOLDOWN_MS = 60 * 60_000')
    expect(source).toContain('rendered page validation skipped during timeout cooldown')
  })

  it('keeps a 48px floor on bare h1 title elements in the runtime shell', () => {
    const fs = require('fs')
    const source = fs.readFileSync('src/main/presentation/html/page-shell.ts', 'utf8')

    // 裸 <h1 data-role="title">（元素自身带角色而非容器）此前命中不了
    // [data-role="title"] h1 选择器，标题会缩到正文级。
    expect(source).toContain('h1[data-role="title"]')
    expect(source).toContain('h1[data-block-id="title"]')
  })
})
