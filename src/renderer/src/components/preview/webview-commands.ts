/** PreviewIframe 的 webview 命令层：句柄类型、页面审计脚本与全部 imperative 命令。 */
import { nanoid } from 'nanoid'
import type {
  EditableElementSnapshot,
  EditSnapPoints,
  EditSnapSettings,
  EditTextTarget,
  PresentationEditorOperation,
  PresentationEditorOperationResult,
  PresentationElementSnapshot
} from '@arcsin1/presentation-editor-runtime'
import type { EditModeLayoutIsland } from '@renderer/lib/presentation-layout-island'
import { normalizeEditModeLayoutIsland } from '@renderer/lib/presentation-layout-island'
import type { InsertChartSeries } from '../session-detail/workspace/insert-charts'

export const PAGE_LAYOUT_AUDIT_SCRIPT = `
(() => {
  const root = document.querySelector('.ppt-page-root[data-ppt-guard-root="1"]') || document.querySelector('.ppt-page-root');
  const content = root && (root.querySelector(':scope > .ppt-page-fit-scope > .ppt-page-content') || root.querySelector('.ppt-page-content'));
  if (!(root instanceof HTMLElement) || !(content instanceof HTMLElement)) return '';

  const rootRect = root.getBoundingClientRect();
  if (rootRect.width <= 0 || rootRect.height <= 0) return '';
  const round = (value) => Math.round(value);
  const compact = (value, limit) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  const isVisible = (element, rect) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 2 && rect.height > 2;
  };
  const directText = (element) => Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || '')
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
  const describe = (element) => {
    const classes = String(element.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    const text = compact(directText(element) || element.getAttribute('aria-label') || '', 42);
    return '<' + element.tagName.toLowerCase() + (classes ? '.' + classes : '') + '>' + (text ? ' “' + text + '”' : '');
  };
  const rectInCanvas = (rect) => ({
    x: round(rect.left - rootRect.left),
    y: round(rect.top - rootRect.top),
    width: round(rect.width),
    height: round(rect.height)
  });
  const elements = Array.from(content.querySelectorAll('*')).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    return isVisible(element, element.getBoundingClientRect());
  });
  const issues = [];
  const seen = new Set();
  const addIssue = (kind, element, detail) => {
    const key = kind + ':' + detail;
    if (seen.has(key) || issues.length >= 12) return;
    seen.add(key);
    issues.push('[' + kind + '] ' + describe(element) + ': ' + detail);
  };
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const text = directText(element);
    const isLeafText = Boolean(text) && element.children.length === 0;
    const isMedia = /^(CANVAS|IMG|VIDEO|SVG)$/.test(element.tagName);
    if (isLeafText || isMedia) {
      const overflowLeft = rootRect.left - rect.left;
      const overflowTop = rootRect.top - rect.top;
      const overflowRight = rect.right - rootRect.right;
      const overflowBottom = rect.bottom - rootRect.bottom;
      const overflow = Math.max(overflowLeft, overflowTop, overflowRight, overflowBottom);
      if (overflow > 2) {
        addIssue('canvas-overflow', element, 'extends ' + round(overflow) + 'px beyond the canvas at ' + JSON.stringify(rectInCanvas(rect)));
      }
    }
    if (isLeafText && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)) {
      const horizontal = Math.max(0, element.scrollWidth - element.clientWidth);
      const vertical = Math.max(0, element.scrollHeight - element.clientHeight);
      addIssue('text-overflow', element, 'text needs ' + horizontal + 'px more width and ' + vertical + 'px more height');
    }
    const style = getComputedStyle(element);
    const clipsX = style.overflowX !== 'visible';
    const clipsY = style.overflowY !== 'visible';
    if ((clipsX && element.scrollWidth > element.clientWidth + 2) || (clipsY && element.scrollHeight > element.clientHeight + 2)) {
      const horizontal = Math.max(0, element.scrollWidth - element.clientWidth);
      const vertical = Math.max(0, element.scrollHeight - element.clientHeight);
      addIssue('scroll-overflow', element, 'clipped container has ' + horizontal + 'px horizontal and ' + vertical + 'px vertical overflow');
    }
  }
  const regions = elements
    .filter((element) => {
      const style = getComputedStyle(element);
      return /^(HEADER|FOOTER|SECTION|MAIN|ARTICLE|ASIDE)$/.test(element.tagName) || (element.children.length >= 2 && (style.display === 'grid' || style.display === 'flex'));
    })
    .slice(0, 10)
    .map((element) => {
      const rect = rectInCanvas(element.getBoundingClientRect());
      return describe(element) + ' at x=' + rect.x + ', y=' + rect.y + ', w=' + rect.width + ', h=' + rect.height;
    });
  return [
    'Canvas: ' + round(rootRect.width) + 'px x ' + round(rootRect.height) + 'px.',
    regions.length ? 'Key regions:' : '',
    ...regions.map((region) => '- ' + region),
    issues.length ? 'Measured defects:' : 'Measured defects: none.',
    ...issues.map((issue) => '- ' + issue)
  ].filter(Boolean).join('\\n');
})()
`

