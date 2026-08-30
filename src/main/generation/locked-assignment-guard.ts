/**
 * I-11：锁定版式快速通道对封面/结尾页是净负资产——内置 cover/ending 骨架是
 * 极简示意结构（~1.7KB，对比 LLM 创作页 ~344KB），壳层 bug 修复前锁定填充
 * 从未真正生效（全部静默回退 AI 创作），修复后封面/结尾质量断崖式下降。
 * 封面与结尾是整套 deck 最吃设计的两页，交还 LLM 创作；锁定确定性保留给
 * 内容页。纯函数，便于单测。
 */
export type LockedAssignmentLike = unknown

export function filterCoverEndingLockedAssignments<T>(
  assignments: Array<T | null | undefined>,
  pageRoles: Array<'cover' | 'ending' | 'content' | string | undefined>
): Array<T | null> {
  return assignments.map((assignment, index) => {
    if (assignment === null || assignment === undefined) return null
    const role = pageRoles[index]
    if (role === 'cover' || role === 'ending') return null
    return assignment
  })
}
