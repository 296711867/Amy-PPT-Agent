import type { Fill, Shadow } from '@arcsin1/pptx2json'
import { clampNumber } from './render-shared'
import {
  isCompactAutoFitText,
  isTransparentCssColor,
  sanitizeImportedCssColor
} from './sanitize'
import { writeImageDataUrl } from './image-registry'
import type {
  ImageRegistry,
  ImportedTableBorder,
  ImportedTableCell,
  TableBorderSide
} from './types'
import type { PptxXmlShapeMetadata } from './xml-shape-metadata'

export const hasVisibleFill = (fill: Fill | undefined): boolean =>
  Boolean(
    fill &&
      (
        fill.type === 'image' ||
        fill.type === 'gradient' ||
        fill.type === 'pattern' ||
        (fill.type === 'color' && !isTransparentCssColor(sanitizeImportedCssColor(fill.value)))
      )
  )

const hasVisibleSurface = (element: Record<string, unknown>): boolean => {
  const borderColor = sanitizeImportedCssColor(element.borderColor)
  return (
    hasVisibleFill(element.fill as Fill | undefined) ||
    (clampNumber(element.borderWidth) > 0 && !isTransparentCssColor(borderColor))
  )
}

export const boxShadowCss = (
  element: Record<string, unknown>,
  scaleX: number,
  scaleY: number
): string[] => {
  const shadow = element.shadow as Shadow | undefined
  if (!shadow || !hasVisibleSurface(element)) return []
  const offsetX = clampNumber(shadow.h) * scaleX
  const offsetY = clampNumber(shadow.v) * scaleY
  const blur = Math.max(0, clampNumber(shadow.blur) * ((scaleX + scaleY) / 2))
  if (Math.abs(offsetX) < 0.01 && Math.abs(offsetY) < 0.01 && blur < 0.01) return []
  const color = sanitizeImportedCssColor(shadow.color) || '#00000066'
  return [`box-shadow:${offsetX.toFixed(1)}px ${offsetY.toFixed(1)}px ${blur.toFixed(1)}px ${color}`]
}

export const normalizeGradientPosition = (
  rawPosition: unknown,
  fallbackIndex = 0,
  fallbackCount = 1
): string => {
  const fallback = `${Math.round((fallbackIndex / Math.max(1, fallbackCount - 1)) * 100)}%`
  if (typeof rawPosition !== 'string' && typeof rawPosition !== 'number') return fallback
  const value = String(rawPosition).trim()
  if (!value) return fallback
  const percentMatch = value.match(/^([0-9.]+)%$/)
  if (percentMatch) {
    const percent = clampNumber(percentMatch[1])
    return `${Math.max(0, Math.min(100, percent)).toFixed(percent % 1 ? 2 : 0)}%`
  }
  if (!/^[0-9.]+$/.test(value)) return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  if (numeric > 100) {
    return `${Math.max(0, Math.min(100, numeric / 1000)).toFixed(numeric % 1000 ? 2 : 0)}%`
  }
  return `${Math.max(0, Math.min(100, numeric)).toFixed(numeric % 1 ? 2 : 0)}%`
}

const sanitizeGradientStop = (
  rawColor: unknown,
  rawPosition: unknown,
  fallbackIndex = 0,
  fallbackCount = 1
): string | null => {
  const color = sanitizeImportedCssColor(rawColor)
  if (!color) return null
  return `${color} ${normalizeGradientPosition(rawPosition, fallbackIndex, fallbackCount)}`
}

export const fillToCss = async (
  fill: Fill | undefined,
  imagesDir: string,
  registry: ImageRegistry
): Promise<string[]> => {
  if (!fill) return []
  if (fill.type === 'color' && fill.value) {
    const color = sanitizeImportedCssColor(fill.value)
    return color ? [`background:${color}`] : []
  }
  if (fill.type === 'image' && fill.value?.base64) {
    const imagePath = await writeImageDataUrl(
      imagesDir,
      registry,
      fill.value.ref || fill.value.base64,
      fill.value.base64
    )
    if (imagePath) {
      return [
        `background-image:url('${imagePath}')`,
        'background-size:cover',
        'background-position:center'
      ]
    }
  }
  if (fill.type === 'gradient' && Array.isArray(fill.value?.colors) && fill.value.colors.length) {
    const colors = fill.value.colors
      .map((item, index) => sanitizeGradientStop(item.color, item.pos, index, fill.value.colors.length))
      .filter((item): item is string => Boolean(item))
    return colors.length ? [`background:linear-gradient(135deg, ${colors.join(', ')})`] : []
  }
  return []
}

