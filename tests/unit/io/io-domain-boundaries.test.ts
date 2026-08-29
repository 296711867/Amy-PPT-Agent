import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const canonicalIoFiles = [
  'src/main/io/local-asset-roots.ts',
  'src/main/io/assets-handlers.ts',
  'src/main/io/file-handlers.ts',
  'src/main/io/export-handlers.ts',
  'src/main/io/document-csv-to-markdown.ts',
  'src/main/io/document-outline-scan.ts',
  'src/main/io/document-parse-handlers.ts',
  'src/main/io/document-plan-normalizer.ts',
  'src/main/io/document-plan-page-skeleton.ts',
  'src/main/io/pptx-import/index.ts',
  'src/main/io/pptx-import/animation-import.ts',
  'src/main/io/pptx-import/block-builders.ts',
  'src/main/io/pptx-import/chart-rewrite-agent.ts',
  'src/main/io/pptx-import/element-model.ts',
  'src/main/io/pptx-import/image-registry.ts',
  'src/main/io/pptx-import/progress.ts',
  'src/main/io/pptx-import/render-shared.ts',
  'src/main/io/pptx-import/sanitize.ts',
  'src/main/io/pptx-import/shape-view-box.ts',
  'src/main/io/pptx-import/slide-render.ts',
  'src/main/io/pptx-import/style-css.ts',
  'src/main/io/pptx-import/text-validator.ts',
  'src/main/io/pptx-import/xml-shape-metadata.ts',
  'src/main/io/pptx-import/handlers.ts',
  'src/main/io/html-video/exporter.ts',
  'src/main/io/html-pptx/renderer.ts',
  'src/main/io/thumbnails/html-thumbnail-service.ts',
  'src/main/io/thumbnails/png-stitch.ts',
  'src/main/io/thumbnails/handlers.ts'
]

const removedIoPaths = [
  'src/main/utils/pptx-importer/index.ts',
  'src/main/utils/pptx-animation-import.ts',
  'src/main/utils/pptx-chart-rewrite-agent.ts',
  'src/main/utils/pptx-ooxml-path-renderer.ts',
  'src/main/utils/pptx-svg-shape-geometry.ts',
  'src/main/io/pptx-import/ooxml-path-renderer.ts',
  'src/main/io/pptx-import/svg-shape-geometry.ts',
  'src/main/utils/pptx-text-validator.ts',
  'src/main/utils/pptx-xml-shape-metadata.ts',
  'src/main/ipc/io/pptx-import-progress.ts',
  'src/main/ipc/io/pptx-import-handlers.ts',
  'src/main/utils/html-pptx/browser-scripts.ts',
  'src/main/utils/html-pptx/renderer.ts',
  'src/main/utils/html-thumbnail-service.ts',
  'src/main/utils/html-video/exporter.ts',
  'src/main/utils/png-stitch.ts',
  'src/main/ipc/io/thumbnail-handlers.ts',
  'src/main/ipc/io/local-asset-roots.ts',
  'src/main/ipc/io/assets-handlers.ts',
  'src/main/ipc/io/file-handlers.ts',
  'src/main/ipc/io/export-handlers.ts',
  'src/main/ipc/io/document-csv-to-markdown.ts',
  'src/main/ipc/io/document-outline-scan.ts',
  'src/main/ipc/io/document-parse-handlers.ts',
  'src/main/ipc/io/document-plan-normalizer.ts',
  'src/main/ipc/io/document-plan-page-skeleton.ts'
]

const readTypeScriptSources = (directory: string): Array<{ filePath: string; source: string }> => {
  const sources: Array<{ filePath: string; source: string }> = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...readTypeScriptSources(filePath))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      sources.push({ filePath, source: fs.readFileSync(filePath, 'utf8') })
    }
  }
  return sources
}

describe('I/O domain boundaries', () => {
  it('owns document, asset, export, PPTX, HTML-PPTX, thumbnail, and local-asset capabilities in io/', () => {
    expect(canonicalIoFiles.filter((filePath) => !fs.existsSync(filePath))).toEqual([])
  })

  it('removes legacy I/O paths after every caller migrates', () => {
    expect(removedIoPaths.filter((filePath) => fs.existsSync(filePath))).toEqual([])
  })

  it('does not let application code import an old I/O path', () => {
    const removedFragments = [
      'utils/pptx-importer',
      'utils/pptx-animation-import',
      'utils/pptx-chart-rewrite-agent',
      'utils/pptx-ooxml-path-renderer',
      'utils/pptx-svg-shape-geometry',
      'io/pptx-import/ooxml-path-renderer',
      'io/pptx-import/svg-shape-geometry',
      'utils/pptx-text-validator',
      'utils/pptx-xml-shape-metadata',
      'ipc/io/pptx-import-progress',
      'ipc/io/pptx-import-handlers',
      'utils/html-pptx',
      'utils/html-thumbnail-service',
      'utils/html-video/exporter',
      'utils/png-stitch',
      'ipc/io/thumbnail-handlers',
      'ipc/io/local-asset-roots',
      'ipc/io/assets-handlers',
      'ipc/io/file-handlers',
      'ipc/io/export-handlers',
      'ipc/io/document-csv-to-markdown',
      'ipc/io/document-outline-scan',
      'ipc/io/document-parse-handlers',
      'ipc/io/document-plan-normalizer',
      'ipc/io/document-plan-page-skeleton'
    ]
    for (const { filePath, source } of readTypeScriptSources('src/main')) {
      for (const fragment of removedFragments) {
        expect(source, `${filePath}: ${fragment}`).not.toContain(fragment)
      }
    }
  })
})
