import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logInfo, logAgentToolEvents } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logAgentToolEvents: vi.fn()
}))

vi.mock('electron-log/main.js', () => ({
  default: { info: logInfo, warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../src/main/utils/agent-tool-logger', () => ({
  logAgentToolEvents
}))

import {
  processAgentStreamCore,
  readAssistantTextFromChunkData
} from '../../../src/main/generation/agent-stream-processor'

async function* chunks(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value
}

describe('agent stream processor', () => {
  beforeEach(() => {
    logInfo.mockClear()
    logAgentToolEvents.mockClear()
  })

  it('reads the final non-empty assistant message', () => {
    expect(
      readAssistantTextFromChunkData({
        messages: [
          { role: 'user', content: 'question' },
          { type: 'ai', content: 'first' },
          { role: 'assistant', content: 'final' }
        ]
      })
    ).toBe('final')
    expect(readAssistantTextFromChunkData(null)).toBe('')
  })

  it('processes updates, messages, custom status, and thinking callbacks', async () => {
    const onCustom = vi.fn()
    const onModelThinking = vi.fn()
    const result = await processAgentStreamCore(
      chunks([
        ['root', 'invalid'],
        ['root', 'messages', { messages: [] }],
        ['root', 'updates', { model: true, messages: [{ type: 'ai', content: 'done' }] }],
        ['root', 'custom', { type: 'deck_tool_status', label: 'written', progress: 80 }]
      ]),
      {
        runId: 'run-1',
        stage: 'generating',
        totalPages: 2,
        provider: 'test',
        model: 'test-model',
        sessionId: 'session-1',
        onCustom,
        onModelThinking
      }
    )

    expect(result.finalAssistantText).toBe('done')
    expect(onModelThinking).toHaveBeenCalledWith(42)
    expect(onCustom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deck_tool_status', label: 'written' })
    )
    expect(logAgentToolEvents).toHaveBeenCalledTimes(2)
    expect(logInfo).toHaveBeenCalledTimes(1)
  })

  it('stops consuming when the custom callback requests it', async () => {
    const onModelThinking = vi.fn()
    const result = await processAgentStreamCore(
      chunks([
        ['root', 'updates', { messages: [{ role: 'assistant', content: 'before' }] }],
        ['root', 'custom', { type: 'deck_tool_status', label: 'complete' }],
        ['root', 'updates', { model: true, messages: [{ role: 'assistant', content: 'after' }] }]
      ]),
      {
        runId: 'run-2',
        stage: 'generating',
        totalPages: 1,
        provider: 'test',
        model: 'test-model',
        sessionId: 'session-2',
        onCustom: () => true,
        onModelThinking
      }
    )

    expect(result.finalAssistantText).toBe('before')
    expect(onModelThinking).not.toHaveBeenCalled()
  })
})
