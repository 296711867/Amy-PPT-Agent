/**
 * 资产完整性校验：扫描页面 HTML 中引用的本地资源（图片/字体/背景），
 * 验证对应文件在 session 目录中存在。缺失 = 警告（不阻塞，但报告给用户）。
 */
import fs from 'fs'
import path from 'path'
import log from 'electron-log/main.js'

export type AssetIntegrityViolation = {
  pageId: string
  pageNumber: number
  assetPath: string
  kind: 'missing' | 'external'
}

export type AssetIntegrityReport = {
  violations: AssetIntegrityViolation[]
  totalReferences: number
  checkedPages: number
}

/** 从 HTML 中提取本地资源引用（src/href/poster/srcset + CSS url()）。 */
export function extractLocalAssetRefs(html: string): Set<string> {
  const refs = new Set<string>()

  // <img src>, <source srcset>, <video poster>, <link href>, <script src>
  const attrRe = /\b(?:src|href|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const match of html.matchAll(attrRe)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    // srcset 可能含多个候选，取全部
    const candidates = value.includes(',') && value.includes(' ')
      ? value.split(',').map((part) => part.trim().split(/\s+/)[0])
      : [value]
    for (const candidate of candidates) addLocalRef(refs, candidate)
  }

  // CSS url(...)
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi
  for (const match of html.matchAll(urlRe)) {
    addLocalRef(refs, match[1])
  }

  return refs
}

const addLocalRef = (refs: Set<string>, rawValue: string): void => {
  const value = rawValue.trim()
  if (!value) return
  // 只关心相对路径（./xxx 或不带协议的路径）
  if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/\/)/i.test(value)) return
  // 去掉 query string 和 hash
  const clean = value.replace(/[?#].*$/, '')
  if (!clean || clean === '/') return
  refs.add(clean)
}

/**
 * 校验一组页面的本地资源完整性。
 * 违规不阻塞生成 —— 记录后由调用方决定如何呈现。
 */
export function validateAssetIntegrity(pages: Array<{
  pageId: string
  pageNumber: number
  htmlPath: string
}>): AssetIntegrityReport {
  const violations: AssetIntegrityViolation[] = []
  let totalReferences = 0

  for (const page of pages) {
    try {
      const html = fs.readFileSync(page.htmlPath, 'utf-8')
      const refs = extractLocalAssetRefs(html)
      const pageDir = path.dirname(page.htmlPath)

      for (const ref of refs) {
        totalReferences += 1
        const absolute = path.resolve(pageDir, ref)
        if (!fs.existsSync(absolute)) {
          violations.push({
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            assetPath: ref,
            kind: 'missing'
          })
        }
      }
    } catch {
      // 页面文件读不到时跳过（可能是尚未写入）
    }
  }

  if (violations.length > 0) {
    log.warn('[asset-integrity] missing local assets found', {
      checkedPages: pages.length,
      totalReferences,
      violations: violations.slice(0, 10).map((v) => ({
        page: v.pageNumber,
        path: v.assetPath
      })),
      totalViolations: violations.length
    })
  }

  return { violations, totalReferences, checkedPages: pages.length }
}
