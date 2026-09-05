import { beforeEach, describe, expect, it } from 'vitest'

import {
  editTargetMatchesDeletedSelector,
  useEditHistoryStore
} from '../../../src/renderer/src/store/editHistoryStore'
import { useHtmlEditHistoryStore } from '../../../src/renderer/src/store/htmlEditHistoryStore'

describe('editHistoryStore delete merging', () => {
  beforeEach(() => {
    useEditHistoryStore.getState().clear()
    useHtmlEditHistoryStore.getState().clear()
  })

  it('keeps the session and standalone HTML editor histories isolated', () => {
    useEditHistoryStore.getState().addDelete({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      selector: '[data-block-id="session-only"]'
    })

    expect(useEditHistoryStore.getState().hasPendingEdits('page-1')).toBe(true)
    expect(useHtmlEditHistoryStore.getState().hasPendingEdits('page-1')).toBe(false)
  })

  it('bounds per-page undo history', () => {
    for (let index = 0; index < 120; index += 1) {
      useEditHistoryStore.getState().upsertTextEdit({
        pageId: 'page-1',
        htmlPath: '/tmp/page.html',
        selector: '[data-block-id="title"]',
        patch: { text: `Title ${index}`, style: {} }
      })
    }

    expect(useEditHistoryStore.getState().undoStacks['page-1']).toHaveLength(100)
  })

  it('cancels a pending added element when that element is deleted before saving', () => {
    const store = useEditHistoryStore.getState()
    store.addElement({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      parentSelector: 'body[data-page-id="page-1"] [data-ppt-guard-root="1"]',
      htmlFragment: '<img data-block-id="select-arcsin1-added" src="./images/a.png">',
      assignedBlockId: 'select-arcsin1-added',
      insertIndex: -1
    })

    useEditHistoryStore.getState().addDelete({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      selector: 'body[data-page-id="page-1"] [data-block-id="select-arcsin1-added"]'
    })

    const snapshot = useEditHistoryStore.getState().getSnapshotForPage('page-1')
    expect(snapshot.addElements).toHaveLength(0)
    expect(snapshot.deletes).toHaveLength(0)
    expect(useEditHistoryStore.getState().canUndo('page-1')).toBe(true)
  })

  it('removes pending edits that target the same added block when deleting the added element', () => {
    const store = useEditHistoryStore.getState()
    store.addElement({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      parentSelector: 'body[data-page-id="page-1"] [data-ppt-guard-root="1"]',
      htmlFragment: '<p data-block-id="select-arcsin1-added"><span>文字</span></p>',
      assignedBlockId: 'select-arcsin1-added',
      insertIndex: -1
    })
    useEditHistoryStore.getState().upsertPropertyEdit({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      selector: 'body[data-page-id="page-1"] [data-block-id="select-arcsin1-added"] span',
      blockId: 'select-arcsin1-added',
      patch: { style: { color: '#ff0000' } }
    })

    useEditHistoryStore.getState().addDelete({
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      selector: 'body[data-page-id="page-1"] [data-block-id="select-arcsin1-added"]'
    })

    const snapshot = useEditHistoryStore.getState().getSnapshotForPage('page-1')
    expect(snapshot.addElements).toHaveLength(0)
    expect(snapshot.propertyEdits).toHaveLength(0)
    expect(snapshot.deletes).toHaveLength(0)
  })

  it('dedupes repeated deletes for the same existing element', () => {
    const deleteItem = {
      pageId: 'page-1',
      htmlPath: '/tmp/page.html',
      selector: 'body[data-page-id="page-1"] [data-block-id="existing"]'
    }

    useEditHistoryStore.getState().addDelete(deleteItem)
    useEditHistoryStore.getState().addDelete(deleteItem)

    const snapshot = useEditHistoryStore.getState().getSnapshotForPage('page-1')
    expect(snapshot.deletes).toHaveLength(1)
  })

  it('keeps only the latest pending generated background replacement', () => {
    const deletes = [
      {
        pageId: 'page-1',
        htmlPath: '/tmp/page.html',
        selector: '[data-ppt-generated-background="1"]'
      },
      {
        pageId: 'page-1',
        htmlPath: '/tmp/page.html',
        selector: '[data-ppt-generated-background-style="1"]'
      }
    ]

    useEditHistoryStore.getState().addElementWithDeletes(
      {
        pageId: 'page-1',
        htmlPath: '/tmp/page.html',
        parentSelector: 'body[data-page-id="page-1"] [data-ppt-guard-root="1"]',
        htmlFragment: '<img data-block-id="bg-1" data-ppt-generated-background="1">',
        assignedBlockId: 'bg-1',
        insertIndex: -1
      },
      deletes
    )
    useEditHistoryStore.getState().addElementWithDeletes(
      {
        pageId: 'page-1',
        htmlPath: '/tmp/page.html',
        parentSelector: 'body[data-page-id="page-1"] [data-ppt-guard-root="1"]',
        htmlFragment: '<img data-block-id="bg-2" data-ppt-generated-background="1">',
        assignedBlockId: 'bg-2',
        insertIndex: -1
      },
      deletes
    )

    const snapshot = useEditHistoryStore.getState().getSnapshotForPage('page-1')
    expect(snapshot.addElements).toHaveLength(1)
    expect(snapshot.addElements[0].assignedBlockId).toBe('bg-2')
    expect(snapshot.deletes).toHaveLength(2)
  })
})

describe('edit history selector matching', () => {
  it('matches selectors that target the same data-block-id', () => {
    expect(
      editTargetMatchesDeletedSelector(
        'body[data-page-id="page-1"] [data-block-id="block-1"] span',
        'body[data-page-id="page-1"] [data-block-id="block-1"]'
      )
    ).toBe(true)
  })

  it('can match by edit block id when selector text differs', () => {
    expect(
      editTargetMatchesDeletedSelector(
        'body[data-page-id="page-1"] .generated-title',
        'body[data-page-id="page-1"] [data-block-id="block-1"]',
        'block-1'
      )
    ).toBe(true)
  })
})
