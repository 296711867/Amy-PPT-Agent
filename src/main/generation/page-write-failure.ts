/**
 * 单页生成结束时若目标页从未成功写盘，外层只能报「页面未写入」。
 * 但写盘工具此前可能已被质量校验拒绝过（如 font-below-floor），
 * 若不把最近一次拒绝原因并进最终错误，重试提示词就拿不到具体违规，
 * 模型会原样重写同样的片段，重试在同一个校验上反复耗尽。
 */

export interface WriteToolStatusLikeChunk {
  label?: string
  detail?: string
}

// 工具状态事件发出前 label 会经 progressLabel 归一化：
// 「验证失败/落盘校验失败/…」统一变成「已失败 / Failed」，
// 因此除原始 label 外还必须匹配归一化后的失败 label。
const WRITE_VALIDATION_FAILURE_LABEL_RE = /已失败|Failed|验证失败|校验失败|写入失败/

// 写盘被拒的 detail 特征（字号/间距下限、模板骨架、远程资源、渲染/Deck 回滚、骨架缺失）。
// 其他工具的失败状态（如动画配置失败）不应被并入「页面未写入」的上下文。
const WRITE_VALIDATION_DETAIL_RE =
  /低于当前画布|下限|已恢复写入前页面|写入内容丢失|远程 script|缺少 \.ppt-page|质量校验未通过/

/**
 * 从写盘工具状态事件里识别「校验失败」类状态（验证失败 / 落盘校验失败 /
 * 模板骨架校验失败 / 外链资源校验失败 / 渲染质量校验失败 / Deck 一致性校验失败
 * / 写入失败（I-7 意外异常），含被 progressLabel 归一化成「已失败」的形式），
 * 返回应记录的失败摘要；与写盘校验无关的事件返回 null。
 */
export function extractWriteValidationFailure(
  chunk: WriteToolStatusLikeChunk
): string | null {
  const label = (chunk.label || '').trim()
  const detail = (chunk.detail || '').trim()
  if (!label || !detail) return null
  if (!WRITE_VALIDATION_FAILURE_LABEL_RE.test(label)) return null
  // 「写入失败」承载任意异常文本（fs/序列化等），detail 无固定特征，
  // 直接放行，否则真实原因又会退化成「模型没有调用工具」。
  if (/写入失败/.test(label)) return `${label}: ${detail}`
  if (!WRITE_VALIDATION_DETAIL_RE.test(detail)) return null
  return `${label}: ${detail}`
}

export function buildPageNotWrittenMessage(args: {
  pageId: string
  writeToolName: string
  lastWriteValidationFailure: string
}): string {
  const lines = [
    `页面未写入 (${args.pageId})：模型没有成功调用 ${args.writeToolName} 写入目标 page 文件。`,
    `必须调用 ${args.writeToolName}(pageId="${args.pageId}", content=完整创意页面片段)，不要只在最终回复里描述 HTML。`
  ]
  if (args.lastWriteValidationFailure) {
    lines.push(
      `最近一次写盘被质量校验拒绝，必须修正下列问题后重新调用写盘工具：${args.lastWriteValidationFailure}`
    )
  }
  return lines.join(' ')
}

const HTML_ROOT_TAG_RE = /<(div|section|main|article|header|footer)\b/i
const HTML_ROOT_CLOSE_RE = /<\/(?:div|section|main|article|header|footer)>/i

function sliceHtmlFragment(source: string): string | null {
  let body = source
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source)
  if (bodyMatch) body = bodyMatch[1]
  body = body.replace(/<script[\s\S]*?<\/script>/gi, '')
  const startMatch = HTML_ROOT_TAG_RE.exec(body)
  if (!startMatch) return null
  // 裁到最后一个根级闭合标签，去掉 HTML 之后混入的围栏符和说明文字
  const closeRe = /<\/(?:div|section|main|article|header|footer)>/gi
  let end = -1
  let closeMatch: RegExpExecArray | null
  while ((closeMatch = closeRe.exec(body)) !== null) {
    end = closeMatch.index + closeMatch[0].length
  }
  if (end <= startMatch.index) return null
  const fragment = body.slice(startMatch.index, end).trim()
  if (fragment.length < 120) return null
  if (!HTML_ROOT_CLOSE_RE.test(fragment)) return null
  return fragment
}

/**
 * 模型未调用写盘工具、但把页面 HTML 写在了最终文本回复里时，
 * 从回复中提取可落盘的创意片段（优先 ```html 围栏块，其次正文中的 HTML）。
 * 提取结果交给 persistPageHtmlFromFragment 走正常修复/校验管道。
 */
export function extractHtmlFragmentCandidate(text: string): string | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  const candidates: string[] = []
  const fenceRe = /```(?:html)?\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(raw)) !== null) {
    candidates.push(match[1])
  }
  candidates.push(raw)
  candidates.sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    const fragment = sliceHtmlFragment(candidate)
    if (fragment) return fragment
  }
  return null
}
