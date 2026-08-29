import type { Element, ElementLayer } from '@arcsin1/pptx2json'
import { clampNumber } from './render-shared'
import { stripHtml } from './sanitize'
import type { FlattenedElement } from './types'

type ElementFrame = {
  left: number
  top: number
  width: number
  height: number
}

const elementFrame = (element: Element): ElementFrame => {
  const record = element as unknown as Record<string, unknown>
  return {
    left: clampNumber(record.left),
    top: clampNumber(record.top),
    width: clampNumber(record.width),
    height: clampNumber(record.height)
  }
}

const elementBounds = (elements: Element[]): ElementFrame | null => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const element of elements) {
    const frame = elementFrame(element)
    minX = Math.min(minX, frame.left)
    minY = Math.min(minY, frame.top)
    maxX = Math.max(maxX, frame.left + frame.width)
    maxY = Math.max(maxY, frame.top + frame.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }
  return {
    left: minX,
    top: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

export const normalizeGroupChildren = (group: Element, children: Element[]): Element[] => {
  if (!children.length) return children
  const groupFrame = elementFrame(group)
  const bounds = elementBounds(children)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || groupFrame.width <= 0 || groupFrame.height <= 0) {
    return children
  }
  const scaleX = groupFrame.width / bounds.width
  const scaleY = groupFrame.height / bounds.height
  const needsNormalization =
    Math.abs(scaleX - 1) > 0.001 ||
    Math.abs(scaleY - 1) > 0.001 ||
    Math.abs(bounds.left) > 0.001 ||
    Math.abs(bounds.top) > 0.001
  if (!needsNormalization) return children

  return children.map((child) => {
    const frame = elementFrame(child)
    return {
      ...child,
      left: (frame.left - bounds.left) * scaleX,
      top: (frame.top - bounds.top) * scaleY,
      width: frame.width * scaleX,
      height: frame.height * scaleY
    } as Element
  })
}

export const flattenElements = (
  elements: Element[],
  offsetX = 0,
  offsetY = 0
): FlattenedElement[] => {
  const flattened: FlattenedElement[] = []
  for (const element of elements) {
    const record = element as unknown as Record<string, unknown>
    const left = offsetX + clampNumber(record.left)
    const top = offsetY + clampNumber(record.top)
    if (element.type === 'group') {
      const children = normalizeGroupChildren(
        element,
        Array.isArray(element.elements) ? element.elements : []
      )
      flattened.push(
        ...flattenElements(
          children,
          left,
          top
        )
      )
      continue
    }
    flattened.push({
      element,
      left,
      top,
      width: clampNumber(record.width),
      height: clampNumber(record.height),
      text: 'content' in element ? stripHtml(String(element.content || '')) : ''
    })
  }
  return flattened
}

const layerSourceRank = (source: unknown): number => {
  if (source === 'master') return 0
  if (source === 'layout') return 1
  if (source === 'slide') return 2
  if (source === 'group') return 3
  return 4
}

const numberAtPath = (path: unknown, index: number): number => {
  if (!Array.isArray(path)) return 0
  return clampNumber(path[index])
}

const compareElementLayerPath = (leftPath: unknown, rightPath: unknown): number => {
  const left = Array.isArray(leftPath) ? leftPath : []
  const right = Array.isArray(rightPath) ? rightPath : []
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const delta = numberAtPath(left, i) - numberAtPath(right, i)
    if (delta !== 0) return delta
  }
  return 0
}

const elementLayer = (element: Element): ElementLayer | undefined =>
  (element as unknown as Record<string, unknown>).layer as ElementLayer | undefined

const elementZIndex = (element: Element): number => {
  const record = element as unknown as Record<string, unknown>
  const layer = elementLayer(element)
  return clampNumber(record.zIndex ?? layer?.zIndex ?? record.order)
}

export const compareElementsForRender = (left: Element, right: Element): number => {
  const leftLayer = elementLayer(left)
  const rightLayer = elementLayer(right)
  return (
    layerSourceRank(leftLayer?.source) - layerSourceRank(rightLayer?.source) ||
    elementZIndex(left) - elementZIndex(right) ||
    compareElementLayerPath(leftLayer?.path, rightLayer?.path) ||
    clampNumber((left as unknown as Record<string, unknown>).order) -
      clampNumber((right as unknown as Record<string, unknown>).order)
  )
}
