import { describe, expect, it } from 'vitest'
import { buildAiStyleSnapshotInput } from '../../../src/main/db/services/session-style-snapshot-service'

describe('session style snapshot policy', () => {
  it('builds a stable custom snapshot input from a persisted AI selection', () => {
    const input = buildAiStyleSnapshotInput('Session_12-special', {
      styleId: 'ai-existing-id',
      metadata: JSON.stringify({
        styleSelection: {
          mode: 'ai',
          description: '  warm technical atlas  ',
          themeColors: [' #A23E48 ', '', null, '#F0EBD8']
        }
      })
    })

    expect(input).toMatchObject({
      styleId: 'ai-existing-id',
      styleKey: 'ai-generated-Session1',
      description: 'warm technical atlas',
      source: 'custom',
      version: '1.0.0'
    })
    expect(input?.styleSkill).toContain('Theme color anchors: #A23E48, #F0EBD8')
  })

  it('uses the session-derived id when no style id has been persisted', () => {
    expect(
      buildAiStyleSnapshotInput('session-2', {
        styleId: null,
        metadata: JSON.stringify({
          styleSelection: { mode: 'ai', description: 'editorial grid' }
        })
      })
    ).toMatchObject({ styleId: 'ai-session-2' })
  })

  it.each([
    undefined,
    { styleId: null, metadata: '{invalid' },
    { styleId: null, metadata: JSON.stringify({ styleSelection: { mode: 'preset' } }) },
    {
      styleId: null,
      metadata: JSON.stringify({ styleSelection: { mode: 'ai', description: '  ' } })
    }
  ])('does not create an AI snapshot for unusable metadata %#', (session) => {
    expect(buildAiStyleSnapshotInput('session-3', session)).toBeNull()
  })
})
