import { useEffect, useRef } from 'react'
import { ipc } from '@renderer/lib/ipc'
import {
  useEditHistoryStore,
  useEditSessionStore,
  useGenerateStore,
  useSessionDetailUiStore,
  useSessionStore
} from '@renderer/store'

export function useSessionDetailLifecycle(sessionId: string | undefined) {
  const sessionIdRef = useRef(sessionId)
  const sessionStateEpochRef = useRef(0)
  const pageEditStateEpochRef = useRef(0)
  const pageBeautifyStateEpochRef = useRef(0)
  const deckEditStateEpochRef = useRef(0)
  const styleSwitchStateEpochRef = useRef(0)
  sessionIdRef.current = sessionId

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const invalidateRequests = (): void => {
      sessionStateEpochRef.current += 1
      pageEditStateEpochRef.current += 1
      pageBeautifyStateEpochRef.current += 1
      deckEditStateEpochRef.current += 1
      styleSwitchStateEpochRef.current += 1
    }

    invalidateRequests()
    const sessionStore = useSessionStore.getState()
    sessionStore.resetRuntimeState()
    sessionStore.setMessages([])
    useGenerateStore.getState().setPages([])
    useSessionDetailUiStore.getState().resetForSessionChange()
    sessionStore.setLoading(true)

    void (async () => {
      try {
        await ipc.migratePageOutlinesToSourceSkeletons({ sessionId })
      } catch (error) {
        console.warn('[session] migrate page outlines failed', error)
      }
      if (!cancelled) {
        await sessionStore.loadSession(sessionId, () => !cancelled)
      }
    })()

    return () => {
      cancelled = true
      invalidateRequests()
      useSessionStore.getState().resetRuntimeState()
      useGenerateStore.getState().reset()
      useSessionDetailUiStore.getState().resetForSessionChange()
      useEditHistoryStore.getState().clear()
      useEditSessionStore.getState().resetForPage()
    }
  }, [sessionId])

  return {
    sessionIdRef,
    sessionStateEpochRef,
    pageEditStateEpochRef,
    pageBeautifyStateEpochRef,
    deckEditStateEpochRef,
    styleSwitchStateEpochRef
  }
}
