import fs from 'fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_JITTER_MAX_MS,
  RATE_LIMIT_RETRY_DELAYS_MS,
  resolveRateLimitBackoff
} from '../../../src/main/generation/rate-limit-backoff'

const noJitter = () => 0
const maxJitter = () => 0.999999

describe('resolveRateLimitBackoff', () => {
  it('schedules the first retry on the short delay with bounded jitter', () => {
    const backoff = resolveRateLimitBackoff({
      attemptsAlreadyUsed: 0,
      cooldownUntil: 0,
      nowMs: 100_000,
      random: noJitter
    })

    expect(backoff).not.toBeNull()
    expect(backoff!.attempt).toBe(1)
    expect(backoff!.cooldownUntil).toBe(100_000 + RATE_LIMIT_RETRY_DELAYS_MS[0])
    expect(backoff!.waitMs).toBe(RATE_LIMIT_RETRY_DELAYS_MS[0])

    const jittered = resolveRateLimitBackoff({
      attemptsAlreadyUsed: 0,
      cooldownUntil: 0,
      nowMs: 100_000,
      random: maxJitter
    })
    expect(jittered!.waitMs).toBeLessThanOrEqual(
      RATE_LIMIT_RETRY_DELAYS_MS[0] + RATE_LIMIT_JITTER_MAX_MS
    )
    expect(jittered!.waitMs).toBeGreaterThan(backoff!.waitMs)
  })

  it('escalates to the long delay on the second attempt and stops after that', () => {
    const second = resolveRateLimitBackoff({
      attemptsAlreadyUsed: 1,
      cooldownUntil: 0,
      nowMs: 0,
      random: noJitter
    })
    expect(second!.attempt).toBe(2)
    expect(second!.waitMs).toBe(RATE_LIMIT_RETRY_DELAYS_MS[1])

    expect(
      resolveRateLimitBackoff({
        attemptsAlreadyUsed: MAX_RATE_LIMIT_RETRIES,
        cooldownUntil: 0,
        nowMs: 0,
        random: noJitter
      })
    ).toBeNull()
  })

  it('never shortens an existing shared cooldown from another worker', () => {
    const existingCooldownUntil = 200_000
    const backoff = resolveRateLimitBackoff({
      attemptsAlreadyUsed: 0,
      cooldownUntil: existingCooldownUntil,
      nowMs: 100_000,
      random: noJitter
    })

    expect(backoff!.cooldownUntil).toBe(existingCooldownUntil)
    expect(backoff!.waitMs).toBe(existingCooldownUntil - 100_000)
  })

  it('extends the shared cooldown when its own delay would end later', () => {
    const backoff = resolveRateLimitBackoff({
      attemptsAlreadyUsed: 1,
      cooldownUntil: 110_000,
      nowMs: 100_000,
      random: noJitter
    })

    expect(backoff!.cooldownUntil).toBe(100_000 + RATE_LIMIT_RETRY_DELAYS_MS[1])
    expect(backoff!.waitMs).toBe(RATE_LIMIT_RETRY_DELAYS_MS[1])
  })
})

describe('agent-runner rate limit retry wiring', () => {
  it('handles rate limit backoff before the system-scope break in the page retry loop', () => {
    // The page retry loop moved out of agent-runner into the single-page
    // generator; the wiring contract follows the code.
    const source = fs.readFileSync('src/main/generation/single-page-generator.ts', 'utf8')
    const rateLimitBranch = source.indexOf(
      "if (failure.code === 'MODEL_RATE_LIMIT') {"
    )
    const systemBreak = source.indexOf('if (failure.scope === \'system\') break', rateLimitBranch)

    expect(rateLimitBranch).toBeGreaterThan(-1)
    // The system break after the rate-limit branch must exist, proving a 429
    // gets its backoff retries first instead of pausing the run immediately.
    expect(systemBreak).toBeGreaterThan(rateLimitBranch)
    expect(source.slice(rateLimitBranch, systemBreak)).toContain('resolveRateLimitBackoff')
    expect(source.slice(rateLimitBranch, systemBreak)).toContain('continue')
  })
})
