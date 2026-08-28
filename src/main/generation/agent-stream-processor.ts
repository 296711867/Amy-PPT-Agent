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

export async function processAgentStreamCore(
  stream: AsyncIterable<unknown>,
  options: StreamProcessOptions
): Promise<{ finalAssistantText: string }> {
  const { sessionId, workerLabel, onCustom, onModelThinking } = options
  let firstChunkLogged = false
  const seenToolEvents = new Set<string>()
  let finalAssistantText = ''

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      firstChunkLogged = true
      log.info('[deepagent] stream first chunk', { sessionId, worker: workerLabel })
    }
    if (!Array.isArray(chunk) || chunk.length < 3) continue
    const parts = chunk as unknown[]
    const mode = parts[1] as string
    const data = parts[2]

    if (mode === 'updates') {
      logAgentToolEvents(data, seenToolEvents, { tag: 'deepagent', source: 'updates' })
      const assistantText = readAssistantTextFromChunkData(data)
      if (assistantText) finalAssistantText = assistantText
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

  return { finalAssistantText }
}
