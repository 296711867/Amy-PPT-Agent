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

const WRITE_VALIDATION_FAILURE_LABEL_RE = /验证失败|校验失败/

/**
 * 从写盘工具状态事件里识别「校验失败」类 label（验证失败 / 落盘校验失败 /
 * 模板骨架校验失败 / 外链资源校验失败 / 渲染质量校验失败 / Deck 一致性校验失败），
 * 返回应记录的失败摘要；与写盘校验无关的事件返回 null。
 */
export function extractWriteValidationFailure(
  chunk: WriteToolStatusLikeChunk
): string | null {
  const label = (chunk.label || '').trim()
  if (!label || !WRITE_VALIDATION_FAILURE_LABEL_RE.test(label)) return null
  const detail = (chunk.detail || '').trim()
  if (!detail) return null
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
