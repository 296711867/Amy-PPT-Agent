import { describe, expect, it } from 'vitest'
import { parsePromptCacheLog, summarizePromptCache } from '../../../scripts/check-prompt-cache.mjs'

const jsonStyleLog = [
  '[2026-08-29 18:00:00.101] info: [deepagent] create session deck agent {"sessionId":"session-a","styleId":"blue","generalPurposeSubagentEnabled":false,"systemPromptMetrics":{"characterCount":21000,"utf8ByteCount":23000,"estimatedTokens":6782,"fingerprint":"aaaa1111bbbb"}}',
  '[2026-08-29 18:00:05.222] info: [deepagent] single-page prompt metrics {"sessionId":"session-a","pageId":"pg-1","generationMode":"generate","userPromptMetrics":{"characterCount":2400,"estimatedTokens":510,"fingerprint":"cccc3333dddd"}}',
  '[2026-08-29 18:00:12.333] info: [deepagent] create session deck agent {"sessionId":"session-a","styleId":"blue","generalPurposeSubagentEnabled":false,"systemPromptMetrics":{"characterCount":21000,"utf8ByteCount":23000,"estimatedTokens":6782,"fingerprint":"aaaa1111bbbb"}}',
  '[2026-08-29 18:00:18.444] info: [deepagent] single-page prompt metrics {"sessionId":"session-a","pageId":"pg-2","generationMode":"generate","userPromptMetrics":{"characterCount":3000,"estimatedTokens":640,"fingerprint":"eeee5555ffff"}}'
].join('\n')

const inspectStyleLog = [
  "8/29/2026, 6:00:00 PM info [deepagent] create session deck agent {",
  "  sessionId: 'session-b',",
  '  generalPurposeSubagentEnabled: false,',
  '  systemPromptMetrics: {',
  "    characterCount: 21000,",
  '    utf8ByteCount: 23000,',
  '    estimatedTokens: 6782,',
  "    fingerprint: 'aaaa1111bbbb'",
  '  }',
  '}',
  "8/29/2026, 6:00:06 PM info [deepagent] single-page prompt metrics {",
  "  sessionId: 'session-b',",
  "  pageId: 'pg-1',",
  '  userPromptMetrics: { estimatedTokens: 510, fingerprint: \'cccc3333dddd\' }',
  '}'
].join('\n')

describe('prompt-cache log verification script', () => {
  it('parses single-line JSON-style metric records', () => {
    const parsed = parsePromptCacheLog(jsonStyleLog)

    expect(parsed.systemEvents).toHaveLength(2)
    expect(parsed.systemEvents[0]).toMatchObject({
      sessionId: 'session-a',
      fingerprint: 'aaaa1111bbbb',
      estimatedTokens: 6782
    })
    expect(parsed.userEvents).toHaveLength(2)
    expect(parsed.userEvents[1]).toMatchObject({
      sessionId: 'session-a',
      pageId: 'pg-2',
      estimatedTokens: 640
    })
  })

  it('parses multi-line inspect-style metric records', () => {
    const parsed = parsePromptCacheLog(inspectStyleLog)

    expect(parsed.systemEvents).toHaveLength(1)
    expect(parsed.systemEvents[0]).toMatchObject({
      sessionId: 'session-b',
      fingerprint: 'aaaa1111bbbb',
      estimatedTokens: 6782
    })
    expect(parsed.userEvents).toHaveLength(1)
    expect(parsed.userEvents[0]).toMatchObject({
      sessionId: 'session-b',
      pageId: 'pg-1',
      estimatedTokens: 510
    })
  })

  it('flags a session as cache-stable only when the system fingerprint never changes', () => {
    const stable = summarizePromptCache(parsePromptCacheLog(jsonStyleLog))
    expect(stable).toHaveLength(1)
    expect(stable[0].cacheStable).toBe(true)
    expect(stable[0].distinctSystemFingerprints).toBe(1)
    expect(stable[0].systemEstimatedTokens).toBe(6782)
    expect(stable[0].pages).toBe(2)
    expect(stable[0].userEstimatedTokens).toBe(1150)
    expect(stable[0].userMinTokens).toBe(510)
    expect(stable[0].userMaxTokens).toBe(640)

    const busted = parsePromptCacheLog(
      jsonStyleLog.replace('cccc3333dddd', 'cccc3333dddd').concat(
        '\n[2026-08-29 18:01:00.000] info: [deepagent] create session deck agent {"sessionId":"session-a","systemPromptMetrics":{"estimatedTokens":6900,"fingerprint":"999988887777"}}'
      )
    )
    const unstable = summarizePromptCache(busted)
    expect(unstable[0].cacheStable).toBe(false)
    expect(unstable[0].distinctSystemFingerprints).toBe(2)
  })

  it('groups sessions independently', () => {
    const combined = summarizePromptCache(
      parsePromptCacheLog(`${jsonStyleLog}\n${inspectStyleLog}`)
    )

    expect(combined).toHaveLength(2)
    expect(combined.map((entry) => entry.sessionId).sort()).toEqual(['session-a', 'session-b'])
  })
})
