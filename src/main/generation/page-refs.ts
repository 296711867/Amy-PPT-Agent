/** 页面任务（PageRef）解析：规划 outline/页面任务 → 带版式提示词的生成页引用。 */
import type { OutlineItem } from '@shared/generation'
import type { VisualFormat } from '@shared/generation'
import {
  formatLayoutMasterPrompt,
  resolveLayoutMasterTemplate,
  type SessionLayoutLibrary
} from '@shared/layout-master'
import {
  formatUniversalLayoutPrompt,
  normalizeUniversalLayoutId
} from '@shared/universal-layouts'
import { readSessionLayoutLibrary } from '../session/master-service'

export type PageRef = {
  pageNumber: number
  pageId: string
  title: string
  outline: string
  layoutIntent?: OutlineItem['layoutIntent']
  contentStructure?: OutlineItem['contentStructure']
  moduleCount?: OutlineItem['moduleCount']
  visualAspect?: OutlineItem['visualAspect']
  contentDensity?: OutlineItem['contentDensity']
  visualFormat?: VisualFormat
  audienceMove?: string
  layoutId: string
  layoutPrompt: string
  imageAssetPath?: string
  imageAssetPaths?: string[]
  backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
  templatePageRole?: string
}

export type PageTaskInput = {
  pageNumber: number
  pageId: string
  title: string
  contentOutline?: string | null
  layoutIntent?: OutlineItem['layoutIntent']
  contentStructure?: OutlineItem['contentStructure']
  moduleCount?: OutlineItem['moduleCount']
  visualAspect?: OutlineItem['visualAspect']
  contentDensity?: OutlineItem['contentDensity']
  visualFormat?: OutlineItem['visualFormat']
  audienceMove?: OutlineItem['audienceMove']
  layoutId?: OutlineItem['layoutId']
  imageAssetPath?: string
  imageAssetPaths?: string[]
  backgroundAsset?: import('@shared/generation').DeckBackgroundAsset
  templatePageRole?: string
}

export const resolveLayoutMasterOutlineItems = async (
  projectDir: string,
  outlineItems: OutlineItem[]
): Promise<OutlineItem[]> => {
  const layoutLibrary = (await readSessionLayoutLibrary(projectDir)).library
  return outlineItems.map((item) => {
    if (!item.layoutIntent) return item
    const universalLayoutId = normalizeUniversalLayoutId(item.layoutId)
    if (universalLayoutId) {
      return {
        ...item,
        layoutId: universalLayoutId,
        layoutPrompt: formatUniversalLayoutPrompt(universalLayoutId)
      }
    }
    const template = resolveLayoutMasterTemplate(layoutLibrary, item.layoutIntent)
    return {
      ...item,
      layoutId: template.id,
      layoutPrompt: formatLayoutMasterPrompt(template)
    }
  })
}

export const createPageRefResolver = (layoutLibrary: SessionLayoutLibrary) => {
  return (page: PageTaskInput): PageRef => {
    const universalLayoutId = normalizeUniversalLayoutId(page.layoutId)
    const layoutTemplate = resolveLayoutMasterTemplate(layoutLibrary, page.layoutIntent)
    return {
      pageNumber: page.pageNumber,
      pageId: page.pageId,
      title: page.title,
      outline: page.contentOutline || '',
      layoutIntent: page.layoutIntent,
      contentStructure: page.contentStructure,
      moduleCount: page.moduleCount,
      visualAspect: page.visualAspect,
      contentDensity: page.contentDensity,
      visualFormat: page.visualFormat,
      audienceMove: page.audienceMove,
      layoutId: universalLayoutId || layoutTemplate.id,
      layoutPrompt: universalLayoutId
        ? formatUniversalLayoutPrompt(universalLayoutId)
        : formatLayoutMasterPrompt(layoutTemplate),
      imageAssetPath: page.imageAssetPath,
      imageAssetPaths: page.imageAssetPaths,
      backgroundAsset: page.backgroundAsset,
      templatePageRole: page.templatePageRole
    }
  }
}

export const resolveDeckPageRefs = (args: {
  pageTasks?: PageTaskInput[]
  pageFileMap: Record<string, string>
  outlineTitles: string[]
  outlineItems: OutlineItem[]
  layoutLibrary: SessionLayoutLibrary
}): PageRef[] => {
  const resolvePageRef = createPageRefResolver(args.layoutLibrary)
  if (args.pageTasks && args.pageTasks.length > 0) {
    return args.pageTasks.map(resolvePageRef)
  }
  const pageIds = Object.keys(args.pageFileMap || {})
  if (pageIds.length === 0) {
    throw new Error('pageFileMap 为空，无法建立页面任务。')
  }
  return args.outlineTitles.map((title, index) =>
    resolvePageRef({
      pageNumber: index + 1,
      pageId: pageIds[index] || pageIds[Math.min(index, pageIds.length - 1)],
      title,
      contentOutline: args.outlineItems[index]?.contentOutline || '',
      layoutIntent: args.outlineItems[index]?.layoutIntent,
      contentStructure: args.outlineItems[index]?.contentStructure,
      moduleCount: args.outlineItems[index]?.moduleCount,
      visualAspect: args.outlineItems[index]?.visualAspect,
      contentDensity: args.outlineItems[index]?.contentDensity,
      visualFormat: args.outlineItems[index]?.visualFormat,
      audienceMove: args.outlineItems[index]?.audienceMove,
      layoutId: args.outlineItems[index]?.layoutId,
      imageAssetPath: args.outlineItems[index]?.imageAssetPath,
      imageAssetPaths: args.outlineItems[index]?.imageAssetPaths,
      backgroundAsset: args.outlineItems[index]?.backgroundAsset
    })
  )
}
