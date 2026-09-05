import { create } from 'zustand'
import type { InsertChartSeries } from '../components/session-detail/workspace/insert-charts'
import type { EditModeLayoutIsland } from '../lib/presentation-layout-island'

// ─── Types ────────────────────────────────────────────

export interface DragEditItem {
  pageId: string
  htmlPath: string
  selector: string
  x: number
  y: number
  width: number | null
  height: number | null
  layoutIsland?: EditModeLayoutIsland
  childUpdates: Array<{ path: number[]; width?: number; height?: number }>
  isAbsoluteMode: boolean
  zIndex?: number
  zIndexOnly?: boolean
}

export interface TextEditItem {
  pageId: string
  htmlPath: string
  selector: string
  patch: {
    text?: string
    style: { color?: string; fontSize?: string; fontWeight?: string; textAlign?: string }
  }
}

export interface PropertyEditItem {
  pageId: string
  htmlPath: string
  selector: string
  blockId?: string
  patch: {
    html?: string
    text?: string
    formula?: {
      latex: string
      html: string
      displayMode: boolean
      originalLatex?: string
    }
    chart?: {
      type: string
      title: string
      labels: string[]
      values: number[]
      series: InsertChartSeries[]
      primaryColor: string
      accentColor: string
      textColor: string
      smooth: boolean
      horizontal: boolean
      stacked: boolean
      areaFill: boolean
      showPoints: boolean
      showLegend: boolean
      doughnutCutout: number
      radarFill: boolean
      configJson: string
    }
    textTarget?: {
      type: 'text-node'
      parentSelector: string
      textNodeIndex: number
      text: string
    }
    style?: {
      zIndex?: number
      opacity?: number
      backgroundColor?: string
      color?: string
      fontSize?: string
      fontWeight?: string
      textAlign?: string
      objectFit?: string
    }
    attrs?: {
      alt?: string
      poster?: string
      controls?: boolean
      muted?: boolean
      loop?: boolean
      autoplay?: boolean
      playsInline?: boolean
      preload?: string
    }
  }
}

export interface DeleteItem {
  pageId: string
  htmlPath: string
  selector: string
}

export interface AddElementItem {
  pageId: string
  htmlPath: string
  parentSelector: string
  htmlFragment: string
  assignedBlockId: string
  insertIndex: number
}

export interface EditSnapshot {
  dragEdits: DragEditItem[]
  textEdits: TextEditItem[]
  propertyEdits: PropertyEditItem[]
  deletes: DeleteItem[]
  addElements: AddElementItem[]
}

type PageEditStacks = Record<string, EditSnapshot[]>
const MAX_PAGE_HISTORY = 100

// ─── Helpers ──────────────────────────────────────────

function cloneSnapshot(s: EditSnapshot): EditSnapshot {
  return structuredClone(s)
}

function emptySnapshot(): EditSnapshot {
  return {
    dragEdits: [],
    textEdits: [],
    propertyEdits: [],
    deletes: [],
    addElements: []
  }
}

function getSnapshotForPageFromState(
  state: Pick<
    EditHistoryState,
    'dragEdits' | 'textEdits' | 'propertyEdits' | 'deletes' | 'addElements'
  >,
  pageId: string
): EditSnapshot {
  return {
    dragEdits: state.dragEdits.filter((e) => e.pageId === pageId),
    textEdits: state.textEdits.filter((e) => e.pageId === pageId),
    propertyEdits: state.propertyEdits.filter((e) => e.pageId === pageId),
    deletes: state.deletes.filter((e) => e.pageId === pageId),
    addElements: state.addElements.filter((e) => e.pageId === pageId)
  }
}

function replacePageSnapshot<
  T extends Pick<
    EditHistoryState,
    'dragEdits' | 'textEdits' | 'propertyEdits' | 'deletes' | 'addElements'
  >
