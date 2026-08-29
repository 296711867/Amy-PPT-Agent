import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  isAllowedIpcEventChannel,
  isAllowedIpcInvokeChannel
} from '../../../src/shared/ipc-channels'

// The renderer IPC facade is split by domain under lib/ipc/; the policy must
// scan every module so no channel escapes the allowlist.
const rendererIpcSource = [
  'src/renderer/src/lib/ipc.ts',
  ...fs
    .readdirSync('src/renderer/src/lib/ipc')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('src/renderer/src/lib/ipc', name))
]
  .map((filePath) => fs.readFileSync(filePath, 'utf-8'))
  .join('\n')

function extractChannels(pattern: RegExp): string[] {
  return Array.from(rendererIpcSource.matchAll(pattern), (match) => match[1]).filter(
    (channel): channel is string => typeof channel === 'string'
  )
}

describe('renderer IPC channel policy', () => {
  it('covers every literal invoke channel used by the renderer IPC facade', () => {
    const rendererChannels = new Set(extractChannels(/invoke\(\s*['"]([^'"]+)['"]/g))
    const allowedChannels = new Set(IPC_INVOKE_CHANNELS)

    expect(allowedChannels).toEqual(rendererChannels)
  })

  it('covers every event channel used by the renderer IPC facade', () => {
    const rendererChannels = new Set(extractChannels(/const channel = ['"]([^'"]+)['"]/g))
    const allowedChannels = new Set(IPC_EVENT_CHANNELS)

    expect(allowedChannels).toEqual(rendererChannels)
  })

  it('rejects channels outside the invoke and event policies', () => {
    expect(isAllowedIpcInvokeChannel('session:list')).toBe(true)
    expect(isAllowedIpcEventChannel('generate:chunk')).toBe(true)
    expect(isAllowedIpcInvokeChannel('ipcMain:internal')).toBe(false)
    expect(isAllowedIpcEventChannel('ipcMain:internal')).toBe(false)
  })

  it('does not expose the electron toolkit API wholesale', () => {
    const preloadSource = fs.readFileSync('src/preload/index.ts', 'utf-8')

    expect(preloadSource).not.toContain("from '@electron-toolkit/preload'")
    expect(preloadSource).not.toContain('...electronAPI')
    expect(preloadSource).toContain('ipcRenderer: ipcRendererApi')
    expect(preloadSource).toContain('process: Object.freeze({ platform: process.platform })')
  })

  it('wraps event listeners and removes the exact native wrapper', async () => {
    const exposeInMainWorld = vi.fn()
    const nativeOn = vi.fn()
    const nativeRemoveListener = vi.fn()
    const nativeInvoke = vi.fn()
    const previousContextIsolation = (process as typeof process & { contextIsolated?: boolean })
      .contextIsolated

    vi.resetModules()
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: {
        invoke: nativeInvoke,
        on: nativeOn,
        removeListener: nativeRemoveListener
      },
      webUtils: { getPathForFile: vi.fn() }
    }))
    ;(process as typeof process & { contextIsolated?: boolean }).contextIsolated = true

    try {
      await import('../../../src/preload/index')
      const api = exposeInMainWorld.mock.calls[0]?.[1] as {
        ipcRenderer: {
          on(channel: string, listener: (...args: any[]) => void): void
          removeListener(channel: string, listener: (...args: any[]) => void): void
        }
      }
      const listener = vi.fn()

      api.ipcRenderer.on('generate:chunk', listener)
      const wrapped = nativeOn.mock.calls[0]?.[1] as (...args: unknown[]) => void
      wrapped({ sender: 'private-event-object' }, { pageNumber: 1 })

      expect(listener).toHaveBeenCalledWith(undefined, { pageNumber: 1 })
      expect(listener).not.toHaveBeenCalledWith({ sender: 'private-event-object' }, expect.anything())

      api.ipcRenderer.removeListener('generate:chunk', listener)
      expect(nativeRemoveListener).toHaveBeenCalledWith('generate:chunk', wrapped)
    } finally {
      vi.doUnmock('electron')
      vi.resetModules()
      if (previousContextIsolation === undefined) {
        delete (process as typeof process & { contextIsolated?: boolean }).contextIsolated
      } else {
        ;(process as typeof process & { contextIsolated?: boolean }).contextIsolated =
          previousContextIsolation
      }
    }
  })
})
