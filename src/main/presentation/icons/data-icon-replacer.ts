import * as cheerio from 'cheerio'
import log from 'electron-log/main.js'
import { getIconInner, getIconStrokeAttrs, getIconViewBox, resolveCloseIconId } from './icon-registry'

const SAFE_ROOT_ATTRIBUTES = new Set([
  'class',
  'style',
  'id',
  'role',
  'tabindex',
  'focusable',
  'width',
  'height',
  'x',
  'y',
  'preserveaspectratio',
  'opacity',
  'transform',
  'vector-effect',
  'color'
])

const UNSAFE_STYLE_VALUE =
  /(?:url\s*\(|expression\s*\(|@import|javascript\s*:|behavior\s*:|-moz-binding)/i

const isSafeRootAttribute = (name: string, value: string): boolean => {
  const normalized = name.toLowerCase()
  if (normalized === 'style') return !UNSAFE_STYLE_VALUE.test(value)
  return (
    SAFE_ROOT_ATTRIBUTES.has(normalized) ||
    normalized.startsWith('aria-') ||
    normalized === 'data-motion' ||
    normalized === 'data-anim' ||
    normalized.startsWith('data-anim-')
  )
}

/**
 * 把 HTML 里的 `data-icon="id"` 引用替换成真实 lucide SVG inner markup。
 *
 * - 已知 id：保留原 class/style，注入 viewBox + strokeAttrs，塞 inner，移除 data-icon → 完整 svg
 * - 未知 id：保留原样（不替换），收集到 unknownIds（校验由 page-quality-validator 做）
 *
 * 替换器只做转换、不抛错；校验分层在 validator，符合现有 harness 设计。
 */
export function replaceDataIcons(html: string): { html: string; unknownIds: string[] } {
  // 快速跳过：绝大多数页不含图标引用，避免无谓的 cheerio 解析
  if (!html.includes('data-icon')) return { html, unknownIds: [] }

  const $ = cheerio.load(html, { scriptingEnabled: false })
  const unknownIds: string[] = []
  const viewBox = getIconViewBox()
  const strokeAttrs = getIconStrokeAttrs()

  $('[data-icon]').each((_index, el) => {
    const $el = $(el)
    const id = ($el.attr('data-icon') || '').trim()
    if (!id) {
      if (!unknownIds.includes('(empty)')) unknownIds.push('(empty)')
      return
    }
    const tagName = String($el.prop('tagName') || '').toLowerCase()
    if (tagName !== 'svg') {
      if (!unknownIds.includes(id)) unknownIds.push(id)
      return
    }
    const inner = getIconInner(id)
    if (inner === null) {
      // 未知 id：先试唯一前缀纠正（"graduation" → "graduation-cap"，I-9）。
      // 模型重复写同一个简写 id 曾把整页重试耗尽；确定性纠正零成本且安全，
      // 仅在唯一命中时替换，多候选保持未知交给校验层列候选。
      const closeId = resolveCloseIconId(id)
      if (closeId !== null) {
        const closeInner = getIconInner(closeId)
        if (closeInner !== null) {
          log.info('[page-writer] corrected unknown icon id to unique prefix match', {
            from: id,
            to: closeId
          })
          $el.attr('data-icon', closeId)
          $el.attr('viewBox', viewBox)
          const trustedSvg = cheerio.load(`<svg ${strokeAttrs}></svg>`, {
            scriptingEnabled: false
          })('svg')
          for (const [name, value] of Object.entries(trustedSvg.attr() || {})) {
            $el.attr(name, value)
          }
          $el.html(closeInner)
          $el.removeAttr('data-icon')
          return
        }
      }
      if (!unknownIds.includes(id)) unknownIds.push(id)
      return
    }
    for (const [name, value] of Object.entries($el.attr() || {})) {
      if (name.toLowerCase() === 'data-icon') continue
      if (!isSafeRootAttribute(name, value)) $el.removeAttr(name)
    }
    // 已知 id：保留原 class/style，构造标准描边 svg
    $el.attr('viewBox', viewBox)
    const trustedSvg = cheerio.load(`<svg ${strokeAttrs}></svg>`, {
      scriptingEnabled: false
    })('svg')
    for (const [name, value] of Object.entries(trustedSvg.attr() || {})) {
      $el.attr(name, value)
    }
    $el.html(inner)
    $el.removeAttr('data-icon')
  })

  return { html: $.html(), unknownIds }
}
