import { describe, expect, it } from 'vitest'
import {
  sessionPageRecordToInput,
  type SessionPageRecord
} from '../../../src/main/db/records'

describe('database records', () => {
  it('converts a persisted session page without leaking database bookkeeping fields', () => {
    const record: SessionPageRecord = {
      id: 'page-1',
      session_id: 'session-1',
      legacy_page_id: 'legacy-1',
      file_slug: 'opening',
      page_number: 1,
      title: 'Opening',
      html_path: 'pages/opening.html',
      status: 'completed',
      error: null,
      created_at: 100,
      updated_at: 200,
      deleted_at: null
    }

    expect(sessionPageRecordToInput(record)).toEqual({
      id: 'page-1',
      sessionId: 'session-1',
      legacyPageId: 'legacy-1',
      fileSlug: 'opening',
      pageNumber: 1,
      title: 'Opening',
      htmlPath: 'pages/opening.html',
      status: 'completed',
      error: null
    })
  })
})
