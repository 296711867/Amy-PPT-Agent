// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  migratePageOutlinesToSourceSkeletons: vi.fn()
}))

vi.mock('../../../src/renderer/src/lib/ipc', () => ({ ipc: ipcState }))

import { useSessionDetailLifecycle } from '../../../src/renderer/src/components/session-detail/hooks/useSessionDetailLifecycle'
import {
  useEditHistoryStore,
  useEditSessionStore,
  useGenerateStore,
  useSessionDetailUiStore,
  useSessionStore
} from '../../../src/renderer/src/store'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('session detail lifecycle', () => {
  const resetRuntimeState = vi.fn()
  const setMessages = vi.fn()
  const setLoading = vi.fn()
  const loadSession = vi.fn(async () => true)
  const setPages = vi.fn()
  const resetGeneration = vi.fn()
  const resetForSessionChange = vi.fn()
  const clearHistory = vi.fn()
  const resetForPage = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ipcState.migratePageOutlinesToSourceSkeletons.mockResolvedValue(undefined)
    useSessionStore.setState({ resetRuntimeState, setMessages, setLoading, loadSession })
    useGenerateStore.setState({ setPages, reset: resetGeneration })
    useSessionDetailUiStore.setState({ resetForSessionChange })
    useEditHistoryStore.setState({ clear: clearHistory })
    useEditSessionStore.setState({ resetForPage })
  })

  it('initializes, loads after migration, invalidates requests, and cleans up', async () => {
    let lifecycle: ReturnType<typeof useSessionDetailLifecycle> | undefined
    const Harness = ({ sessionId }: { sessionId: string }): React.JSX.Element | null => {
      lifecycle = useSessionDetailLifecycle(sessionId)
      return null
    }
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(React.createElement(Harness, { sessionId: 'session-1' }))
    })

    expect(resetRuntimeState).toHaveBeenCalledTimes(1)
    expect(setMessages).toHaveBeenCalledWith([])
    expect(setPages).toHaveBeenCalledWith([])
    expect(setLoading).toHaveBeenCalledWith(true)
    expect(ipcState.migratePageOutlinesToSourceSkeletons).toHaveBeenCalledWith({
      sessionId: 'session-1'
    })
    expect(loadSession).toHaveBeenCalledWith('session-1', expect.any(Function))
    expect(lifecycle?.sessionStateEpochRef.current).toBe(1)

    await act(async () => root.unmount())

    expect(lifecycle?.sessionStateEpochRef.current).toBe(2)
    expect(resetGeneration).toHaveBeenCalledTimes(1)
    expect(clearHistory).toHaveBeenCalledTimes(1)
    expect(resetForPage).toHaveBeenCalledTimes(1)
    expect(resetForSessionChange).toHaveBeenCalledTimes(2)
  })
})
