/**
 * 资产完整性插件：通过事件总线挂载，渲染后检查本地资源引用。
 */
import { generationBus } from '../generation-events'
import { validateAssetIntegrity } from '../asset-integrity'

interface AssetIntegrityPluginDeps {
  getPages: () => Array<{
    pageId: string
    pageNumber: number
    htmlPath: string
  }>
  onViolation: (message: string) => void
}

export function registerAssetIntegrityPlugin(deps: AssetIntegrityPluginDeps): () => void {
  return generationBus.on(
    'deck:asset-integrity',
    async (event) => {
      const pages = deps.getPages()
      if (pages.length === 0) return

      const report = validateAssetIntegrity(pages)
      if (report.violations.length > 0) {
        deps.onViolation(
          `注意：${report.violations.length} 个本地资源引用缺失，页面上可能显示裂图。`
        )
      }

      // 写回事件（供其他监听器使用）
      event.violations.push(...report.violations)
      event.totalReferences = report.totalReferences
    },
    'asset-integrity'
  )
}
