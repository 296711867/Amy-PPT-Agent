import type { Fill } from '@arcsin1/pptx2json'
import type { ImportedElementAnimation } from './animation-import'
import {
  getSvgPathBounds,
  renderOoxmlCustomGeometryPath,
  renderOoxmlPresetShapePath,
  type SvgPathBounds
} from '@arcsin1/pptx-ooxml-geometry'
import { escapeHtml } from '../../presentation/html/escape'
import { buildAnimationAttrs, buildBlockStyle, clampNumber } from './render-shared'
import { getSvgShapeViewBox } from './shape-view-box'
import { PAGE_HEIGHT } from './constants'
import {
  extractTextTypography,
  isTransparentCssColor,
  sanitizeContentHtml,
  sanitizeImportedCssColor,
  sanitizeTableCellContentHtml,
  scaleContentTypography,
  stripHtml
} from './sanitize'
import {
  applyXmlShapeFrame,
  borderCss,
  boxShadowCss,
  fillToCss,
  hasVisibleFill,
  isMergedTableContinuation,
  normalizeGradientPosition,
  spanAttr,
  spanSize,
  tableBorderDeclarations,
  tableVerticalAlign,
  textInsetCss,
  textVerticalCss
} from './style-css'
import { writeImageDataUrl } from './image-registry'
import type { PptxTextValidator } from './text-validator'
import type { PptxXmlShapeMetadata } from './xml-shape-metadata'
import type {
  ImageRegistry,
  ImportWarning,
  SvgShapeFill,
  TextImportAdjustment,
  ImportedTableBorder,
  ImportedTableCell,
  TableBorderSide
} from './types'

const adjustTextBlockWithPretext = async (args: {
  validator?: PptxTextValidator
  element: Record<string, unknown>
  blockId: string
  content: string
  text: string
  scaleX: number
  scaleY: number
  textScale: number
  offsetX: number
  offsetY: number
  canvasHeight?: number
  pageNumber?: number
  warnings?: ImportWarning[]
}): Promise<TextImportAdjustment> => {
  if (!args.validator || args.text.length < 2) {
    return { content: args.content, extraCss: [] }
  }
  const y = (clampNumber(args.element.top) + clampNumber(args.offsetY)) * args.scaleY
  const width = Math.max(1, clampNumber(args.element.width) * args.scaleX)
  const height = Math.max(1, clampNumber(args.element.height) * args.scaleY)
  const typography = extractTextTypography(args.content, args.element, args.textScale)
  const [result] = await args.validator.measure([
    {
      id: args.blockId,
      text: args.text,
      width,
      height,
      ...typography
    }
  ])
  if (!result || (!result.overflow && result.suggestedFontSize >= typography.fontSize - 0.5)) {
    return {
      content: args.content,
      extraCss: [
        `font-size:${typography.fontSize.toFixed(1)}px`,
        `line-height:${typography.lineHeight.toFixed(1)}px`
      ]
    }
  }

  const fontRatio = Math.min(1, result.suggestedFontSize / typography.fontSize)
  const maxHeight = Math.max(1, (args.canvasHeight ?? PAGE_HEIGHT) - y - 2)
  const nextHeight = Math.min(maxHeight, Math.max(height, result.suggestedHeight))
  const extraCss = [
    `font-size:${result.suggestedFontSize.toFixed(1)}px`,
    `line-height:${result.suggestedLineHeight.toFixed(1)}px`
  ]
  if (nextHeight > height + 1) {
    extraCss.push(`height:${nextHeight.toFixed(1)}px`)
  }
  args.warnings?.push({
    pageNumber: args.pageNumber,
    message: `文本块 ${args.blockId} 已按 Pretext 测量调整排版`
  })

  return {
    content: scaleContentTypography(args.content, fontRatio),
    extraCss
  }
}

