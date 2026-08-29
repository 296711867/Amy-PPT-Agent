// Verifies provider prompt-cache friendliness from real generation logs.
//
// The deck agent factory logs a log-safe systemPromptMetrics object per agent
// creation, and the single-page runner logs userPromptMetrics per page. Within
// one deck every page must produce a byte-identical system prompt, i.e. one
// fingerprint per session. Run after a real multi-page generation:
//
//   node scripts/check-prompt-cache.mjs [path/to/main.log]
//
// Without an argument it falls back to the default electron-log location.
// Exits 1 when any session shows more than one system fingerprint.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const SYSTEM_MARKER = 'create session deck agent'
const USER_MARKER = 'single-page prompt metrics'
const TIMESTAMP_START = /^(\d{1,2}\/\d{1,2}\/\d{2,4}, |\d{4}-\d{2}-\d{2}[T ]|\[\d{4}-\d{2}-\d{2} )/

const fieldString = (text, key) => {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"|${key}\\s*:\\s*'([^']+)'`).exec(text)
  return match ? (match[1] ?? match[2] ?? null) : null
}

const fieldNumber = (text, key) => {
  const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)|${key}\\s*:\\s*(\\d+)`).exec(text)
  return match ? Number(match[1] ?? match[2]) : null
}

/**
 * electron-log renders objects either as one JSON line or as a multi-line
 * util.inspect block; buffer every line after a marker until the next
 * timestamped record so both shapes parse.
 */
export function parsePromptCacheLog(text) {
  const systemEvents = []
  const userEvents = []
  let buffer = null

  const flush = () => {
    if (!buffer) return
    const { kind, lines } = buffer
    const record = lines.join('\n')
    const sessionId = fieldString(record, 'sessionId')
    const fingerprint = fieldString(record, 'fingerprint')
    const estimatedTokens = fieldNumber(record, 'estimatedTokens')
    if (sessionId && fingerprint) {
      const event = {
        sessionId,
        fingerprint,
        estimatedTokens: estimatedTokens ?? 0,
        pageId: fieldString(record, 'pageId')
      }
      if (kind === 'system') systemEvents.push(event)
      else userEvents.push(event)
    }
    buffer = null
  }

  for (const line of text.split(/\r?\n/)) {
    const isSystem = line.includes(SYSTEM_MARKER)
    const isUser = !isSystem && line.includes(USER_MARKER)
    if (isSystem || isUser) {
      flush()
      buffer = { kind: isSystem ? 'system' : 'user', lines: [line] }
      continue
    }
    if (buffer && TIMESTAMP_START.test(line)) {
      flush()
      continue
    }
    if (buffer) buffer.lines.push(line)
  }
  flush()

  return { systemEvents, userEvents }
}

export function summarizePromptCache(parsed) {
  const sessions = new Map()

  const session = (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        systemFingerprints: new Map(),
        systemEstimatedTokens: 0,
        userEvents: []
      })
    }
    return sessions.get(sessionId)
  }

  for (const event of parsed.systemEvents) {
    const entry = session(event.sessionId)
    entry.systemFingerprints.set(
      event.fingerprint,
      (entry.systemFingerprints.get(event.fingerprint) || 0) + 1
    )
    entry.systemEstimatedTokens = Math.max(entry.systemEstimatedTokens, event.estimatedTokens)
  }
  for (const event of parsed.userEvents) {
    session(event.sessionId).userEvents.push(event)
  }

  return [...sessions.values()].map((entry) => {
    const userTokens = entry.userEvents.map((event) => event.estimatedTokens)
    return {
      sessionId: entry.sessionId,
      distinctSystemFingerprints: entry.systemFingerprints.size,
      systemFingerprints: [...entry.systemFingerprints.entries()].map(([fingerprint, count]) => ({
        fingerprint,
        count
      })),
      systemEstimatedTokens: entry.systemEstimatedTokens,
      pages: entry.userEvents.length,
      userEstimatedTokens: userTokens.reduce((acc, value) => acc + value, 0),
      userMinTokens: userTokens.length > 0 ? Math.min(...userTokens) : 0,
      userMaxTokens: userTokens.length > 0 ? Math.max(...userTokens) : 0,
      cacheStable: entry.systemFingerprints.size <= 1
    }
  })
}

const defaultLogPath = () => {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'amy-ppt', 'logs', 'main.log')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'amy-ppt', 'main.log')
  }
  return path.join(os.homedir(), '.config', 'amy-ppt', 'logs', 'main.log')
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()

if (invokedDirectly) {
  const logPath = process.argv[2] || defaultLogPath()
  if (!fs.existsSync(logPath)) {
    process.stderr.write(`[prompt-cache] Log file not found: ${logPath}\n`)
    process.stderr.write('[prompt-cache] Pass a path or generate a deck first.\n')
    process.exitCode = 1
  } else {
    const summaries = summarizePromptCache(parsePromptCacheLog(fs.readFileSync(logPath, 'utf8')))
    if (summaries.length === 0) {
      process.stdout.write(
        '[prompt-cache] No prompt-metric events found; generate a deck with the current build first.\n'
      )
    } else {
      let unstable = 0
      for (const summary of summaries) {
        const verdict = summary.cacheStable ? 'stable' : 'CACHE-BUSTER'
        if (!summary.cacheStable) unstable += 1
        process.stdout.write(
          [
            `[prompt-cache] session ${summary.sessionId}: ${verdict}`,
            `system ${summary.systemEstimatedTokens} tokens, ${summary.distinctSystemFingerprints} fingerprint(s)`,
            `user pages=${summary.pages} tokens=${summary.userEstimatedTokens} min/max=${summary.userMinTokens}/${summary.userMaxTokens}`
          ].join(' | ') + '\n'
        )
        for (const fingerprint of summary.systemFingerprints) {
          process.stdout.write(
            `[prompt-cache]   fingerprint ${fingerprint.fingerprint} x${fingerprint.count}\n`
          )
        }
      }
      process.stdout.write(
        `[prompt-cache] ${summaries.length} session(s), ${unstable} with unstable system prompts\n`
      )
      process.exitCode = unstable > 0 ? 1 : 0
    }
  }
}
