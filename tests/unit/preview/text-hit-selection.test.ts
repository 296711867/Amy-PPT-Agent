import path from 'path'
import fs from 'fs'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import {
  EDIT_MODE_CONSOLE_PREFIX,
  buildEditModeInjectScript,
  INSPECTOR_CONSOLE_PREFIX,
  buildInspectorInjectScript
} from '@arcsin1/presentation-editor-runtime'

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>

function setupInlineTextPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <p data-block-id="text">Alpha <span style="color:#FB4526" data-block-id="text-6">red text</span> omega</p>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const paragraph = document.querySelector('[data-block-id="text"]') as HTMLElement
  const redSpan = document.querySelector('[data-block-id="text-6"]') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [paragraph, { left: 100, top: 100, right: 520, bottom: 130, width: 420, height: 30 }],
    [redSpan, { left: 180, top: 100, right: 260, bottom: 130, width: 80, height: 30 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => { startContainer: ChildNode | null }
  }
  mockedDocument.elementFromPoint = () => paragraph
  mockedDocument.elementsFromPoint = () => [paragraph, content, root]
  mockedDocument.caretRangeFromPoint = () => ({ startContainer: redSpan.firstChild })
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, paragraph, logs }
}

function setupOverlappingPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div style="pointer-events:none" data-block-id="top">top visual layer</div>
        <span data-block-id="behind">small behind layer</span>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const top = document.querySelector('[data-block-id="top"]') as HTMLElement
  const behind = document.querySelector('[data-block-id="behind"]') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [top, { left: 100, top: 100, right: 420, bottom: 260, width: 320, height: 160 }],
    [behind, { left: 150, top: 120, right: 180, bottom: 145, width: 30, height: 25 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => behind
  mockedDocument.elementsFromPoint = () =>
    Array.from(document.head.querySelectorAll('style')).some((style) =>
      style.textContent?.includes('pointer-events: auto')
    )
      ? [top, behind, content, root]
      : [behind, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, eventTarget: behind, logs }
}

function setupMixedInlineParagraphPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <p data-block-id="text"><span data-block-id="text-1">南欧</span>（意、西、希）TFR在1.1-1.2区间徘徊超20年</p>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const paragraph = document.querySelector('[data-block-id="text"]') as HTMLElement
  const span = document.querySelector('[data-block-id="text-1"]') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [paragraph, { left: 100, top: 100, right: 520, bottom: 130, width: 420, height: 30 }],
    [span, { left: 100, top: 100, right: 140, bottom: 130, width: 40, height: 30 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => { startContainer: ChildNode | null }
  }
  mockedDocument.elementFromPoint = () => paragraph
  mockedDocument.elementsFromPoint = () => [paragraph, content, root]
  mockedDocument.caretRangeFromPoint = () => ({ startContainer: paragraph.lastChild })
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, paragraph, logs }
}

function setupFormulaPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="formula-card">
          <span class="katex">
            <span class="katex-mathml">
              <math>
                <semantics>
                  <mrow></mrow>
                  <annotation encoding="application/x-tex">x^2</annotation>
                </semantics>
              </math>
            </span>
            <span class="katex-html">x2</span>
          </span>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const card = document.querySelector('[data-block-id="formula-card"]') as HTMLElement
  const formula = document.querySelector('.katex') as HTMLElement
  const formulaHtml = document.querySelector('.katex-html') as HTMLElement
  const annotation = document.querySelector('annotation') as Element
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [card, { left: 100, top: 100, right: 520, bottom: 220, width: 420, height: 120 }],
    [formula, { left: 160, top: 130, right: 300, bottom: 180, width: 140, height: 50 }],
    [formulaHtml, { left: 160, top: 130, right: 300, bottom: 180, width: 140, height: 50 }],
    [annotation, { left: 160, top: 130, right: 300, bottom: 180, width: 140, height: 50 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => formulaHtml
  mockedDocument.elementsFromPoint = () => [formulaHtml, formula, card, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, formula, formulaHtml, logs }
}

function setupAnchoredFormulaPage(script: string) {
  const result = setupFormulaPage(script)
  result.formula.setAttribute('data-block-id', 'formula-1')
  return result
}

function setupFormulaWithoutAnnotationPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <p data-block-id="text">函数 <span class="katex"><span class="katex-html">x2</span></span> 的导数</p>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const paragraph = document.querySelector('[data-block-id="text"]') as HTMLElement
  const formula = document.querySelector('.katex') as HTMLElement
  const formulaHtml = document.querySelector('.katex-html') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [paragraph, { left: 100, top: 100, right: 520, bottom: 130, width: 420, height: 30 }],
    [formula, { left: 160, top: 100, right: 220, bottom: 130, width: 60, height: 30 }],
    [formulaHtml, { left: 160, top: 100, right: 220, bottom: 130, width: 60, height: 30 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => formulaHtml
  mockedDocument.elementsFromPoint = () => [formulaHtml, formula, paragraph, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, formulaHtml, logs }
}

function setupDisplayFormulaPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="formula-card">
          <span class="katex-display">
            <span class="katex">
              <span class="katex-mathml">
                <math>
                  <semantics>
                    <mrow></mrow>
                    <annotation encoding="application/x-tex">x^2</annotation>
                  </semantics>
                </math>
              </span>
              <span class="katex-html">
                <span class="base">x2</span>
              </span>
            </span>
          </span>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const card = document.querySelector('[data-block-id="formula-card"]') as HTMLElement
  const display = document.querySelector('.katex-display') as HTMLElement
  const formula = document.querySelector('.katex') as HTMLElement
  const formulaHtml = document.querySelector('.katex-html') as HTMLElement
  const base = document.querySelector('.base') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [card, { left: 100, top: 100, right: 560, bottom: 260, width: 460, height: 160 }],
    [display, { left: 120, top: 110, right: 520, bottom: 230, width: 400, height: 120 }],
    [formula, { left: 120, top: 110, right: 520, bottom: 230, width: 400, height: 120 }],
    [formulaHtml, { left: 210, top: 145, right: 330, bottom: 185, width: 120, height: 40 }],
    [base, { left: 210, top: 145, right: 330, bottom: 185, width: 120, height: 40 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => display
  mockedDocument.elementsFromPoint = () => [display, card, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, display, formula, formulaHtml, logs }
}

function setupFormulaHostHitPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="formula-card">
          <span data-block-id="formula-label">GAUSSIAN INTEGRAL</span>
          <span class="katex" data-ppt-formula-latex="\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}">
            <span class="katex-mathml">
              <math>
                <semantics>
                  <mrow></mrow>
                  <annotation encoding="application/x-tex">\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}</annotation>
                </semantics>
              </math>
            </span>
            <span class="katex-html">
              <span class="base">integral glyphs</span>
            </span>
          </span>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const card = document.querySelector('[data-block-id="formula-card"]') as HTMLElement
  const label = document.querySelector('[data-block-id="formula-label"]') as HTMLElement
  const formula = document.querySelector('.katex') as HTMLElement
  const formulaHtml = document.querySelector('.katex-html') as HTMLElement
  const base = document.querySelector('.base') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [card, { left: 80, top: 70, right: 750, bottom: 220, width: 670, height: 150 }],
    [label, { left: 82, top: 92, right: 748, bottom: 112, width: 666, height: 20 }],
    [formula, { left: 280, top: 140, right: 540, bottom: 195, width: 260, height: 55 }],
    [formulaHtml, { left: 280, top: 140, right: 540, bottom: 195, width: 260, height: 55 }],
    [base, { left: 280, top: 140, right: 540, bottom: 195, width: 260, height: 55 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => card
  mockedDocument.elementsFromPoint = () => [card, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, card, formula, logs }
}

function setupChartPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="chart-frame" class="ppt-chart-frame">
          <canvas id="chart-canvas"></canvas>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const frame = document.querySelector('[data-block-id="chart-frame"]') as HTMLElement
  const canvas = document.querySelector('#chart-canvas') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [frame, { left: 120, top: 120, right: 420, bottom: 320, width: 300, height: 200 }],
    [canvas, { left: 120, top: 120, right: 420, bottom: 320, width: 300, height: 200 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => canvas
  mockedDocument.elementsFromPoint = () => [canvas, frame, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, frame, canvas, logs }
}

function setupSvgPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="logo" class="logo-host">
          <svg viewBox="0 0 100 100">
            <path d="M10 10 L90 10 L50 90 Z"></path>
          </svg>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const logo = document.querySelector('[data-block-id="logo"]') as HTMLElement
  const svg = document.querySelector('svg') as HTMLElement
  const path = document.querySelector('path') as Element
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [logo, { left: 180, top: 110, right: 340, bottom: 270, width: 160, height: 160 }],
    [svg, { left: 180, top: 110, right: 340, bottom: 270, width: 160, height: 160 }],
    [path, { left: 190, top: 120, right: 330, bottom: 260, width: 140, height: 140 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.SVGElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }
  window.SVGElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => path
  mockedDocument.elementsFromPoint = () => [path as unknown as Element, svg, logo, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, logo, path, logs }
}

function setupGeneratedBackgroundPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="hero">Hero content</div>
        <img data-block-id="bg" data-ppt-generated-background="1" src="./bg.png" alt="">
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const hero = document.querySelector('[data-block-id="hero"]') as HTMLElement
  const background = document.querySelector('[data-ppt-generated-background="1"]') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [hero, { left: 120, top: 120, right: 520, bottom: 280, width: 400, height: 160 }],
    [background, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () =>
    background.style.visibility === 'hidden' ? hero : background
  mockedDocument.elementsFromPoint = () =>
    background.style.visibility === 'hidden'
      ? [hero, content, root]
      : Array.from(document.head.querySelectorAll('style')).some((style) =>
            style.textContent?.includes('pointer-events: auto')
          )
        ? [background, hero, content, root]
        : [background, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, hero, background, logs }
}

function setupOverflowBoxPage(script: string) {
  const window = new Window({ url: 'http://localhost/page.html' }) as unknown as Window & {
    ResizeObserver: typeof ResizeObserver
    eval: (code: string) => void
  }
  const { document } = window
  const logs: string[] = []

  document.body.setAttribute('data-page-id', 'page')
  document.body.innerHTML = `
    <main class="ppt-page-root" data-ppt-guard-root="1">
      <main data-block-id="content" data-role="content">
        <div data-block-id="card">
          <span class="overflow-child">Overflowing child</span>
        </div>
      </main>
    </main>
  `

  const root = document.querySelector('.ppt-page-root') as HTMLElement
  const content = document.querySelector('[data-block-id="content"]') as HTMLElement
  const card = document.querySelector('[data-block-id="card"]') as HTMLElement
  const child = document.querySelector('.overflow-child') as HTMLElement
  const rects = new Map<Element, Rect>([
    [root, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [content, { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
    [card, { left: 180, top: 120, right: 280, bottom: 160, width: 100, height: 40 }],
    [child, { left: 170, top: 110, right: 360, bottom: 210, width: 190, height: 100 }]
  ])

  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }

  const mockedDocument = document as Document & {
    caretRangeFromPoint: () => null
  }
  mockedDocument.elementFromPoint = () => card
  mockedDocument.elementsFromPoint = () => [card, child, content, root]
  mockedDocument.caretRangeFromPoint = () => null
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.console.log = (value?: unknown) => logs.push(String(value))

  window.eval(script)

  return { window, card, logs }
}

function readPayload(logs: string[], prefix: string) {
  const log = logs.findLast((item) => item.startsWith(prefix))
  expect(log).toBeTruthy()
  return JSON.parse(String(log).slice(prefix.length)) as { selector?: string; elementTag?: string }
}

describe('preview text hit selection', () => {
  it('animation-select inspector mode does not freeze motion', () => {
    const script = buildInspectorInjectScript({ mode: 'animation-select' })
    expect(script).toContain('MODE = "animation-select"')
    expect(script).toContain('window.__pptInspectorRestoreSelection')
    expect(script).toContain('shouldFreezeMotion')
  })

  it('preview iframe does not install a click animation bridge', async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/src/components/preview/PreviewIframe.tsx'),
      'utf-8'
    )
    const webviewUtils = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../src/renderer/src/components/presentation-webview/webview-utils.ts'
      ),
      'utf-8'
    )
    expect(source).not.toContain('preview-click-animation')
    expect(webviewUtils).toContain("url.searchParams.set('pptPlayback', '0')")
    expect(webviewUtils).toContain("url.searchParams.set('print', '1')")
  })

  it('inspector selects the inline span under the text caret point', () => {
    const { window, paragraph, logs } = setupInlineTextPage(buildInspectorInjectScript())

    paragraph.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 190,
        clientY: 115
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('span')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="text-6"]')
  })

  it('edit mode selects the inline span under the text caret point', () => {
    const { window, paragraph, logs } = setupInlineTextPage(buildEditModeInjectScript())

    paragraph.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 190,
        clientY: 115,
        pointerId: 1
      })
    )
    paragraph.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 190,
        clientY: 115,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('span')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="text-6"]')
  })

  it('edit mode does not treat a long pointer release as a selection click', () => {
    const { window, paragraph, logs } = setupInlineTextPage(buildEditModeInjectScript())

    paragraph.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 190,
        clientY: 115,
        pointerId: 1
      })
    )
    paragraph.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 240,
        clientY: 115,
        pointerId: 1
      })
    )

    expect(logs.some((item) => item.startsWith(EDIT_MODE_CONSOLE_PREFIX))).toBe(false)
  })

  it('inspector follows the browser hit-test stack before geometry size', () => {
    const { window, eventTarget, logs } = setupOverlappingPage(buildInspectorInjectScript())

    eventTarget.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 160,
        clientY: 130
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="top"]')
  })

  it('edit mode follows the browser hit-test stack before geometry size', () => {
    const { window, eventTarget, logs } = setupOverlappingPage(buildEditModeInjectScript())

    eventTarget.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 160,
        clientY: 130,
        pointerId: 1
      })
    )
    eventTarget.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 160,
        clientY: 130,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="top"]')
  })

  it('edit mode treats mixed inline paragraphs as editable text', () => {
    const { window, paragraph, logs } = setupMixedInlineParagraphPage(buildEditModeInjectScript())

    paragraph.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 115,
        pointerId: 1
      })
    )
    paragraph.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 115,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX) as {
      isText?: boolean
      selector?: string
      text?: string
      html?: string
      textTarget?: {
        parentSelector?: string
        textNodeIndex?: number
        text?: string
      }
    }
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="text"]')
    expect(payload.isText).toBe(true)
    expect(payload.text).toBe('南欧（意、西、希）TFR在1.1-1.2区间徘徊超20年')
    expect(payload.html).toBe(
      '<span data-block-id="text-1">南欧</span>（意、西、希）TFR在1.1-1.2区间徘徊超20年'
    )
    expect(payload.textTarget).toMatchObject({
      parentSelector: 'body[data-page-id="page"] [data-block-id="text"]',
      textNodeIndex: 1,
      text: '（意、西、希）TFR在1.1-1.2区间徘徊超20年'
    })
  })

  it('inspector selects the KaTeX node instead of its formula container', () => {
    const { window, formula, formulaHtml, logs } = setupFormulaPage(buildInspectorInjectScript())

    formulaHtml.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 145
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('span')
    expect(payload.selector).not.toContain('formula-card')
    expect(window.document.querySelector(payload.selector || '')).toBe(formula)
  })

  it('animation-select includes formula metadata for runtime-rendered formulas', () => {
    const { window, formulaHtml, logs } = setupFormulaPage(
      buildInspectorInjectScript({ mode: 'animation-select' })
    )

    formulaHtml.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 145
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX) as {
      mode?: string
      formula?: { latex?: string; html?: string; displayMode?: boolean }
    }
    expect(payload.mode).toBe('animation-select')
    expect(payload.formula).toMatchObject({
      latex: 'x^2',
      displayMode: false
    })
    expect(payload.formula?.html).toContain('class="katex"')
  })

  it('inspector selects the formula when hit testing returns the formula host', () => {
    const { window, card, formula, logs } = setupFormulaHostHitPage(buildInspectorInjectScript())

    card.dispatchEvent(
      new window.MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
        clientY: 166
      })
    )
    card.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
        clientY: 166
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.selector).not.toContain('formula-card')
    expect(window.document.querySelector(payload.selector || '')).toBe(formula)
    const overlay = window.document.getElementById('ppt-inspector-highlight-overlay') as HTMLElement
    expect(overlay.style.left).toBe('276px')
    expect(overlay.style.top).toBe('136px')
    expect(overlay.style.width).toBe('268px')
    expect(overlay.style.height).toBe('63px')
  })

  it('inspector does not steal the formula host when the point is outside formula glyphs', () => {
    const { window, card, formula, logs } = setupFormulaHostHitPage(buildInspectorInjectScript())

    card.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 360,
        clientY: 102
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(window.document.querySelector(payload.selector || '')).toBe(card)
    expect(window.document.querySelector(payload.selector || '')).not.toBe(formula)
  })

  it('inspector selects the chart frame when clicking the canvas', () => {
    const { window, frame, canvas, logs } = setupChartPage(buildInspectorInjectScript())

    canvas.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 180
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('div')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="chart-frame"]')
    expect(window.document.querySelector(payload.selector || '')).toBe(frame)
  })

  it('inspector keeps generated backgrounds from stealing selection', () => {
    const { window, hero, background, logs } = setupGeneratedBackgroundPage(
      buildInspectorInjectScript()
    )

    background.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 180
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="hero"]')
    expect(window.document.querySelector(payload.selector || '')).toBe(hero)
  })

  it('inspector selects the svg owner instead of the nested svg path', () => {
    const { window, logo, path, logs } = setupSvgPage(buildInspectorInjectScript())

    path.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 240,
        clientY: 180
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('div')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="logo"]')
    expect(window.document.querySelector(payload.selector || '')).toBe(logo)
  })

  it('edit mode selects the KaTeX node instead of its formula container', () => {
    const { window, formula, formulaHtml, logs } = setupFormulaPage(buildEditModeInjectScript())

    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 145,
        pointerId: 1
      })
    )
    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 145,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('span')
    expect(payload.selector).not.toContain('formula-card')
    expect(window.document.querySelector(payload.selector || '')).toBe(formula)
    expect(payload.kind).toBe('formula')
    expect(payload.capabilities).toContain('formula')
    expect(payload.snapshot?.formula?.html).toContain('class="katex"')
    expect(payload.snapshot?.formula?.html).not.toContain('arcsin1-presentation-editor-selected')
  })

  it('edit mode selects the formula when hit testing returns the formula host', () => {
    const { window, card, formula, logs } = setupFormulaHostHitPage(buildEditModeInjectScript())

    card.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 360,
        clientY: 166,
        pointerId: 1
      })
    )
    card.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 360,
        clientY: 166,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.selector).not.toContain('formula-card')
    expect(window.document.querySelector(payload.selector || '')).toBe(formula)
    expect(payload.kind).toBe('formula')
    const overlay = window.document.getElementById('arcsin1-presentation-editor-resize-overlay') as HTMLElement
    expect(overlay.style.left).toBe('280px')
    expect(overlay.style.top).toBe('140px')
    expect(overlay.style.width).toBe('260px')
    expect(overlay.style.height).toBe('55px')
  })

  it('edit mode does not steal the formula host when the point is outside formula glyphs', () => {
    const { window, card, formula, logs } = setupFormulaHostHitPage(buildEditModeInjectScript())

    card.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 360,
        clientY: 102,
        pointerId: 1
      })
    )
    card.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 360,
        clientY: 102,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(window.document.querySelector(payload.selector || '')).toBe(card)
    expect(window.document.querySelector(payload.selector || '')).not.toBe(formula)
  })

  it('edit mode selects the chart frame when clicking the canvas', () => {
    const { window, frame, canvas, logs } = setupChartPage(buildEditModeInjectScript())

    canvas.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 200,
        clientY: 180,
        pointerId: 1
      })
    )
    canvas.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 200,
        clientY: 180,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('div')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="chart-frame"]')
    expect(window.document.querySelector(payload.selector || '')).toBe(frame)
  })

  it('edit mode selects the svg owner instead of the nested svg path', () => {
    const { window, logo, path, logs } = setupSvgPage(buildEditModeInjectScript())

    path.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 240,
        clientY: 180,
        pointerId: 1
      })
    )
    path.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 240,
        clientY: 180,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.elementTag).toBe('div')
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="logo"]')
    expect(window.document.querySelector(payload.selector || '')).toBe(logo)
  })

  it('keeps the formula block id after live formula replacement', () => {
    const { window, formulaHtml, logs } = setupAnchoredFormulaPage(buildEditModeInjectScript())

    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 145,
        pointerId: 1
      })
    )
    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 145,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX)
    expect(payload.selector).toBe('body[data-page-id="page"] [data-block-id="formula-1"]')

    ;(
      window as Window & {
        __pptEditModeLiveUpdate: (
          selector: string,
          patch: { formula: { latex: string; html: string; displayMode: boolean } }
        ) => void
      }
    ).__pptEditModeLiveUpdate(payload.selector, {
      formula: {
        latex: 'x^3',
        html: '<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">x^3</annotation></semantics></math></span><span class="katex-html">x3</span></span>',
        displayMode: false
      }
    })

    const updatedFormula = window.document.querySelector(
      'body[data-page-id="page"] [data-block-id="formula-1"]'
    )
    expect(updatedFormula).toBeTruthy()
    expect(updatedFormula?.classList.contains('katex')).toBe(true)
    expect(updatedFormula?.getAttribute('data-ppt-formula-latex')).toBe('x^3')
  })

  it('does not treat surrounding text as latex when KaTeX has no annotation', () => {
    const { window, formulaHtml, logs } = setupFormulaWithoutAnnotationPage(
      buildEditModeInjectScript()
    )

    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 115,
        pointerId: 1
      })
    )
    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 180,
        clientY: 115,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX) as {
      snapshot?: { formula?: { latex?: string } }
    }
    expect(payload.snapshot?.formula).toBeUndefined()
  })

  it('edit mode overlay uses tight KaTeX bounds instead of the inflated wrapper box', () => {
    const { window, formulaHtml } = setupDisplayFormulaPage(buildEditModeInjectScript())

    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 240,
        clientY: 160,
        pointerId: 1
      })
    )
    formulaHtml.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 240,
        clientY: 160,
        pointerId: 1
      })
    )

    const overlay = window.document.getElementById('arcsin1-presentation-editor-resize-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.style.left).toBe('210px')
    expect(overlay.style.top).toBe('145px')
    expect(overlay.style.width).toBe('120px')
    expect(overlay.style.height).toBe('40px')
  })

  it('inspector overlay keeps display formulas aligned to the rendered glyph bounds', () => {
    const { window, formulaHtml, logs } = setupDisplayFormulaPage(buildInspectorInjectScript())

    formulaHtml.dispatchEvent(
      new window.MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 240,
        clientY: 160
      })
    )
    formulaHtml.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 240,
        clientY: 160
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX)
    expect(payload.selector).not.toContain('formula-card')
    const overlay = window.document.getElementById('ppt-inspector-highlight-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.style.left).toBe('206px')
    expect(overlay.style.top).toBe('141px')
    expect(overlay.style.width).toBe('128px')
    expect(overlay.style.height).toBe('48px')
  })

  it('edit mode keeps non-formula overlays aligned to the selected element box', () => {
    const { window, card, logs } = setupOverflowBoxPage(buildEditModeInjectScript())

    card.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 220,
        clientY: 140,
        pointerId: 1
      })
    )
    card.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 220,
        clientY: 140,
        pointerId: 1
      })
    )

    const payload = readPayload(logs, EDIT_MODE_CONSOLE_PREFIX) as {
      viewportBounds?: { width?: number; height?: number }
    }
    expect(payload.viewportBounds).toMatchObject({ width: 100, height: 40 })
    const overlay = window.document.getElementById('arcsin1-presentation-editor-resize-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.style.left).toBe('180px')
    expect(overlay.style.top).toBe('120px')
    expect(overlay.style.width).toBe('100px')
    expect(overlay.style.height).toBe('40px')
  })

  it('inspector keeps non-formula highlights aligned to the selected element box', () => {
    const { window, card, logs } = setupOverflowBoxPage(buildInspectorInjectScript())

    card.dispatchEvent(
      new window.MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 140
      })
    )
    card.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 140
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX) as {
      bounds?: { width?: number; height?: number }
    }
    expect(payload.bounds).toMatchObject({ width: 100, height: 40 })
    const overlay = window.document.getElementById('ppt-inspector-highlight-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.style.left).toBe('176px')
    expect(overlay.style.top).toBe('116px')
    expect(overlay.style.width).toBe('108px')
    expect(overlay.style.height).toBe('48px')
  })

  it('inspector keeps the selected highlight after hover moves away', () => {
    const { window, card, logs } = setupOverflowBoxPage(buildInspectorInjectScript())

    card.dispatchEvent(
      new window.MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 140
      })
    )
    card.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 140
      })
    )

    const payload = readPayload(logs, INSPECTOR_CONSOLE_PREFIX) as {
      bounds?: { width?: number; height?: number }
    }
    expect(payload.bounds).toMatchObject({ width: 100, height: 40 })

    const overlay = window.document.getElementById('ppt-inspector-highlight-overlay') as HTMLElement
    expect(overlay).toBeTruthy()
    expect(overlay.style.left).toBe('176px')
    expect(overlay.style.top).toBe('116px')
    expect(overlay.style.width).toBe('108px')
    expect(overlay.style.height).toBe('48px')

    const mockedDocument = window.document as Document & {
      elementFromPoint: () => Element | null
      elementsFromPoint: () => Element[]
    }
    mockedDocument.elementFromPoint = () => null
    mockedDocument.elementsFromPoint = () => []

    card.dispatchEvent(
      new window.MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 12
      })
    )

    expect(overlay.style.left).toBe('176px')
    expect(overlay.style.top).toBe('116px')
    expect(overlay.style.width).toBe('108px')
    expect(overlay.style.height).toBe('48px')
  })
})
