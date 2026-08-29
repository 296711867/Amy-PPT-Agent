/** PreviewIframe 的 console 消息路由：选中/移动/删除事件锚定后分发给回调。 */
import { useEffect, useRef } from 'react'
import {
  EDIT_MODE_CONSOLE_PREFIX,
  INSPECTOR_CONSOLE_PREFIX,
  type EditableElementSnapshot,
  type EditModeMovePayload,
  type EditTextTarget,
  type EditSelectionPayload
} from '@arcsin1/presentation-editor-runtime'
import { ipc } from '@renderer/lib/ipc'
import { buildSelectedElementRuntimeContext } from '@renderer/lib/presentation-element-context'
import { normalizeEditModeLayoutIsland } from '@renderer/lib/presentation-layout-island'
import type { InteractionMode } from '@renderer/store'
import type { SelectedElementRuntimeContext } from '@shared/generation'
import { isCurrentInspectorSelectionRequest } from './PreviewIframeHelpers'

export type PreviewConsoleRouterArgs = {
  webviewElement: Electron.WebviewTag | null
  inspectable: boolean
  pageHtmlPath?: string
  pageId?: string
  webviewRef: { current: Electron.WebviewTag | null }
  safeExecuteJavaScript: (webview: Electron.WebviewTag, script: string) => void
  canExecuteJavaScript: (webview: Electron.WebviewTag) => boolean
  inspectorSelectionRequestRef: { current: number }
  inspectorActiveRef: { current: boolean }
  inspectorInteractionModeRef: { current: InteractionMode }
  inspectPresentationElement: (
    webview: Electron.WebviewTag,
    selector: string
  ) => Promise<import('@arcsin1/presentation-editor-runtime').PresentationElementSnapshot | null>
  onSelectorSelected?: (
    selector: string,
    label: string,
    elementTag?: string,
    elementText?: string,
    selectedElementContext?: SelectedElementRuntimeContext | null
  ) => void
  onElementMoved?: (payload: EditModeMovePayload) => void
  onElementSelected?: (payload: EditSelectionPayload) => void
  onInspectExit?: () => void
  onDeleteRequest?: (selector: string) => void
}