export const buildTextBlock = async (args: {
  element: Record<string, unknown>
  blockId: string
  role?: string
  placeholderRole?: string
  animation?: ImportedElementAnimation
  imagesDir: string
  registry: ImageRegistry
  scaleX: number
  scaleY: number
  textScale: number
  zIndex: number
  offsetX: number
  offsetY: number
  canvasHeight?: number
  pageNumber?: number
  warnings?: ImportWarning[]
  textValidator?: PptxTextValidator
  xmlShape?: PptxXmlShapeMetadata
}): Promise<string> => {
  const fillCss = await fillToCss(args.element.fill as Fill | undefined, args.imagesDir, args.registry)
  const rawContent = String(args.element.content || '')
  const text = stripHtml(rawContent)
  const sanitizedContent = sanitizeContentHtml(rawContent, args.textScale)
  const adjustment = await adjustTextBlockWithPretext({
    validator: args.textValidator,
    element: args.element,
    blockId: args.blockId,
    content: sanitizedContent,
    text,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    textScale: args.textScale,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    canvasHeight: args.canvasHeight,
    pageNumber: args.pageNumber,
    warnings: args.warnings
  })
  const css = buildBlockStyle({
    element: args.element,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    zIndex: args.zIndex,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    extra: [
      ...fillCss,
      ...borderCss(args.element, args.textScale),
      ...boxShadowCss(args.element, args.scaleX, args.scaleY),
      ...textInsetCss(args.xmlShape, args.textScale),
      ...textVerticalCss(args.element, args.xmlShape, sanitizedContent, args.scaleY, args.textScale),
      ...adjustment.extraCss
    ]
  })
  const roleAttr = args.role ? ` data-role="${escapeHtml(args.role)}"` : ''
  const phRoleAttr = args.placeholderRole
    ? ` data-ph-role="${escapeHtml(args.placeholderRole)}"`
    : ''
  const animationAttrs = buildAnimationAttrs(args.animation)
  const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
  return `<section data-block-id="${escapeHtml(args.blockId)}"${roleAttr}${phRoleAttr}${animationAttrText} style="${css}">${adjustment.content || '&nbsp;'}</section>`
}

export const buildImageBlock = async (args: {
  element: Record<string, unknown>
  blockId: string
  placeholderRole?: string
  animation?: ImportedElementAnimation
  imagesDir: string
  registry: ImageRegistry
  scaleX: number
  scaleY: number
  zIndex: number
  offsetX: number
  offsetY: number
}): Promise<string> => {
  const source = await writeImageDataUrl(
    args.imagesDir,
    args.registry,
    String(args.element.ref || args.element.base64 || args.blockId),
    String(args.element.base64 || '')
  )
  const css = buildBlockStyle({
    element: args.element,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    zIndex: args.zIndex,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    overflow: 'hidden',
    extra: [...borderCss(args.element, Math.min(args.scaleX, args.scaleY)), 'display:flex']
  })
  const animationAttrs = buildAnimationAttrs(args.animation)
  const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
  const phRoleAttr = args.placeholderRole
    ? ` data-ph-role="${escapeHtml(args.placeholderRole)}"`
    : ''
  if (!source) {
    return `<section data-block-id="${escapeHtml(args.blockId)}"${phRoleAttr}${animationAttrText} style="${css};align-items:center;justify-content:center;background:#f3f4f6;color:#6b7280;font-size:18px;">图片未能导入</section>`
  }
  return `<figure data-block-id="${escapeHtml(args.blockId)}"${phRoleAttr}${animationAttrText} style="${css}"><img src="${source}" alt="" style="width:100%;height:100%;object-fit:contain;display:block;" /></figure>`
}

