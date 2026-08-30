import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { SlideSizePreset } from '@shared/slide-size'
import { isKnownIconId, resolveCloseIconId, searchIcons } from '../icons/icon-registry'

/**
 * Harness 质量校验器。
 *
 * 在 HTML 落盘前，机械判定那些 prompt 约束不住、但确定性可检查的问题
 * （如 emoji 当图标、内容区 padding 突破下限）。不达标时由调用方抛出
 * PageWriteValidationError，让 agent 在 ReAct 循环内带反馈重写。
 *
 * 设计原则：只查确定性可判定、低误判的项目。不确定的（如对齐一致性、
 * 画布越界）留给 prompt，不在这里猜。
 */

export interface QualityViolation {
  /** 机器可读的规则 code，如 'emoji-as-icon' */
  code: string
  severity: 'error' | 'warn'
  /** 具体位置/值，便于定位 */
  detail: string
  /** 给 LLM 的修复指令 */
  fix: string
}

// 真正的 emoji 范围（表情、动物、物品、符号补充、旗帜）。
// 刻意排除 →←↑↓ 这类箭头与 ★ 等可能合法的排版符号，降低误判。
const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}]/u

function containsEmoji(text: string): boolean {
  return EMOJI_REGEX.test(text)
}

function firstEmoji(text: string): string {
  return (text.match(EMOJI_REGEX) || ['?'])[0]
}

/**
 * 从 class 字符串解析水平 padding（Tailwind `px-N` 或 `px-[Npx]`）。
 * 返回 px 数值；未声明则返回 null。
 */
function parseHorizontalPaddingFromClass(cls: string | undefined): number | null {
  if (!cls) return null
  // px-[Npx] 或 px-[N]（任意值语法）
  const arbitrary = /(?:^|\s)px-\[(\d+(?:\.\d+)?)(?:px)?\]/.exec(cls)
  if (arbitrary) return Math.round(parseFloat(arbitrary[1]))
  // px-N（Tailwind spacing scale，N × 4px）
  const scalar = /(?:^|\s)px-(\d+)(?=\s|$)/.exec(cls)
  if (scalar) return parseInt(scalar[1], 10) * 4
  return null
}

/**
 * 从内联 style 解析水平 padding，堵住 LLM 用 style="padding:..." 绕过 class 检测的漏洞。
 * 支持 padding 简写（1/2/3/4 值）与 padding-left / padding-right。
 */
function parseHorizontalPaddingFromStyle(style: string | undefined): number | null {
  if (!style) return null
  const padMatch = /padding\s*:\s*([^;]+)/i.exec(style)
  if (padMatch) {
    const parts = padMatch[1]
      .trim()
      .split(/\s+/)
      .map((p) => parseFloat(p))
      .filter((n) => Number.isFinite(n))
    // padding: a (四向=a) | a b (上下=a 左右=b) | a b c (左右=b) | a b c d (右=b 左=d)
    if (parts.length === 1) return Math.round(parts[0])
    if (parts.length >= 2) return Math.round(parts[1]) // 第 2 个值始终是水平(right)
  }
  const pl = /padding-left\s*:\s*([\d.]+)/i.exec(style)
  const pr = /padding-right\s*:\s*([\d.]+)/i.exec(style)
  if (pl && pr) return Math.round((parseFloat(pl[1]) + parseFloat(pr[1])) / 2)
  if (pl) return Math.round(parseFloat(pl[1]))
  if (pr) return Math.round(parseFloat(pr[1]))
  return null
}

/** 综合解析水平 padding：先 class，后内联 style（堵绕过）。 */
function resolveHorizontalPaddingPx(
  cls: string | undefined,
  style: string | undefined
): number | null {
  return parseHorizontalPaddingFromClass(cls) ?? parseHorizontalPaddingFromStyle(style)
}

const AUXILIARY_SELECTOR = [
  'footer',
  'small',
  'figcaption',
  '[data-ppt-text-role="auxiliary"]',
  '[data-role="footer"]',
  '[data-role="footnote"]',
  '[data-role="source"]',
  '[data-role="annotation"]',
  '[data-role="page-number"]'
].join(',')

const TAILWIND_TEXT_SIZE_PX: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
  '6xl': 60,
  '7xl': 72,
  '8xl': 96,
  '9xl': 128
}

