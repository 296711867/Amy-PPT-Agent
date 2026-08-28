// @vitest-environment happy-dom

import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  getPageBeautifyState: vi.fn(),
  getStyleSwitchState: vi.fn(),
  getDeckEditState: vi.fn(),
  getPageEditState: vi.fn()
}))

vi.mock('../../../src/renderer/src/lib/ipc', () => ({ ipc: ipcState }))

import {
  useRestoreDeckEditJob,
  useRestorePageBeautifyJob,
  useRestorePageEditJob,
  useRestoreStyleSwitchJob
} from '../../../src/renderer/src/components/session-detail/hooks/useSessionJobRecovery'
import { useGenerateStore } from '../../../src/renderer/src/store/generateStore'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('session job recovery', () => {
  const startPageBeautify = vi.fn()
  const updatePageBeautify = vi.fn()
  const setStyleSwitchJob = vi.fn()
  const startDeckEdit = vi.fn()
  const updateDeckEdit = vi.fn()
  const finishDeckEdit = vi.fn()
  const startPageEdit = vi.fn()
  const updatePageEdit = vi.fn()
  const setSessionError = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useGenerateStore.setState({
      pageBeautifyJobs: {},
      styleSwitchJobs: {},
      deckEditJobs: {},
      pageEditJobs: {},
      startPageBeautify,
      updatePageBeautify,
      setStyleSwitchJob,
      startDeckEdit,
      updateDeckEdit,
      finishDeckEdit,
      startPageEdit,
      updatePageEdit,
      setSessionError
    })
  })

  it('hydrates each job kind through its matching store actions', async () => {
    ipcState.getPageBeautifyState.mockResolvedValue({
      hasActiveRun: true,
      kind: 'page-beautify',
      targetPageId: 'beautify-page',
      targetPageNumber: 1,
      runId: 'beautify-run',
      status: 'running',
      progress: 40
    })
    ipcState.getStyleSwitchState.mockResolvedValue({
      status: 'running',
      runId: 'style-run',
      targetStyleId: 'style-1',
      targetStyleName: 'Editorial',
      progress: 30,
      totalPages: 4,
      error: null,
      pages: []
    })
    ipcState.getDeckEditState.mockResolvedValue({
      hasActiveRun: true,
      kind: 'deck-edit',
      totalPages: 4,
      retryPayload: undefined,
      runId: 'deck-run',
      status: 'queued',
      progress: 20
    })
    ipcState.getPageEditState.mockResolvedValue({
      hasActiveRun: true,
      kind: 'page-edit',
      targetPageId: 'edit-page',
      targetPageNumber: 2,
      runId: 'edit-run',
      status: 'running',
      progress: 55
    })

    const Harness = (): React.JSX.Element | null => {
      const sessionIdRef = useRef<string | undefined>('session-1')
      const beautifyEpoch = useRef(0)
      const styleEpoch = useRef(0)
      const deckEpoch = useRef(0)
      const pageEpoch = useRef(0)
      const shared = { sessionId: 'session-1', sessionIdRef, errorMessage: 'restore failed' }
      useRestorePageBeautifyJob({ ...shared, epochRef: beautifyEpoch })
      useRestoreStyleSwitchJob({ ...shared, epochRef: styleEpoch })
      useRestoreDeckEditJob({ ...shared, epochRef: deckEpoch })
      useRestorePageEditJob({ ...shared, epochRef: pageEpoch })
      return null
    }
    const root = createRoot(document.createElement('div'))

    await act(async () => root.render(React.createElement(Harness)))

    expect(startPageBeautify).toHaveBeenCalledWith('session-1', {
      pageId: 'beautify-page',
      pageNumber: 1
    })
    expect(updatePageBeautify).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ runId: 'beautify-run', progress: 40 })
    )
    expect(setStyleSwitchJob).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ styleId: 'style-1', runId: 'style-run' })
    )
    expect(startDeckEdit).toHaveBeenCalledWith('session-1', {
      totalPages: 4,
      payload: undefined
    })
    expect(updateDeckEdit).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ status: 'queued', runId: 'deck-run' })
    )
    expect(startPageEdit).toHaveBeenCalledWith('session-1', {
      pageId: 'edit-page',
      pageNumber: 2
    })
    expect(updatePageEdit).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ runId: 'edit-run', progress: 55 })
    )
    expect(setSessionError).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
