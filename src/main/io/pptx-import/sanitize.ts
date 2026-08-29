import * as cheerio from 'cheerio'
import { clampNumber } from './render-shared'
import { DEFAULT_IMPORTED_TEXT_FONT } from './constants'

export const stripHtml = (html: string): string => {
  if (!html) return ''
  const $ = cheerio.load(html, { scriptingEnabled: false })
  return $.root().text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

const ALLOWED_TEXT_TAGS = new Set([
  'p',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'sub',
  'sup'
])

const DANGEROUS_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'img'
])

const ALLOWED_TEXT_STYLE_PROPS = new Set([
  'color',
  'background',
  'background-image',
  'background-color',
  'background-clip',
  '-webkit-background-clip',
  '-webkit-text-fill-color',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-align',
  'text-shadow',
  'line-height',
  'vertical-align',
  'letter-spacing',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'text-indent'
])

const normalizeImportedSymbols = (value: string): string =>
  value
    // PowerPoint stores Wingdings 3 glyph 0xC4 in Unicode's private-use area.
    .replace(/\uf0c4/gi, '➜')

const scaleCssLengthToken = (value: string, scale: number): string | null => {
  const trimmed = value.trim()
  if (/^0(?:\.0+)?(?:px|pt)?$/i.test(trimmed)) return '0'
  const ptMatch = trimmed.match(/^(-?[0-9.]+)pt$/i)
  if (ptMatch) return `${(clampNumber(ptMatch[1]) * scale).toFixed(1)}px`
  const pxMatch = trimmed.match(/^(-?[0-9.]+)px$/i)
  if (pxMatch) return `${clampNumber(pxMatch[1]).toFixed(1)}px`
  return null
}

const sanitizeCssBoxLength = (value: string, scale: number): string | null => {
  const tokens = value.trim().split(/\s+/)
  if (tokens.length < 1 || tokens.length > 4) return null
  const scaled = tokens.map((token) => scaleCssLengthToken(token, scale))
  return scaled.every((token): token is string => Boolean(token)) ? scaled.join(' ') : null
}

