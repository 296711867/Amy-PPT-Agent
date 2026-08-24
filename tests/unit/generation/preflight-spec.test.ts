import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { preflightSpecCheck } from '../../../src/main/generation/preflight-spec'
import { AMY_IMAGE_PLACEHOLDER_PATH } from '../../../src/shared/generation'

describe('preflightSpecCheck', () => {
  it('truncates overlong titles and content outlines', () => {
    const result = preflightSpecCheck([
      {
        title: 'A'.repeat(60),
        contentOutline: 'B'.repeat(300),
        moduleCount: 3
      }
    ])

    expect(result.items[0].title.length).toBeLessThanOrEqual(49) // 48 + ellipsis
    expect(result.items[0].title).toMatch(/…$/)
    expect(result.items[0].contentOutline.length).toBeLessThanOrEqual(201) // 200 + ellipsis
    expect(result.adjustments).toHaveLength(2)
    expect(result.adjustments[0]).toMatchObject({ field: 'title', action: 'truncate' })
    expect(result.adjustments[1]).toMatchObject({ field: 'contentOutline', action: 'truncate' })
  })

  it('trims items when they exceed moduleCount capacity', () => {
    const result = preflightSpecCheck([
      {
        title: 'Normal title',
        contentOutline: 'Short',
        moduleCount: 3,
        items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
      }
    ])

    // moduleCount=3 × 2 per module = 6 max
    expect(result.items[0].items).toHaveLength(6)
    expect(result.adjustments).toHaveLength(1)
    expect(result.adjustments[0]).toMatchObject({ field: 'items', action: 'trim' })
  })

  it('replaces missing image paths with placeholders', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'))
    try {
      const result = preflightSpecCheck(
        [
          {
            title: 'Test',
            contentOutline: 'Test',
            imageAssetPath: './images/nonexistent.png',
            imageAssetPaths: ['./images/nonexistent.png', AMY_IMAGE_PLACEHOLDER_PATH]
          }
        ],
        { projectDir: tempDir }
      )

      expect(result.items[0].imageAssetPaths![0]).toBe(AMY_IMAGE_PLACEHOLDER_PATH)
      expect(result.items[0].imageAssetPaths![1]).toBe(AMY_IMAGE_PLACEHOLDER_PATH)
      expect(result.adjustments.some((a) => a.action === 'replace-missing')).toBe(true)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('clears image paths when the layout has zero image slots', () => {
    const result = preflightSpecCheck([
      {
        title: 'Test',
        contentOutline: 'Test',
        layoutId: 'text-focus', // a layout with 0 image slots
        imageAssetPath: './images/some.png',
        imageAssetPaths: ['./images/some.png']
      }
    ])

    expect(result.items[0].imageAssetPaths).toBeUndefined()
    expect(result.items[0].imageAssetPath).toBeUndefined()
    expect(result.adjustments.some((a) => a.action === 'clear-no-image-layout')).toBe(true)
  })

  it('leaves valid items untouched', () => {
    const result = preflightSpecCheck([
      {
        title: 'Good title',
        contentOutline: 'Good outline',
        moduleCount: 3,
        items: ['a', 'b', 'c']
      }
    ])

    expect(result.items[0].title).toBe('Good title')
    expect(result.items[0].contentOutline).toBe('Good outline')
    expect(result.items[0].items).toEqual(['a', 'b', 'c'])
    expect(result.adjustments).toHaveLength(0)
  })
})