function parseExplicitFontSizePx(cls: string | undefined, style: string | undefined): number | null {
  const arbitrary = /(?:^|\s)text-\[(\d+(?:\.\d+)?)px\](?=\s|$)/.exec(cls || '')
  if (arbitrary) return Number.parseFloat(arbitrary[1])
  const token = /(?:^|\s)text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?=\s|$)/.exec(
    cls || ''
  )
  if (token) return TAILWIND_TEXT_SIZE_PX[token[1]] ?? null
  const inline = /font-size\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style || '')
  return inline ? Number.parseFloat(inline[1]) : null
}

/** Rule 3 与修复函数共用的文本元素选择器。 */
const TEXT_FLOOR_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,label,button,span'

/** 画布字号下限：正文 18px、标题 24px（按 900 高度基准等比换算）。 */
const resolveFontFloors = (slideSize: SlideSizePreset): { bodyFloorPx: number; headingFloorPx: number } => ({
  bodyFloorPx: Math.round(18 * (slideSize.height / 900)),
  headingFloorPx: Math.round(24 * (slideSize.height / 900))
})

export interface FontFloorFix {
  locator: string
  fromPx: number
  toPx: number
}

/**
 * 确定性修复：把低于画布字号下限的显式字号（text-[Npx]、text-xl 等语义档、
 * 内联 font-size）抬高到对应下限。只处理会被 font-below-floor 拒绝的元素，
 * 辅助标记文本照旧豁免——模型反复带出 text-xl 模块标题这类 web 习惯小字号时，
 * 与其靠重试循环耗尽，不如落盘前机械抬到位。
 */
export function repairExplicitFontFloors(
  html: string,
  slideSize: SlideSizePreset
): { html: string; fixes: FontFloorFix[] } {
  const { bodyFloorPx, headingFloorPx } = resolveFontFloors(slideSize)
  const $ = cheerio.load(html, { scriptingEnabled: false })
  const fixes: FontFloorFix[] = []
  $(TEXT_FLOOR_SELECTOR).each((_i, el) => {
    const $el = $(el)
    if ($el.closest('script,style,svg,canvas').length > 0) return
    if (!$el.text().trim()) return
    if ($el.closest(AUXILIARY_SELECTOR).length > 0) return
    const cls = $el.attr('class') || ''
    const style = $el.attr('style') || ''
    const explicitPx = parseExplicitFontSizePx(cls, style)
    if (explicitPx === null) return
    const tag = ($el.prop('tagName') || '').toLowerCase()
    const isHeading = /^h[1-6]$/.test(tag) || $el.attr('data-role') === 'title'
    const floor = isHeading ? headingFloorPx : bodyFloorPx
    if (explicitPx >= floor) return
    const locator = elementLocator($el)
    if (/(?:^|\s)text-\[\d+(?:\.\d+)?px\](?=\s|$)/.test(cls)) {
      $el.attr('class', cls.replace(/text-\[\d+(?:\.\d+)?px\]/, `text-[${floor}px]`))
    } else if (/(?:^|\s)text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?=\s|$)/.test(cls)) {
      $el.attr(
        'class',
        cls.replace(
          /text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?=\s|$)/,
          `text-[${floor}px]`
        )
      )
    } else if (/font-size\s*:\s*[\d.]+px/i.test(style)) {
      $el.attr('style', style.replace(/font-size\s*:\s*[\d.]+px/i, `font-size: ${floor}px`))
    } else {
      return
    }
    fixes.push({ locator, fromPx: explicitPx, toPx: floor })
  })
  return { html: $.html(), fixes }
}

function elementLocator($el: cheerio.Cheerio<AnyNode>): string {
  const tag = ($el.prop('tagName') || 'div').toLowerCase()
  const cls = ($el.attr('class') || '').trim()
  return cls ? `<${tag} class="${cls.slice(0, 56)}">` : `<${tag}>`
}

/** px → Tailwind spacing step（px-N 里 N = ceil(px/4)） */
function toTailwindSpacing(px: number): number {
  return Math.max(1, Math.ceil(px / 4))
}

