import { describe, expect, it, beforeEach } from 'vitest'
import {
  nextSequence,
  resetSequenceCache,
  rowToSessionEvent,
  toInsertValues,
  replaySessionSummary,
  type SessionEvent
} from '../../../src/main/generation/session-event-log'

describe('session-event-log', () => {
  beforeEach(() => {
    resetSequenceCache()
  })

  describe('nextSequence', () => {
    it('generates monotonically increasing sequence per session', () => {
      expect(nextSequence('s1')).toBe(1)
      expect(nextSequence('s1')).toBe(2)
      expect(nextSequence('s1')).toBe(3)
    })

    it('maintains independent sequences per session', () => {
      expect(nextSequence('s1')).toBe(1)
      expect(nextSequence('s2')).toBe(1)
      expect(nextSequence('s1')).toBe(2)
      expect(nextSequence('s2')).toBe(2)
    })

    it('resets when cache is cleared', () => {
      nextSequence('s1')
      nextSequence('s1')
      resetSequenceCache('s1')
      expect(nextSequence('s1')).toBe(1)
    })
  })

  describe('toInsertValues', () => {
    it('converts input to DB insert shape with JSON payload', () => {
      const values = toInsertValues({
        sessionId: 'sess-1',
        runId: 'run-1',
        eventType: 'page/generated',
        payload: { pageId: 'p1', pageNumber: 1, title: 'Test' },
        actor: 'ai'
      })

      expect(values.sessionId).toBe('sess-1')
      expect(values.runId).toBe('run-1')
      expect(values.eventType).toBe('page/generated')
      expect(values.actor).toBe('ai')
      expect(values.sequence).toBeGreaterThan(0)
      expect(values.createdAt).toBeGreaterThan(0)
      expect(JSON.parse(values.payload)).toEqual({ pageId: 'p1', pageNumber: 1, title: 'Test' })
    })

    it('defaults actor to system and payload to empty object', () => {
      const values = toInsertValues({
        sessionId: 's',
        eventType: 'run/completed'
      })
      expect(values.actor).toBe('system')
      expect(JSON.parse(values.payload)).toEqual({})
      expect(values.runId).toBeNull()
    })
  })

  describe('rowToSessionEvent', () => {
    it('parses DB row with JSON payload', () => {
      const event = rowToSessionEvent({
        id: 1,
        sessionId: 's',
        runId: 'r',
        sequence: 1,
        eventType: 'planning/completed',
        payload: '{"totalPages": 5}',
        actor: 'system',
        createdAt: 12345
      })
      expect(event.eventType).toBe('planning/completed')
      expect(event.payload).toEqual({ totalPages: 5 })
      expect(event.id).toBe(1)
    })

    it('handles malformed JSON payload gracefully', () => {
      const event = rowToSessionEvent({
        id: 1, sessionId: 's', runId: null, sequence: 1,
        eventType: 'run/completed', payload: 'not-json', actor: 'system', createdAt: 0
      })
      expect(event.payload).toEqual({})
    })
  })

  describe('replaySessionSummary', () => {
    it('summarizes counts from an event stream', () => {
      const events: SessionEvent[] = [
        { id: 1, sessionId: 's', runId: 'r', sequence: 1, eventType: 'planning/completed', payload: { totalPages: 5 }, actor: 'system', createdAt: 100 },
        { id: 2, sessionId: 's', runId: 'r', sequence: 2, eventType: 'design-contract/set', payload: { theme: 'clean' }, actor: 'ai', createdAt: 101 },
        { id: 3, sessionId: 's', runId: 'r', sequence: 3, eventType: 'page/generated', payload: { pageNumber: 1, title: 'P1' }, actor: 'ai', createdAt: 102 },
        { id: 4, sessionId: 's', runId: 'r', sequence: 4, eventType: 'page/generated', payload: { pageNumber: 2, title: 'P2' }, actor: 'ai', createdAt: 103 },
        { id: 5, sessionId: 's', runId: 'r', sequence: 5, eventType: 'page/adjusted', payload: { pageNumber: 1, adjustment: 'moduleCount' }, actor: 'user', createdAt: 104 },
        { id: 6, sessionId: 's', runId: 'r', sequence: 6, eventType: 'page/failed', payload: { pageNumber: 3, reason: 'timeout' }, actor: 'system', createdAt: 105 },
        { id: 7, sessionId: 's', runId: 'r', sequence: 7, eventType: 'run/completed', payload: { completedPages: 4 }, actor: 'ai', createdAt: 106 }
      ]

      const summary = replaySessionSummary(events)

      expect(summary.totalRuns).toBe(1)
      expect(summary.totalGenerations).toBe(2)
      expect(summary.totalAdjustments).toBe(1)
      expect(summary.totalEdits).toBe(0)
      expect(summary.totalFailures).toBe(1)
      expect(summary.lastEventType).toBe('run/completed')
      expect(summary.timeline).toHaveLength(7)
      expect(summary.timeline[4].summary).toContain('调节')
      expect(summary.timeline[4].actor).toBe('user')
    })

    it('returns empty summary for empty stream', () => {
      const summary = replaySessionSummary([])
      expect(summary.totalRuns).toBe(0)
      expect(summary.lastEventType).toBeNull()
      expect(summary.timeline).toHaveLength(0)
    })
  })
})
