import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import {
  buildEditModeCleanupScript,
  buildEditModeInjectScript,
  buildEditModeSetPreviewScaleScript,
  buildInspectorCleanupScript,
  buildInspectorInjectScript,
  buildPresentationEditorRuntimeInjectScript
} from '@arcsin1/presentation-editor-runtime'
import type { InteractionMode } from '@renderer/store'
import type { SelectedElementRuntimeContext } from '@shared/generation'
import { requireSlideSize, type SlideSizePreset } from '@shared/slide-size'
import { useT } from '@renderer/i18n'
import { Button } from '../ui/Button'
import { useWebviewLoadError } from '../../hooks/useWebviewLoadError'
import {
  applyPreviewUrlParams,
  resolvePageHtmlPath,
  toPreviewFileUrl
} from '../presentation-webview/webview-utils'
import { usePresentationWebviewRuntime } from '../presentation-webview/usePresentationWebviewRuntime'
import {
  createWebviewCommands,
  inspectPresentationElement,
  type PreviewIframeHandle
} from './webview-commands'
import { usePreviewConsoleRouter } from './usePreviewConsoleRouter'
import { isCurrentInspectorSelectionRequest } from './PreviewIframeHelpers'
import type { EditModeMovePayload, EditSelectionPayload } from '@arcsin1/presentation-editor-runtime'

export type { PreviewIframeHandle } from './webview-commands'
export { isCurrentInspectorSelectionRequest }

export const PreviewIframe = forwardRef<
  PreviewIframeHandle,
  {
    html?: string
    src?: string
    title: string
    htmlPath?: string
    pageId?: string
    inspecting?: boolean
    inspectable?: boolean
    editMode?: boolean
    thumbnail?: boolean
    interactionMode?: InteractionMode
    slideSize: SlideSizePreset
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
    onDidReload?: () => void
    onDeleteRequest?: (selector: string) => void
  }
