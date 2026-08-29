/** PreviewIframe 的纯判定帮助函数。 */
import type { InteractionMode } from '@renderer/store'

export function isCurrentInspectorSelectionRequest(args: {
  requestId: number
  latestRequestId: number
  isInspectorActive: boolean
  selectionInteractionMode: InteractionMode
  currentInteractionMode: InteractionMode
}): boolean {
  return (
    args.isInspectorActive &&
    args.requestId === args.latestRequestId &&
    args.selectionInteractionMode === args.currentInteractionMode
  )
}
