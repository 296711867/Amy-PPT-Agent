import { describe, expect, it } from 'vitest'
import { classifyGenerationError } from '../../../src/shared/generation-error'

describe('classifyGenerationError', () => {
  it('classifies a malformed Responses payload as a system pause', () => {
    const failure = classifyGenerationError(
      new TypeError("Cannot read properties of undefined (reading 'map')")
    )

    expect(failure).toMatchObject({
      code: 'MODEL_RESPONSE_FORMAT',
      scope: 'system',
      action: 'pause-run',
      retryable: false
    })
  })

  it('classifies middleware response contract failures as a system pause', () => {
    const failure = classifyGenerationError(
      new Error(
        'Invalid response from "wrapModelCall" in middleware "thinkingToolAllowlist": expected AIMessage or Command, got object'
      )
    )

    expect(failure).toMatchObject({
      code: 'MODEL_RESPONSE_FORMAT',
      scope: 'system',
      action: 'pause-run',
      retryable: false
    })
  })

  it('classifies connection and authentication failures as system failures', () => {
    expect(classifyGenerationError(new Error('fetch failed: ECONNRESET'))).toMatchObject({
      code: 'MODEL_CONNECTION',
      scope: 'system'
    })
    expect(classifyGenerationError(new Error('401 Unauthorized'))).toMatchObject({
      code: 'MODEL_AUTH',
      scope: 'system'
    })
  })

  it('classifies billing errors as non-retryable quota failures even with a 429 prefix', () => {
    const zhipuQuota = classifyGenerationError(new Error('429 余额不足或无可用资源，请充值。\n'))
    const openaiQuota = classifyGenerationError(
      new Error('429 You exceeded your current quota, please check your plan and billing details')
    )
    const dailyQuota = classifyGenerationError(
      new Error('429 Daily usage quota exhausted for this platform')
    )

    for (const failure of [zhipuQuota, openaiQuota, dailyQuota]) {
      expect(failure).toMatchObject({
        code: 'MODEL_QUOTA',
        scope: 'system',
        action: 'pause-run',
        retryable: false
      })
    }
    expect(zhipuQuota.titleZh).toBe('模型额度不足')
  })

  it('still classifies plain rate limits as retryable system failures', () => {
    expect(classifyGenerationError(new Error('429 Too many requests'))).toMatchObject({
      code: 'MODEL_RATE_LIMIT',
      scope: 'system',
      action: 'pause-run',
      retryable: true
    })
  })

  it('classifies 503/502 service unavailable as rate-limit-class transient failures', () => {
    for (const message of [
      '503 Service temporarily unavailable',
      '502 Bad Gateway',
      'The service is overloaded'
    ]) {
      const failure = classifyGenerationError(new Error(message))
      expect(failure, message).toMatchObject({
        code: 'MODEL_RATE_LIMIT',
        scope: 'system',
        action: 'pause-run',
        retryable: true
      })
    }
    expect(classifyGenerationError(new Error('503 Service temporarily unavailable')).titleZh).toBe(
      '模型服务暂不可用'
    )
  })

  it('keeps HTML validation failures scoped to one page', () => {
    expect(classifyGenerationError(new Error('HTML 落盘校验失败：存在未闭合标签'))).toMatchObject({
      code: 'PAGE_WRITE',
      scope: 'page',
      action: 'retry-page'
    })
  })

  it('keeps harness quality failures page-scoped and retryable', () => {
    expect(
      classifyGenerationError(
        new Error('质量校验未通过 (page-2)：[font-below-floor] 正文显式字号 14px')
      )
    ).toMatchObject({
      code: 'PAGE_VALIDATION',
      scope: 'page',
      action: 'retry-page',
      retryable: true
    })
  })

  it('keeps rendered quality failures in the same-page repair loop', () => {
    expect(
      classifyGenerationError(
        new Error('浏览器渲染校验未通过 (page-4)：[render-text-clipped] 正文被容器裁切')
      )
    ).toMatchObject({
      code: 'PAGE_VALIDATION',
      scope: 'page',
      action: 'retry-page',
      retryable: true
    })
  })

  it('keeps deck contract failures scoped to the responsible page', () => {
    expect(
      classifyGenerationError(
        new Error('Deck-level quality review: [deck-font-system-drift] core font changed')
      )
    ).toMatchObject({
      code: 'PAGE_VALIDATION',
      scope: 'page',
      action: 'retry-page',
      retryable: true
    })
  })

  it('does not classify a real generation cancellation as a model failure', () => {
    expect(classifyGenerationError(new Error('Generation canceled'))).toMatchObject({
      code: 'UNKNOWN',
      scope: 'page',
      retryable: true
    })
  })

  it('normalizes volatile ids in fingerprints', () => {
    const first = classifyGenerationError(
      new Error('request 12345 failed for 945bdd75-92a9-413a-b54a-f682e0e786e2: ECONNRESET')
    )
    const second = classifyGenerationError(
      new Error('request 67890 failed for 145bdd75-92a9-413a-b54a-f682e0e786e2: ECONNRESET')
    )

    expect(first.fingerprint).toBe(second.fingerprint)
  })
})
