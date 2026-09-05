import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import type { ImageModelProvider } from '@shared/image-generation'
import type { ImagePolicy, OutlineItem } from '@shared/generation'
import { AMY_IMAGE_PLACEHOLDER_PATH } from '@shared/generation'
import { readString } from '../agent-runtime/provider/image/providers/utils'
import { resolveImageGenerationProvider } from '../agent-runtime/provider/image'
import type { ResolvedImageModelConfig } from '../agent-runtime/provider/image'
import { resolveImageModelRuntimeConfig } from '../config/image-model-runtime-config'
import {
  getUniversalLayoutImageAspect,
  getUniversalLayoutImageCount
} from '@shared/universal-layouts'

const VALID_IMAGE_PROVIDERS = new Set<ImageModelProvider>([
  'jimeng',
  'jimeng4',
  'agnes',
  'siliconflow',
  'openaiCompatible',
  'gemini',
  'seedream'
])

const PLACEHOLDER_PATH = AMY_IMAGE_PLACEHOLDER_PATH

export const resolveDeckImageGenerationSize = (layoutId: unknown): string => {
  const aspect = getUniversalLayoutImageAspect(layoutId)
  if (aspect === 'portrait') return '3:4'
  if (aspect === 'square') return '1:1'
  return '16:9'
}