>(
  state: T,
  pageId: string,
  snapshot: EditSnapshot
): Pick<EditHistoryState, 'dragEdits' | 'textEdits' | 'propertyEdits' | 'deletes' | 'addElements'> {
  return {
    dragEdits: [...state.dragEdits.filter((item) => item.pageId !== pageId), ...snapshot.dragEdits],
    textEdits: [...state.textEdits.filter((item) => item.pageId !== pageId), ...snapshot.textEdits],
    propertyEdits: [
      ...state.propertyEdits.filter((item) => item.pageId !== pageId),
      ...snapshot.propertyEdits
    ],
    deletes: [...state.deletes.filter((item) => item.pageId !== pageId), ...snapshot.deletes],
    addElements: [
      ...state.addElements.filter((item) => item.pageId !== pageId),
      ...snapshot.addElements
    ]
  }
}

function pushPageStack(
  stacks: PageEditStacks,
  pageId: string,
  snapshot: EditSnapshot
): PageEditStacks {
  return {
    ...stacks,
    [pageId]: [...(stacks[pageId] || []).slice(-(MAX_PAGE_HISTORY - 1)), cloneSnapshot(snapshot)]
  }
}

function clearPageStack(stacks: PageEditStacks, pageId: string): PageEditStacks {
  const next = { ...stacks }
  delete next[pageId]
  return next
}

function compactPatchObject<T extends Record<string, unknown>>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>
}

function propertyPatchEquals(a: PropertyEditItem['patch'], b: PropertyEditItem['patch']): boolean {
  const aStyle = compactPatchObject(a.style)
  const bStyle = compactPatchObject(b.style)
  const aAttrs = compactPatchObject(a.attrs)
  const bAttrs = compactPatchObject(b.attrs)
  return (
    a.text === b.text &&
    a.html === b.html &&
    JSON.stringify(a.formula || null) === JSON.stringify(b.formula || null) &&
    JSON.stringify(a.chart || null) === JSON.stringify(b.chart || null) &&
    JSON.stringify(a.textTarget || null) === JSON.stringify(b.textTarget || null) &&
    JSON.stringify(aStyle) === JSON.stringify(bStyle) &&
    JSON.stringify(aAttrs) === JSON.stringify(bAttrs)
  )
}

