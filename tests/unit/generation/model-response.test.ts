import { describe, expect, it } from 'vitest'
import {
  normalizeDesignContract,
  parseModelJson
} from '../../../src/main/generation/planning/model-response'

describe('generation model response', () => {
  it('parses raw, fenced, and JSON-encoded JSON responses', () => {
    expect(parseModelJson('{"ok":true}')).toEqual({ ok: true })
    expect(parseModelJson('```json\n[{"title":"A"}]\n```')).toEqual([{ title: 'A' }])
    expect(parseModelJson(JSON.stringify('{"nested":1}'))).toEqual({ nested: 1 })
  })

  it('reports a localized parse failure with a bounded preview', () => {
    expect(() => parseModelJson('not-json', 'en')).toThrow(
      'Failed to parse JSON returned by the LLM'
    )
    expect(() => parseModelJson('not-json', 'zh')).toThrow('LLM 返回的 JSON 解析失败')
  })

  it('normalizes contract text, palette, and subtitle fallback', () => {
    const contract = normalizeDesignContract({
      theme: '  clean   editorial  ',
      palette: ['#111111', '', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#aaaaaa', '#bbbbbb'],
      titleFont: 'Inter',
      bodyFont: 'Source Sans 3'
    })

    expect(contract.theme).toBe('clean editorial')
    expect(contract.palette).toHaveLength(6)
    expect(contract.subtitleFont).toBe('Source Sans 3')
  })
})