export const usePreviewConsoleRouter = (args: PreviewConsoleRouterArgs): void => {
  const {
    webviewElement,
    inspectable,
    pageHtmlPath,
    pageId,
    webviewRef,
    safeExecuteJavaScript,
    canExecuteJavaScript,
    inspectorSelectionRequestRef,
    inspectorActiveRef,
    inspectorInteractionModeRef,
    inspectPresentationElement
  } = args

  // Use refs for callback props to avoid re-registering listener on every parent re-render
  const onSelectorSelectedRef = useRef(args.onSelectorSelected)
  onSelectorSelectedRef.current = args.onSelectorSelected
  const onElementMovedRef = useRef(args.onElementMoved)
  onElementMovedRef.current = args.onElementMoved
  // Serialize 'moved' events per webview: each event awaits ensureAnchoredAnchor
  // before dispatching handleMoved. Without serialization, a slow anchor (first
  // edit on an unanchored element, or any IPC scheduling jitter) can let a later
  // 'moved' resolve before an earlier one, so a stale drag's x/y (or null
  // width/height) overwrites a fresh resize. The promise chain guarantees
  // emission order === dispatch order.
  const movedChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const onElementSelectedRef = useRef(args.onElementSelected)
  onElementSelectedRef.current = args.onElementSelected
  const onInspectExitRef = useRef(args.onInspectExit)
  onInspectExitRef.current = args.onInspectExit
  const onDeleteRequestRef = useRef(args.onDeleteRequest)
  onDeleteRequestRef.current = args.onDeleteRequest

  useEffect(() => {
    const webview = webviewElement
    if (!webview || !inspectable) return

    const ensureAnchoredAnchor = async (anchorArgs: {
      selector: string
      elementTag?: string
      elementText?: string
      reason: 'inspect' | 'drag' | 'text-edit'
      formula?: EditableElementSnapshot['formula']
    }): Promise<{ selector: string; blockId?: string }> => {
      if (!pageHtmlPath || !pageId) {
        throw new Error('Cannot anchor element without page path and page id')
      }
      const existingBlockId = anchorArgs.selector.match(/\[data-block-id="([^"]+)"\]/)?.[1]
      if (existingBlockId) return { selector: anchorArgs.selector, blockId: existingBlockId }
      try {
        const result = await ipc.ensureElementAnchor({
          htmlPath: pageHtmlPath,
          pageId,
          selector: anchorArgs.selector,
          elementTag: anchorArgs.elementTag,
          elementText: anchorArgs.elementText,
          reason: anchorArgs.reason,
          formula: anchorArgs.formula
        })
        if (result.changed && result.blockId) {
          const wv = webviewRef.current
          if (wv) {
            safeExecuteJavaScript(
              wv,
              `(() => {
                var __selector = ${JSON.stringify(anchorArgs.selector)};
                var __blockId = ${JSON.stringify(result.blockId)};
                var __latex = ${JSON.stringify(anchorArgs.formula?.latex || '')};
                var __normalize = function(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); };
                var __nodes = [];
                try { __nodes = Array.prototype.slice.call(document.querySelectorAll(__selector)); } catch (_error) {}
                var __el = __nodes.length === 1 ? __nodes[0] : null;
                if (!__el && __latex) {
                  var __formulaNodes = Array.prototype.slice.call(document.querySelectorAll('.katex'));
                  var __matches = __formulaNodes.filter(function(node) {
                    if (!(node instanceof Element) || node.getAttribute('data-block-id')) return false;
                    var annotation = node.querySelector('annotation[encoding="application/x-tex"]');
                    var latex = node.getAttribute('data-ppt-formula-latex') || (annotation ? annotation.textContent : '');
                    return __normalize(latex) === __normalize(__latex);
                  });
                  if (__matches.length === 1) __el = __matches[0];
                }
                if (__el instanceof Element) {
                  var __target = __el.classList.contains('katex-display') && !__el.classList.contains('katex')
                    ? (__el.querySelector('.katex') || __el)
                    : __el;
                  if (!__target.getAttribute('data-block-id')) __target.setAttribute('data-block-id', __blockId);
                }
              })();`
            )
          }
        }
        return { selector: result.selector || anchorArgs.selector, blockId: result.blockId }
      } catch {
        throw new Error('Failed to anchor selected element')
      }
    }

    const handleConsoleMessage = (event: Event): void => {
      const payloadText = (event as { message?: unknown }).message
      if (typeof payloadText !== 'string') {
        return
      }
      if (payloadText.startsWith('[PreviewIframe:')) {
        console.error(payloadText)
        return
      }
      const isInspectorMessage = payloadText.startsWith(INSPECTOR_CONSOLE_PREFIX)
      const isEditModeMessage = payloadText.startsWith(EDIT_MODE_CONSOLE_PREFIX)
      if (!isInspectorMessage && !isEditModeMessage) return

      const prefixLength = isInspectorMessage
        ? INSPECTOR_CONSOLE_PREFIX.length
        : EDIT_MODE_CONSOLE_PREFIX.length
      const raw = payloadText.slice(prefixLength).trim()
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as {
          type?: string
          mode?: 'inspect' | 'text-edit' | 'animation-select'
          selector?: string
          blockId?: string
          label?: string
          elementTag?: string
          elementText?: string
          formula?: EditableElementSnapshot['formula']
          kind?: EditSelectionPayload['kind']
          capabilities?: EditSelectionPayload['capabilities']
          snapshot?: EditSelectionPayload['snapshot']
          isText?: boolean
          layoutMode?: EditModeMovePayload['layoutMode']
          x?: number
          y?: number
          deltaX?: number
          deltaY?: number
          visualX?: number
          visualY?: number
          width?: number
          height?: number
          layoutIsland?: unknown
          childUpdates?: Array<{
            path: number[]
            width?: number
            height?: number
          }>
          text?: string
          html?: string
          textTarget?: EditTextTarget
          style?: EditSelectionPayload['style']
          bounds?: EditSelectionPayload['bounds']
          translateX?: number
          translateY?: number
          zIndex?: number
          editability?: EditSelectionPayload['editability']
        }

        // Inspector / animation-select: element selected
        if (isInspectorMessage && parsed.type === 'selected' && parsed.selector) {
          const selectedSelector = parsed.selector
          const requestId = ++inspectorSelectionRequestRef.current
          const selectionInteractionMode = inspectorInteractionModeRef.current
          if (parsed.mode === 'animation-select' && parsed.formula) {
            void (async () => {
              const anchor = await ensureAnchoredAnchor({
                selector: selectedSelector,
                elementTag: parsed.elementTag,
                elementText: parsed.elementText,
                reason: 'inspect',
                formula: parsed.formula
              })
              if (
                webviewRef.current !== webview ||
                !isCurrentInspectorSelectionRequest({
                  requestId,
                  latestRequestId: inspectorSelectionRequestRef.current,
                  isInspectorActive: inspectorActiveRef.current,
                  selectionInteractionMode,
                  currentInteractionMode: inspectorInteractionModeRef.current
                })
              ) {
                return
              }
              onSelectorSelectedRef.current?.(
                anchor.selector,
                anchor.selector,
                parsed.elementTag,
                parsed.elementText
              )
            })().catch(() => {})
            return
          }
          void (async () => {
            const snapshot = await inspectPresentationElement(webview, selectedSelector)
            if (
              webviewRef.current !== webview ||
              !isCurrentInspectorSelectionRequest({
                requestId,
                latestRequestId: inspectorSelectionRequestRef.current,
                isInspectorActive: inspectorActiveRef.current,
                selectionInteractionMode,
                currentInteractionMode: inspectorInteractionModeRef.current
              })
            ) {
              return
            }
            onSelectorSelectedRef.current?.(
              selectedSelector,
              parsed.label || selectedSelector,
              parsed.elementTag,
              parsed.elementText,
              snapshot ? buildSelectedElementRuntimeContext(snapshot) : null
            )
          })().catch(() => {})
          return
        }

        // Edit mode: element selected (click)
        if (isEditModeMessage && parsed.type === 'selected' && parsed.selector) {
          void (async () => {
            const anchor = await ensureAnchoredAnchor({
              selector: parsed.selector || '',
              elementTag: parsed.elementTag,
              elementText: parsed.elementText,
              reason: 'drag',
              formula: parsed.snapshot?.formula
            })
            if (webviewRef.current !== webview) return
            const textTarget =
              parsed.textTarget && parsed.textTarget.parentSelector === parsed.selector
                ? { ...parsed.textTarget, parentSelector: anchor.selector }
                : parsed.textTarget
            onElementSelectedRef.current?.({
              selector: anchor.selector,
              blockId: anchor.blockId || parsed.blockId,
              label: anchor.selector,
              elementTag: parsed.elementTag || '',
              elementText: parsed.elementText || '',
              kind: parsed.kind,
              capabilities: parsed.capabilities,
              snapshot: parsed.snapshot
                ? {
                    ...parsed.snapshot,
                    selector: anchor.selector,
                    blockId: anchor.blockId || parsed.snapshot.blockId || parsed.blockId
                  }
                : parsed.snapshot,
              isText: Boolean(parsed.isText),
              text: typeof parsed.text === 'string' ? parsed.text : '',
              html: typeof parsed.html === 'string' ? parsed.html : '',
              textTarget,
              style: parsed.style || {},
              bounds: parsed.bounds,
              translateX: Number(parsed.translateX || 0),
              translateY: Number(parsed.translateY || 0),
              zIndex: typeof parsed.zIndex === 'number' ? parsed.zIndex : undefined,
              editability: parsed.editability || undefined
            })
          })().catch(() => {})
          return
        }

        // Edit mode: pre-anchor request
        if (isEditModeMessage && parsed.type === 'pre-anchor' && parsed.selector) {
          void (async () => {
            let anchorResult: { selector: string; blockId?: string }
            try {
              anchorResult = await ensureAnchoredAnchor({
                selector: parsed.selector || '',
                elementTag: parsed.elementTag,
                reason: 'drag',
                formula: parsed.snapshot?.formula
              })
            } catch {
              return
            }
            if (webviewRef.current !== webview) return
            const wv = webviewRef.current
            if (wv) {
              safeExecuteJavaScript(
                wv,
                `if (window.__pptResolveEditModeAnchor) window.__pptResolveEditModeAnchor(${JSON.stringify(anchorResult)});`
              )
            }
          })().catch(() => {})
          return
        }

        // Edit mode: element moved/resized.
        // Serialized via movedChainRef: each event must finish ensureAnchoredAnchor
        // → handleMoved before the next one starts, so emission order === dispatch
        // order. Without this, a stale 'moved' (e.g. a drag whose anchor IPC was
        // slow) can resolve after a fresh resize and clobber the resize's x/y or
        // null-out its width/height in upsertDragEdit.
        if (isEditModeMessage && parsed.type === 'moved' && parsed.selector) {
          movedChainRef.current = movedChainRef.current
            .catch(() => {})
            .then(() =>
              (async () => {
                const anchor = await ensureAnchoredAnchor({
                  selector: parsed.selector || '',
                  elementTag: parsed.elementTag,
                  reason: 'drag',
                  formula: parsed.snapshot?.formula
                })
                if (webviewRef.current !== webview) return
                onElementMovedRef.current?.({
                  selector: anchor.selector,
                  blockId: anchor.blockId || parsed.blockId,
                  label: anchor.selector,
                  elementTag: parsed.elementTag || '',
                  layoutMode: parsed.layoutMode,
                  x: Number(parsed.x || 0),
                  y: Number(parsed.y || 0),
                  deltaX: Number(parsed.deltaX || 0),
                  deltaY: Number(parsed.deltaY || 0),
                  visualX: parsed.visualX === undefined ? undefined : Number(parsed.visualX),
                  visualY: parsed.visualY === undefined ? undefined : Number(parsed.visualY),
                  width: parsed.width === undefined ? undefined : Number(parsed.width),
                  height: parsed.height === undefined ? undefined : Number(parsed.height),
                  layoutIsland: normalizeEditModeLayoutIsland(parsed.layoutIsland),
                  childUpdates: Array.isArray(parsed.childUpdates)
                    ? parsed.childUpdates
                        .map((item) => ({
                          path: Array.isArray(item.path)
                            ? item.path
                                .map((value) => Number(value))
                                .filter((value) => Number.isInteger(value) && value >= 0)
                            : [],
                          width: item.width === undefined ? undefined : Number(item.width),
                          height: item.height === undefined ? undefined : Number(item.height)
                        }))
                        .filter(
                          (item) =>
                            item.path.length > 0 &&
                            (item.width !== undefined || item.height !== undefined)
                        )
                    : undefined
                })
              })()
            )
            .catch(() => {})
          return
        }

        // Exit from either mode
        if (parsed.type === 'exit') {
          onInspectExitRef.current?.()
        }

        // Edit mode: keyboard delete request
        if (isEditModeMessage && parsed.type === 'delete-request' && parsed.selector) {
          onDeleteRequestRef.current?.(parsed.selector)
        }
      } catch {
        // ignore parse error
      }
    }

    webview.addEventListener('console-message', handleConsoleMessage as EventListener)
    return () => {
      webview.removeEventListener('console-message', handleConsoleMessage as EventListener)
    }
  }, [
    inspectable,
    pageHtmlPath,
    pageId,
    webviewElement,
    webviewRef,
    safeExecuteJavaScript,
    canExecuteJavaScript,
    inspectorSelectionRequestRef,
    inspectorActiveRef,
    inspectorInteractionModeRef,
    inspectPresentationElement
  ])
}
