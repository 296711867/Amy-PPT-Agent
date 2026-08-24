/**
 * 前置规格拦截：在页面生成 LLM 调用之前，把内容规格校准到版式容量内。
 * 省掉"生成 → 校验失败 → 重试"整轮：文案超长截断、数组超量裁剪、
 * 图片路径缺失替换为占位。
 */
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'
import type { OutlineItem } from '@shared/generation'
import { AMY_IMAGE_PLACEHOLDER_PATH } from '@shared/generation'
import { getUniversalLayoutImageCount } from '@shared/universal-layouts'

export type PreflightAdjustment = {
  pageNumber: number
  field: string
  action: string
  detail: string
}

export type PreflightResult = {
  items: OutlineItem[]
  adjustments: PreflightAdjustment[]
}

const MAX_TITLE_CHARS = 48
const MAX_CONTENT_OUTLINE_CHARS = 200
const MAX_ITEMS_PER_MODULE = 2

/**
 * 把规划产出的 outline items 校准到版式容量内，避免生成后校验失败触发重试。
 * 纯同步纯函数，不抛异常 — 每项调整都记录但不阻塞。
 */
export function preflightSpecCheck(
  items: OutlineItem[],
  options: { projectDir?: string } = {}
): PreflightResult {
  const adjustments: PreflightAdjustment[] = []
  const adjusted = items.map((item, index) => {
    const pageNumber = index + 1
    let next = { ...item }

    // 1. 标题截断：超长标题导致换行溢出
    if (next.title && next.title.length > MAX_TITLE_CHARS) {
      const truncated = `${next.title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
      adjustments.push({
        pageNumber,
        field: 'title',
        action: 'truncate',
        detail: `${next.title.length} → ${truncated.length} chars`
      })
      next.title = truncated
    }

    // 2. 内容大纲截断：超长大纲导致模型生成过多文字
    if (next.contentOutline && next.contentOutline.length > MAX_CONTENT_OUTLINE_CHARS) {
      const truncated = `${next.contentOutline.slice(0, MAX_CONTENT_OUTLINE_CHARS).trimEnd()}…`
      adjustments.push({
        pageNumber,
        field: 'contentOutline',
        action: 'truncate',
        detail: `${next.contentOutline.length} → ${truncated.length} chars`
      })
      next.contentOutline = truncated
    }

    // 3. items（keyPoints）裁剪：超出 moduleCount × 每模块容量的裁掉
    if (Array.isArray(next.items) && next.items.length > 0) {
      const moduleCount = next.moduleCount || 4
      const maxItems = moduleCount * MAX_ITEMS_PER_MODULE
      if (next.items.length > maxItems) {
        const trimmed = next.items.slice(0, maxItems)
        adjustments.push({
          pageNumber,
          field: 'items',
          action: 'trim',
          detail: `${next.items.length} → ${trimmed.length} items (moduleCount=${moduleCount})`
        })
        next.items = trimmed
      }
    }

    // 4. 图片路径存在性：引用不存在的图片 → 替换为占位符
    if (options.projectDir && next.imageAssetPaths) {
      const checkedPaths = next.imageAssetPaths.map((assetPath) => {
        if (assetPath === AMY_IMAGE_PLACEHOLDER_PATH) return assetPath
        const absolute = path.resolve(options.projectDir!, assetPath.replace(/^\.\//, ''))
        if (!fs.existsSync(absolute)) {
          adjustments.push({
            pageNumber,
            field: 'imageAssetPaths',
            action: 'replace-missing',
            detail: `${assetPath} → placeholder (file not found)`
          })
          return AMY_IMAGE_PLACEHOLDER_PATH
        }
        return assetPath
      })
      next.imageAssetPaths = checkedPaths
      next.imageAssetPath = checkedPaths[0] || next.imageAssetPath
    }

    // 5. moduleCount 与 layoutId 的图片槽对齐：如果版式不支持图片但分配了图片路径，清除
    if (next.layoutId && next.imageAssetPaths) {
      const imageSlots = getUniversalLayoutImageCount(next.layoutId)
      if (imageSlots === 0) {
        adjustments.push({
          pageNumber,
          field: 'imageAssetPaths',
          action: 'clear-no-image-layout',
          detail: `layout ${next.layoutId} has 0 image slots, clearing ${next.imageAssetPaths.length} assigned paths`
        })
        next.imageAssetPaths = undefined
        next.imageAssetPath = undefined
      }
    }

    return next
  })

  if (adjustments.length > 0) {
    log.info('[preflight-spec] adjustments applied', {
      totalAdjustments: adjustments.length,
      summary: adjustments.slice(0, 8).map((a) => `p${a.pageNumber}:${a.field}:${a.action}`)
    })
  }

  return { items: adjusted, adjustments }
}