const sanitizeCssValue = (property: string, rawValue: string, scale: number): string | null => {
  const value = rawValue.trim()
  if (!value) return null
  if (/url\s*\(|expression\s*\(|javascript:|data:/i.test(value)) return null
  const normalizedProperty = property.trim().toLowerCase()
  if (normalizedProperty === 'background' || normalizedProperty === 'background-image') {
    if (!/^(?:linear-gradient|radial-gradient)\s*\(/i.test(value)) return null
  }
  if (normalizedProperty === 'background-clip' || normalizedProperty === '-webkit-background-clip') {
    return /^(?:text|border-box|padding-box|content-box)$/i.test(value) ? value : null
  }
  if (property === 'font-size' || property === 'line-height') {
    const ptMatch = value.match(/^([0-9.]+)pt$/i)
    if (ptMatch) {
      const px = Math.max(8, clampNumber(ptMatch[1]) * scale)
      return `${px.toFixed(1)}px`
    }
  }
  if (
    normalizedProperty === 'text-indent' ||
    normalizedProperty === 'margin' ||
    normalizedProperty.startsWith('margin-')
  ) {
    return sanitizeCssBoxLength(value, scale)
  }
  if (/^[#a-z0-9\s.,()%'"-]+$/i.test(value)) return value
  return null
}

const ensureVisibleTextStyle = (style: string): string => {
  if (!style) return ''
  const hasTransparentText =
    /(?:^|;)\s*color\s*:\s*transparent\s*(?:;|$)/i.test(style) ||
    /(?:^|;)\s*-webkit-text-fill-color\s*:\s*transparent\s*(?:;|$)/i.test(style)
  if (!hasTransparentText) return style

  const hasGradientBackground =
    /(?:^|;)\s*background(?:-image)?\s*:\s*(?:linear-gradient|radial-gradient)\s*\(/i.test(style)
  const hasTextClip =
    /(?:^|;)\s*(?:-webkit-)?background-clip\s*:\s*text\s*(?:;|$)/i.test(style)

  if (hasGradientBackground && hasTextClip) {
    return style.includes('-webkit-background-clip')
      ? style
      : `${style};-webkit-background-clip:text`
  }

  return style
    .replace(/((?:^|;)\s*color\s*:\s*)transparent(\s*(?:;|$))/gi, '$1#111827$2')
    .replace(
      /((?:^|;)\s*-webkit-text-fill-color\s*:\s*)transparent(\s*(?:;|$))/gi,
      '$1#111827$2'
    )
}

export const sanitizeImportedCssColor = (rawValue: unknown): string | null => {
  if (typeof rawValue !== 'string') return null
  return sanitizeCssValue('color', rawValue, 1)
}

export const isTransparentCssColor = (color: string | null | undefined): boolean => {
  if (!color) return true
  const normalized = color.trim().toLowerCase()
  if (!normalized || normalized === 'none' || normalized === 'transparent') return true
  const hex = normalized.match(/^#([0-9a-f]{8})$/i)
  return Boolean(hex && hex[1].slice(6) === '00')
}

const sanitizeStyleAttribute = (style: string, scale: number): string => {
  return ensureVisibleTextStyle(
    style
      .split(';')
      .map((part) => {
        const [propertyRaw, ...valueParts] = part.split(':')
        const property = propertyRaw?.trim().toLowerCase()
        const valueRaw = valueParts.join(':')
        if (!property || !ALLOWED_TEXT_STYLE_PROPS.has(property)) return ''
        const value = sanitizeCssValue(property, valueRaw, scale)
        return value ? `${property}:${value}` : ''
      })
      .filter(Boolean)
      .join(';')
  )
}

export const sanitizeContentHtml = (html: string, scale: number): string => {
  if (!html) return ''
  const $ = cheerio.load(html, { scriptingEnabled: false }, false)
  $('*').each((_, node) => {
    const rawNode = node as unknown as { tagName?: string; attribs?: Record<string, string> }
    const element = $(node)
    const tagName = String(rawNode.tagName || '').toLowerCase()
    if (DANGEROUS_TAGS.has(tagName)) {
      element.remove()
      return
    }
    if (!ALLOWED_TEXT_TAGS.has(tagName)) {
      element.replaceWith(element.contents())
      return
    }
    for (const attribute of Object.keys(rawNode.attribs || {})) {
      const value = element.attr(attribute) || ''
      const name = attribute.toLowerCase()
      if (name.startsWith('on')) {
        element.removeAttr(attribute)
        continue
      }
      if (name !== 'style') {
        element.removeAttr(attribute)
        continue
      }
      const sanitizedStyle = sanitizeStyleAttribute(value, scale)
      if (sanitizedStyle) {
        element.attr('style', sanitizedStyle)
      } else {
        element.removeAttr('style')
      }
    }
  })
  $.root()
    .contents()
    .add($.root().find('*').contents())
    .each((_, node) => {
      if (node.type === 'text' && 'data' in node && typeof node.data === 'string') {
        node.data = normalizeImportedSymbols(node.data)
      }
    })
  return $.root().html() || ''
}

export const sanitizeTableCellContentHtml = (html: string, scale: number): string => {
  const sanitized = sanitizeContentHtml(html, Math.min(scale, 1.25))
  return sanitized.replace(/\u00a0/g, '&nbsp;')
}

const parseCssPx = (style: string, property: string): number | null => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(`${escaped}\\s*:\\s*([0-9.]+)px`, 'i'))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

const parseCssValue = (style: string, property: string): string | null => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(`${escaped}\\s*:\\s*([^;]+)`, 'i'))
  return match?.[1]?.trim() || null
}

export const extractTextTypography = (
  content: string,
  element: Record<string, unknown>,
  textScale: number
): {
  fontSize: number
  lineHeight: number
  fontFamily: string
  fontWeight: string
  fontStyle: string
  letterSpacing: number
} => {
  const $ = cheerio.load(`<body>${content}</body>`, { scriptingEnabled: false })
  let style = ''
  $('*').each((_, node) => {
    const candidate = $(node).attr('style') || ''
    if (candidate && (!style || candidate.includes('font-size'))) style = candidate
  })
  const fontSize =
    parseCssPx(style, 'font-size') ||
    Math.max(10, clampNumber(element.fontSize || element.font_size || 18) * textScale)
  const lineHeight = parseCssPx(style, 'line-height') || fontSize * 1.18
  return {
    fontSize,
    lineHeight,
    fontFamily: DEFAULT_IMPORTED_TEXT_FONT,
    fontWeight:
      parseCssValue(style, 'font-weight') ||
      (element.fontBold || element.bold ? '700' : '400'),
    fontStyle: parseCssValue(style, 'font-style') || (element.fontItalic ? 'italic' : 'normal'),
    letterSpacing: parseCssPx(style, 'letter-spacing') || 0
  }
}

export const scaleContentTypography = (content: string, ratio: number): string => {
  if (ratio >= 0.995) return content
  const $ = cheerio.load(`<body>${content}</body>`, { scriptingEnabled: false })
  $('*').each((_, node) => {
    const element = $(node)
    const style = element.attr('style') || ''
    if (!style) return
    const scaled = style
      .split(';')
      .map((part) => {
        const [propertyRaw, ...valueParts] = part.split(':')
        const property = propertyRaw?.trim()
        const value = valueParts.join(':').trim()
        if (!property || !value) return ''
        if (/^(font-size|line-height|letter-spacing)$/i.test(property)) {
          const pxMatch = value.match(/^([0-9.]+)px$/i)
          if (pxMatch) {
            return `${property}:${Math.max(0, Number(pxMatch[1]) * ratio).toFixed(1)}px`
          }
        }
        return `${property}:${value}`
      })
      .filter(Boolean)
      .join(';')
    if (scaled) element.attr('style', scaled)
  })
  return $('body').html() || content
}

const countExplicitTextLines = (content: string): number | null => {
  const $ = cheerio.load(`<body>${content}</body>`, { scriptingEnabled: false })
  const paragraphs = $('p')
  if (paragraphs.length === 0) return null
  let lineCount = 0
  paragraphs.each((_, node) => {
    const paragraph = $(node)
    const text = paragraph.text().replace(/\u00a0/g, ' ').trim()
    if (!text) return
    lineCount += Math.max(1, paragraph.find('br').length + 1)
  })
  return lineCount > 0 ? lineCount : null
}

export const isCompactAutoFitText = (
  element: Record<string, unknown>,
  content: string,
  scaleY: number,
  textScale: number
): boolean => {
  const autoFit = element.autoFit as { type?: string } | undefined
  if (autoFit?.type !== 'shape') return false
  const text = stripHtml(content)
  if (!text) return false
  const lineCount = countExplicitTextLines(content)
  if (!lineCount || lineCount > 3) return false
  const typography = extractTextTypography(content, element, textScale)
  const renderedHeight = Math.max(1, clampNumber(element.height) * scaleY)
  const lineHeight = Math.max(1, typography.lineHeight)
  return renderedHeight <= lineHeight * (lineCount + 0.95)
}
