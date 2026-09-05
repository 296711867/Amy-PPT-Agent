import { describe, expect, it } from 'vitest'
import {
  createTemplateSeedFingerprint,
  isUntouchedTemplateSeed,
  resolveUnconfirmedTemplatePageFailure
} from '../../../src/main/templates/template-seed-fingerprint'

describe('template page completion outcome', () => {
  it('rejects untouched seed pages without a completed callback', () => {
    const seedHtml = '<html><body>LED template seed</body></html>'
    const seedFingerprint = createTemplateSeedFingerprint(seedHtml)

    expect(isUntouchedTemplateSeed(seedHtml, seedFingerprint)).toBe(true)

    expect(
      resolveUnconfirmedTemplatePageFailure({
        html: seedHtml,
        seedFingerprint,
        completedCallbackObserved: false
      })
    ).toBe('页面未被生成改写（仍为模板基底）')
  })

  it('rejects unconfirmed pages when an old session has no seed fingerprint', () => {
    expect(
      resolveUnconfirmedTemplatePageFailure({
        html: '<html><body>changed</body></html>',
        completedCallbackObserved: false
      })
    ).toBe('页面生成未确认完成（缺少 completed 回调）')
  })

  it('accepts only pages confirmed by the completed callback', () => {
    expect(
      resolveUnconfirmedTemplatePageFailure({
        html: '<html><body>rewritten op-amp content</body></html>',
        completedCallbackObserved: true
      })
    ).toBeNull()
  })

  it('keeps a 15-page interrupted template run at 3 completed and 12 failed', () => {
    const pages = Array.from({ length: 15 }, (_, index) => {
      const seedHtml = `<html><body>LED seed ${index + 1}</body></html>`
      return {
        html: index < 3 ? `<html><body>rewritten op-amp page ${index + 1}</body></html>` : seedHtml,
        seedFingerprint: createTemplateSeedFingerprint(seedHtml),
        completedCallbackObserved: index < 3
      }
    })
    const failures = pages.filter((page) => resolveUnconfirmedTemplatePageFailure(page))

    expect(pages.length - failures.length).toBe(3)
    expect(failures).toHaveLength(12)
  })
})
