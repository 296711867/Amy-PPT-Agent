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

  it('collects main-graph conversation messages and flags tool activity', async () => {
    const result = await processAgentStreamCore(
      chunks([
        [[], 'updates', { messages: [{ id: 'a1', type: 'ai', content: '', tool_calls: [{ id: 'c1' }] }] }],
        [
          [],
          'updates',
          { tools: { update_single_page_file: 'ok' }, messages: [{ id: 't1', type: 'tool', tool_call_id: 'c1', content: 'done' }] }
        ],
        [[], 'updates', { messages: [{ id: 'a1', type: 'ai', content: '', tool_calls: [{ id: 'c1' }] }] }]
      ]),
      {
        runId: 'run-3',
        stage: 'rendering',
        totalPages: 1,
        provider: 'test',
        model: 'test-model',
        sessionId: 'session-3'
      }
    )

    expect(result.sawToolCall).toBe(true)
    expect(result.sawHumanMessage).toBe(false)
    // 同 id 消息在多个 updates 分片重复出现时只保留一份
    expect(result.conversationMessages).toHaveLength(2)
  })

  it('reports an empty turn as no tool calls and no human message in history', async () => {
    const result = await processAgentStreamCore(
      chunks([[[], 'updates', { model: true, messages: [{ id: 'a1', type: 'ai', content: '' }] }]]),
      {
        runId: 'run-4',
        stage: 'rendering',
        totalPages: 1,
        provider: 'test',
        model: 'test-model',
        sessionId: 'session-4'
      }
    )

    expect(result.finalAssistantText).toBe('')
    expect(result.sawToolCall).toBe(false)
    expect(result.sawHumanMessage).toBe(false)
    expect(result.conversationMessages).toHaveLength(1)
  })

  it('ignores subagent subgraph updates when collecting conversation messages', async () => {
    const result = await processAgentStreamCore(
      chunks([
        [
          ['subagents:general-purpose'],
          'updates',
          { messages: [{ id: 'sub-1', type: 'ai', content: 'inner', tool_calls: [{ id: 'sub-c1' }] }] }
        ],
        [[], 'updates', { messages: [{ id: 'a1', type: 'ai', content: '' }] }]
      ]),
      {
        runId: 'run-5',
        stage: 'rendering',
        totalPages: 1,
        provider: 'test',
        model: 'test-model',
        sessionId: 'session-5'
      }
    )

    expect(result.sawToolCall).toBe(false)
    expect(result.conversationMessages).toHaveLength(1)
    expect((result.conversationMessages[0] as { id?: string }).id).toBe('a1')
  })
})