export interface PreviewIframeHandle {
  reloadIgnoringCache: () => void
  patchPageContent: (pageId: string, newHtml: string) => void
  liveUpdateElement: (
    selector: string,
    patch: {
      html?: string
      text?: string
      textTarget?: EditTextTarget
      formula?: {
        latex: string
        html: string
        displayMode: boolean
        originalLatex?: string
      }
      chart?: {
        type: string
        title: string
        labels: string[]
        values: number[]
        series: InsertChartSeries[]
        primaryColor: string
        accentColor: string
        textColor: string
        smooth: boolean
        horizontal: boolean
        stacked: boolean
        areaFill: boolean
        showPoints: boolean
        showLegend: boolean
        doughnutCutout: number
        radarFill: boolean
        configJson: string
      }
      style?: { color?: string; fontSize?: string; fontWeight?: string; textAlign?: string }
    }
  ) => void
  applyElementProperties: (
    selector: string,
    patch: {
      style?: {
        zIndex?: number
        opacity?: number
        backgroundColor?: string
        color?: string
        fontSize?: string
        fontWeight?: string
        textAlign?: string
        objectFit?: string
      }
      attrs?: {
        alt?: string
        poster?: string
        controls?: boolean
        muted?: boolean
        loop?: boolean
        autoplay?: boolean
        playsInline?: boolean
        preload?: string
      }
    }
  ) => void
  setElementLayout: (
    selector: string,
    layout: { x?: number; y?: number; width?: number; height?: number }
  ) => void
  restoreEditModeSelection: (selector: string) => Promise<boolean>
  restoreInspectorSelection: (selector: string) => Promise<boolean>
  clearEditModeSelection: () => void
  hideElement: (selector: string) => void
  showElement: (selector: string) => void
  applyDragStyle: (
    selector: string,
    style: {
      x: number
      y: number
      width?: number
      height?: number
      isAbsoluteMode?: boolean
    }
  ) => void
  applyLayoutIsland: (layoutIsland: EditModeLayoutIsland) => void
  applyZIndex: (selector: string, zIndex: number) => void
  copyElement: (
    selector: string,
    newBlockId: string
  ) => Promise<{ selector: string; htmlFragment: string } | null>
  readElementHtml: (selector: string) => Promise<string>
  readElementSnapshot: (selector: string) => Promise<EditableElementSnapshot | null>
  inspectElement: (selector: string) => Promise<PresentationElementSnapshot | null>
  applyElementOperations: (
    selector: string,
    operations: PresentationEditorOperation[]
  ) => Promise<PresentationEditorOperationResult[]>
  readElementLayout: (
    selector: string
  ) => Promise<{
    isAbsoluteMode: boolean
    x: number
    y: number
    width: number
    height: number
    visualX?: number
    visualY?: number
    layoutIsland?: EditModeLayoutIsland
  } | null>
  applyChildUpdates: (
    selector: string,
    childUpdates: Array<{ path: number[]; width?: number; height?: number }>
  ) => void
  injectElement: (
    parentSelector: string,
    htmlFragment: string,
    insertIndex?: number,
    selectAfterInsert?: boolean
  ) => void
  setEditSnapSettings: (settings: EditSnapSettings) => Promise<boolean>
  readEditSnapPoints: () => Promise<EditSnapPoints>
  readPageLayoutAudit: () => Promise<string | null>
}

export type WebviewCommandRuntime = {
  webviewRef: { current: Electron.WebviewTag | null }
  canExecuteJavaScript: (webview: Electron.WebviewTag) => boolean
  safeExecuteJavaScript: (webview: Electron.WebviewTag, script: string) => void
}