const svgResourceId = (blockId: string, suffix: string): string =>
  `pptx-${blockId}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '-')

const OPEN_SHAPE_PRESETS = new Set(['arc', 'line', 'straightconnector1'])

const isOpenXmlShape = (xmlShape?: PptxXmlShapeMetadata): boolean =>
  Boolean(xmlShape?.preset && OPEN_SHAPE_PRESETS.has(xmlShape.preset.toLowerCase()))

const resolveSvgShapeFill = async (args: {
  fill?: Fill
  blockId: string
  safePath: string
  viewBox: SvgPathBounds
  imagesDir: string
  registry: ImageRegistry
}): Promise<SvgShapeFill> => {
  if (!args.fill) return { defs: [], paint: 'none' }
  if (args.fill.type === 'color') {
    return { defs: [], paint: sanitizeImportedCssColor(args.fill.value) || 'none' }
  }
  if (args.fill.type === 'gradient' && args.fill.value.colors.length > 0) {
    const gradient = args.fill.value
    const gradientId = svgResourceId(args.blockId, 'gradient')
    const fallbackPaint = gradient.colors
      .map((stop) => sanitizeImportedCssColor(stop.color))
      .find((color): color is string => Boolean(color)) || '#000000'
    const stops = gradient.colors
      .map((stop, index) => {
        const color = sanitizeImportedCssColor(stop.color)
        if (!color) return ''
        const offset = normalizeGradientPosition(stop.pos, index, gradient.colors.length)
        return `<stop offset="${offset}" stop-color="${color}" />`
      })
      .filter(Boolean)
      .join('')
    if (!stops) return { defs: [], paint: 'none' }
    if (gradient.path === 'line') {
      const rotation = clampNumber(gradient.rot)
      return {
        defs: [
          `<linearGradient id="${gradientId}" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="rotate(${rotation.toFixed(2)} 0.5 0.5)">${stops}</linearGradient>`
        ],
        paint: `url(#${gradientId}) ${fallbackPaint}`
      }
    }
    return {
      defs: [
        `<radialGradient id="${gradientId}" cx="50%" cy="50%" r="70%">${stops}</radialGradient>`
      ],
      paint: `url(#${gradientId}) ${fallbackPaint}`
    }
  }
  if (args.fill.type === 'pattern') {
    const patternId = svgResourceId(args.blockId, 'pattern')
    const foreground = sanitizeImportedCssColor(args.fill.value.foregroundColor) || '#000000'
    const background = sanitizeImportedCssColor(args.fill.value.backgroundColor) || '#ffffff'
    const patternType = String(args.fill.value.type || '').toLowerCase()
    const patternLines = patternType.includes('vert')
      ? '<path d="M4 0 V8" />'
      : patternType.includes('horz')
        ? '<path d="M0 4 H8" />'
        : patternType.includes('cross')
          ? '<path d="M4 0 V8 M0 4 H8" />'
          : '<path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" />'
    return {
      defs: [
        `<pattern id="${patternId}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${background}" /><g fill="none" stroke="${foreground}" stroke-width="1">${patternLines}</g></pattern>`
      ],
      paint: `url(#${patternId}) ${background}`
    }
  }
  if (args.fill.type === 'image' && args.fill.value.base64) {
    const source = await writeImageDataUrl(
      args.imagesDir,
      args.registry,
      args.fill.value.ref || args.fill.value.base64,
      args.fill.value.base64
    )
    if (!source) return { defs: [], paint: 'none' }
    const clipId = svgResourceId(args.blockId, 'clip')
    const opacity = Math.min(1, Math.max(0, clampNumber(args.fill.value.opacity, 1)))
    return {
      defs: [`<clipPath id="${clipId}"><path d="${escapeHtml(args.safePath)}" /></clipPath>`],
      paint: 'none',
      content: `<image href="${escapeHtml(source)}" x="${args.viewBox.minX.toFixed(4)}" y="${args.viewBox.minY.toFixed(4)}" width="${args.viewBox.width.toFixed(4)}" height="${args.viewBox.height.toFixed(4)}" preserveAspectRatio="xMidYMid slice" opacity="${opacity.toFixed(3)}" clip-path="url(#${clipId})" />`
    }
  }
  return { defs: [], paint: 'none' }
}

const scaleImportedUnitPath = (path: string, width: number, height: number): string => {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  const output: string[] = []
  let command = ''
  let coordinateIndex = 0
  for (const token of tokens) {
    if (/^[A-Za-z]$/.test(token)) {
      command = token
      coordinateIndex = 0
      output.push(token)
      continue
    }
    const value = Number(token)
    if (!Number.isFinite(value)) continue
    const upperCommand = command.toUpperCase()
    let scaled = value
    if (['M', 'L', 'C', 'Q', 'S', 'T'].includes(upperCommand)) {
      scaled = value * (coordinateIndex % 2 === 0 ? width : height)
    } else if (upperCommand === 'A') {
      const arcIndex = coordinateIndex % 7
      if (arcIndex === 0 || arcIndex === 5) scaled = value * width
      else if (arcIndex === 1 || arcIndex === 6) scaled = value * height
    }
    output.push(Number(scaled.toFixed(4)).toString())
    coordinateIndex += 1
  }
  return output.join(' ')
}

