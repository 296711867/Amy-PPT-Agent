import { describe, expect, it } from 'vitest'
import {
  buildDeckNarrativeReviewEventPayload,
  buildDeckQualityReviewEventPayload
} from '../../../src/main/generation/deck-review-repair'

describe('deck review session events', () => {
  it('builds a compact quality-review payload with deduped codes and repair outcome', () => {
    const payload = buildDeckQualityReviewEventPayload({
      available: true,
      reviewedPages: 6,
      violations: [
        { code: 'deck-title-anchor-drift', severity: 'error', pageIds: ['p1', 'p2'] },
        { code: 'deck-title-anchor-drift', severity: 'warn', pageIds: ['p3'] },
        { code: 'deck-palette-drift', severity: 'warn', pageIds: ['p4'] }
      ],
      repairedPageIds: ['p1'],
      repairFailurePageIds: ['p2'],
      skipped: false
    })

    expect(payload).toMatchObject({
      available: true,
      skipped: false,
      reviewedPages: 6,
      errorCount: 1,
      warnCount: 2,
      repairedPageIds: ['p1'],
      repairFailurePageIds: ['p2']
    })
    expect(payload.codes).toEqual(['deck-title-anchor-drift', 'deck-palette-drift'])
    expect(payload.violations).toHaveLength(3)
  })

  it('marks a skipped review explicitly so consumers can tell skip from empty', () => {
    const payload = buildDeckQualityReviewEventPayload({
      available: false,
      reviewedPages: 0,
      violations: [],
      repairedPageIds: [],
      repairFailurePageIds: [],
      skipped: true
    })

    expect(payload).toMatchObject({ skipped: true, errorCount: 0, warnCount: 0, codes: [] })
  })

  it('builds a narrative-review payload separating static and semantic findings', () => {
    const payload = buildDeckNarrativeReviewEventPayload({
      semanticAvailable: true,
      staticIssues: [
        { code: 'narrative-opening', severity: 'warn', pageIds: ['p1'] },
        { code: 'narrative-close', severity: 'error', pageIds: ['p6'] }
      ],
      semanticIssues: [{ code: 'narrative-evidence', severity: 'warn', pageIds: ['p2'] }],
      repairedPageIds: ['p6'],
      skipped: false
    })

    expect(payload).toMatchObject({
      semanticAvailable: true,
      skipped: false,
      staticErrorCount: 1,
      staticWarnCount: 1,
      semanticErrorCount: 0,
      semanticWarnCount: 1,
      repairedPageIds: ['p6']
    })
  })
})