/** 判断 class 是否"图标底托"：圆形/大圆角 + 固定尺寸 w/h，且尺寸是图标级（≤ 96px，排除大卡片）。 */
function looksLikeIconBacking(cls: string | undefined): boolean {
  if (!cls) return false
  // 圆形或大圆角矩形（rounded-full / [50%] / xl / 2xl / 3xl）
  const hasRound = /(?:^|\s)rounded-(full|\[50%\]|xl|2xl|3xl)(?:\s|$|\[)/.test(cls)
  if (!hasRound) return false
  // 固定尺寸 w-N h-N（标量）
  const wScalar = /(?:^|\s)w-(\d+)(?=\s|$)/.exec(cls)
  const hScalar = /(?:^|\s)h-(\d+)(?=\s|$)/.exec(cls)
  if (wScalar && hScalar) {
    const wPx = parseInt(wScalar[1], 10) * 4
    const hPx = parseInt(hScalar[1], 10) * 4
    return wPx <= 96 && hPx <= 96 // 图标级尺寸，排除大卡片
  }
  // 固定尺寸 w-[Npx] h-[Npx]（任意值）
  const wArb = /(?:^|\s)w-\[(\d+)(?:px)?\]/.exec(cls)
  const hArb = /(?:^|\s)h-\[(\d+)(?:px)?\]/.exec(cls)
  if (wArb && hArb) {
    return parseInt(wArb[1], 10) <= 96 && parseInt(hArb[1], 10) <= 96
  }
  return false
}

/** 把 class 字符串里和尺寸/圆角相关的 token 取出来，给 detail 用。 */
function summarizeBackingClass(cls: string): string {
  return cls
    .split(/\s+/)
    .filter((c) => /rounded|w-|h-/.test(c))
    .slice(0, 4)
    .join(' ')
}

/** 判断是否"大字号图标位 span"：text-xl 及以上。 */
function isLargeIconText($el: cheerio.Cheerio<AnyNode>): boolean {
  const tag = $el.prop('tagName')
  if (!tag || tag.toLowerCase() !== 'span') return false
  const cls = $el.attr('class') || ''
  return /(?:^|\s)text-(xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?:\s|$)/.test(cls)
}

/**
 * 校验单页 HTML。返回所有违规；空数组表示达标。
 *
 * @param html 已包裹（含 section/main/.ppt-page-root）的完整落盘 HTML
 * @param slideSize 当前画布尺寸，用于按宽度计算 padding 下限
 */
export function validatePageQuality(
  html: string,
  slideSize: SlideSizePreset
): QualityViolation[] {
  const violations: QualityViolation[] = []
  const $ = cheerio.load(html, { scriptingEnabled: false })

  // ---- Rule 1: emoji 当图标 ----
  // 1a. 图标底托（rounded-full + 固定尺寸）内含 emoji —— 底托里本应是 <svg>
  $('[class]').each((_i, el) => {
    const $el = $(el)
    const cls = $el.attr('class') || ''
    if (!looksLikeIconBacking(cls)) return
    const text = $el.text().trim()
    if (containsEmoji(text)) {
      violations.push({
        code: 'emoji-as-icon',
        severity: 'error',
        detail: `图标底托 (${summarizeBackingClass(cls)}) 内含 emoji "${firstEmoji(text)}"，本应是内联 SVG`,
        fix: '把底托里的 emoji 换成内联 SVG 图标（<svg>...</svg>），禁止用 emoji 充当图标或装饰锚点'
      })
    }
  })

  // 1b. 大字号 span 里的 emoji —— 图标位用 emoji 的常见写法。
  // 跳过已在图标底托内的 span：那种情况由 1a 统一报告，避免重复。
  $('span[class]').each((_i, el) => {
    const $el = $(el)
    if (!isLargeIconText($el)) return
    const insideBacking = $el
      .parents()
      .toArray()
      .some((p) => looksLikeIconBacking($(p).attr('class')))
    if (insideBacking) return
    const text = $el.text().trim()
    if (containsEmoji(text)) {
      violations.push({
        code: 'emoji-as-icon',
        severity: 'error',
        detail: `大字号 span 内含 emoji "${firstEmoji(text)}"，疑似当图标用`,
        fix: '图标位必须是内联 SVG；若该 emoji 属正文内容，请移到正文中性字号处，不要用 text-xl+ 放大'
      })
    }
  })

  // ---- Rule 2: 内容区水平 padding 下限 ----
  const floorPx = Math.round(slideSize.width * 0.06)
  const floorTw = toTailwindSpacing(floorPx)

  // persisted HTML 形如 .ppt-page-root > section[data-page-scaffold] > main[data-role=content] > 用户根容器
  // 校验 main 的直接子元素（内容区根容器）水平 padding 是否达到下限。
  let $roots = $('main[data-role="content"] > *')
  if ($roots.length === 0) {
    // 兼容没有 main 包装的退化情形：取 section 直接子元素
    $roots = $('[data-page-scaffold] > *')
  }
  let rootsWithExplicitSafeArea = 0
  $roots.each((_i, el) => {
    const $el = $(el)
    const cls = $el.attr('class') || ''
    const style = $el.attr('style') || ''
    const px = resolveHorizontalPaddingPx(cls, style)
    if (px === null) return
    rootsWithExplicitSafeArea += 1
    if (px < floorPx) {
      // 定位片段：让 LLM 知道改哪个元素（pi 模式 D：精确错误加速修正）
      const tag = ($el.prop('tagName') || 'div').toLowerCase()
      const locator = cls ? `<${tag} class="${cls.slice(0, 48)}">` : `<${tag}>`
      const viaStyle = style && parseHorizontalPaddingFromClass(cls) === null
      violations.push({
        code: 'padding-below-floor',
        severity: 'error',
        detail: `内容区根容器 ${locator} 水平 padding 仅 ${px}px${viaStyle ? '（来自内联 style，非 class px-N）' : ''}，低于下限 ${floorPx}px（画布宽 ${slideSize.width}px 的 6%）`,
        fix: `把该元素的水平 padding 改为 px-${floorTw}（${floorPx}px）或更大；禁用 px-10/px-12/px-16/px-20，也不要用内联 style 写更小的 padding 绕过；内容过多时先压缩文案而非贴边`
      })
    }
  })

  if ($roots.length > 0 && rootsWithExplicitSafeArea === 0) {
    violations.push({
      code: 'safe-area-implicit',
      severity: 'warn',
      detail: `内容区的 ${$roots.length} 个根容器都没有显式水平 padding，无法静态确认文字是否位于安全区内`,
      fix: `在承载正文的根容器上显式设置至少 px-${floorTw}（${floorPx}px）的水平 padding；只有全出血背景和装饰层可以贴边`
    })
  }

  // ---- Rule 3: 显式小字号 ----
  const { bodyFloorPx, headingFloorPx } = resolveFontFloors(slideSize)
  $(TEXT_FLOOR_SELECTOR).each((_i, el) => {
    const $el = $(el)
    if ($el.closest('script,style,svg,canvas').length > 0) return
    if (!$el.text().trim()) return
    if ($el.closest(AUXILIARY_SELECTOR).length > 0) return
    const explicitPx = parseExplicitFontSizePx($el.attr('class'), $el.attr('style'))
    if (explicitPx === null) return
    const tag = ($el.prop('tagName') || '').toLowerCase()
    // 标题带 [data-role="title"] 内部常含 kicker/副标题等非标题文字，
    // 只有标题元素本身（h1-h6 或带 data-role="title" 的元素）适用标题下限，
    // 其余子元素按正文下限处理，避免把 22px 副标题误判成标题字号不足。
    const isHeading = /^h[1-6]$/.test(tag) || $el.attr('data-role') === 'title'
    const floor = isHeading ? headingFloorPx : bodyFloorPx
    if (explicitPx >= floor) return
    violations.push({
      code: 'font-below-floor',
      severity: 'error',
      detail: `${elementLocator($el)} 显式字号 ${explicitPx}px，低于当前画布${isHeading ? '标题' : '正文'}下限 ${floor}px`,
      fix: `把该文字提高到至少 ${floor}px；内容放不下时先精简文案或更换构图，不要缩小到投影不可读`
    })
  })

  // ---- Rule 4: Web UI 倾向（advisory，不直接阻断有意展示产品界面的页面）----
  const interactiveCount = $('nav,input,select,textarea,form,[role="button"],[role="tab"]').length
  if (interactiveCount > 0) {
    violations.push({
      code: 'interactive-ui-controls',
      severity: 'warn',
      detail: `检测到 ${interactiveCount} 个导航、表单或交互控件，页面可能被写成可操作网页而不是静态演示画面`,
      fix: '如果不是在展示真实产品界面，请改成静态文字、图形或截图式表达，并移除导航、按钮、表单和标签页语义'
    })
  }

  const cardLikeCount = $('[class]').toArray().filter((node) => {
    const cls = $(node).attr('class') || ''
    return /(?:^|\s)(?:card|panel|tile)(?:\s|$)|rounded-(?:xl|2xl|3xl)[\s\S]*(?:shadow|border)|(?:shadow|border)[\s\S]*rounded-(?:xl|2xl|3xl)/i.test(
      cls
    )
  }).length
  if (cardLikeCount >= 6) {
    violations.push({
      code: 'card-wall-density',
      severity: 'warn',
      detail: `检测到 ${cardLikeCount} 个卡片式容器，页面可能退化为 dashboard、bento 或功能卡片墙`,
      fix: '重新确定一个主结论和主视觉，把次要内容压缩为 0–2 个支撑区；只有确实并列的信息才保留同组卡片'
    })
  }

  // ---- Rule 5: under-fill 孤儿页（极保守兜底，prompt 主力管一般情况）----
  // 只在「文本极少 + 无任何主体视觉」同时满足时触发，避免误伤章节扉页/金句页/
  // 图表页/目录页（它们要么有大字号主体，要么有图/图表/列表，文本量也够）。
  const $content = $('main[data-role="content"]')
  if ($content.length > 0) {
    const contentText = $content.text().replace(/\s+/g, '')
    const hasLargeText = /(?:^|\s)text-(5xl|6xl|7xl|8xl|9xl)(?:\s|$)/.test($content.attr('class') || '') ||
      $content.find('[class]').toArray().some((node) => {
        const c = $(node).attr('class') || ''
        return /(?:^|\s)text-(5xl|6xl|7xl|8xl|9xl)(?:\s|$)/.test(c)
      })
    const hasVisualSubject =
      $content.find('svg').length > 0 ||
      $content.find('img').length > 0 ||
      $content.find('[data-role="image-placeholder"]').length > 0 ||
      $content.find('[data-chart], [data-ppt-chart]').length > 0 ||
      /PPT\.createChart|@ppt-chart-height=/.test($content.html() || '')
    // 文本极少（< 80 字符去空白）、无大字号主体、无视觉主体 → 极可能是填不满的孤页
    if (contentText.length < 80 && !hasLargeText && !hasVisualSubject) {
      violations.push({
        code: 'under-fill-orphan',
        severity: 'error',
        detail: `内容区文本仅 ${contentText.length} 字符，且无大字号主体（text-5xl+）、无图表/图像/SVG 等视觉主体，疑似填不满的孤页`,
        fix: '内容不足以撑满画布时必须主动扩充：放大主体（hero 数字/图表占满 zone）、补 evidence rail（1-2 张支撑卡片/指标）、加视觉锚点（图示/时间线/对比），或扩展论点（背景/对比/启示）。不要交半空的内容页'
      })
    }
  }

  // ---- Rule 6: 未知图标 id（data-icon 引用了全集里没有的 id，替换器已保留原样）----
  $('[data-icon]').each((_i, el) => {
    const $el = $(el)
    const id = ($el.attr('data-icon') || '').trim()
    const tagName = String($el.prop('tagName') || '').toLowerCase()
    if (!id || tagName !== 'svg') {
      violations.push({
        code: 'unknown-icon-id',
        severity: 'error',
        detail: !id
          ? '图标引用缺少 data-icon id。'
          : `图标 id "${id}" 使用在 <${tagName || 'unknown'}> 上，data-icon 只能用于 <svg>。`,
        fix: !id
          ? '填写有效图标 id，或删除这个空图标；不确定时调用 search_icons。'
          : `改为 <svg data-icon="${id}" class="..."></svg>，不要把 data-icon 写在 div/span 等标签上。`
      })
      return
    }
    if (id && !isKnownIconId(id)) {
      // I-9：错误信息必须带可执行的候选——只说"未知 id"模型重试会原样重写
      // （实测 graduation 重试三次全部失败）。优先给唯一前缀纠正，其次列模糊搜索候选。
      const closeId = resolveCloseIconId(id)
      const suggestions =
        closeId !== null
          ? [closeId]
          : searchIcons(id, 5)
              .map((item) => item.id)
              .filter(Boolean)
      const suggestionText =
        suggestions.length > 0 ? `可改用：${suggestions.join('、')}` : '调用 search_icons 工具查正确 id'
      violations.push({
        code: 'unknown-icon-id',
        severity: 'error',
        detail: `未知图标 id "${id}"，不在可用图标库中（拼写错误？）`,
        fix: `把 data-icon="${id}" 改成正确 id；${suggestionText}`
      })
    }
  })

  return violations
}