export const buildShapeBlock = async (args: {
  element: Record<string, unknown>
  blockId: string
  role?: string
  placeholderRole?: string
  animation?: ImportedElementAnimation
  imagesDir: string
  registry: ImageRegistry
  scaleX: number
  scaleY: number
  textScale: number
  zIndex: number
  offsetX: number
  offsetY: number
  canvasHeight?: number
  pageNumber?: number
  warnings?: ImportWarning[]
  textValidator?: PptxTextValidator
  xmlShape?: PptxXmlShapeMetadata
}): Promise<string> => {
  const element = applyXmlShapeFrame(args.element, args.xmlShape)
  const rawContent = typeof element.content === 'string' ? element.content : ''
  const hasTextContent = stripHtml(rawContent).length > 0
  const customGeometryPath = args.xmlShape?.customGeometry
    ? renderOoxmlCustomGeometryPath(
        args.xmlShape.customGeometry,
        clampNumber(element.width),
        clampNumber(element.height)
      )
    : ''
  const presetGeometryPath =
    !customGeometryPath && args.xmlShape?.preset
      ? renderOoxmlPresetShapePath(
          args.xmlShape.preset,
          clampNumber(element.width),
          clampNumber(element.height),
          args.xmlShape.adjustments
      )
      : ''
  const importedGeometryPath = !customGeometryPath && !presetGeometryPath &&
    String(element.shapType || '').toLowerCase() === 'customgeometry' &&
    typeof element.path === 'string'
    ? scaleImportedUnitPath(element.path, clampNumber(element.width), clampNumber(element.height))
    : ''
  const rawPath =
    customGeometryPath || presetGeometryPath || importedGeometryPath || (typeof element.path === 'string' ? element.path.trim() : '')
  const safePath = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(rawPath) ? rawPath : ''
  const fill = element.fill as Fill | undefined
  const pathBounds = safePath ? getSvgPathBounds(safePath) : null
  const isDegeneratePath = Boolean(pathBounds && (pathBounds.width < 0.5 || pathBounds.height < 0.5))
  const borderColor = sanitizeImportedCssColor(element.borderColor)
  const hasVisibleBorder = clampNumber(element.borderWidth) > 0 && !isTransparentCssColor(borderColor)
  const shapeHasVisibleFill = hasVisibleFill(fill)
  if (hasTextContent && (!(safePath && pathBounds) || (isDegeneratePath && !shapeHasVisibleFill && !hasVisibleBorder))) {
    return buildTextBlock({ ...args, element })
  }
  if (safePath && pathBounds) {
    const viewBox = getSvgShapeViewBox(element, pathBounds, safePath, args.xmlShape)
    const shadow = element.shadow as
      | { h?: number; v?: number; blur?: number; color?: string }
      | undefined
    const css = buildBlockStyle({
      element,
      scaleX: args.scaleX,
      scaleY: args.scaleY,
      zIndex: args.zIndex,
      offsetX: args.offsetX,
      offsetY: args.offsetY,
      overflow: shadow ? 'visible' : 'hidden'
    })
    const isOpenShape = isOpenXmlShape(args.xmlShape)
    const svgFill = isOpenShape
      ? { defs: [], paint: 'none' }
      : args.xmlShape?.fillColor
      ? { defs: [], paint: args.xmlShape.fillColor }
      : await resolveSvgShapeFill({
          fill,
          blockId: args.blockId,
          safePath,
          viewBox,
          imagesDir: args.imagesDir,
          registry: args.registry
        })
    const strokeWidth = Math.max(
      0,
      args.xmlShape?.lineWidth !== undefined
        ? args.xmlShape.lineWidth
        : clampNumber(element.borderWidth)
    ) * (4 / 3)
    const rawStrokeColor = args.xmlShape?.lineColor || sanitizeImportedCssColor(element.borderColor)
    const strokeColor = strokeWidth > 0 && !isTransparentCssColor(rawStrokeColor)
      ? rawStrokeColor || '#000000'
      : 'none'
    let dashArray = typeof element.borderStrokeDasharray === 'string' &&
      /^[0-9.,\s-]+$/.test(element.borderStrokeDasharray)
      ? element.borderStrokeDasharray
      : ''
    const borderType = String(element.borderType || '').toLowerCase()
    if (!dashArray && strokeWidth > 0 && borderType === 'dashed') {
      dashArray = `${(strokeWidth * 4).toFixed(2)} ${(strokeWidth * 2).toFixed(2)}`
    } else if (!dashArray && strokeWidth > 0 && borderType === 'dotted') {
      dashArray = `0 ${(strokeWidth * 2).toFixed(2)}`
    }
    if (strokeColor === 'none') dashArray = ''
    const defs = [...svgFill.defs]
    let filterAttribute = ''
    if (shadow) {
      const shadowColor = sanitizeImportedCssColor(shadow.color) || '#00000066'
      const shadowId = svgResourceId(args.blockId, 'shadow')
      defs.push(
        `<filter id="${shadowId}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${(clampNumber(shadow.h) * (4 / 3)).toFixed(3)}" dy="${(clampNumber(shadow.v) * (4 / 3)).toFixed(3)}" stdDeviation="${Math.max(0, clampNumber(shadow.blur) * (2 / 3)).toFixed(3)}" flood-color="${shadowColor}" /></filter>`
      )
      filterAttribute = ` filter="url(#${shadowId})"`
    }
    const markerAttributes: string[] = []
    if (strokeColor !== 'none' && args.xmlShape?.headEnd && args.xmlShape.headEnd !== 'none') {
      const markerId = svgResourceId(args.blockId, 'head-arrow')
      defs.push(
        `<marker id="${markerId}" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 10 0 L 0 5 L 10 10 z" fill="${strokeColor}"></path></marker>`
      )
      markerAttributes.push(`marker-start="url(#${markerId})"`)
    }
    if (strokeColor !== 'none' && args.xmlShape?.tailEnd && args.xmlShape.tailEnd !== 'none') {
      const markerId = svgResourceId(args.blockId, 'tail-arrow')
      defs.push(
        `<marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${strokeColor}"></path></marker>`
      )
      markerAttributes.push(`marker-end="url(#${markerId})"`)
    }
    const flipX = element.isFlipH ? -1 : 1
    const flipY = element.isFlipV ? -1 : 1
    const svgTransform = flipX === 1 && flipY === 1
      ? ''
      : `transform:scale(${flipX},${flipY});transform-origin:center;`
    const animationAttrs = buildAnimationAttrs(args.animation)
    const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
    const defsMarkup = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : ''
    const markerAttrText = markerAttributes.length ? ` ${markerAttributes.join(' ')}` : ''
    const shapeMarkup = `${svgFill.content || ''}<path d="${escapeHtml(safePath)}" fill="${svgFill.paint}" stroke="${strokeColor}" stroke-width="${strokeWidth.toFixed(3)}"${dashArray ? ` stroke-dasharray="${dashArray}"` : ''} stroke-linecap="round" stroke-linejoin="round"${markerAttrText} />`
    const sanitizedOverlayContent = hasTextContent ? sanitizeContentHtml(rawContent, args.textScale) : ''
    const overlayCss = [
      'position:absolute',
      'inset:0',
      'overflow:visible',
      ...textInsetCss(args.xmlShape, args.textScale),
      ...textVerticalCss(
        element,
        args.xmlShape,
        sanitizedOverlayContent,
        args.scaleY,
        args.textScale
      )
    ].join(';')
    const textOverlay = hasTextContent
      ? `<div style="${overlayCss}">${sanitizedOverlayContent}</div>`
      : ''
    const shapePhRoleAttr = args.placeholderRole
      ? ` data-ph-role="${escapeHtml(args.placeholderRole)}"`
      : ''
    return `<figure data-block-id="${escapeHtml(args.blockId)}" data-pptx-kind="vector-shape"${shapePhRoleAttr}${animationAttrText} style="${css};margin:0"><svg viewBox="${viewBox.minX.toFixed(4)} ${viewBox.minY.toFixed(4)} ${viewBox.width.toFixed(4)} ${viewBox.height.toFixed(4)}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;overflow:visible;${svgTransform}" aria-hidden="true">${defsMarkup}<g${filterAttribute}>${shapeMarkup}</g></svg>${textOverlay}</figure>`
  }
  const fillCss = await fillToCss(element.fill as Fill | undefined, args.imagesDir, args.registry)
  const shadowCss = boxShadowCss(element, args.scaleX, args.scaleY)
  const css = buildBlockStyle({
    element,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    zIndex: args.zIndex,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    overflow: shadowCss.length ? 'visible' : 'hidden',
    extra: [...fillCss, ...borderCss(element, args.textScale), ...shadowCss]
  })
  const animationAttrs = buildAnimationAttrs(args.animation)
  const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
  const phRoleAttr = args.placeholderRole
    ? ` data-ph-role="${escapeHtml(args.placeholderRole)}"`
    : ''
  return `<div data-block-id="${escapeHtml(args.blockId)}"${phRoleAttr}${animationAttrText} style="${css}"></div>`
}

