import { useEffect, type RefObject } from 'react'
import { ipc } from '@renderer/lib/ipc'
import { useGenerateStore } from '@renderer/store'

type RecoveryArgs = {
  sessionId: string | undefined
  sessionIdRef: RefObject<string | undefined>
  epochRef: RefObject<number>
  errorMessage: string
}

const shouldIgnore = (
  disposed: boolean,
  requestEpoch: number,
  args: RecoveryArgs
): boolean =>
  disposed || requestEpoch !== args.epochRef.current || args.sessionIdRef.current !== args.sessionId

const reportRestoreError = (args: RecoveryArgs): void => {
  if (args.sessionId) {
    useGenerateStore.getState().setSessionError(args.sessionId, args.errorMessage)
  }
}

export function useRestorePageBeautifyJob(args: RecoveryArgs): void {
  useEffect(() => {
    const { sessionId } = args
    if (!sessionId) return
    let disposed = false
    const requestEpoch = args.epochRef.current
    void ipc
      .getPageBeautifyState(sessionId)
      .then((state) => {
        if (
          shouldIgnore(disposed, requestEpoch, args) ||
          !state.hasActiveRun ||
          state.kind !== 'page-beautify' ||
          !state.targetPageId
        )
          return
        const generateState = useGenerateStore.getState()
        if (generateState.pageBeautifyJobs[sessionId]) return
        generateState.startPageBeautify(sessionId, {
          pageId: state.targetPageId,
          pageNumber: state.targetPageNumber
        })
        generateState.updatePageBeautify(sessionId, {
          runId: state.runId || undefined,
          status: state.status === 'queued' ? 'queued' : 'running',
          progress: state.progress
        })
      })
      .catch(() => {
        if (!shouldIgnore(disposed, requestEpoch, args)) reportRestoreError(args)
      })
    return () => {
      disposed = true
    }
  }, [args.epochRef, args.errorMessage, args.sessionId, args.sessionIdRef])
}

export function useRestoreStyleSwitchJob(args: RecoveryArgs): void {
  useEffect(() => {
    const { sessionId } = args
    if (!sessionId) return
    let disposed = false
    const requestEpoch = args.epochRef.current
    void ipc
      .getStyleSwitchState(sessionId)
      .then((state) => {
        if (shouldIgnore(disposed, requestEpoch, args) || state.status === 'idle') return
        useGenerateStore.getState().setStyleSwitchJob(sessionId, {
          sessionId,
          runId: state.runId || undefined,
          styleId: state.targetStyleId || '',
          styleName: state.targetStyleName || undefined,
          status: state.status,
          progress: state.progress,
          totalPages: state.totalPages,
          error: state.error,
          pages: state.pages
        })
      })
      .catch(() => {
        if (!shouldIgnore(disposed, requestEpoch, args)) reportRestoreError(args)
      })
    return () => {
      disposed = true
    }
  }, [args.epochRef, args.errorMessage, args.sessionId, args.sessionIdRef])
}

export function useRestoreDeckEditJob(args: RecoveryArgs): void {
  useEffect(() => {
    const { sessionId } = args
    if (!sessionId) return
    let disposed = false
    const requestEpoch = args.epochRef.current
    void ipc
      .getDeckEditState(sessionId)
      .then((state) => {
        if (shouldIgnore(disposed, requestEpoch, args) || state.kind !== 'deck-edit') return
        const generateState = useGenerateStore.getState()
        if (state.hasActiveRun) {
          if (generateState.deckEditJobs[sessionId]) return
          generateState.startDeckEdit(sessionId, {
            totalPages: state.totalPages,
            payload: state.retryPayload
          })
          generateState.updateDeckEdit(sessionId, {
            runId: state.runId || undefined,
            status: state.status === 'queued' ? 'queued' : 'running',
            progress: state.progress
          })
          return
        }
        if (
          state.runId &&
          state.retryPayload &&
          Math.max(0, Number(state.failedPageCount) || 0) > 0
        ) {
          generateState.finishDeckEdit(sessionId, {
            runId: state.runId,
            failedPageCount: Math.max(1, Number(state.failedPageCount) || 1),
            payload: state.retryPayload
          })
        }
      })
      .catch(() => {
        if (!shouldIgnore(disposed, requestEpoch, args)) reportRestoreError(args)
      })
    return () => {
      disposed = true
    }
  }, [args.epochRef, args.errorMessage, args.sessionId, args.sessionIdRef])
}

export function useRestorePageEditJob(args: RecoveryArgs): void {
  useEffect(() => {
    const { sessionId } = args
    if (!sessionId) return
    let disposed = false
    const requestEpoch = args.epochRef.current
    void ipc
      .getPageEditState(sessionId)
      .then((state) => {
        if (
          shouldIgnore(disposed, requestEpoch, args) ||
          !state.hasActiveRun ||
          state.kind !== 'page-edit' ||
          !state.targetPageId
        )
          return
        const generateState = useGenerateStore.getState()
        if (generateState.pageEditJobs[sessionId]) return
        generateState.startPageEdit(sessionId, {
          pageId: state.targetPageId,
          pageNumber: state.targetPageNumber
        })
        generateState.updatePageEdit(sessionId, {
          runId: state.runId || undefined,
          status: state.status === 'queued' ? 'queued' : 'running',
          progress: state.progress
        })
      })
      .catch(() => {
        if (!shouldIgnore(disposed, requestEpoch, args)) reportRestoreError(args)
      })
    return () => {
      disposed = true
    }
  }, [args.epochRef, args.errorMessage, args.sessionId, args.sessionIdRef])
}
