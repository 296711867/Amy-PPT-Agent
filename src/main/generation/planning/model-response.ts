import type { DesignContract } from '@shared/generation'
import { extractJsonBlock } from '../../agent-runtime/model'

type AppLocale = 'zh' | 'en'

export const normalizeDesignContract = (value: unknown): DesignContract => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const readText = (key: keyof Omit<DesignContract, 'palette'>): string => {
    const text = String(record[key] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text
  }
  const paletteRaw = Array.isArray(record.palette) ? record.palette : []
  const palette = paletteRaw
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0)
    .slice(0, 6)
  return {
    theme: readText('theme'),
    background: readText('background'),
    palette,
    titleStyle: readText('titleStyle'),
    layoutMotif: readText('layoutMotif'),
    chartStyle: readText('chartStyle'),
    shapeLanguage: readText('shapeLanguage'),
    titleFont: readText('titleFont'),
    subtitleFont: readText('subtitleFont') || readText('bodyFont'),
    bodyFont: readText('bodyFont')
  }
}

const unwrapJsonLikeString = (value: string): string => {
  const source = value.trim()
  if (source.length < 2 || !source.startsWith('"') || !source.endsWith('"')) {
    return source
  }
  const inner = source
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .trim()
  return inner.startsWith('{') || inner.startsWith('[') || inner.startsWith('```') ? inner : source
}

export const parseModelJson = (responseText: string, appLocale?: AppLocale): unknown => {
  let source = responseText.trim()
  let lastError: unknown

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidates = Array.from(new Set([source, extractJsonBlock(source)]))
    let decodedJsonString = false

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (typeof parsed !== 'string') return parsed
        source = parsed.trim()
        lastError = null
        decodedJsonString = true
        break
      } catch (error) {
        lastError = error
      }
    }

    if (decodedJsonString) continue

    const unwrapped = unwrapJsonLikeString(source)
    if (unwrapped !== source) {
      source = unwrapped
      continue
    }

    const block = extractJsonBlock(source)
    if (block !== source) {
      source = block
      continue
    }

    break
  }

  const preview = source.length > 200 ? `${source.slice(0, 200)}…` : source
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    appLocale === 'en'
      ? `Failed to parse JSON returned by the LLM: ${reason}. Raw text preview: ${preview}`
      : `LLM 返回的 JSON 解析失败: ${reason}. 原始文本预览: ${preview}`
  )
}