const hasCompleteGeneratedImageSet = (
  projectDir: string,
  item: OutlineItem,
  imageCount: number
): boolean =>
  Array.isArray(item.imageAssetPaths) &&
  item.imageAssetPaths.length === imageCount &&
  item.imageAssetPaths.every(
    (assetPath) =>
      typeof assetPath === 'string' &&
      assetPath !== PLACEHOLDER_PATH &&
      fs.existsSync(path.resolve(projectDir, assetPath.replace(/^\.\//, '')))
  )

const safeFilePart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'slide-image'

export async function prepareDeckImageAssets(args: {
  db: {
    getActiveImageModelConfig(): Promise<
      | {
          id: string
          name: string
          provider: string
          active: number
          modelConfig: string
        }
      | undefined
    >
  }
  decryptApiKey(value: string): string
  projectDir: string
  imagePolicy: ImagePolicy
  outlineItems: OutlineItem[]
  pageNumbers?: number[]
  signal: AbortSignal
  onStatus?: (status: {
    pageNumber: number
    state: 'preparing' | 'generated' | 'placeholder'
    detail?: string
  }) => void
}): Promise<OutlineItem[]> {
  const resolvePageNumber = (index: number): number => args.pageNumbers?.[index] || index + 1
  // 'none'：用户明确不需要额外配图（模板链路默认），既不生成也不挂占位图。
  if (args.imagePolicy === 'none') return args.outlineItems
  const imagePages = args.outlineItems
    .map((item, index) => ({
      item,
      index,
      imageCount: getUniversalLayoutImageCount(item.layoutId)
    }))
    .filter(
      ({ item, imageCount }) =>
        imageCount > 0 && !hasCompleteGeneratedImageSet(args.projectDir, item, imageCount)
    )
  if (imagePages.length === 0) return args.outlineItems

  const incompletePageIndexes = new Set(imagePages.map(({ index }) => index))
  const fallback = (): OutlineItem[] =>
    args.outlineItems.map((item, index) => {
      if (!incompletePageIndexes.has(index)) return item
      const imageCount = getUniversalLayoutImageCount(item.layoutId)
      if (imageCount === 0) return item
      const imageAssetPaths = Array.from({ length: imageCount }, () => PLACEHOLDER_PATH)
      return {
        ...item,
        imagePolicy: args.imagePolicy,
        imageAssetPath: imageAssetPaths[0],
        imageAssetPaths
      }
    })
  if (args.imagePolicy !== 'ai') {
    imagePages.forEach(({ index }) =>
      args.onStatus?.({ pageNumber: resolvePageNumber(index), state: 'placeholder' })
    )
    return fallback()
  }

  const rawConfig = await args.db.getActiveImageModelConfig().catch(() => undefined)
  if (!rawConfig || !VALID_IMAGE_PROVIDERS.has(rawConfig.provider as ImageModelProvider)) {
    log.warn('[generate:deck-images] no active image model; using placeholders')
    imagePages.forEach(({ index }) =>
      args.onStatus?.({
        pageNumber: resolvePageNumber(index),
        state: 'placeholder',
        detail: 'No active image model'
      })
    )
    return fallback()
  }

  const modelConfig: ResolvedImageModelConfig = {
    id: rawConfig.id,
    name: rawConfig.name,
    provider: rawConfig.provider as ImageModelProvider,
    active: rawConfig.active === 1,
    modelConfig: resolveImageModelRuntimeConfig({
      config: rawConfig,
      decryptConfig: args.decryptApiKey
    })
  }
  // 预检：配置了 provider 但缺 model 的半成品配置直接走占位图，
  // 避免每页每槽都撞一次适配器抛错。
  const configuredImageModel = readString(modelConfig.modelConfig, 'model')
  if (!configuredImageModel) {
    log.warn('[generate:deck-images] active image model config incomplete; using placeholders', {
      provider: modelConfig.provider
    })
    imagePages.forEach(({ index }) =>
      args.onStatus?.({
        pageNumber: resolvePageNumber(index),
        state: 'placeholder',
        detail: `生图模型「${rawConfig.name}」缺少 model 字段`
      })
    )
    return fallback()
  }
  const adapter = resolveImageGenerationProvider(modelConfig.provider)
  const imagesDir = path.join(args.projectDir, 'images')
  await fs.promises.mkdir(imagesDir, { recursive: true })
  const resolved = [...args.outlineItems]

  for (const { item, index, imageCount } of imagePages) {
    if (args.signal.aborted) throw args.signal.reason
    const pageNumber = resolvePageNumber(index)
    args.onStatus?.({ pageNumber, state: 'preparing' })
    const imageAssetPaths: string[] = []
    let failureCount = 0
    const generationSize = resolveDeckImageGenerationSize(item.layoutId)
    const imageAspect = getUniversalLayoutImageAspect(item.layoutId) || 'landscape'
    for (let slotIndex = 0; slotIndex < imageCount; slotIndex += 1) {
      const prompt = [
        `Create visual ${slotIndex + 1} of ${imageCount} for the presentation slide "${item.title}".`,
        `Slide content: ${item.contentOutline}`,
        'Each slot on this slide must show a distinct subject, angle, moment, example, or supporting detail.',
        `Make this visual specifically useful for slot ${slotIndex + 1}; do not repeat the composition of another slot.`,
        `Compose for a ${imageAspect} PowerPoint frame. Important subjects must remain readable after object-fit: cover cropping.`,
        'Use a clean editorial composition suitable for insertion into a PowerPoint image frame.',
        'No text, no letters, no watermark, no UI screenshot, and no decorative border.'
      ].join('\n')
      try {
        const [result] = await adapter.generate(modelConfig, {
          prompt,
          size: generationSize,
          count: 1,
          signal: args.signal
        })
        if (!result) throw new Error('Image provider returned no result')
        const extension = /^\.[a-z0-9]{2,5}$/i.test(result.extension) ? result.extension : '.png'
        const fileName = `deck-${pageNumber}-slot-${slotIndex + 1}-${safeFilePart(item.title)}${extension}`
        await fs.promises.writeFile(path.join(imagesDir, fileName), result.bytes)
        imageAssetPaths.push(`./images/${fileName}`)
      } catch (error) {
        failureCount += 1
        imageAssetPaths.push(PLACEHOLDER_PATH)
        log.warn('[generate:deck-images] slot failed; using placeholder', {
          pageNumber,
          slotNumber: slotIndex + 1,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    resolved[index] = {
      ...item,
      imagePolicy: 'ai',
      imageAssetPath: imageAssetPaths[0],
      imageAssetPaths
    }
    if (failureCount === 0) {
      args.onStatus?.({ pageNumber, state: 'generated' })
      log.info('[generate:deck-images] generated', {
        pageNumber,
        imageCount
      })
    } else {
      args.onStatus?.({
        pageNumber,
        state: 'placeholder',
        detail: `${failureCount}/${imageCount} image slots fell back to placeholders`
      })
    }
  }
  return resolved
}
