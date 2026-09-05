import { createEditHistoryStore } from './editHistoryStore'

export { editTargetMatchesDeletedSelector } from './editHistoryStore'

export type {
  AddElementItem,
  DeleteItem,
  DragEditItem,
  EditHistoryState,
  EditSnapshot,
  PropertyEditItem,
  TextEditItem
} from './editHistoryStore'

export const useHtmlEditHistoryStore = createEditHistoryStore()