export const borderCss = (element: Record<string, unknown>, scale: number): string[] => {
  const width = clampNumber(element.borderWidth)
  if (width <= 0) return []
  const color = sanitizeImportedCssColor(element.borderColor)
  if (isTransparentCssColor(color)) return []
  const rawType = typeof element.borderType === 'string' ? element.borderType.trim().toLowerCase() : ''
  const type = ['solid', 'dashed', 'dotted', 'double'].includes(rawType) ? rawType : 'solid'
  return [`border:${Math.max(1, width * scale).toFixed(1)}px ${type} ${color}`]
}

const normalizeBorderType = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['solid', 'dashed', 'dotted', 'double'].includes(raw)) return raw
  return 'solid'
}

const tableBorderDeclaration = (
  side: TableBorderSide,
  border: ImportedTableBorder | undefined,
  scale: number
): string | null => {
  if (!border) return null
  const width = clampNumber(border.borderWidth)
  if (width <= 0) return null
  const color = sanitizeImportedCssColor(border.borderColor)
  if (isTransparentCssColor(color)) return null
  const type = normalizeBorderType(border.borderType)
  return `border-${side}:${Math.max(0.5, width * scale).toFixed(1)}px ${type} ${color}`
}

export const tableBorderDeclarations = (
  cellBorders: Partial<Record<TableBorderSide, ImportedTableBorder>> | undefined,
  fallbackBorders: Partial<Record<TableBorderSide, ImportedTableBorder>> | undefined,
  scale: number
): string[] => {
  const declarations = (['top', 'right', 'bottom', 'left'] as TableBorderSide[])
    .map((side) => tableBorderDeclaration(side, cellBorders?.[side] || fallbackBorders?.[side], scale))
    .filter((item): item is string => Boolean(item))
  return declarations.length > 0 ? declarations : ['border:1px solid #d1d5db']
}

export const spanAttr = (name: 'colspan' | 'rowspan', value: unknown): string => {
  const span = Math.floor(clampNumber(value, 1))
  return span > 1 ? ` ${name}="${span}"` : ''
}

export const spanSize = (value: unknown): number => Math.max(1, Math.floor(clampNumber(value, 1)))

export const isMergedTableContinuation = (cell: ImportedTableCell): boolean =>
  clampNumber(cell.hMerge) > 0 || clampNumber(cell.vMerge) > 0

export const tableVerticalAlign = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'mid' || raw === 'middle' || raw === 'center' || raw === 'ctr') return 'middle'
  if (raw === 'down' || raw === 'bottom' || raw === 'b') return 'bottom'
  return 'top'
}

const textAnchorCss = (xmlShape?: PptxXmlShapeMetadata): string[] => {
  const anchor = xmlShape?.textAnchor?.toLowerCase()
  if (anchor !== 'ctr' && anchor !== 'b') return []
  return [
    'display:flex',
    'flex-direction:column',
    `justify-content:${anchor === 'b' ? 'flex-end' : 'center'}`
  ]
}

export const textVerticalCss = (
  element: Record<string, unknown>,
  xmlShape: PptxXmlShapeMetadata | undefined,
  content: string,
  scaleY: number,
  textScale: number
): string[] => {
  const anchorCss = textAnchorCss(xmlShape)
  if (anchorCss.length) return anchorCss
  if (!isCompactAutoFitText(element, content, scaleY, textScale)) return []
  return [
    'display:flex',
    'flex-direction:column',
    'justify-content:center'
  ]
}

export const textInsetCss = (xmlShape?: PptxXmlShapeMetadata, scale = 1): string[] => {
  const base = ['box-sizing:border-box']
  const insets = xmlShape?.textInsets
  if (!insets) return [...base, 'padding:0.1px']
  const top = insets.top ?? 0
  const right = insets.right ?? 0
  const bottom = insets.bottom ?? 0
  const left = insets.left ?? 0
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return [...base, 'padding:0.1px']
  return [
    ...base,
    `padding:${(top * scale).toFixed(1)}px ${(right * scale).toFixed(1)}px ${(bottom * scale).toFixed(1)}px ${(left * scale).toFixed(1)}px`
  ]
}

export const applyXmlShapeFrame = (
  element: Record<string, unknown>,
  xmlShape?: PptxXmlShapeMetadata
): Record<string, unknown> => {
  if (!xmlShape) return element
  return {
    ...element,
    left: xmlShape.left ?? element.left,
    top: xmlShape.top ?? element.top,
    width: xmlShape.width ?? element.width,
    height: xmlShape.height ?? element.height,
    rotate: xmlShape.rotate ?? element.rotate,
    isFlipH: Boolean(element.isFlipH) || Boolean(xmlShape.flipH),
    isFlipV: Boolean(element.isFlipV) || Boolean(xmlShape.flipV)
  }
}