export const inspectPresentationElement = async (
  webview: Electron.WebviewTag,
  selector: string,
  canExecuteJavaScript: WebviewCommandRuntime['canExecuteJavaScript']
): Promise<PresentationElementSnapshot | null> => {
  if (!canExecuteJavaScript(webview)) return null
  try {
    const result = await webview.executeJavaScript(
      `(function(){` +
        `var __el = document.querySelector(${JSON.stringify(selector)});` +
        `if (!__el) return null;` +
        `if (window.__pptEditModeInspectElement) return window.__pptEditModeInspectElement(${JSON.stringify(selector)});` +
        `return window.__pptPresentationEditorRuntime ? window.__pptPresentationEditorRuntime.inspect(__el) : null;` +
      `})()`
    )
    return (result as PresentationElementSnapshot | null) || null
  } catch {
    return null
  }
}

export const createWebviewCommands = (runtime: WebviewCommandRuntime) => {
  const { webviewRef, canExecuteJavaScript, safeExecuteJavaScript } = runtime

  return {
    patchPageContent(targetPageId: string, newHtml: string): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `
        var section = document.querySelector('[data-page-id="${targetPageId}"]');
        if (section) {
          section.innerHTML = ${JSON.stringify(newHtml)};
        } else {
          document.body.innerHTML = ${JSON.stringify(newHtml)};
        }
      `
      )
    },
    liveUpdateElement(
      selector: string,
      patch: {
        html?: string
        text?: string
        textTarget?: EditTextTarget
        formula?: {
          latex: string
          html: string
          displayMode: boolean
          originalLatex?: string
        }
        chart?: {
          type: string
          title: string
          labels: string[]
          values: number[]
          series: InsertChartSeries[]
          primaryColor: string
          accentColor: string
          textColor: string
          smooth: boolean
          horizontal: boolean
          stacked: boolean
          areaFill: boolean
          showPoints: boolean
          showLegend: boolean
          doughnutCutout: number
          radarFill: boolean
          configJson: string
        }
        style?: { color?: string; fontSize?: string; fontWeight?: string; textAlign?: string }
        zIndex?: number
      }
    ): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `if (window.__pptEditModeLiveUpdate) window.__pptEditModeLiveUpdate(${JSON.stringify(selector)}, ${JSON.stringify(patch)});`
      )
    },
    applyElementProperties(
      selector: string,
      patch: {
        style?: {
          zIndex?: number
          opacity?: number
          backgroundColor?: string
          color?: string
          fontSize?: string
          fontWeight?: string
          textAlign?: string
          objectFit?: string
        }
        attrs?: {
          alt?: string
          poster?: string
          controls?: boolean
          muted?: boolean
          loop?: boolean
          autoplay?: boolean
          playsInline?: boolean
          preload?: string
        }
      }
    ): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `if (window.__pptEditModeApplyProperties) window.__pptEditModeApplyProperties(${JSON.stringify(selector)}, ${JSON.stringify(patch)});`
      )
    },
    setElementLayout(
      selector: string,
      layout: { x?: number; y?: number; width?: number; height?: number }
    ): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `if (window.__pptEditModeSetLayout) window.__pptEditModeSetLayout(${JSON.stringify(selector)}, ${JSON.stringify(layout)});`
      )
    },
    async setEditSnapSettings(settings: EditSnapSettings): Promise<boolean> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return false
      try {
        return Boolean(
          await wv.executeJavaScript(
            `(function(){` +
              `if (!window.__pptEditModeSetSnapSettings) return false;` +
              `window.__pptEditModeSetSnapSettings(${JSON.stringify(settings)});` +
              `return true;` +
            `})()`
          )
        )
      } catch {
        return false
      }
    },
    async readEditSnapPoints(): Promise<EditSnapPoints> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return { x: [], y: [] }
      try {
        const result = (await wv.executeJavaScript(
          `(function(){` +
            `try {` +
              `return window.__pptEditModeReadSnapPoints ? window.__pptEditModeReadSnapPoints() : { x: [], y: [] };` +
            `} catch (_error) { return { x: [], y: [] }; }` +
          `})()`
        )) as Partial<EditSnapPoints> | null
        return {
          x: Array.isArray(result?.x) ? result.x.filter(Number.isFinite) : [],
          y: Array.isArray(result?.y) ? result.y.filter(Number.isFinite) : []
        }
      } catch {
        return { x: [], y: [] }
      }
    },
    async readPageLayoutAudit(): Promise<string | null> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return null
      try {
        const report = await wv.executeJavaScript(PAGE_LAYOUT_AUDIT_SCRIPT)
        if (typeof report !== 'string') return null
        const normalized = report.trim().slice(0, 6000)
        return normalized || null
      } catch {
        return null
      }
    },
    async restoreEditModeSelection(selector: string): Promise<boolean> {
      const wv = webviewRef.current
      if (!wv) return false
      try {
        const result = await wv.executeJavaScript(
          `(function() {
            try {
              if (window.__pptEditModeRestoreSelection) {
                return window.__pptEditModeRestoreSelection(${JSON.stringify(selector)});
              }
              return false;
            } catch (e) {
              console.debug("[EditMode] restore script error", e);
              return false;
            }
          })()`
        )
        return Boolean(result)
      } catch {
        return false
      }
    },
    async restoreInspectorSelection(selector: string): Promise<boolean> {
      const wv = webviewRef.current
      if (!wv) return false
      try {
        const result = await wv.executeJavaScript(
          `(function() {
            try {
              if (window.__pptInspectorRestoreSelection) {
                return window.__pptInspectorRestoreSelection(${JSON.stringify(selector)});
              }
              return false;
            } catch (e) {
              console.debug("[Inspector] restore selection error", e);
              return false;
            }
          })()`
        )
        return Boolean(result)
      } catch {
        return false
      }
    },
    clearEditModeSelection(): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `if (window.__pptEditModeClearSelection) window.__pptEditModeClearSelection();`
      )
    },
    hideElement(selector: string): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `(function(){` +
          `var __el = document.querySelector(${JSON.stringify(selector)});` +
          `if (!__el) return;` +
          `__el.setAttribute('data-ppt-pending-delete', '1');` +
          `if (__el.hasAttribute && __el.hasAttribute('data-ppt-art-text')) {` +
          `  var __blockId = __el.getAttribute('data-block-id') || '';` +
          `  var __style = __blockId ? Array.from(document.querySelectorAll('style[data-ppt-art-text-style]')).find(function(s){ return s.getAttribute('data-ppt-art-text-style') === __blockId; }) : null;` +
          `  if (__style) { __style.setAttribute('data-ppt-pending-delete', '1'); __style.disabled = true; }` +
          `}` +
          `if (__el.tagName === 'STYLE') { __el.disabled = true; return; }` +
          `__el.style.setProperty('display', 'none', 'important');` +
        `})()`
      )
    },
    showElement(selector: string): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `(function(){` +
          `var __el = document.querySelector(${JSON.stringify(selector)});` +
          `if (!__el || __el.getAttribute('data-ppt-pending-delete') !== '1') return;` +
          `if (__el.hasAttribute && __el.hasAttribute('data-ppt-art-text')) {` +
          `  var __blockId = __el.getAttribute('data-block-id') || '';` +
          `  var __style = __blockId ? Array.from(document.querySelectorAll('style[data-ppt-art-text-style]')).find(function(s){ return s.getAttribute('data-ppt-art-text-style') === __blockId; }) : null;` +
          `  if (__style) { __style.disabled = false; __style.removeAttribute('data-ppt-pending-delete'); }` +
          `}` +
          `if (__el.tagName === 'STYLE') { __el.disabled = false; __el.removeAttribute('data-ppt-pending-delete'); return; }` +
          `__el.style.removeProperty('display');` +
          `__el.removeAttribute('data-ppt-pending-delete');` +
        `})()`
      )
    },
    applyDragStyle(
      selector: string,
      style: {
        x: number
        y: number
        width?: number
        height?: number
        isAbsoluteMode?: boolean
      }
    ): void {
      const wv = webviewRef.current
      if (!wv) return
      if (style.isAbsoluteMode) {
        safeExecuteJavaScript(
          wv,
          `(function(){` +
            `var __el = document.querySelector(${JSON.stringify(selector)}); if (!__el) return;` +
            `__el.style.position = 'absolute';` +
            `if (!__el.style.zIndex) __el.style.zIndex = '10';` +
            `__el.style.left = ${JSON.stringify(style.x + 'px')};` +
            `__el.style.top = ${JSON.stringify(style.y + 'px')};` +
            `__el.style.translate = '';` +
            `__el.style.removeProperty('--ppt-drag-x');` +
            `__el.style.removeProperty('--ppt-drag-y');` +
            `__el.setAttribute('data-ppt-layout-converted', '1');` +
            (style.width != null ? `__el.style.width = ${JSON.stringify(style.width + 'px')};` : '') +
            (style.height != null ? `__el.style.height = ${JSON.stringify(style.height + 'px')};` : '') +
          `})()`
        )
        return
      }
      safeExecuteJavaScript(
        wv,
        `(function(){` +
          `var __el = document.querySelector(${JSON.stringify(selector)}); if (!__el) return;` +
          `var __pos = __el.style.position || getComputedStyle(__el).position;` +
          `if (!__pos || __pos === 'static') __el.style.position = 'relative';` +
          `if (!__el.style.zIndex) __el.style.zIndex = '10';` +
          `__el.style.setProperty('--ppt-drag-x', ${JSON.stringify(style.x + 'px')});` +
          `__el.style.setProperty('--ppt-drag-y', ${JSON.stringify(style.y + 'px')});` +
          `__el.style.translate = 'var(--ppt-drag-x, 0px) var(--ppt-drag-y, 0px)';` +
          (style.width != null ? `__el.style.width = ${JSON.stringify(style.width + 'px')};` : '') +
          (style.height != null ? `__el.style.height = ${JSON.stringify(style.height + 'px')};` : '') +
        `})()`
      )
    },
    applyLayoutIsland(layoutIsland: EditModeLayoutIsland): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `if (window.__pptEditModeApplyLayoutIsland) window.__pptEditModeApplyLayoutIsland(${JSON.stringify(layoutIsland)});`
      )
    },
    applyZIndex(selector: string, zIndex: number): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `(function(){` +
        `var __el = document.querySelector(${JSON.stringify(selector)});` +
        `if (!__el) return;` +
        `var __position = window.getComputedStyle(__el).position;` +
        `if (!__position || __position === "static") __el.style.setProperty("position", "relative", "important");` +
        `__el.style.setProperty("z-index", String(${zIndex}), "important");` +
        `})()`
      )
    },
    async copyElement(
      selector: string,
      newBlockId: string
    ): Promise<{ selector: string; htmlFragment: string } | null> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return null
      const scope = selector.match(/\[data-page-id="([^"]+)"\]/)?.[1] || ''
      const root = scope ? `body[data-page-id="${scope}"] [data-ppt-guard-root="1"]` : 'body'
      const newSelector = scope
        ? `body[data-page-id="${scope}"] [data-block-id="${newBlockId}"]`
        : `[data-block-id="${newBlockId}"]`
      try {
        // Pre-generate child block IDs with nanoid (same pattern as host code)
        const childIds = Array.from({ length: 20 }, () => 'select-arcsin1-' + nanoid(8))
        const copyResult = (await wv.executeJavaScript(
          `(function(){` +
          `var __src = document.querySelector(${JSON.stringify(selector)});` +
          `if (!__src) return null;` +
          `var __root = document.querySelector(${JSON.stringify(root)});` +
          `if (!__root) return null;` +
          `var __clone = __src.cloneNode(true);` +
          `var __childIds = ${JSON.stringify(childIds)};` +
          `var __oldBlockId = __src.getAttribute("data-block-id") || "";` +
          `var __styleClone = null;` +
          `var __styleHtml = "";` +
          `__clone.setAttribute("data-block-id", ${JSON.stringify(newBlockId)});` +
          `__clone.querySelectorAll("[data-block-id]").forEach(function(c,i){if(__childIds[i])c.setAttribute("data-block-id",__childIds[i]);});` +
          `__clone.classList.remove("arcsin1-presentation-editor-selected","arcsin1-presentation-editor-hover");` +
          `__clone.removeAttribute("data-arcsin1-presentation-editor-selected");` +
          `__clone.removeAttribute("data-arcsin1-presentation-editor-hover");` +
          `if (__src.hasAttribute("data-ppt-art-text") && __oldBlockId) {` +
          `  var __style = Array.from(document.querySelectorAll("style[data-ppt-art-text-style]")).find(function(s){ return s.getAttribute("data-ppt-art-text-style") === __oldBlockId; });` +
          `  if (__style) {` +
          `    __styleClone = __style.cloneNode(true);` +
          `    __styleClone.setAttribute("data-ppt-art-text-style", ${JSON.stringify(newBlockId)});` +
          `    __styleClone.textContent = String(__styleClone.textContent || "").split(__oldBlockId).join(${JSON.stringify(newBlockId)});` +
          `    __styleClone.disabled = false;` +
          `    __styleClone.removeAttribute("data-ppt-pending-delete");` +
          `    __styleHtml = __styleClone.outerHTML;` +
          `    __root.appendChild(__styleClone);` +
          `  }` +
          `}` +
          `var __rect = __src.getBoundingClientRect();` +
          `var __pos = __src.style.position || getComputedStyle(__src).position;` +
          `if (__pos === "absolute" || __src.hasAttribute("data-ppt-layout-converted")) {` +
          `  __clone.style.left = (parseFloat(__src.style.left||"0")+40)+"px";` +
          `  __clone.style.top = (parseFloat(__src.style.top||"0")+40)+"px";` +
          `  var __z = parseInt(__src.style.zIndex||"10")||10;` +
          `  __clone.style.zIndex = String(__z+1);` +
          `} else {` +
          `  __clone.style.position = "absolute";` +
          `  __clone.style.left = (__rect.left+40)+"px";` +
          `  __clone.style.top = (__rect.top+40)+"px";` +
          `  __clone.style.width = __rect.width+"px";` +
          `  __clone.style.height = __rect.height+"px";` +
          `  __clone.style.zIndex = "20";` +
          `}` +
          `__clone.removeAttribute("data-ppt-layout-converted");` +
          `__clone.removeAttribute("data-ppt-last-vp-x");` +
          `__clone.removeAttribute("data-ppt-last-vp-y");` +
          `var __htmlFragment = __styleHtml + __clone.outerHTML;` +
          `__root.appendChild(__clone);` +
          `return { selector: ${JSON.stringify(newSelector)}, htmlFragment: __htmlFragment };` +
          `})()`
        )) as { selector?: string; htmlFragment?: string } | null
        if (!copyResult?.selector || !copyResult.htmlFragment) return null
        return { selector: copyResult.selector, htmlFragment: copyResult.htmlFragment }
      } catch {
        return null
      }
    },
    async readElementHtml(selector: string): Promise<string> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return ''
      try {
        return (await wv.executeJavaScript(
          `(function(){` +
            `var __el = document.querySelector(${JSON.stringify(selector)});` +
            `if (!__el) return '';` +
            `if (__el.hasAttribute && __el.hasAttribute('data-ppt-art-text')) {` +
            `  var __blockId = __el.getAttribute('data-block-id') || '';` +
            `  var __style = __blockId ? Array.from(document.querySelectorAll('style[data-ppt-art-text-style]')).find(function(s){ return s.getAttribute('data-ppt-art-text-style') === __blockId; }) : null;` +
            `  return (__style ? __style.outerHTML : '') + __el.outerHTML;` +
            `}` +
            `return __el.outerHTML || '';` +
          `})()`
        )) || ''
      } catch {
        return ''
      }
    },
    async readElementSnapshot(selector: string): Promise<EditableElementSnapshot | null> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return null
      try {
        return (
          (await wv.executeJavaScript(
            `window.__pptEditModeReadSnapshot ? window.__pptEditModeReadSnapshot(${JSON.stringify(selector)}) : null`
          )) || null
        )
      } catch {
        return null
      }
    },
    async inspectElement(selector: string): Promise<PresentationElementSnapshot | null> {
      const wv = webviewRef.current
      return wv ? inspectPresentationElement(wv, selector, canExecuteJavaScript) : null
    },
    async applyElementOperations(
      selector: string,
      operations: PresentationEditorOperation[]
    ): Promise<PresentationEditorOperationResult[]> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv) || operations.length === 0) return []
      try {
        const result = await wv.executeJavaScript(
          `window.__pptEditModeApplyOperations ? window.__pptEditModeApplyOperations(${JSON.stringify(selector)}, ${JSON.stringify(operations)}) : []`
        )
        return Array.isArray(result) ? (result as PresentationEditorOperationResult[]) : []
      } catch {
        return []
      }
    },
    async readElementLayout(
      selector: string
    ): Promise<{
      isAbsoluteMode: boolean
      x: number
      y: number
      width: number
      height: number
      visualX?: number
      visualY?: number
      layoutIsland?: EditModeLayoutIsland
    } | null> {
      const wv = webviewRef.current
      if (!wv || !canExecuteJavaScript(wv)) return null
      try {
        const layout = (await wv.executeJavaScript(
          `window.__pptEditModeReadLayout ? window.__pptEditModeReadLayout(${JSON.stringify(selector)}) : null`
        )) as {
          isAbsoluteMode: boolean
          x: number
          y: number
          width: number
          height: number
          visualX?: number
          visualY?: number
          layoutIsland?: unknown
        } | null
        if (!layout) return null
        return {
          ...layout,
          layoutIsland: normalizeEditModeLayoutIsland(layout.layoutIsland)
        }
      } catch {
        return null
      }
    },
    applyChildUpdates(
      selector: string,
      childUpdates: Array<{ path: number[]; width?: number; height?: number }>
    ): void {
      const wv = webviewRef.current
      if (!wv || childUpdates.length === 0) return
      const updatesJs = childUpdates
        .map(
          (u) =>
            `{path:${JSON.stringify(u.path)},width:${u.width != null ? u.width : 'null'},height:${u.height != null ? u.height : 'null'}}`
        )
        .join(',')
      safeExecuteJavaScript(
        wv,
        `(function(){` +
        `var __parent = document.querySelector(${JSON.stringify(selector)}); if (!__parent) return;` +
        `var __ups = [${updatesJs}];` +
        `for (var __i = 0; __i < __ups.length; __i++) {` +
        `  var __u = __ups[__i]; var __c = __parent;` +
        `  for (var __j = 0; __j < __u.path.length; __j++) { __c = __c.children[__u.path[__j]]; if (!__c) break; }` +
        `  if (!__c) continue;` +
        `  if (__u.width !== null) __c.style.width = __u.width + 'px';` +
        `  if (__u.height !== null) __c.style.height = __u.height + 'px';` +
        `}` +
        `if (window.PPT && typeof window.PPT.resizeCharts === "function") { try { window.PPT.resizeCharts(__parent); } catch(__e) {} }` +
        `})()`
      )
    },
    injectElement(
      parentSelector: string,
      htmlFragment: string,
      insertIndex = -1,
      selectAfterInsert = true
    ): void {
      const wv = webviewRef.current
      if (!wv) return
      safeExecuteJavaScript(
        wv,
        `(function(){` +
        `var __parentSelector = ${JSON.stringify(parentSelector)};` +
        `var __html = ${JSON.stringify(htmlFragment)};` +
        `var __insertIndex = ${JSON.stringify(insertIndex)};` +
        `var __selectAfterInsert = ${JSON.stringify(selectAfterInsert)};` +
        `if (window.__pptEditModeInjectElement) { window.__pptEditModeInjectElement(__parentSelector, __html, __insertIndex, __selectAfterInsert); return; }` +
        `var __parent = document.querySelector(__parentSelector); if (!__parent) return;` +
        `var __template = document.createElement("template"); __template.innerHTML = __html;` +
        `var __nodes = Array.from(__template.content.children); if (__nodes.length === 0) return;` +
        `var __existingBlock = null;` +
        `for (var __k = 0; __k < __nodes.length; __k++) {` +
        `  var __blockId = __nodes[__k] instanceof Element ? __nodes[__k].getAttribute("data-block-id") : "";` +
        `  if (__blockId && document.querySelector('[data-block-id="' + __blockId.replace(/"/g, '\\\\"') + '"]')) { __existingBlock = __blockId; break; }` +
        `}` +
        `if (__existingBlock) return;` +
        `var __anchor = Number.isInteger(__insertIndex) && __insertIndex >= 0 && __insertIndex < __parent.children.length ? __parent.children[__insertIndex] : null;` +
        `__nodes.forEach(function(__node){ if (__anchor) __parent.insertBefore(__node, __anchor); else __parent.appendChild(__node); });` +
        `__nodes.forEach(function(__node){ if (!(__node instanceof Element)) return; var __scripts = []; if (__node.matches('script[data-ppt-generated-chart-script="1"]')) __scripts.push(__node); __node.querySelectorAll('script[data-ppt-generated-chart-script="1"]').forEach(function(__script){ __scripts.push(__script); }); __scripts.forEach(function(__script){ try { new Function(__script.textContent || "")(); } catch(__e) {} }); });` +
        `})()`
      )
    }
  }
}
