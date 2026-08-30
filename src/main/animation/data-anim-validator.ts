import * as cheerio from 'cheerio'
import {
  DATA_ANIM_FROM_VALUES,
  DATA_ANIM_SEQUENCES,
  DATA_ANIM_SUPPORTED_TYPES,
  DATA_ANIM_TRIGGERS,
  normalizeDataAnimTrigger,
  type DataAnimSequence
} from '../../shared/element-animation'

const LINEAR_PATH_RE =
  /^M\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+L\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s*$/i
const CLICK_GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const isLinearMotionPathString = (value: string): boolean => LINEAR_PATH_RE.test(value.trim())

const normalizeAnimTrigger = (value: string): 'load' | 'click' | 'with' | 'after' =>
  normalizeDataAnimTrigger(value) ?? 'load'

export function validateDataAnimContract(
  html: string
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const supportedAnimTypes = new Set<string>(DATA_ANIM_SUPPORTED_TYPES)
  const supportedAnimTriggers = new Set<string>(DATA_ANIM_TRIGGERS)
  const supportedAnimFromValues = new Set<string>(DATA_ANIM_FROM_VALUES)

  try {
    const $ = cheerio.load(html, { scriptingEnabled: false })
    const invalidAnimTypes = new Set<string>()
    $('[data-anim]').each((_, node) => {
      const type = ($(node).attr('data-anim') || '').trim().toLowerCase()
      if (!type || !supportedAnimTypes.has(type)) {
        invalidAnimTypes.add(type || '(empty)')
      }
    })
    if (invalidAnimTypes.size > 0) {
      // 必须把合法取值列全：这条错误会进入生成重试反馈，
      // 只说"非法值"模型会反复写同一个猜出来的值（实测 fade-in 重试仍失败）。
      errors.push(
        `data-anim 仅支持以下取值：${DATA_ANIM_SUPPORTED_TYPES.join('/')}。非法值：${Array.from(invalidAnimTypes).join(', ')}（请改用列表中的类型，例如 fade-in 改为 fade 或 fade-up）`
      )
    }

    const invalidTriggers = new Set<string>()
    $('[data-anim-trigger]').each((_, node) => {
      const trigger = ($(node).attr('data-anim-trigger') || '').trim().toLowerCase()
      // Generation gate enforces canonical triggers; legacy aliases are tolerated
      // only by the editor's parse path (normalizeDataAnimTrigger).
      if (!trigger || !supportedAnimTriggers.has(trigger)) {
        invalidTriggers.add(trigger || '(empty)')
      }
    })
    if (invalidTriggers.size > 0) {
      errors.push(
        `data-anim-trigger 仅支持 ${DATA_ANIM_TRIGGERS.join('/')}，非法值：${Array.from(invalidTriggers).join(', ')}`
      )
    }

    const invalidFromValues = new Set<string>()
    const incompatibleCenterAnims = new Set<string>()
    $('[data-anim-from]').each((_, node) => {
      const from = ($(node).attr('data-anim-from') || '').trim().toLowerCase()
      if (!from || !supportedAnimFromValues.has(from)) {
        invalidFromValues.add(from || '(empty)')
      }
      if (from === 'center') {
        const animType = ($(node).attr('data-anim') || '').trim().toLowerCase()
        if (['fly-in', 'wipe', 'exit-fly', 'exit-wipe'].includes(animType)) {
          incompatibleCenterAnims.add(animType)
        }
      }
    })
    if (invalidFromValues.size > 0) {
      errors.push(
        `data-anim-from 仅支持 ${DATA_ANIM_FROM_VALUES.join('/')}，非法值：${Array.from(invalidFromValues).join(', ')}`
      )
    }
    if (incompatibleCenterAnims.size > 0) {
      errors.push(
        `data-anim-from="center" 与以下动画类型不兼容（无法往返）：${Array.from(incompatibleCenterAnims).join(', ')}。center 仅支持 fade/zoom/path 类动画`
      )
    }

    const missingPathValues = new Set<string>()
    const unexpectedPathValues = new Set<string>()
    $('[data-anim]').each((_, node) => {
      const type = ($(node).attr('data-anim') || '').trim().toLowerCase()
      const rawPath = ($(node).attr('data-anim-path') || '').trim()
      if (type === 'path') {
        if (!rawPath || !isLinearMotionPathString(rawPath)) {
          missingPathValues.add(rawPath || 'path')
        }
        return
      }
      if ($(node).attr('data-anim-path') !== undefined) {
        unexpectedPathValues.add(type || '(empty)')
      }
    })
    if (missingPathValues.size > 0) {
      errors.push(
        `data-anim="path" 必须同时提供可解析为线性位移的 data-anim-path，非法值：${Array.from(missingPathValues).join(', ')}`
      )
    }
    if (unexpectedPathValues.size > 0) {
      errors.push(
        `只有 data-anim="path" 才能使用 data-anim-path，非法类型：${Array.from(unexpectedPathValues).join(', ')}`
      )
    }

    const invalidDurations = new Set<string>()
    $('[data-anim-duration]').each((_, node) => {
      const raw = ($(node).attr('data-anim-duration') || '').trim()
      const value = Number(raw)
      if (!raw || !Number.isFinite(value) || value < 100 || value > 5000) {
        invalidDurations.add(raw || '(empty)')
      }
    })
    if (invalidDurations.size > 0) {
      errors.push(
        `data-anim-duration 必须是 100-5000 的数字毫秒值，非法值：${Array.from(invalidDurations).join(', ')}`
      )
    }

    const invalidDelays = new Set<string>()
    $('[data-anim-delay]').each((_, node) => {
      const raw = ($(node).attr('data-anim-delay') || '').trim()
      if (!raw) {
        invalidDelays.add('(empty)')
        return
      }
      if (/^stagger\s*\(\s*\d+\s*\)$/i.test(raw)) return
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) invalidDelays.add(raw)
    })
    if (invalidDelays.size > 0) {
      errors.push(
        `data-anim-delay 必须是大于等于 0 的数字毫秒值或 stagger(N)，非法值：${Array.from(invalidDelays).join(', ')}`
      )
    }

    const invalidStaggers = new Set<string>()
    $('[data-anim-stagger]').each((_, node) => {
      const raw = ($(node).attr('data-anim-stagger') || '').trim()
      const value = Number(raw)
      if (!raw || !Number.isFinite(value) || value < 0) {
        invalidStaggers.add(raw || '(empty)')
      }
    })
    if (invalidStaggers.size > 0) {
      errors.push(
        `data-anim-stagger 必须是大于等于 0 的数字毫秒值，非法值：${Array.from(invalidStaggers).join(', ')}`
      )
    }

    const runtimeOnlyAttributes = [
      ['data-anim-easing', 'data-anim-easing'],
      ['data-anim-repeat', 'data-anim-repeat'],
      ['data-anim-direction', 'data-anim-direction']
    ] as const
    for (const [selector, label] of runtimeOnlyAttributes) {
      const values = new Set<string>()
      $(`[${selector}]`).each((_, node) => {
        values.add(($(node).attr(selector) || '').trim() || '(empty)')
      })
      if (values.size > 0) {
        errors.push(
          `${label} 当前属于 runtime-only 兼容能力，不应进入标准可编辑导出页面，非法值：${Array.from(values).join(', ')}`
        )
      }
    }

    const invalidSequences = new Set<string>()
    const clickSequences = new Set<string>()
    $('[data-anim-sequence]').each((_, node) => {
      const value = ($(node).attr('data-anim-sequence') || '').trim().toLowerCase()
      if (!value || !DATA_ANIM_SEQUENCES.includes(value as DataAnimSequence)) {
        invalidSequences.add(value || '(empty)')
        return
      }
      const trigger = normalizeAnimTrigger($(node).attr('data-anim-trigger') || 'load')
      if (trigger === 'click') clickSequences.add(value)
    })
    if (invalidSequences.size > 0) {
      errors.push(
        `data-anim-sequence 仅支持 with/after，非法值：${Array.from(invalidSequences).join(', ')}`
      )
    }
    if (clickSequences.size > 0) {
      errors.push(
        `data-anim-sequence 仅用于自动动画顺序，click 动画不能使用：${Array.from(clickSequences).join(', ')}`
      )
    }

    const invalidClickGroups = new Set<string>()
    const nonClickGrouped: string[] = []
    const clickGroupTimeline: Array<string | null> = []
    $('[data-anim]').each((_, node) => {
      const trigger = normalizeAnimTrigger($(node).attr('data-anim-trigger') || 'load')
      const attrValue = $(node).attr('data-anim-click-group')
      const group = (attrValue || '').trim()
      if (trigger !== 'click') {
        if (attrValue !== undefined && !group) {
          invalidClickGroups.add('(empty)')
          return
        }
        if (!group) return
        if (!CLICK_GROUP_RE.test(group)) {
          invalidClickGroups.add(group)
          return
        }
        nonClickGrouped.push(group)
        return
      }
      if (attrValue === undefined) {
        clickGroupTimeline.push(null)
        return
      }
      if (!group) {
        invalidClickGroups.add('(empty)')
        clickGroupTimeline.push(null)
        return
      }
      if (!CLICK_GROUP_RE.test(group)) {
        invalidClickGroups.add(group)
        clickGroupTimeline.push(null)
        return
      }
      clickGroupTimeline.push(group)
    })
    if (invalidClickGroups.size > 0) {
      errors.push(
        `data-anim-click-group 仅支持字母/数字/中划线/下划线，并且必须以字母或数字开头，非法值：${Array.from(invalidClickGroups).join(', ')}`
      )
    }
    if (nonClickGrouped.length > 0) {
      errors.push(
        `data-anim-click-group 只能用于 click 触发动画，非法分组：${Array.from(new Set(nonClickGrouped)).join(', ')}`
      )
    }
    if (clickGroupTimeline.length > 1) {
      const closedGroups = new Set<string>()
      let activeGroup: string | null = null
      for (const group of clickGroupTimeline) {
        if (!group) {
          if (activeGroup) {
            closedGroups.add(activeGroup)
            activeGroup = null
          }
          continue
        }
        if (group === activeGroup) continue
        if (closedGroups.has(group)) {
          errors.push(`data-anim-click-group 必须在 click 动画的 DOM 顺序上连续出现，非法分组：${group}`)
          break
        }
        if (activeGroup) closedGroups.add(activeGroup)
        activeGroup = group
      }
    }
  } catch {
    errors.push('HTML 动画结构解析失败')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Return only the contract violations a patch newly introduces (whole-page before/after diff).
 * Pre-existing violations cancel out, so old debt elsewhere doesn't block a targeted edit;
 * page-level constraints the patch can affect (e.g. click-group continuity) still surface.
 */
export function validateDataAnimPatch(
  beforeHtml: string,
  afterHtml: string
): { newErrors: string[] } {
  const beforeErrors = validateDataAnimContract(beforeHtml).errors
  const afterErrors = validateDataAnimContract(afterHtml).errors
  return { newErrors: afterErrors.filter((error) => !beforeErrors.includes(error)) }
}