export const buildTableBlock = (args: {
  element: Record<string, unknown>
  blockId: string
  animation?: ImportedElementAnimation
  scaleX: number
  scaleY: number
  textScale: number
  zIndex: number
  offsetX: number
  offsetY: number
}): string => {
  const rows = Array.isArray(args.element.data) ? (args.element.data as ImportedTableCell[][]) : []
  const tableTextScale = Math.min(args.textScale, 1.25)
  const tableBorders = args.element.borders as Partial<Record<TableBorderSide, ImportedTableBorder>> | undefined
  const colWidths = Array.isArray(args.element.colWidths)
    ? (args.element.colWidths as unknown[])
        .map((width) => clampNumber(width) * args.scaleX)
        .filter((width) => width > 0)
    : []
  const rowHeights = Array.isArray(args.element.rowHeights)
    ? (args.element.rowHeights as unknown[]).map((height) => clampNumber(height) * args.scaleY)
    : []
  const colgroup = colWidths.length
    ? `<colgroup>${colWidths
        .map((width) => `<col style="width:${width.toFixed(1)}px;" />`)
        .join('')}</colgroup>`
    : ''
  const tableRows = rows
    .map((row, rowIndex) => {
      let logicalColIndex = 0
      const rowHeight = rowHeights[rowIndex] && rowHeights[rowIndex] > 0
        ? ` style="height:${rowHeights[rowIndex].toFixed(1)}px;"`
        : ''
      const cells = row
        .map((cell) => {
          if (isMergedTableContinuation(cell)) {
            logicalColIndex += 1
            return ''
          }
          const colIndex = logicalColIndex
          logicalColIndex += spanSize(cell.colSpan)
          const styles = [
            ...tableBorderDeclarations(cell.borders, tableBorders, args.textScale),
            'padding:6px 8px',
            'overflow-wrap:anywhere',
            'white-space:pre-wrap',
            `vertical-align:${tableVerticalAlign(cell.vAlign)}`,
            sanitizeImportedCssColor(cell.fillColor) ? `background:${sanitizeImportedCssColor(cell.fillColor)}` : '',
            sanitizeImportedCssColor(cell.fontColor) ? `color:${sanitizeImportedCssColor(cell.fontColor)}` : '',
            cell.fontBold ? 'font-weight:700' : '',
            rowHeights[rowIndex] && rowHeights[rowIndex] > 0
              ? `height:${rowHeights[rowIndex].toFixed(1)}px`
              : ''
          ]
            .filter(Boolean)
            .join(';')
          const colspan = spanAttr('colspan', cell.colSpan)
          const rowspan = spanAttr('rowspan', cell.rowSpan)
          const content = sanitizeTableCellContentHtml(String(cell.text || ''), args.textScale)
          return `<td data-cell-id="r${rowIndex + 1}-c${colIndex + 1}"${colspan}${rowspan} style="${styles}">${content || '&nbsp;'}</td>`
        })
        .join('')
      return `<tr${rowHeight}>${cells}</tr>`
    })
    .join('')
  const css = buildBlockStyle({
    element: args.element,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    zIndex: args.zIndex,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    extra: ['background:transparent']
  })
  const placeholderCss = buildBlockStyle({
    element: args.element,
    scaleX: args.scaleX,
    scaleY: args.scaleY,
    zIndex: args.zIndex,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    extra: ['background:#fff']
  })
  const animationAttrs = buildAnimationAttrs(args.animation)
  const animationAttrText = animationAttrs ? ` ${animationAttrs}` : ''
  if (!rows.length) {
    return `<section data-block-id="${escapeHtml(args.blockId)}" data-pptx-kind="table" data-pptx-import-mode="placeholder"${animationAttrText} style="${placeholderCss};display:flex;align-items:center;justify-content:center;color:#6b7280;">表格已作为占位导入</section>`
  }
  return `<section data-block-id="${escapeHtml(args.blockId)}" data-pptx-kind="table" data-pptx-import-mode="editable"${animationAttrText} style="${css}"><table style="width:100%;height:100%;border-collapse:collapse;border-spacing:0;table-layout:fixed;font-size:${Math.max(12, 12 * tableTextScale).toFixed(1)}px;">${colgroup}${tableRows}</table></section>`
}
