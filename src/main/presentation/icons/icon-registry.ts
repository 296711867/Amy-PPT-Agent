import fs from 'node:fs'
import path from 'node:path'
import * as cheerio from 'cheerio'

/**
 * 图标库注册表：加载 lucide 全集（resources/icons/lucide-icons.json），
 * 供 data-icon 落盘替换、未知 id 校验、search_icons 工具查询共用。
 *
 * 单一来源：精选高频标签 POPULAR_ICONS 同时供 searchIcons 中文匹配
 * 和 prompt 注入（shared.ts）使用。
 */

interface IconLibraryData {
  viewBox: string
  strokeAttrs: string
  count: number
  icons: Record<string, string>
}

interface IconLibraryCache {
  data: IconLibraryData
  idSet: Set<string>
  ids: string[]
}

/** 精选高频图标（id + 中文标签·场景）。供 searchIcons 标签匹配与 prompt 注入共用。 */
export const POPULAR_ICONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'arrow-right', label: '右箭头·流程下一步' },
  { id: 'arrow-left', label: '左箭头·返回' },
  { id: 'arrow-up', label: '上箭头·上升' },
  { id: 'arrow-down', label: '下箭头·下降' },
  { id: 'arrow-up-right', label: '右上·外链增长' },
  { id: 'chevron-right', label: '右尖角·折叠' },
  { id: 'chevron-down', label: '下尖角·展开' },
  { id: 'refresh-cw', label: '循环刷新·更新' },
  { id: 'rotate-cw', label: '旋转·轮换' },
  { id: 'undo', label: '撤销·回退' },
  { id: 'redo', label: '重做·恢复' },
  { id: 'external-link', label: '外链·跳转' },
  { id: 'check', label: '对勾·正确' },
  { id: 'x', label: '叉·错误' },
  { id: 'circle-check', label: '圆形对勾·达成' },
  { id: 'circle-x', label: '圆形叉·否决' },
  { id: 'circle-alert', label: '圆形警示·风险' },
  { id: 'triangle-alert', label: '三角警示·警告' },
  { id: 'info', label: '信息·提示' },
  { id: 'lightbulb', label: '灯泡·洞察创意' },
  { id: 'ban', label: '禁止·不允许' },
  { id: 'loader', label: '加载·进行中' },
  { id: 'quote', label: '引号·金句证言' },
  { id: 'thumbs-up', label: '点赞·认可' },
  { id: 'sparkles', label: '闪光·亮点AI' },
  { id: 'star', label: '星星·评分亮点' },
  { id: 'heart', label: '心形·喜爱' },
  { id: 'chart-column', label: '柱状图·对比' },
  { id: 'chart-pie', label: '饼图·占比' },
  { id: 'chart-line', label: '折线图·走势' },
  { id: 'chart-bar', label: '条形图·横向对比' },
  { id: 'trending-up', label: '上升·增长' },
  { id: 'trending-down', label: '下降·下滑' },
  { id: 'dollar-sign', label: '美元·金额营收' },
  { id: 'percent', label: '百分比·比率' },
  { id: 'activity', label: '脉搏·活跃波动' },
  { id: 'database', label: '数据库·资产' },
  { id: 'gauge', label: '仪表盘·指标刻度' },
  { id: 'users', label: '人群·团队受众' },
  { id: 'user', label: '单人·用户' },
  { id: 'user-check', label: '认证用户·审核' },
  { id: 'user-plus', label: '新增用户·注册' },
  { id: 'smile', label: '笑脸·满意好评' },
  { id: 'heart-handshake', label: '握手·合作共赢' },
  { id: 'bot', label: '机器人·AI自动化' },
  { id: 'briefcase', label: '公文包·商务职业' },
  { id: 'building', label: '大楼·企业机构' },
  { id: 'building-2', label: '大楼·总部' },
  { id: 'credit-card', label: '信用卡·支付交易' },
  { id: 'trophy', label: '奖杯·冠军成就' },
  { id: 'rocket', label: '火箭·起飞增长' },
  { id: 'target', label: '靶心·目标聚焦' },
  { id: 'flag', label: '旗帜·里程碑' },
  { id: 'zap', label: '闪电·快速能量' },
  { id: 'award', label: '奖章·荣誉认证' },
  { id: 'piggy-bank', label: '存钱罐·储蓄理财' },
  { id: 'wallet', label: '钱包·资金账户' },
  { id: 'coins', label: '硬币·资金' },
  { id: 'gem', label: '宝石·高端珍贵' },
  { id: 'store', label: '店铺·零售门店' },
  { id: 'factory', label: '工厂·制造生产' },
  { id: 'image', label: '图片·配图素材' },
  { id: 'video', label: '视频·内容' },
  { id: 'music', label: '音乐·音频' },
  { id: 'mic', label: '麦克风·语音播客' },
  { id: 'play', label: '播放·开始' },
  { id: 'pause', label: '暂停' },
  { id: 'gift', label: '礼物·福利活动' },
  { id: 'shopping-cart', label: '购物车·消费电商' },
  { id: 'coffee', label: '咖啡·生活场景' },
  { id: 'file-text', label: '文档·报告文章' },
  { id: 'folder', label: '文件夹·归档分类' },
  { id: 'book', label: '书本·知识手册' },
  { id: 'newspaper', label: '报纸·资讯新闻' },
  { id: 'pen-tool', label: '画笔·设计创作' },
  { id: 'palette', label: '调色板·色彩风格' },
  { id: 'layers', label: '图层·层级堆叠' },
  { id: 'film', label: '胶片·影像影视' },
  { id: 'clock', label: '时钟·时长效率' },
  { id: 'calendar', label: '日历·日期日程' },
  { id: 'timer', label: '计时器·倒计时' },
  { id: 'hourglass', label: '沙漏·等待时限' },
  { id: 'map-pin', label: '定位·地点区域' },
  { id: 'search', label: '搜索·查找检索' },
  { id: 'mail', label: '邮件·联系订阅' },
  { id: 'phone', label: '电话·客服联系' },
  { id: 'link', label: '链接·关联引用' },
  { id: 'book-open', label: '翻开的书·学习阅读' },
  { id: 'bookmark', label: '书签·收藏标记' },
  { id: 'bell', label: '铃铛·通知提醒' },
  { id: 'message-circle', label: '消息·评论对话' },
  { id: 'send', label: '发送·提交分发' },
  { id: 'megaphone', label: '喇叭·公告宣传' },
  { id: 'lock', label: '锁·加密保护' },
  { id: 'shield', label: '盾牌·防护' },
  { id: 'shield-check', label: '盾牌对勾·合规保障' },
  { id: 'settings', label: '齿轮·设置系统' },
  { id: 'cloud', label: '云·云端在线' },
  { id: 'cpu', label: '芯片·算力AI' },
  { id: 'server', label: '服务器·后端服务' },
  { id: 'wifi', label: '无线·网络连接' },
  { id: 'key', label: '钥匙·权限密钥' },
  { id: 'graduation-cap', label: '学士帽·教育学习' },
  { id: 'code', label: '代码·开发编程' },
  { id: 'terminal', label: '终端·命令行' },
  { id: 'hard-drive', label: '硬盘·存储' },
  { id: 'eye', label: '眼睛·查看关注' },
  { id: 'sun', label: '太阳·积极活力' },
  { id: 'moon', label: '月亮·夜间静谧' },
  { id: 'leaf', label: '叶子·环保生长' },
  { id: 'droplet', label: '水滴·液态纯净' },
  { id: 'flame', label: '火焰·热门燃烧' },
  { id: 'wind', label: '风·轻快流动' },
  { id: 'snowflake', label: '雪花·寒冷冬季' },
  { id: 'anchor', label: '锚·稳定根基' },
  { id: 'compass', label: '指南针·方向导航' },
  { id: 'cloud-sun', label: '多云·天气' },
  { id: 'trees', label: '树木·森林生态' }
]