export function extractSelectorBlockIds(selector: string): string[] {
  if (!selector || !selector.includes('data-block-id')) return []
  const pattern = /data-block-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))/g
  const ids: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(selector)) !== null) {
    const id = match[1] || match[2] || match[3]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function selectorReferencesBlockId(selector: string, blockId: string): boolean {
  return extractSelectorBlockIds(selector).includes(blockId)
}

export function selectorsTargetSameBlock(selectorA: string, selectorB: string): boolean {
  if (!selectorA || !selectorB) return false
  if (selectorA === selectorB) return true
  const idsA = extractSelectorBlockIds(selectorA)
  if (idsA.length === 0) return false
  const idsB = extractSelectorBlockIds(selectorB)
  return idsB.some((id) => idsA.includes(id))
}

export function editTargetMatchesDeletedSelector(
  editSelector: string,
  deletedSelector: string,
  editBlockId?: string
): boolean {
  if (selectorsTargetSameBlock(editSelector, deletedSelector)) return true
  return Boolean(editBlockId && selectorReferencesBlockId(deletedSelector, editBlockId))
}

function deleteItemsTargetSameElement(a: DeleteItem, b: DeleteItem): boolean {
  return (
    a.pageId === b.pageId &&
    a.htmlPath === b.htmlPath &&
    selectorsTargetSameBlock(a.selector, b.selector)
  )
}

function isGeneratedBackgroundAdd(item: AddElementItem): boolean {
  return (
    item.htmlFragment.includes('data-ppt-generated-background="1"') ||
    item.htmlFragment.includes("data-ppt-generated-background='1'")
  )
}

function isGeneratedBackgroundDelete(item: DeleteItem): boolean {
  return (
    item.selector === '[data-ppt-generated-background="1"]' ||
    item.selector === "[data-ppt-generated-background='1']" ||
    item.selector === '[data-ppt-generated-background-style="1"]' ||
    item.selector === "[data-ppt-generated-background-style='1']"
  )
}

function appendUniqueDeletes(existing: DeleteItem[], incoming: DeleteItem[]): DeleteItem[] {
  const next = [...existing]
  for (const item of incoming) {
    const duplicate = next.some((deleteItem) => deleteItemsTargetSameElement(deleteItem, item))
    if (!duplicate) next.push(item)
  }
  return next
}

// ─── Store ────────────────────────────────────────────

export interface EditHistoryState {
  dragEdits: DragEditItem[]
  textEdits: TextEditItem[]
  propertyEdits: PropertyEditItem[]
  deletes: DeleteItem[]
  addElements: AddElementItem[]
  undoStacks: PageEditStacks
  redoStacks: PageEditStacks
  savedCheckpoints: Record<string, EditSnapshot>

  upsertDragEdit: (edit: DragEditItem) => void
  upsertTextEdit: (edit: TextEditItem) => void
  upsertPropertyEdit: (edit: PropertyEditItem) => void
  addDelete: (item: DeleteItem) => void
  addElement: (item: AddElementItem) => void
  addElementWithDeletes: (item: AddElementItem, deletes: DeleteItem[]) => void
  undo: (pageId: string) => EditSnapshot | null
  redo: (pageId: string) => EditSnapshot | null
  canUndo: (pageId?: string | null) => boolean
  canRedo: (pageId?: string | null) => boolean
  hasPendingEdits: (pageId?: string | null) => boolean
  markPageSaved: (pageId: string) => void
  clearPage: (pageId: string) => void
  clear: () => void
  getSnapshotForPage: (pageId: string) => EditSnapshot
}

export const createEditHistoryStore = () =>
  create<EditHistoryState>((set, get) => ({
    dragEdits: [],
    textEdits: [],
    propertyEdits: [],
    deletes: [],
    addElements: [],
    undoStacks: {},
    redoStacks: {},
    savedCheckpoints: {},

    upsertDragEdit: (edit) =>
      set((state) => {
        const snapshot = getSnapshotForPageFromState(state, edit.pageId)
        const idx = state.dragEdits.findIndex(
          (item) =>
            item.pageId === edit.pageId &&
            item.htmlPath === edit.htmlPath &&
            item.selector === edit.selector
        )
        let next: DragEditItem[]
        if (idx < 0) {
          next = [...state.dragEdits, edit]
        } else {
          // Merge: zIndexOnly edits preserve existing position data;
          // drag edits preserve existing zIndex if new edit has none
          const existing = state.dragEdits[idx]
          const merged: DragEditItem = {
            ...edit,
            zIndex: edit.zIndex ?? existing.zIndex,
            layoutIsland: edit.layoutIsland ?? existing.layoutIsland
          }
          if (edit.zIndexOnly) {
            // Z-index-only change: keep existing position data, preserve flag
            merged.x = existing.x
            merged.y = existing.y
            merged.width = existing.width
            merged.height = existing.height
            merged.layoutIsland = existing.layoutIsland
            merged.childUpdates = existing.childUpdates
            merged.isAbsoluteMode = existing.isAbsoluteMode
            merged.zIndexOnly = true
          } else {
            // Full drag edit: clear zIndexOnly flag since position is also being updated
            merged.zIndexOnly = undefined
          }
          next = state.dragEdits.map((item, i) => (i === idx ? merged : item))
        }
        return {
          undoStacks: pushPageStack(state.undoStacks, edit.pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, edit.pageId),
          dragEdits: next
        }
      }),

    upsertTextEdit: (edit) =>
      set((state) => {
        const snapshot = getSnapshotForPageFromState(state, edit.pageId)
        const idx = state.textEdits.findIndex(
          (item) => item.pageId === edit.pageId && item.selector === edit.selector
        )
        const next =
          idx < 0
            ? [...state.textEdits, edit]
            : state.textEdits.map((item, i) => (i === idx ? edit : item))
        return {
          undoStacks: pushPageStack(state.undoStacks, edit.pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, edit.pageId),
          textEdits: next
        }
      }),

    upsertPropertyEdit: (edit) =>
      set((state) => {
        const snapshot = getSnapshotForPageFromState(state, edit.pageId)
        const idx = state.propertyEdits.findIndex(
          (item) =>
            item.pageId === edit.pageId &&
            item.htmlPath === edit.htmlPath &&
            item.selector === edit.selector
        )
        const mergePatch = (
          prev: PropertyEditItem['patch'],
          next: PropertyEditItem['patch']
        ): PropertyEditItem['patch'] => ({
          html: next.html ?? prev.html,
          text: next.text ?? prev.text,
          formula: next.formula ?? prev.formula,
          chart: next.chart ?? prev.chart,
          textTarget: next.textTarget ?? prev.textTarget,
          style: {
            ...(prev.style || {}),
            ...(next.style || {})
          },
          attrs: {
            ...(prev.attrs || {}),
            ...(next.attrs || {})
          }
        })
        const next =
          idx < 0
            ? [...state.propertyEdits, edit]
            : state.propertyEdits.map((item, i) =>
                i === idx ? { ...item, ...edit, patch: mergePatch(item.patch, edit.patch) } : item
              )
        if (idx >= 0 && propertyPatchEquals(state.propertyEdits[idx].patch, next[idx].patch)) {
          return state
        }
        return {
          undoStacks: pushPageStack(state.undoStacks, edit.pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, edit.pageId),
          propertyEdits: next
        }
      }),

    addDelete: (item) =>
      set((state) => {
        const snapshot = getSnapshotForPageFromState(state, item.pageId)
        const pendingAdd = state.addElements.find(
          (add) =>
            add.pageId === item.pageId &&
            add.htmlPath === item.htmlPath &&
            selectorReferencesBlockId(item.selector, add.assignedBlockId)
        )
        if (pendingAdd) {
          const cancelGeneratedBackgroundReplacement = isGeneratedBackgroundAdd(pendingAdd)
          return {
            undoStacks: pushPageStack(state.undoStacks, item.pageId, snapshot),
            redoStacks: clearPageStack(state.redoStacks, item.pageId),
            dragEdits: state.dragEdits.filter(
              (edit) =>
                edit.pageId !== item.pageId ||
                !editTargetMatchesDeletedSelector(edit.selector, item.selector)
            ),
            textEdits: state.textEdits.filter(
              (edit) =>
                edit.pageId !== item.pageId ||
                !editTargetMatchesDeletedSelector(edit.selector, item.selector)
            ),
            propertyEdits: state.propertyEdits.filter(
              (edit) =>
                edit.pageId !== item.pageId ||
                !editTargetMatchesDeletedSelector(edit.selector, item.selector, edit.blockId)
            ),
            deletes: cancelGeneratedBackgroundReplacement
              ? state.deletes.filter(
                  (deleteItem) =>
                    deleteItem.pageId !== item.pageId ||
                    deleteItem.htmlPath !== item.htmlPath ||
                    !isGeneratedBackgroundDelete(deleteItem)
                )
              : state.deletes,
            addElements: state.addElements.filter(
              (add) =>
                add !== pendingAdd &&
                !(
                  cancelGeneratedBackgroundReplacement &&
                  add.pageId === item.pageId &&
                  add.htmlPath === item.htmlPath &&
                  isGeneratedBackgroundAdd(add)
                )
            )
          }
        }
        const exists = state.deletes.some((deleteItem) =>
          deleteItemsTargetSameElement(deleteItem, item)
        )
        if (exists) return state
        return {
          undoStacks: pushPageStack(state.undoStacks, item.pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, item.pageId),
          deletes: [...state.deletes, item]
        }
      }),

    addElement: (item) =>
      set((state) => {
        const snapshot = getSnapshotForPageFromState(state, item.pageId)
        return {
          undoStacks: pushPageStack(state.undoStacks, item.pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, item.pageId),
          addElements: [...state.addElements, item]
        }
      }),

    addElementWithDeletes: (item, deletes) =>
      set((state) => {
        const pageId = item.pageId
        const snapshot = getSnapshotForPageFromState(state, pageId)
        const generatedBackgroundAdd = isGeneratedBackgroundAdd(item)
        const existingDeletes = generatedBackgroundAdd
          ? state.deletes.filter(
              (deleteItem) =>
                deleteItem.pageId !== pageId ||
                deleteItem.htmlPath !== item.htmlPath ||
                !isGeneratedBackgroundDelete(deleteItem)
            )
          : state.deletes
        const existingAddElements = generatedBackgroundAdd
          ? state.addElements.filter(
              (add) =>
                add.pageId !== pageId ||
                add.htmlPath !== item.htmlPath ||
                !isGeneratedBackgroundAdd(add)
            )
          : state.addElements
        return {
          undoStacks: pushPageStack(state.undoStacks, pageId, snapshot),
          redoStacks: clearPageStack(state.redoStacks, pageId),
          deletes: appendUniqueDeletes(existingDeletes, deletes),
          addElements: [...existingAddElements, item]
        }
      }),

    undo: (pageId) => {
      const state = get()
      const pageUndoStack = state.undoStacks[pageId] || []
      if (pageUndoStack.length === 0) return null
      const prev = pageUndoStack[pageUndoStack.length - 1]
      const current = getSnapshotForPageFromState(state, pageId)
      set({
        undoStacks: {
          ...state.undoStacks,
          [pageId]: pageUndoStack.slice(0, -1)
        },
        redoStacks: pushPageStack(state.redoStacks, pageId, current),
        ...replacePageSnapshot(state, pageId, prev)
      })
      return cloneSnapshot(prev)
    },

    redo: (pageId) => {
      const state = get()
      const pageRedoStack = state.redoStacks[pageId] || []
      if (pageRedoStack.length === 0) return null
      const next = pageRedoStack[pageRedoStack.length - 1]
      const current = getSnapshotForPageFromState(state, pageId)
      set({
        redoStacks: {
          ...state.redoStacks,
          [pageId]: pageRedoStack.slice(0, -1)
        },
        undoStacks: pushPageStack(state.undoStacks, pageId, current),
        ...replacePageSnapshot(state, pageId, next)
      })
      return cloneSnapshot(next)
    },

    canUndo: (pageId) => Boolean(pageId && (get().undoStacks[pageId]?.length || 0) > 0),
    canRedo: (pageId) => Boolean(pageId && (get().redoStacks[pageId]?.length || 0) > 0),
    hasPendingEdits: (pageId) => {
      if (!pageId) return false
      const state = get()
      const snapshot = getSnapshotForPageFromState(state, pageId)
      return Boolean(
        snapshot.dragEdits.length > 0 ||
        snapshot.textEdits.length > 0 ||
        snapshot.propertyEdits.length > 0 ||
        snapshot.deletes.length > 0 ||
        snapshot.addElements.length > 0
      )
    },

    markPageSaved: (pageId) =>
      set((state) => ({
        ...replacePageSnapshot(state, pageId, emptySnapshot()),
        undoStacks: clearPageStack(state.undoStacks, pageId),
        redoStacks: clearPageStack(state.redoStacks, pageId),
        savedCheckpoints: {
          ...state.savedCheckpoints,
          [pageId]: emptySnapshot()
        }
      })),

    clearPage: (pageId) =>
      set((state) => ({
        dragEdits: state.dragEdits.filter((item) => item.pageId !== pageId),
        textEdits: state.textEdits.filter((item) => item.pageId !== pageId),
        propertyEdits: state.propertyEdits.filter((item) => item.pageId !== pageId),
        deletes: state.deletes.filter((item) => item.pageId !== pageId),
        addElements: state.addElements.filter((item) => item.pageId !== pageId),
        undoStacks: clearPageStack(state.undoStacks, pageId),
        redoStacks: clearPageStack(state.redoStacks, pageId),
        savedCheckpoints: {
          ...state.savedCheckpoints,
          [pageId]: emptySnapshot()
        }
      })),

    clear: () =>
      set({
        dragEdits: [],
        textEdits: [],
        propertyEdits: [],
        deletes: [],
        addElements: [],
        undoStacks: {},
        redoStacks: {},
        savedCheckpoints: {}
      }),

    getSnapshotForPage: (pageId) => {
      return cloneSnapshot(getSnapshotForPageFromState(get(), pageId))
    }
  }))

export const useEditHistoryStore = createEditHistoryStore()
