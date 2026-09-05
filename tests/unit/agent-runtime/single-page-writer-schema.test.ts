import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {},
  session: {}
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { createPageWriteTools } from '../../../src/main/agent-runtime/tools/page-writer'

describe('single-page writer schema', () => {
  it('accepts omitted pageId because the tool is locked to the selected page', () => {
    const [writer] = createPageWriteTools({
      context: {
        sessionId: 'session-1',
        selectedPageId: 'page-1',
        allowedPageIds: ['page-1'],
        pageFileMap: { 'page-1': '/tmp/page-1.html' },
        outlineItems: [{ title: 'Page 1' }],
        templatePageReadRequired: true
      } as never,
      isEditMode: false,
      isContainerScopeEdit: false,
      emitNormalizedToolStatus: vi.fn()
    }) as Array<{ schema: { safeParse: (input: unknown) => { success: boolean } } }>

    expect(writer.schema.safeParse({ content: '<section>new content</section>' }).success).toBe(true)
    expect(
      writer.schema.safeParse({ pageId: 'page-1', content: '<section>new content</section>' })
        .success
    ).toBe(true)
  })
})