const POPULAR_BY_ID = new Map(POPULAR_ICONS.map((item) => [item.id, item.label]))

let cache: IconLibraryCache | null = null

const SAFE_ICON_TAGS = new Set(['path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'rect'])
const SAFE_ICON_ATTRIBUTES = new Set([
  'cx',
  'cy',
  'd',
  'fill',
  'height',
  'points',
  'r',
  'rx',
  'ry',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2'
])

const validateRootStrokeAttributes = (strokeAttrs: string): void => {
  const $ = cheerio.load(`<svg ${strokeAttrs}></svg>`, { scriptingEnabled: false }, false)
  const attributes = $('svg').first().attr() || {}
  const expected: Record<string, string> = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  }
  if (
    Object.keys(attributes).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, value]) => attributes[name] !== value)
  ) {
    throw new Error('Icon library has unsafe or unsupported root SVG attributes')
  }
}

const validateIconLibraryData = (data: IconLibraryData): void => {
  if (data.viewBox !== '0 0 24 24') {
    throw new Error(`Icon library has an unsupported viewBox: ${data.viewBox}`)
  }
  validateRootStrokeAttributes(data.strokeAttrs)
  const entries = Object.entries(data.icons || {})
  if (!Number.isInteger(data.count) || data.count !== entries.length) {
    throw new Error(`Icon library count mismatch: declared ${data.count}, loaded ${entries.length}`)
  }

  for (const [id, inner] of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof inner !== 'string' || !inner.trim()) {
      throw new Error(`Icon library entry "${id}" has an invalid id or empty markup`)
    }
  }

  const combinedMarkup = entries
    .map(([, inner], index) => `<g data-registry-index="${index}">${inner}</g>`)
    .join('')
  const $ = cheerio.load(`<svg>${combinedMarkup}</svg>`, { scriptingEnabled: false }, false)
  const groups = $('svg').first().children('g[data-registry-index]').toArray()
  if (groups.length !== entries.length || $('svg').first().children().length !== entries.length) {
    throw new Error('Icon library contains malformed markup that escapes its registry entry')
  }

  groups.forEach((group, index) => {
    const [id] = entries[index]
    const $group = $(group)
    if ($group.attr('data-registry-index') !== String(index) || $group.text().trim()) {
      throw new Error(`Icon library entry "${id}" contains malformed or textual content`)
    }
    let invalid: string | null = null
    $group.find('*').each((_index, element) => {
      if (invalid) return
      const $element = $(element)
      const tagName = String($element.prop('tagName') || '').toLowerCase()
      if (!SAFE_ICON_TAGS.has(tagName)) {
        invalid = `tag <${tagName || 'unknown'}>`
        return
      }
      for (const [name, value] of Object.entries($element.attr() || {})) {
        if (!SAFE_ICON_ATTRIBUTES.has(name.toLowerCase())) {
          invalid = `attribute ${name}`
          return
        }
        if (/(?:url\s*\(|javascript\s*:)/i.test(value)) {
          invalid = `unsafe value in ${name}`
          return
        }
      }
    })
    if (invalid) throw new Error(`Icon library entry "${id}" has unsupported ${invalid}`)
  })
}

