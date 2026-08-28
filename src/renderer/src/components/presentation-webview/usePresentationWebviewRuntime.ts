import { useCallback, useEffect, useRef, useState } from 'react'
import { buildSafeVoidScript } from './webview-utils'

type WebviewRuntimeSource = 'PreviewIframe' | 'HtmlEditorCanvas'

export function usePresentationWebviewRuntime(
  source: WebviewRuntimeSource,
  onStartLoading?: () => void
) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const webviewReadyRef = useRef(false)
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null)
  const [webviewReady, setWebviewReady] = useState(false)
  const onStartLoadingRef = useRef(onStartLoading)
  onStartLoadingRef.current = onStartLoading

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null): void => {
    webviewReadyRef.current = false
    setWebviewReady(false)
    webviewRef.current = node
    setWebviewElement((previous) => (previous === node ? previous : node))
  }, [])

  const canExecuteJavaScript = useCallback((webview: Electron.WebviewTag): boolean => {
    return webview.isConnected && webviewRef.current === webview && webviewReadyRef.current
  }, [])

  const safeExecuteJavaScript = useCallback(
    (webview: Electron.WebviewTag, script: string): void => {
      if (!canExecuteJavaScript(webview)) return
      try {
        webview.executeJavaScript(buildSafeVoidScript(source, 'void', script)).catch(() => {})
      } catch {
        // executeJavaScript may throw synchronously before dom-ready
      }
    },
    [canExecuteJavaScript, source]
  )

  const safeExecuteHostScript = useCallback(
    (webview: Electron.WebviewTag, label: string, script: string): void => {
      if (!canExecuteJavaScript(webview)) return
      try {
        webview.executeJavaScript(buildSafeVoidScript(source, label, script)).catch(() => {})
      } catch {
        // executeJavaScript may throw synchronously before dom-ready
      }
    },
    [canExecuteJavaScript, source]
  )

  const waitForWebviewReady = useCallback(async (): Promise<Electron.WebviewTag | null> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const webview = webviewRef.current
      if (webview && canExecuteJavaScript(webview)) return webview
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
    }
    return null
  }, [canExecuteJavaScript])

  const reloadIgnoringCache = useCallback((): void => {
    const webview = webviewRef.current
    if (!webview) return
    try {
      webview.reloadIgnoringCache()
    } catch {
      // The webview can be detached while the route changes.
    }
  }, [])

  useEffect(() => {
    const webview = webviewElement
    if (!webview) return

    webviewReadyRef.current = false
    setWebviewReady(false)
    const markReady = (): void => {
      if (webviewRef.current !== webview) return
      webviewReadyRef.current = true
      setWebviewReady(true)
    }
    const handleStartLoading = (): void => {
      if (webviewRef.current !== webview) return
      onStartLoadingRef.current?.()
      webviewReadyRef.current = false
      setWebviewReady(false)
    }

    webview.addEventListener('dom-ready', markReady as EventListener)
    webview.addEventListener('did-start-loading', handleStartLoading as EventListener)
    return () => {
      webview.removeEventListener('dom-ready', markReady as EventListener)
      webview.removeEventListener('did-start-loading', handleStartLoading as EventListener)
      if (webviewRef.current === webview) {
        webviewReadyRef.current = false
        setWebviewReady(false)
      }
    }
  }, [webviewElement])

  return {
    webviewRef,
    webviewReadyRef,
    webviewElement,
    webviewReady,
    handleWebviewRef,
    canExecuteJavaScript,
    safeExecuteJavaScript,
    safeExecuteHostScript,
    waitForWebviewReady,
    reloadIgnoringCache
  }
}
