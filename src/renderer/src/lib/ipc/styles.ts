/** 样式与元素编辑域 IPC：样式包管理、预览加载、元素编辑、图表数据、文件打开。 */
import { getIpc } from "./core"
import type {
  EnsureElementAnchorPayload,
  EnsureElementAnchorResult,
  HtmlThumbnailTask,
  StyleDetail,
  StyleListItem,
  StyleParseResult,
  UpdateElementLayoutPayload,
  UpdateElementPropertiesPayload
} from "./types"
import type { ElementAnimationConfig, ElementAnimationPatch } from "@shared/element-animation.js"
import type { ParsedChartDataResult } from "@shared/chart-data"
export const stylesIpc = {
  getStyles: () =>
    getIpc().invoke('styles:get') as Promise<{
      categories: Record<
        string,
        Array<{
          id: string
          label: string
          description: string
          source?: 'builtin' | 'custom' | 'override'
          editable?: boolean
          styleCase?: string
        }>
      >
      defaultStyle: string
    }>,
  getStyleDetail: (styleId: string) =>
    getIpc().invoke('styles:getDetail', styleId) as Promise<StyleDetail>,
  listStyles: (payload?: { sessionId?: string }) =>
    getIpc().invoke('styles:list', payload) as Promise<{ items: StyleListItem[] }>,
  generateStylePreview: (payload: { styleId: string; modelConfigId?: string }) =>
    getIpc().invoke('styles:generatePreview', payload) as Promise<{
      success: boolean
      previewPath: string
      thumbnailPath: string
    }>,
  setStyleFavorite: (payload: { styleId: string; favorite: boolean }) =>
    getIpc().invoke('styles:setFavorite', payload) as Promise<{
      success: boolean
      styleId: string
      favoriteAt: number | null
    }>,
  onHtmlThumbnailChanged: (callback: (task: HtmlThumbnailTask) => void): (() => void) => {
    const channel = 'thumbnails:changed'
    const handler = (_event: unknown, task: Parameters<typeof callback>[0]): void => callback(task)
    getIpc().on(channel, handler)
    return () => getIpc().removeListener(channel, handler)
  },
  parseStyleFile: (payload: { filePath: string; modelConfigId?: string }) =>
    getIpc().invoke('styles:parseFile', payload) as Promise<StyleParseResult>,
  parseStylePptx: (payload: { filePath: string; modelConfigId?: string }) =>
    getIpc().invoke('styles:parsePptx', payload) as Promise<StyleParseResult>,
  parseStyleImage: (payload: { imageBase64: string; mimeType: string; modelConfigId?: string }) =>
    getIpc().invoke('styles:parseImage', payload) as Promise<StyleParseResult>,
  importStylePackageZip: () =>
    getIpc().invoke('styles:importPackageZip') as Promise<{
      success: boolean
      cancelled?: boolean
      id: string
      source: 'custom' | 'override'
    }>,
  importStylePackageDirectory: () =>
    getIpc().invoke('styles:importPackageDirectory') as Promise<{
      success: boolean
      cancelled?: boolean
      id: string
      source: 'custom' | 'override'
    }>,
  exportStylePackageZip: (payload: { styleId: string }) =>
    getIpc().invoke('styles:exportPackageZip', payload) as Promise<{
      success: boolean
      canceled?: boolean
      filePath?: string
    }>,
  createStyle: (payload: {
    label: string
    description: string
    category?: string
    aliases?: string[]
    styleSkill: string
    styleCase?: string
  }) =>
    getIpc().invoke('styles:create', payload) as Promise<{
      success: boolean
      id: string
      source: 'custom' | 'override'
    }>,
  updateStyle: (payload: {
    id: string
    label: string
    description: string
    category?: string
    aliases?: string[]
    styleSkill: string
    styleCase?: string
  }) =>
    getIpc().invoke('styles:update', payload) as Promise<{
      success: boolean
      id: string
      source: 'custom' | 'override'
    }>,
  deleteStyle: (styleId: string) =>
    getIpc().invoke('styles:delete', styleId) as Promise<{
      success: boolean
      deleted: boolean
    }>,
  loadPreview: (htmlPath: string, sessionId?: string) =>
    getIpc().invoke('preview:load', { htmlPath, sessionId }) as Promise<string>,
  loadPagePreview: (htmlPath: string, pageId: string, sessionId?: string) =>
    getIpc().invoke('preview:loadPage', { htmlPath, pageId, sessionId }) as Promise<{
      pageNumber: number
      pageId: string
      title: string
      html: string
    }>,
  updateElementLayout: (payload: UpdateElementLayoutPayload) =>
    getIpc().invoke('drag-editor:update-element-layout', payload) as Promise<{
      success: boolean
    }>,
  ensureElementAnchor: (payload: EnsureElementAnchorPayload) =>
    getIpc().invoke('element-anchor:ensure', payload) as Promise<EnsureElementAnchorResult>,
  getElementAnimation: (payload: {
    sessionId: string
    htmlPath: string
    pageId: string
    selector: string
  }) =>
    getIpc().invoke('element-animation:get', payload) as Promise<{
      animation: ElementAnimationConfig | null
    }>,
  setElementAnimation: (payload: {
    sessionId: string
    htmlPath: string
    pageId: string
    selector: string
    patch: ElementAnimationPatch
  }) =>
    getIpc().invoke('element-animation:set', payload) as Promise<{
      success: boolean
      changed: boolean
      animation: ElementAnimationConfig | null
    }>,
  updateElementProperties: (payload: UpdateElementPropertiesPayload) =>
    getIpc().invoke('text-editor:update-element-properties', payload) as Promise<{
      success: boolean
    }>,
  deleteElement: (payload: {
    sessionId: string
    htmlPath: string
    pageId: string
    selector: string
  }) =>
    getIpc().invoke('element-editor:delete-element', payload) as Promise<{
      success: boolean
    }>,
  saveEditBatch: (payload: {
    sessionId: string
    htmlPath: string
    pageId: string
    dragEdits: unknown[]
    textEdits: unknown[]
    propertyEdits?: unknown[]
    deletes?: unknown[]
    addElements?: unknown[]
    prompt?: string
  }) =>
    getIpc().invoke('edit:save-batch', payload) as Promise<{
      success: boolean
      dragCount: number
      textCount: number
      propertyCount?: number
      deleteCount: number
      addCount: number
      warnings?: string[]
    }>,
  applySyncElementToAllPages: (payload: {
    sessionId: string
    htmlPath: string
    pageId: string
    sourceHtmlFragment: string
    syncElementId?: string
    sourceBlockId?: string
  }) =>
    getIpc().invoke('element-editor:apply-sync-to-all-pages', payload) as Promise<{
      success: boolean
      syncElementId: string
      changedCount: number
      insertedCount: number
      updatedCount: number
    }>,
  chooseAndParseChartData: () =>
    getIpc().invoke('chart-data:choose-and-parse') as Promise<ParsedChartDataResult>,
  openFile: (filePath: string, sessionId?: string) =>
    getIpc().invoke('file:open', { path: filePath, sessionId }) as Promise<string>,
  revealFile: (filePath: string, sessionId?: string) =>
    getIpc().invoke('file:reveal', { path: filePath, sessionId }) as Promise<{ success: boolean }>,
  openInBrowser: (filePath: string, hash?: string, sessionId?: string) =>
    getIpc().invoke('file:openInBrowser', { path: filePath, hash, sessionId }) as Promise<{
      success: boolean
    }>,
  saveFile: (payload: { path: string; content: string; sessionId?: string }) =>
    getIpc().invoke('file:save', payload) as Promise<{ success: boolean }>,
}
