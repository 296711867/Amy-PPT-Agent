export type DeckRenderGateReport = {
  available: boolean
  unavailablePages: Array<{ pageId: string; reason: string }>
}

const NON_BLOCKING_RENDER_INFRASTRUCTURE_RE =
  /ERR_BLOCKED_BY_CLIENT|Electron app is not ready|BrowserWindow.*(?:destroyed|unavailable)|renderer unavailable|render validation timeout/i

export const isNonBlockingRenderInfrastructureFailure = (reason: string): boolean =>
  NON_BLOCKING_RENDER_INFRASTRUCTURE_RE.test(reason)

export function resolveIncompleteDeckRenderPages(report: DeckRenderGateReport): Array<{
  pageId: string
  reason: string
}> {
  if (report.available) return []
  return report.unavailablePages.filter(
    (page) =>
      page.pageId.trim().length > 0 && !isNonBlockingRenderInfrastructureFailure(page.reason)
  )
}
