import { describe, expect, it } from 'vitest'
import type { DeckQualityReport } from '../../../src/main/presentation/html/deck-quality-validator'
import { findNewDeckHardViolations } from '../../../src/main/presentation/html/deck-quality-guard'

const report = (violations: DeckQualityReport['violations']): DeckQualityReport => ({
  available: true,
  pages: [],
  violations,
  unavailablePages: []
})

describe('deck quality differential guard', () => {
  it('returns only newly introduced hard issues in the edited page scope', () => {
    const before = report([
      {
        code: 'deck-font-system-drift',
        severity: 'error',
        pageIds: ['page-1'],
        detail: 'existing issue',
        fix: 'fix font'
      }
    ])
    const after = report([
      {
        code: 'deck-font-system-drift',
        severity: 'error',
        pageIds: ['page-1', 'page-2', 'page-3'],
        detail: 'font drift',
        fix: 'fix font'
      },
      {
        code: 'deck-title-size-rhythm',
        severity: 'warn',
        pageIds: ['page-2'],
        detail: 'advisory',
        fix: 'raise title size'
      }
    ])

    expect(findNewDeckHardViolations({ before, after, pageIds: ['page-2'] })).toEqual([
      expect.objectContaining({
        code: 'deck-font-system-drift',
        pageIds: ['page-2']
      })
    ])
  })
})
