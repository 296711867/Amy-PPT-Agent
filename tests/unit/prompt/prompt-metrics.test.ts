import { describe, expect, it } from 'vitest'
import { measurePromptText } from '../../../src/main/agent-runtime/prompt'

describe('prompt metrics', () => {
  it('returns deterministic log-safe measurements without prompt content', () => {
    const metrics = measurePromptText('abcd中文')

    expect(metrics).toEqual({
      characterCount: 6,
      utf8ByteCount: 10,
      estimatedTokens: 3,
      fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/)
    })
    expect(JSON.stringify(metrics)).not.toContain('abcd中文')
    expect(measurePromptText('abcd中文').fingerprint).toBe(metrics.fingerprint)
    expect(measurePromptText('abcd中英').fingerprint).not.toBe(metrics.fingerprint)
  })

  it('handles empty prompts without inventing token usage', () => {
    expect(measurePromptText('')).toEqual({
      characterCount: 0,
      utf8ByteCount: 0,
      estimatedTokens: 0,
      fingerprint: 'e3b0c44298fc'
    })
  })
})
