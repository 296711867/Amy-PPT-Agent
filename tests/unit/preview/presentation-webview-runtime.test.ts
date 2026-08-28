// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { usePresentationWebviewRuntime } from '../../../src/renderer/src/components/presentation-webview/usePresentationWebviewRuntime'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('presentation webview runtime', () => {
  it('tracks readiness, guards script execution, and reloads safely', async () => {
    const onStartLoading = vi.fn()
    const executeJavaScript = vi.fn(async () => undefined)
    const reloadIgnoringCache = vi.fn()
    const webviewElement = document.createElement('div')
    Object.assign(webviewElement, { executeJavaScript, reloadIgnoringCache })
    document.body.appendChild(webviewElement)
    const webview = webviewElement as unknown as Electron.WebviewTag
    let runtime: ReturnType<typeof usePresentationWebviewRuntime> | undefined

    const Harness = (): React.JSX.Element | null => {
      runtime = usePresentationWebviewRuntime('PreviewIframe', onStartLoading)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(React.createElement(Harness)))
    await act(async () => runtime?.handleWebviewRef(webview))

    runtime?.safeExecuteJavaScript(webview, 'window.test = true')
    expect(executeJavaScript).not.toHaveBeenCalled()
    expect(runtime?.webviewReady).toBe(false)

    await act(async () => webviewElement.dispatchEvent(new Event('dom-ready')))
    expect(runtime?.webviewReady).toBe(true)
    runtime?.safeExecuteHostScript(webview, 'inspect', 'window.test = true')
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('[PreviewIframe:inspect]')
    )

    runtime?.reloadIgnoringCache()
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)

    await act(async () => webviewElement.dispatchEvent(new Event('did-start-loading')))
    expect(onStartLoading).toHaveBeenCalledTimes(1)
    expect(runtime?.webviewReady).toBe(false)

    await act(async () => root.unmount())
    webviewElement.remove()
  })
})
