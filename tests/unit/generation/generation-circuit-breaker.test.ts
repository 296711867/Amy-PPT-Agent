import { describe, expect, it } from 'vitest'
import { createGenerationCircuitBreaker } from '../../../src/shared/generation-circuit-breaker'
import { classifyGenerationError } from '../../../src/shared/generation-error'

describe('createGenerationCircuitBreaker', () => {
  it('requires two matching transient system failures before pausing new dispatches', () => {
    const breaker = createGenerationCircuitBreaker()
    const failure = classifyGenerationError(new Error('fetch failed: ECONNRESET'))

    expect(breaker.registerFailure(failure)).toMatchObject({ paused: false, occurrences: 1 })
    expect(breaker.registerFailure(failure)).toMatchObject({ paused: true, occurrences: 2 })
  })

  it('pauses immediately for a non-retryable system failure', () => {
    const breaker = createGenerationCircuitBreaker()
    const failure = classifyGenerationError(new Error('401 unauthorized'))

    expect(breaker.registerFailure(failure)).toMatchObject({ paused: true, occurrences: 1 })
  })

  it('does not pause the queue for a page-scoped validation failure', () => {
    const breaker = createGenerationCircuitBreaker()
    const failure = classifyGenerationError(new Error('页面验证失败：缺少 <html>'))

    expect(breaker.registerFailure(failure)).toMatchObject({
      paused: false,
      failure: null,
      occurrences: 0
    })
  })
})
