import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const readSource = (filePath: string): string => fs.readFileSync(path.resolve(filePath), 'utf8')

describe('Runtime prompt inventory', () => {
  it('records every discovered non-Thinking model builder that is still intentionally inline', () => {
    const inventory = readSource('docs/design/node-agent-runtime-prompt-inventory.md')
    const expectedEntries = [
      ['add-page-plan', 'planNewPage'],
      ['document-image-plan', 'buildImageDocumentPlanPrompt'],
      ['style-import-json-repair', 'retryFixJson']
    ]

    for (const [id, builder] of expectedEntries) {
      expect(inventory).toContain(`| \`${id}\``)
      expect(inventory).toContain(builder)
    }
  })

  it('keeps each inventory builder present in its documented Runtime source file', () => {
    expect(readSource('src/main/generation/planning/page-planner.ts')).toContain('planNewPage')
    expect(readSource('src/main/io/document-parse-handlers.ts')).toContain(
      'buildImageDocumentPlanPrompt'
    )
    expect(readSource('src/main/styles/import/pptx.ts')).toContain('retryFixJson')
  })
})