function resolveIconsJsonPath(): string {
  // dev/test 下 cwd 有 resources/；打包后落在 app.asar.unpacked。用 existsSync 兜底，兼容非 electron 环境。
  const devPath = path.join(process.cwd(), 'resources', 'icons', 'lucide-icons.json')
  if (fs.existsSync(devPath)) return devPath
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icons', 'lucide-icons.json')
}

/** 加载并缓存图标库 JSON。dev/test 下读 process.cwd()/resources，打包后读 app.asar.unpacked。 */
export function loadIconLibrary(): IconLibraryData {
  if (cache) return cache.data
  const raw = fs.readFileSync(resolveIconsJsonPath(), 'utf-8')
  const data = JSON.parse(raw) as IconLibraryData
  validateIconLibraryData(data)
  const ids = Object.keys(data.icons)
  cache = { data, idSet: new Set(ids), ids }
  return data
}

/** 已知 id 返回 inner markup（可直接塞进 <svg>），未知返回 null。 */
export function getIconInner(id: string): string | null {
  return loadIconLibrary().icons[id] ?? null
}

/** id 是否在全集里（供 unknown-icon-id 校验用）。 */
export function isKnownIconId(id: string): boolean {
  loadIconLibrary()
  return cache ? cache.idSet.has(id) : false
}

/**
 * 把模型的简写图标 id 解析成全集 id（I-9）：如 "graduation" → "graduation-cap"。
 * 只在"唯一前缀命中"时返回（候选多于一个无法确定意图，交回校验层列候选）。
 */
export function resolveCloseIconId(id: string): string | null {
  const normalized = id.trim().toLowerCase()
  if (!normalized || isKnownIconId(normalized)) return null
  const matches = (cache?.ids || []).filter(
    (candidate) => candidate === normalized || candidate.startsWith(`${normalized}-`)
  )
  return matches.length === 1 ? matches[0] : null
}

export function getIconViewBox(): string {
  return loadIconLibrary().viewBox
}

export function getIconStrokeAttrs(): string {
  return loadIconLibrary().strokeAttrs
}

export function getIconCount(): number {
  return loadIconLibrary().count
}

/** 精选高频图标的中文标签，未知 id 返回 undefined。 */
export function getPopularLabel(id: string): string | undefined {
  return POPULAR_BY_ID.get(id)
}

/**
 * 按关键词模糊匹配图标 id。同时匹配英文 id 子串与精选中文标签，
 * 让 LLM 传"增长"/"箭头"/"用户"也能命中 trending-up、arrow 系列、user 系列。
 */
export function searchIcons(
  query: string,
  limit = 20
): Array<{ id: string; label?: string }> {
  loadIconLibrary()
  if (!cache) return []
  const q = query.trim().toLowerCase()
  if (!q) {
    return POPULAR_ICONS.slice(0, limit).map((item) => ({ id: item.id, label: item.label }))
  }
  const terms = q.split(/[\s,，、/]+/).filter(Boolean)
  const scored: Array<{ id: string; score: number }> = []
  for (const id of cache.ids) {
    const lower = id.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (lower === term) score += 100
      else if (lower.startsWith(term)) score += 50
      else if (lower.includes(term)) score += 20
    }
    const label = POPULAR_BY_ID.get(id)
    if (label) {
      score += 10 // 高频精选略加分，让常用图标在同类前缀中排前（如 arrow-right 优先于 arrow-big-*）
      for (const term of terms) {
        if (label.toLowerCase().includes(term)) score += 30
      }
    }
    if (score > 0) scored.push({ id, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((item) => ({
    id: item.id,
    label: POPULAR_BY_ID.get(item.id)
  }))
}
