import { describe, expect, it } from 'vitest'
import { filterCoverEndingLockedAssignments } from '../../../src/main/generation/locked-assignment-guard'

describe('filterCoverEndingLockedAssignments', () => {
  it('drops locked assignments for the cover and ending pages (I-11)', () => {
    const result = filterCoverEndingLockedAssignments(
      [{ id: 'cover-asset' }, null, { id: 'content-asset' }, { id: 'ending-asset' }],
      ['cover', 'content', 'content', 'ending']
    )
    expect(result).toEqual([null, null, { id: 'content-asset' }, null])
  })

  it('drops cover intent anywhere and ending role; content role is preserved', () => {
    // deck-flow 侧负责把末页映射为 'ending'（见 deck-flow 调用处），
    // 纯函数只认传入的角色。
    const result = filterCoverEndingLockedAssignments(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      ['summary', 'cover', 'content']
    )
    expect(result).toEqual([{ id: 'a' }, null, { id: 'c' }])
    expect(
      filterCoverEndingLockedAssignments([{ id: 'c' }], ['ending'])
    ).toEqual([null])
  })

  it('keeps null assignments null and preserves content assignments', () => {
    const result = filterCoverEndingLockedAssignments(
      [null, { id: 'content-asset' }],
      ['content', 'content']
    )
    expect(result).toEqual([null, { id: 'content-asset' }])
  })
})
