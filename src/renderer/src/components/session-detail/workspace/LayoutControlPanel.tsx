import { useCallback, useEffect, useState } from 'react'
import { Loader2, Palette, SlidersHorizontal, Target, LayoutGrid } from 'lucide-react'
import { ipc } from '@renderer/lib/ipc'
import { useToastStore } from '@renderer/store'

type LayoutControls = {
  layoutAssetId: string
  moduleRange: { min: number; max: number } | null
  currentModuleCount: number
  canAdjust: boolean
  currentPalette: string
  palettes: Array<{ id: string; label: string }>
  listItems: string[]
  alternativeLayouts: Array<{ id: string; title: string; roles: string[] }>
} | null

/**
 * 版式控件面板：锁定版式生成的页面可免 AI 调节模块数、配色、重点和布局。
 * 全部走确定性填充，零 LLM 调用，拖动即时重渲染。
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
  const [palette, setPalette] = useState('blue')
  const [focusIndex, setFocusIndex] = useState(0)
  const [layoutId, setLayoutId] = useState('')

  const refreshControls = useCallback(async () => {
    if (!sessionId || !pageId) return
    setLoading(true)
    try {
      const result = await ipc.getLayoutControls(sessionId, pageId)
      setControls(result)
      if (result) {
        setModuleCount(result.currentModuleCount)
        setPalette(result.currentPalette)
        setLayoutId(result.layoutAssetId)
        setFocusIndex(0)
      }
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
    async (fn: () => Promise<{ success: boolean }>, label: string) => {
      if (adjusting) return
      setAdjusting(true)
      try {
        await fn()
        success(label)
      } catch (err) {
        error('调整失败', { description: err instanceof Error ? err.message : String(err) })
        void refreshControls()
      } finally {
        setAdjusting(false)
      }
    },
    [adjusting, success, error, refreshControls]
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        检查版式参数...
      </div>
    )
  }

  if (!controls) return null

  const { moduleRange, palettes, listItems, alternativeLayouts } = controls

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2.5 space-y-3">
      <div className="flex items-center gap-1.5">
        <SlidersHorizontal className="h-3 w-3 text-primary" />
        <span className="text-xs font-semibold text-foreground">版式调节</span>
        <span className="text-[10px] text-muted-foreground">（免 AI 即时生效）</span>
      </div>

      {/* 模块数滑杆 */}
      {moduleRange && (
        <div className="flex items-center gap-2">
          <label className="shrink-0 text-[11px] text-muted-foreground">模块数</label>
          <input
            type="range"
            min={moduleRange.min}
            max={moduleRange.max}
            value={moduleCount}
            disabled={adjusting}
            onChange={(e) => setModuleCount(Number(e.target.value))}
            onMouseUp={() =>
              void handleAdjust(
                () => ipc.adjustModuleCount(sessionId, pageId, moduleCount),
                `已调整为 ${moduleCount} 个模块`
              )
            }
            onTouchEnd={() =>
              void handleAdjust(
                () => ipc.adjustModuleCount(sessionId, pageId, moduleCount),
                `已调整为 ${moduleCount} 个模块`
              )
            }
            className="h-1.5 flex-1 cursor-pointer accent-[var(--ui-action)] disabled:opacity-50"
          />
          <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums text-foreground">
            {adjusting ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : moduleCount}
          </span>
        </div>
      )}

      {/* 配色切换 */}
      <div>
        <div className="mb-1 flex items-center gap-1">
          <Palette className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">配色</span>
        </div>
        <div className="flex gap-1.5">
          {palettes.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={adjusting}
              onClick={() => {
                setPalette(p.id)
                void handleAdjust(
                  () => ipc.switchPalette(sessionId, pageId, p.id),
                  `已切换为${p.label}色系`
                )
              }}
              className={`flex-1 rounded border px-1.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                palette === p.id
                  ? 'border-primary bg-[var(--ui-action-soft)]/50 text-foreground'
                  : 'border-border bg-[var(--ui-surface-elevated)]/60 text-muted-foreground hover:border-[var(--ui-focus)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* 重点切换 */}
      {listItems.length > 1 && (
        <div>
          <div className="mb-1 flex items-center gap-1">
            <Target className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">页面重点</span>
          </div>
          <div className="flex flex-col gap-0.5">
            {listItems.slice(0, 6).map((item, index) => (
              <button
                key={`${item}-${index}`}
                type="button"
                disabled={adjusting}
                onClick={() => {
                  setFocusIndex(index)
                  void handleAdjust(
                    () => ipc.reorderFocus(sessionId, pageId, index),
                    `已将「${item.slice(0, 12)}」设为焦点`
                  )
                }}
                className={`truncate rounded px-2 py-1 text-left text-[11px] transition-colors disabled:opacity-50 ${
                  focusIndex === index
                    ? 'bg-[var(--ui-action-soft)]/50 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60'
                }`}
                title={item}
              >
                {focusIndex === index ? '★ ' : ''}
                {item.slice(0, 20)}
                {item.length > 20 ? '…' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 布局切换 */}
      {alternativeLayouts.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1">
            <LayoutGrid className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">切换布局</span>
          </div>
          <select
            value={layoutId}
            disabled={adjusting}
            onChange={(e) => {
              const nextId = e.target.value
              setLayoutId(nextId)
              const nextLayout = alternativeLayouts.find((l) => l.id === nextId)
              void handleAdjust(
                () => ipc.switchLayout(sessionId, pageId, nextId),
                nextLayout ? `已切换为「${nextLayout.title}」` : '布局已切换'
              )
            }}
            className="h-7 w-full rounded border border-border bg-[var(--ui-surface-elevated)] px-2 text-[11px] text-foreground disabled:opacity-50"
          >
            <option value={controls.layoutAssetId}>当前版式</option>
            {alternativeLayouts.map((alt) => (
              <option key={alt.id} value={alt.id}>
                {alt.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="text-[10px] leading-tight text-muted-foreground">
        以上调节均通过确定性填充完成，无需 AI 对话，页面即时重渲染。
      </p>
    </div>
  )
}
