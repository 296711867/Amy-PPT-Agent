import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import type { FontSelection, SessionStyleSelection, SourceDocumentPlan } from '@shared/generation'
import type { SlideSizePresetId } from '@shared/slide-size'

export const SESSION_NOT_FOUND_ERROR = 'Session not found'
export const SESSION_LOAD_ERROR = 'Failed to load session'

export interface Session {
  id: string
  title: string
  topic: string | null
  styleId: string | null
  page_count: number | null
  slideSizeId?: SlideSizePresetId
  slideWidth?: number
  slideHeight?: number
  referenceDocumentPath?: string | null
  reference_document_path?: string | null
  status: string
  provider: string
  model: string
  created_at: number
  updated_at: number
  metadata: string | null
  designContract?: string | null
  generation_duration_sec?: number | null
  generated_count?: number | null
  failed_count?: number | null
  totalTokens?: number | null
  thumbnailPath?: string | null
}

export interface Message {
  id: string
  session_id: string
  chat_scope: 'main' | 'page'
  page_id: string | null
  selector?: string | null
  image_paths?: string[] | null
  video_paths?: string[] | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  type: string
  tool_name: string | null
  tool_call_id: string | null
  token_count: number | null
  run_model?: string | null
  created_at: number
}

export interface GeneratedPage {
  id: string
  pageNumber: number
  title: string
  contentOutline?: string | null
  html: string
  htmlPath?: string
  pageId?: string
  sourceUrl?: string
  status?: string
  error?: string | null
}

interface SessionStore {
  sessions: Session[]
  currentSession: Session | null
  currentMessages: Message[]
  currentGeneratedPages: GeneratedPage[]
  loading: boolean
  error: string | null

