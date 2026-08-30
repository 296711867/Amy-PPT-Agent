/**
 * I-8：锁定版式快速通道直接落盘内置骨架，骨架里的硬编码配色（如 #2F6BFF 蓝）
 * 与整套 design contract 撞色。这里做确定性调色映射：收集页面全部 hex 色，
 * 按相对亮度排序后等秩映射到契约色板（最暗→最暗、最亮→最亮），
 * 保持明暗结构与对比关系，不依赖 LLM。
 */

const HEX_RE = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi

const normalizeHex = (value: string): string => {
  const lower = value.toLowerCase()
  if (lower.length === 7) return lower
  // #abc → #aabbcc
  return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`
}

const channel = (hex: string, start: number): number => Number.parseInt(hex.slice(start, start + 2), 16) / 255

/** WCAG 相对亮度，用于保持映射后的明暗次序。 */
const relativeLuminance = (hex: string): number => {
  const r = channel(hex, 1)
  const g = channel(hex, 3)
  const b = channel(hex, 5)
  const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

const isValidPaletteColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value.trim())

export function applyContractPalette(html: string, palette: readonly unknown[]): string {
  const paletteColors = palette
    .filter(isValidPaletteColor)
    .map((color) => normalizeHex(color.trim()))
  if (paletteColors.length < 2) return html

  const sourceColors = [...new Set((html.match(HEX_RE) || []).map(normalizeHex))]
  if (sourceColors.length === 0) return html

  const sortedPalette = [...paletteColors].sort(
    (left, right) => relativeLuminance(left) - relativeLuminance(right)
  )
  const sortedSources = [...sourceColors].sort(
    (left, right) => relativeLuminance(left) - relativeLuminance(right)
  )

  // 单遍替换：逐个 split/join 在"目标色恰好也是源色"时会发生链式二次替换。
  const mapping = new Map<string, string>()
  sortedSources.forEach((source, index) => {
    // 等秩映射 + round 均匀铺满：最暗源色→最暗契约色、最亮源色→最亮契约色，
    // 中间色按比例取最近的契约档位（floor 会让最亮源色永远够不到最亮档）。
    const targetIndex = Math.min(
      Math.round((index * sortedPalette.length) / sortedSources.length),
      sortedPalette.length - 1
    )
    mapping.set(source, sortedPalette[targetIndex])
  })
  return html.replace(HEX_RE, (match) => mapping.get(normalizeHex(match)) ?? match)
}
