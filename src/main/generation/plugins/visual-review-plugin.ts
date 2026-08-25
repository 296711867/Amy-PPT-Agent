/**
 * 视觉审阅插件：通过事件总线挂载，不修改 deck-flow 主流程。
 * 订阅 deck:before-finalize，在后台执行截图+视觉 LLM 审阅。
 */
import { generationBus } from '../generation-events'
import { runVisualDeckReview } from '../visual-review'

interface VisualReviewPluginDeps {
  db: { getSetting<T>(key: string): Promise<T | null> }
  getProvider: () => {
    provider: string
    apiKey: string
    model: string
    baseUrl: string
    maxTokens: number
    modelRuntime: unknown
    modelControl: unknown
    timeoutMs: number
  }
  getAppLocale: () => 'zh' | 'en'
  getPages: () => Array<{
    pageId: string
    pageNumber: number
    title: string
    htmlPath: string
  }>
  getSlideSize: () => { id: string; width: number; height: number }
  getAbortSignal: () => AbortSignal
  emit: (chunk: unknown) => void
}

export function registerVisualReviewPlugin(deps: VisualReviewPluginDeps): () => void {
  return generationBus.on(
    'deck:before-finalize',
    async (event) => {
      const enabled = await deps.db.getSetting<string>('visual_review').catch(() => null)
      if (enabled === 'off') return

      const pages = deps.getPages()
      if (pages.length === 0) return

      await runVisualDeckReview({
        sessionId: event.sessionId,
        runId: event.runId,
        slideSize: deps.getSlideSize() as never,
        pages,
        model: deps.getProvider() as never,
        appLocale: deps.getAppLocale(),
        isEnabled: async () => true,
        emit: deps.emit as never,
        signal: deps.getAbortSignal()
      })
    },
    'visual-review'
  )
}
