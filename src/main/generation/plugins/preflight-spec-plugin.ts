/**
 * 前置规格拦截插件：规划产出后、LLM 调用前校准内容到版式容量。
 */
import { generationBus } from '../generation-events'
import { preflightSpecCheck } from '../preflight-spec'

interface PreflightPluginDeps {
  projectDir: string
  onAdjustment: (summary: string) => void
}

export function registerPreflightSpecPlugin(deps: PreflightPluginDeps): () => void {
  return generationBus.on(
    'generate:after-planning',
    async (event) => {
      const result = preflightSpecCheck(event.outline, {
        projectDir: deps.projectDir
      })

      if (result.adjustments.length > 0) {
        const summary = result.adjustments
          .slice(0, 5)
          .map((a) => `p${a.pageNumber}:${a.field}:${a.action}`)
          .join(', ')
        deps.onAdjustment(`前置校准 ${result.adjustments.length} 项：${summary}`)

        // 写回事件：后续阶段使用校准后的 items
        event.outline.splice(0, event.outline.length, ...result.items)
      }
    },
    'preflight-spec'
  )
}
