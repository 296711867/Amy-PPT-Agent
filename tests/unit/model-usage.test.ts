import { describe, expect, it, vi } from 'vitest'
import {
  ModelUsageCallbackHandler,
  extractModelUsage,
  scopeModelRuntimeToSession
} from '../../src/main/agent-runtime/model'

describe('model usage tracking', () => {
  it('prefers provider-reported usage metadata', () => {
    const usage = extractModelUsage({
      generations: [
        [
          {
            text: 'done',
            message: {
              usage_metadata: {
                input_tokens: 120,
                output_tokens: 35,
                total_tokens: 155
              }
            }
          }
        ]
      ]
    } as never)

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 35,
      totalTokens: 155,
      source: 'provider'
    })
  })

  it('uses heuristic estimates when the provider omits usage', async () => {
    const recordModelUsage = vi.fn(async () => undefined)
    const handler = new ModelUsageCallbackHandler(
      {
        provider: 'openai',
        model: 'compatible-model',
        sessionId: 'session-usage-1'
      },
      { record: recordModelUsage }
    )

    handler.handleLLMStart({} as never, ['Create a concise presentation outline.'], 'run-1')
    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'A short outline with three sections.' }]]
      },
      'run-1'
    )

    expect(recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'compatible-model',
        sessionId: 'session-usage-1',
        source: 'estimated',
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        totalTokens: expect.any(Number)
      })
    )
    const recorded = recordModelUsage.mock.calls[0][0]
    expect(recorded.inputTokens).toBeGreaterThan(0)
    expect(recorded.outputTokens).toBeGreaterThan(0)
    expect(recorded.totalTokens).toBe(recorded.inputTokens + recorded.outputTokens)
  })

  it('does not underestimate non-ASCII fallback usage with the ASCII divisor', async () => {
    const recordModelUsage = vi.fn(async () => undefined)
    const handler = new ModelUsageCallbackHandler(
      {
        provider: 'openai',
        model: 'compatible-model'
      },
      { record: recordModelUsage }
    )

    handler.handleLLMStart({} as never, ['中文测试'], 'run-zh')
    await handler.handleLLMEnd(
      {
        generations: [[{ text: '完成' }]]
      },
      'run-zh'
    )

    expect(recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'estimated',
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6
      })
    )
  })

  it('scopes a shared recorder to one session without mutating the shared runtime', () => {
    const recorder = { record: vi.fn(async () => undefined) }
    const runtime = { recorder }

    const scoped = scopeModelRuntimeToSession(runtime, ' session-42 ')

    expect(scoped).toEqual({ recorder, sessionId: 'session-42' })
    expect(runtime).toEqual({ recorder })
  })
})
