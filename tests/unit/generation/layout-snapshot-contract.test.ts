import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8')

describe('universal layout snapshot contract', () => {
  it('persists layout and image fields in generation page snapshots', () => {
    const schema = readSource('src/main/db/schema.ts')
    const repository = readSource('src/main/db/repositories/generation-run-repository.ts')
    const migration = readSource('src/main/db/patch/index.ts')

    expect(schema).toContain("layoutId: text('layout_id')")
    expect(schema).toContain("imageAssetPath: text('image_asset_path')")
    expect(schema).toContain("imageAssetPaths: text('image_asset_paths')")
    expect(repository).toContain('layout_id:')
    expect(repository).toContain('image_asset_path:')
    expect(repository).toContain('image_asset_paths:')
    expect(migration).toContain('ALTER TABLE generation_pages ADD COLUMN layout_id TEXT')
    expect(migration).toContain('ALTER TABLE generation_pages ADD COLUMN image_asset_path TEXT')
    expect(migration).toContain('ALTER TABLE generation_pages ADD COLUMN image_asset_paths TEXT')
  })

  it('restores the same layout through retry and edit flows', () => {
    const retry = readSource('src/main/generation/retry-flow.ts')
    const retrySingle = readSource('src/main/generation/retry-single-page-flow.ts')
    const edit = readSource('src/main/generation/edit-flow.ts')
    const editDeck = readSource('src/main/generation/edit-deck-allpage-flow.ts')

    expect(retry).toContain('normalizeUniversalLayoutId(page.layout_id)')
    expect(retrySingle).toContain('normalizeUniversalLayoutId(pageSnapshot?.layout_id)')
    expect(edit).toContain('normalizeUniversalLayoutId(page.layout_id)')
    expect(editDeck).toContain('normalizeUniversalLayoutId(page.layout_id)')
  })
})
