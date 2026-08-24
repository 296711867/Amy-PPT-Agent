import { useCallback, useEffect, useState } from 'react'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import { ipc } from '@renderer/lib/ipc'
import { useToastStore } from '@renderer/store'

type LayoutControls = {
  layoutAssetId: string
  moduleRange: { min: number; max: number } | null
  currentModuleCount: number
  canAdjust: boolean
} | null

/**
 * 版式控件面板：锁定版式生成的页面可免 AI 调节模块数。
 * 滑杆调整后即时重渲染（确定性填充，零 LLM 调用）。
 */
export function LayoutControlPanel({
  sessionId,
  pageId
}: {
  sessionId: string
  pageId: string
}): React.JSX.Element | null {
  const { success, error } = useToastStore()
  const [controls, setControls] = useState<LayoutControls>(null)
  const [loading, setLoading] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [moduleCount, setModuleCount] = useState(0)

  const refreshControls = useCallback(async () => {
    if (!sessionId || !pageId) return
    setLoading(true)
    try {
      const result = await ipc.getLayoutControls(sessionId, pageId)
      setControls(result)
      if (result?.currentModuleCount) setModuleCount(result.currentModuleCount)
    } catch {
      setControls(null)
    } finally {
      setLoading(false)
    }
  }, [sessionId, pageId])

  useEffect(() => {
    void refreshControls()
  }, [refreshControls])

  const handleAdjust = useCallback(
    async (value: number) => {
      if (!sessionId || !pageId || adjusting) return
      setAdjusting(true)
      setModuleCount(value)
      try {
        await ipc.adjustModuleCount(sessionId, pageId, value)
        success(`已调整为 ${value} 个模块`)
      } catch (err) {
        error('调整失败', {
          description: err instanceof Error ? err.message : String(err)
        })
        void refreshControls()
      } finally {
        setAdjusting(false)
      }
    },
    [sessionId, pageId, adjusting, success, error, refreshControls]
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        检查版式参数...
      </div>
    )
  }

  if (!controls?.canAdjust || !controls.moduleRange) return null

  const { min, max } = controls.moduleRange

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <SlidersHorizontal className="h-3 w-3 text-primary" />
        <span className="text-xs font-semibold text-foreground">版式调节</span>
        <span className="text-[10px] text-muted-foreground">（免 AI 即时生效）</span>
      </div>
      <div className="flex items-center gap-3">
        <label className="shrink-0 text-[11px] text-muted-foreground">模块数</label>
        <input
          type="range"
          min={min}
          max={max}
          value={moduleCount}
          disabled={adjusting}
          onChange={(e) => setModuleCount(Number(e.target.value))}
          onMouseUp={(e) => void handleAdjust(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => void handleAdjust(Number((e.target as HTMLInputElement).value))}
          className="h-1.5 flex-1 cursor-pointer accent-[var(--ui-action)] disabled:opacity-50"
        />
        <span className="w-8 shrink-0 text-center text-xs font-semibold tabular-nums text-foreground">
          {adjusting ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : moduleCount}
        </span>
      </div>
      <p className="mt-1.5 text-[10px] leading-tight text-muted-foreground">
        拖动滑杆即时调整内容模块数量，无需 AI 对话，页面立即重渲染。
      </p>
    </div>
  )
}
