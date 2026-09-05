import log from 'electron-log/main.js'
import type { GenerateChunkEvent } from '@shared/generation'
import { logAgentToolEvents } from '../utils/agent-tool-logger'

export interface DeckToolStatusChunk {
  type?: string
  label?: string
  detail?: string
  progress?: number
  pageId?: string
  agentName?: string
}

export interface StreamProcessOptions {
  emit?: (chunk: GenerateChunkEvent) => void
  runId: string
  stage: string
  totalPages: number
  provider: string
  model: string
  sessionId: string
  workerLabel?: string
  /**
   * Called for each `deck_tool_status` custom chunk.
   * Return `true` to break the stream loop (e.g. all pages written).
   */
  onCustom?: (custom: DeckToolStatusChunk) => boolean | void
  /** Called when `updates.model` is detected — the model is actively thinking. */
  onModelThinking?: (defaultProgress: number) => void
}

/** Extract the final AI message text carried by an updates-mode chunk. */
export const readAssistantTextFromChunkData = (data: unknown): string => {
  if (!data || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  const messages = Array.isArray(record.messages) ? record.messages : [data]
  let text = ''
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const msgRecord = message as Record<string, unknown>
    const type = String(msgRecord.type ?? msgRecord.role ?? '')
    if (type !== 'ai' && type !== 'assistant') continue
    if (typeof msgRecord.content === 'string' && msgRecord.content.trim()) {
      text = msgRecord.content
    }
  }
  return text
}

const CONVERSATION_MESSAGE_TYPES = new Set(['ai', 'assistant', 'human', 'user', 'tool'])

const readMessageType = (record: Record<string, unknown>): string =>
  String(record.type ?? record.role ?? '')

const readMessageToolCalls = (record: Record<string, unknown>): unknown[] => {
  const direct = record.tool_calls
  if (Array.isArray(direct) && direct.length > 0) return direct
  const chunks = record.tool_call_chunks
  if (Array.isArray(chunks) && chunks.length > 0) return chunks
  const kwargs = record.additional_kwargs as Record<string, unknown> | undefined
  const fromKwargs = kwargs?.tool_calls
  return Array.isArray(fromKwargs) ? fromKwargs : []
}

/**
 * 从 updates 分片里累积主图（不含 subagent 子图）的会话消息，供空回合
 * 续跑时把完整历史发回同一个 agent。RemoveMessage 等非会话消息被过滤。
 */
const collectConversationMessages = (
  data: unknown,
  collected: Map<string, unknown>
): { sawToolCall: boolean; sawHumanMessage: boolean } => {
  let sawToolCall = false
  let sawHumanMessage = false
  if (!data || typeof data !== 'object') return { sawToolCall, sawHumanMessage }
  const messages = (data as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return { sawToolCall, sawHumanMessage }
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const type = readMessageType(record)
    if (!CONVERSATION_MESSAGE_TYPES.has(type)) continue
    const id = typeof record.id === 'string' && record.id ? record.id : `idx:${collected.size}`
    if (collected.has(id)) continue
    collected.set(id, message)
    if (type === 'human' || type === 'user') sawHumanMessage = true
    if (type === 'tool' || readMessageToolCalls(record).length > 0) sawToolCall = true
  }
  return { sawToolCall, sawHumanMessage }
}

export interface AgentStreamCoreResult {
  finalAssistantText: string
  /** 主图会话消息（含 AI/工具轮），供失败回合续跑复用。 */
  conversationMessages: unknown[]
  /** 本轮流内是否出现过任何工具调用或工具结果。 */
  sawToolCall: boolean
  /** 累积消息里是否已包含初始 user 消息。 */
  sawHumanMessage: boolean
}

export async function processAgentStreamCore(
  stream: AsyncIterable<unknown>,
  options: StreamProcessOptions
): Promise<AgentStreamCoreResult> {
  const { sessionId, workerLabel, onCustom, onModelThinking } = options
  let firstChunkLogged = false
  const seenToolEvents = new Set<string>()
  let finalAssistantText = ''
  const collectedMessages = new Map<string, unknown>()
  let sawToolCall = false
  let sawHumanMessage = false

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      firstChunkLogged = true
      log.info('[deepagent] stream first chunk', { sessionId, worker: workerLabel })
    }
    if (!Array.isArray(chunk) || chunk.length < 3) continue
    const parts = chunk as unknown[]
    const namespace = parts[0]
    const mode = parts[1] as string
    const data = parts[2]

    // subgraphs 模式下子图（subagent）命名空间是非空数组；主图是空数组。
    // 会话消息只从主图收集，避免把 subagent 内部历史混进主会话。
    const isMainGraph = !Array.isArray(namespace) || namespace.length === 0

    if (mode === 'updates') {
      logAgentToolEvents(data, seenToolEvents, { tag: 'deepagent', source: 'updates' })
      const assistantText = readAssistantTextFromChunkData(data)
      if (assistantText) finalAssistantText = assistantText
      if (isMainGraph) {
        const collected = collectConversationMessages(data, collectedMessages)
        sawToolCall = sawToolCall || collected.sawToolCall
        sawHumanMessage = sawHumanMessage || collected.sawHumanMessage
      }
    } else if (mode === 'messages') {
      logAgentToolEvents(data, seenToolEvents, { tag: 'deepagent', source: 'messages' })
    }

    if (mode === 'custom' && data && typeof data === 'object') {
      const custom = data as DeckToolStatusChunk
      if (custom.type === 'deck_tool_status' && custom.label) {
        const shouldBreak = onCustom?.(custom)
        if (shouldBreak) break
      }
      continue
    }

    if (mode === 'updates' && data && typeof data === 'object') {
      const updates = data as Record<string, unknown>
      if (updates.model) onModelThinking?.(42)
    }
  }

  return {
    finalAssistantText,
    conversationMessages: [...collectedMessages.values()],
    sawToolCall,
    sawHumanMessage
  }
}