  fetchSessions: () => Promise<void>
  createSession: (payload: {
    topic: string
    styleId?: string
    styleSelection?: SessionStyleSelection
    modelConfigId?: string
    pageCount?: number
    slideSizeId?: SlideSizePresetId
    referenceDocumentPath?: string
    fontSelection?: FontSelection
    imagePolicy?: import('@shared/generation').ImagePolicy
    generationMode?: import('@shared/generation').GenerationMode
    deckBackgroundPolicy?: import('@shared/generation').DeckBackgroundPolicy
    sourcePlan?: SourceDocumentPlan
  }) => Promise<string>
  loadSession: (sessionId: string, guard?: () => boolean) => Promise<boolean>
  loadMessages: (payload: {
    sessionId: string
    chatType: 'main' | 'page'
    pageId?: string
  }) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  updateSessionTitle: (payload: { sessionId: string; title: string }) => Promise<void>
  importSessionFile: () => Promise<{
    cancelled?: boolean
    sessionId?: string
    title?: string
    pageCount?: number
    warnings?: string[]
  }>
  setCurrentSession: (session: Session | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  resetRuntimeState: () => void
}

const isSameRecentMessage = (left: Message, right: Message): boolean =>
  left.role === right.role &&
  left.chat_scope === right.chat_scope &&
  left.page_id === right.page_id &&
  left.content === right.content &&
  Math.abs(left.created_at - right.created_at) <= 1

const dedupeMessages = (messages: Message[]): Message[] => {
  const result: Message[] = []
  const seenIds = new Set<string>()
  for (const message of messages) {
    if (seenIds.has(message.id)) continue
    if (result.some((item) => isSameRecentMessage(item, message))) continue
    seenIds.add(message.id)
    result.push(message)
  }
  return result
}

const sortMessages = (messages: Message[]): Message[] =>
  [...messages].sort((left, right) => left.created_at - right.created_at)

const messageMatchesContext = (
  message: Message,
  sessionId: string,
  chatType: 'main' | 'page',
  pageId?: string
): boolean =>
  message.session_id === sessionId &&
  message.chat_scope === chatType &&
  (chatType === 'main' || message.page_id === pageId)

export const useSessionStore = create<SessionStore>((set, get) => {
  let sessionLoadEpoch = 0
  let messageLoadEpoch = 0

  return {
    sessions: [],
    currentSession: null,
    currentMessages: [],
    currentGeneratedPages: [],
    loading: false,
    error: null,

    fetchSessions: async () => {
      try {
        const sessions = await ipc.listSessions()
        set({ sessions: sessions as unknown as Session[] })
      } catch {
        set({ error: 'Failed to fetch sessions' })
      }
    },

    createSession: async (payload) => {
      const { sessionId } = await ipc.createSession(payload)
      await get().fetchSessions()
      return sessionId
    },

    loadSession: async (sessionId, guard) => {
      const requestEpoch = ++sessionLoadEpoch
      const isCurrentRequest = (): boolean =>
        requestEpoch === sessionLoadEpoch && (!guard || guard())
      const isSameSessionReload = get().currentSession?.id === sessionId

      set({
        ...(isSameSessionReload
          ? {}
          : {
              currentSession: null,
              currentGeneratedPages: []
            }),
        loading: true,
        error: null
      })
      try {
        const { session, generatedPages } = await ipc.getSession(sessionId)
        if (!isCurrentRequest()) return false
        const normalizedSession = (session as unknown as Session | null | undefined) ?? null
        set({
          currentSession: normalizedSession,
          // 消息由页面上下文独立管理。刷新会话/页面数据时不能清空正在显示的对话。
          currentGeneratedPages: normalizedSession ? generatedPages || [] : [],
          error: normalizedSession ? null : SESSION_NOT_FOUND_ERROR,
          loading: false
        })
        return Boolean(normalizedSession)
      } catch {
        if (!isCurrentRequest()) return false
        set({
          ...(isSameSessionReload
            ? {}
            : {
                currentSession: null,
                currentGeneratedPages: []
              }),
          error: SESSION_LOAD_ERROR,
          loading: false
        })
        return false
      }
    },

    loadMessages: async ({ sessionId, chatType, pageId }) => {
      const requestEpoch = ++messageLoadEpoch
      const requestSessionEpoch = sessionLoadEpoch
      const isCurrentRequest = (): boolean =>
        requestEpoch === messageLoadEpoch &&
        requestSessionEpoch === sessionLoadEpoch &&
        get().currentSession?.id === sessionId
      try {
        const messages = await ipc.getSessionMessages({ sessionId, chatType, pageId })
        const loadedMessages = (messages as unknown as Message[]).filter(
          (message) => message.role === 'user' || message.role === 'assistant'
        )
        set((state) => {
          if (!isCurrentRequest() || state.currentSession?.id !== sessionId) {
            return state
          }
          const pendingMessages = state.currentMessages.filter((message) =>
            messageMatchesContext(message, sessionId, chatType, pageId)
          )
          return {
            currentMessages: sortMessages(dedupeMessages([...loadedMessages, ...pendingMessages]))
          }
        })
      } catch {
        if (isCurrentRequest()) set({ error: 'Failed to load messages' })
      }
    },

    deleteSession: async (sessionId) => {
      await ipc.deleteSession(sessionId)
      await get().fetchSessions()
      if (get().currentSession?.id === sessionId) {
        set({ currentSession: null, currentMessages: [], currentGeneratedPages: [] })
      }
    },

    updateSessionTitle: async ({ sessionId, title }) => {
      await ipc.updateSessionTitle({ sessionId, title })
      await get().fetchSessions()
      const currentSession = get().currentSession
      if (currentSession?.id === sessionId) {
        set({ currentSession: { ...currentSession, title } })
      }
    },

    importSessionFile: async () => {
      const result = await ipc.importSessionFile()
      if (!result.cancelled) {
        await get().fetchSessions()
      }
      return result
    },

    setCurrentSession: (session) => set({ currentSession: session }),
    setMessages: (messages) => set({ currentMessages: sortMessages(dedupeMessages(messages)) }),
    addMessage: (message) =>
      set((state) => {
        const hasSameId = state.currentMessages.some((item) => item.id === message.id)
        if (hasSameId) return state

        const hasSameRecentMessage = state.currentMessages.some((item) =>
          isSameRecentMessage(item, message)
        )
        if (hasSameRecentMessage) return state

        return { currentMessages: sortMessages([...state.currentMessages, message]) }
      }),
    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),
    resetRuntimeState: () =>
      (() => {
        sessionLoadEpoch += 1
        messageLoadEpoch += 1
        set({
          currentSession: null,
          currentMessages: [],
          currentGeneratedPages: [],
          loading: false,
          error: null
        })
      })()
  }
})