>(function PreviewIframe(
  {
    src,
    title,
    htmlPath,
    pageId,
    inspecting = false,
    inspectable = false,
    editMode = false,
    thumbnail = false,
    interactionMode,
    slideSize: slideSizeInput,
    onSelectorSelected,
    onElementMoved,
    onElementSelected,
    onInspectExit,
    onDidReload,
    onDeleteRequest
  },
  ref
) {
  const t = useT()
  const slideSize = requireSlideSize(slideSizeInput)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inspectorInjectedRef = useRef(false)
  const editModeInjectedRef = useRef(false)
  const inspectorSelectionRequestRef = useRef(0)
  const inspectorActiveRef = useRef(inspecting)
  const previewScaleRef = useRef(1)
  const {
    webviewRef,
    webviewElement,
    webviewReady,
    handleWebviewRef: handleRuntimeWebviewRef,
    canExecuteJavaScript,
    safeExecuteJavaScript,
    safeExecuteHostScript,
    reloadIgnoringCache
  } = usePresentationWebviewRuntime('PreviewIframe', () => {
    inspectorSelectionRequestRef.current += 1
  })
  const [transform, setTransform] = useState('scale(1)')
  const [previewScale, setPreviewScale] = useState(1)

  useEffect(() => {
    previewScaleRef.current = previewScale
  }, [previewScale])


  // Always preview concrete page file (<pageId>.html). index.html is only for external full-deck preview.
  const pageHtmlPath = resolvePageHtmlPath(htmlPath, pageId)
  const previewUrlOptions = { thumbnail, pageId }
  const webviewSrc = pageHtmlPath
    ? toPreviewFileUrl(pageHtmlPath, previewUrlOptions)
    : src
      ? applyPreviewUrlParams(src, previewUrlOptions)
      : undefined
  const webviewLoad = useWebviewLoadError(webviewElement, webviewSrc)
  const currentInteractionMode: InteractionMode =
    interactionMode || (editMode ? 'edit' : inspecting ? 'ai-inspect' : 'preview')
  const inspectorInteractionModeRef = useRef(currentInteractionMode)
  inspectorActiveRef.current = inspecting
  inspectorInteractionModeRef.current = currentInteractionMode
  const pointerEnabled = inspectable

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null): void => {
    inspectorSelectionRequestRef.current += 1
    inspectorInjectedRef.current = false
    editModeInjectedRef.current = false
    handleRuntimeWebviewRef(node)
  }, [handleRuntimeWebviewRef])

  const inspectElementInWebview = useCallback(
    (webview: Electron.WebviewTag, selector: string) =>
      inspectPresentationElement(webview, selector, canExecuteJavaScript),
    [canExecuteJavaScript]
  )

  const commands = useMemo(
    () => createWebviewCommands({ webviewRef, canExecuteJavaScript, safeExecuteJavaScript }),
    [webviewRef, canExecuteJavaScript, safeExecuteJavaScript]
  )

  useImperativeHandle(
    ref,
    () => ({
      reloadIgnoringCache(): void {
        reloadIgnoringCache()
      },
      ...commands
    }),
    [commands, reloadIgnoringCache]
  )

  usePreviewConsoleRouter({
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
    inspectPresentationElement: inspectElementInWebview,
    onSelectorSelected,
    onElementMoved,
    onElementSelected,
    onInspectExit,
    onDeleteRequest
  })

  // Selection overlay effect: handles AI inspect and animation-select.
  useEffect(() => {
    const webview = webviewElement
    if (!webview || !inspectable || !webviewReady) return

    const runInspectorLifecycle = (): void => {
      if (inspecting) {
        safeExecuteHostScript(
          webview,
          'presentation-editor-runtime-inject',
          buildPresentationEditorRuntimeInjectScript({
            rootSelector: '[data-ppt-guard-root="1"], .ppt-page-root',
            interaction: false
          })
        )
        safeExecuteHostScript(
          webview,
          'inspector-inject',
          buildInspectorInjectScript({ mode: currentInteractionMode === 'animation-select' ? 'animation-select' : 'inspect' })
        )
        inspectorInjectedRef.current = true
      } else {
        if (!inspectorInjectedRef.current) return
        safeExecuteHostScript(webview, 'inspector-cleanup', buildInspectorCleanupScript())
        inspectorInjectedRef.current = false
      }
    }

    runInspectorLifecycle()

    return () => {
      inspectorSelectionRequestRef.current += 1
      if (!inspectorInjectedRef.current) return
      safeExecuteHostScript(webview, 'inspector-cleanup', buildInspectorCleanupScript())
      inspectorInjectedRef.current = false
    }
  }, [inspectable, inspecting, currentInteractionMode, webviewReady, webviewSrc, webviewElement])

  // Unified edit mode effect: handles click-to-select, drag, and resize.
  // Use ref for onDidReload to avoid re-running effect on every parent re-render.
  const onDidReloadRef = useRef(onDidReload)
  onDidReloadRef.current = onDidReload

  useEffect(() => {
    const webview = webviewElement
    if (!webview || !inspectable || !webviewReady) return

    const runEditModeLifecycle = (): void => {
      if (editMode) {
        safeExecuteHostScript(
          webview,
          'edit-inject',
          buildEditModeInjectScript(previewScaleRef.current)
        )
        editModeInjectedRef.current = true
      } else {
        if (!editModeInjectedRef.current) return
        safeExecuteHostScript(webview, 'edit-cleanup', buildEditModeCleanupScript())
        editModeInjectedRef.current = false
      }
    }

    runEditModeLifecycle()
    if (editMode) onDidReloadRef.current?.()

    return () => {
      if (!editModeInjectedRef.current) return
      safeExecuteHostScript(webview, 'edit-cleanup', buildEditModeCleanupScript())
      editModeInjectedRef.current = false
    }
  }, [inspectable, editMode, webviewReady, webviewSrc, webviewElement])

  useEffect(() => {
    const webview = webviewElement
    if (!webview || !inspectable || !editMode || !webviewReady) return
    safeExecuteHostScript(
      webview,
      'edit-set-preview-scale',
      buildEditModeSetPreviewScaleScript(previewScale)
    )
  }, [editMode, inspectable, previewScale, webviewReady, webviewElement])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateScale = (): void => {
      const { width, height } = el.getBoundingClientRect()
      const nextScaleRaw = Math.min(width / slideSize.width, height / slideSize.height)
      const nextScale = Number.isFinite(nextScaleRaw) && nextScaleRaw > 0 ? nextScaleRaw : 1
      const offsetX = Math.max(0, (width - slideSize.width * nextScale) / 2)
      const offsetY = Math.max(0, (height - slideSize.height * nextScale) / 2)
      setPreviewScale(nextScale)
      setTransform(`translate(${offsetX}px, ${offsetY}px) scale(${nextScale})`)
    }

    updateScale()
    const observer = new ResizeObserver(updateScale)
    observer.observe(el)
    return () => observer.disconnect()
  }, [slideSize.height, slideSize.width])

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-[inherit] bg-[#f5f1e8]"
    >
      {webviewSrc ? (
        <webview
          ref={handleWebviewRef}
          src={webviewSrc}
          tabIndex={thumbnail ? -1 : 0}
          title={title}
          className={`absolute left-0 top-0 origin-top-left ${
            pointerEnabled ? 'pointer-events-auto' : 'pointer-events-none'
          } ${editMode ? 'cursor-move' : inspecting ? 'cursor-crosshair' : ''}`}
          style={{ width: slideSize.width, height: slideSize.height, transform }}
        />
      ) : null}
      {webviewSrc && webviewLoad.error ? (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#f5f1e8]/95 px-6 text-center text-[#7c786b]"
          role="alert"
        >
          <AlertTriangle className="h-5 w-5 text-[#a86d52]" aria-hidden="true" />
          <p className="text-sm font-medium text-[#514d43]">{t('sessionDetail.previewLoadFailed')}</p>
          <p className="max-w-[min(78%,520px)] text-xs leading-5 text-[#7c786b]">
            {webviewLoad.error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={webviewLoad.retry}
            className="gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('sessionDetail.retryPreview')}
          </Button>
        </div>
      ) : null}
    </div>
  )
})
