import fs from 'fs'
import { describe, expect, it } from 'vitest'

describe('single-page post-write timeout contract', () => {
  it('rechecks the committed page before propagating a stream timeout', () => {
    const source = fs.readFileSync('src/main/generation/single-page-generator.ts', 'utf8')
    const catchBlock = source.slice(
      source.indexOf('} catch (error) {\n          streamError = error'),
      source.indexOf('afterPageHtml = await readPageHtmlIfExists(currentPagePath)', source.indexOf('} catch (error) {\n          streamError = error')) + 180
    )

    expect(catchBlock).toContain('afterPageHtml = await readPageHtmlIfExists(currentPagePath)')
    expect(catchBlock).toContain(
      'pageCommitted = hasCommittedGeneratedPage(beforePageHtml, afterPageHtml)'
    )
    expect(source).toContain('if (streamError && !pageCommitted) throw streamError')
  })
})
