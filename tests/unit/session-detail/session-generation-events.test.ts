// @vitest-environment happy-dom

import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateChunkEvent } from '../../../src/shared/generation'

const ipcState = vi.hoisted(() => ({
  handler: undefined as ((event: GenerateChunkEvent) => void) | undefined,
  unsubscribe: vi.fn(),
  onGenerateChunk: vi.fn((handler: (event: GenerateChunkEvent) => void) => {
    ipcState.handler = handler
    return ipcState.unsubscribe
  })
}))

vi.mock('../../../src/renderer/src/lib/ipc', () => ({ ipc: ipcState }))
vi.mock('../../../src/renderer/src/i18n', () => ({
  useT: () => (key: string) => key
}))

import { useSessionGenerationEvents } from '../../../src/renderer/src/components/session-detail/hooks/useSessionGenerationEvents'
import {
  useGenerateStore,
  useSessionStore,
  useToastStore
} from '../../../src/renderer/src/store'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('session generation events', () => {
  const finishPageBeautify = vi.fn()
  const loadSession = vi.fn(async () => true)
  const toastSuccess = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ipcState.handler = undefined
    useGenerateStore.setState({
      pageBeautifyJobs: {
        'session-1': {
          sessionId: 'session-1',
          pageId: 'page-1',
          runId: 'run-1',
          status: 'running',
          label: 'Beautifying',
          progress: 80
        }
      },
      pageEditJobs: {},
      deckEditJobs: {},
      styleSwitchJobs: {},
      finishPageBeautify
    })
    useSessionStore.setState({ loadSession })
    useToastStore.setState({ success: toastSuccess })
  })

  it('deduplicates repeated terminal events for the same run', async () => {
    const Harness = (): React.JSX.Element | null => {
      const pageEditStateEpochRef = useRef(0)
      const pageBeautifyStateEpochRef = useRef(0)
      const deckEditStateEpochRef = useRef(0)
      const styleSwitchStateEpochRef = useRef(0)
      useSessionGenerationEvents({
        sessionId: 'session-1',
        activeChatType: 'page',
        activePageId: 'page-1',
        pageEditStateEpochRef,
        pageBeautifyStateEpochRef,
        deckEditStateEpochRef,
        styleSwitchStateEpochRef
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(React.createElement(Harness)))

    const event = {
      type: 'run_completed',
      payload: {
        sessionId: 'session-1',
        runId: 'run-1',
        activityKind: 'page-beautify',
        outcome: 'updated'
      }
    } as GenerateChunkEvent
    await act(async () => {
      ipcState.handler?.(event)
      ipcState.handler?.(event)
      await Promise.resolve()
    })

    expect(finishPageBeautify).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('sessionDetail.pageBeautifyCompleted')
    expect(loadSession).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    expect(ipcState.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
