/**
 * YAML Profile：声明式功能开关与配置覆盖。
 *
 * 用户在 userData 目录放置 profile.yaml，应用启动时加载。
 * 支持：功能开关（visual_review 等）、生成配置覆盖（并发模式、
 * 图片策略）、自定义设置注入。
 *
 * 示例 profile.yaml：
 *   features:
 *     visual_review: off
 *     locked_layouts: on
 *   generation:
 *     page_concurrency: serial
 *     image_policy: placeholder
 *   settings:
 *     theme: midnight
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'

export interface AmyPptProfile {
  /** 功能开关，覆盖 DB settings。 */
  features?: Record<string, string>
  /** 生成配置，覆盖 page_concurrency 等。 */
  generation?: {
    page_concurrency?: 'auto' | 'serial' | 'parallel'
    image_policy?: 'placeholder' | 'ai'
  }
  /** 直接注入 DB settings 的键值对（最低优先级）。 */
  settings?: Record<string, string>
}

const PROFILE_FILENAME = 'profile.yaml'

export function resolveProfilePath(): string {
  return path.join(app.getPath('userData'), is.dev ? 'profile-dev.yaml' : PROFILE_FILENAME)
}

/** 简易 YAML 解析（只支持两层级 key: value，不引入 js-yaml 依赖）。 */
function parseSimpleYaml(content: string): AmyPptProfile {
  const profile: AmyPptProfile = {}
  let currentSection: string | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue

    // 顶级 section（如 features:）
    const sectionMatch = line.match(/^([a-z_]+):\s*$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      if (currentSection === 'features') profile.features = profile.features || {}
      if (currentSection === 'generation') profile.generation = profile.generation || {}
      if (currentSection === 'settings') profile.settings = profile.settings || {}
      continue
    }

    // key: value 对
    const kvMatch = line.match(/^\s+([a-z_-]+):\s*(.+)$/)
    if (kvMatch && currentSection) {
      const [, key, rawValue] = kvMatch
      const value = rawValue.replace(/^["']|["']$/g, '').trim()
      if (currentSection === 'features' || currentSection === 'settings') {
        const target = currentSection === 'features' ? profile.features : profile.settings
        if (target) target[key] = value
      } else if (currentSection === 'generation' && profile.generation) {
        if (key === 'page_concurrency') {
          profile.generation.page_concurrency =
            value === 'serial' || value === 'parallel' ? value : 'auto'
        } else if (key === 'image_policy') {
          profile.generation.image_policy = value === 'ai' ? 'ai' : 'placeholder'
        }
      }
    }
  }

  return profile
}

/** 读取并解析 profile.yaml；文件不存在返回空对象。 */
export function loadProfile(): AmyPptProfile {
  const profilePath = resolveProfilePath()
  try {
    if (!fs.existsSync(profilePath)) return {}
    const content = fs.readFileSync(profilePath, 'utf-8')
    const profile = parseSimpleYaml(content)
    log.info('[profile] loaded', { path: profilePath, sections: Object.keys(profile) })
    return profile
  } catch (error) {
    log.warn('[profile] failed to load, using defaults', {
      path: profilePath,
      message: error instanceof Error ? error.message : String(error)
    })
    return {}
  }
}

/** 生成默认 profile.yaml 模板。 */
export function createDefaultProfileTemplate(): string {
  return [
    '# Amy-PPT Profile',
    '# 放在应用数据目录，启动时自动加载。',
    '',
    '# 功能开关（覆盖数据库 settings）',
    'features:',
    '  visual_review: on',
    '',
    '# 生成配置',
    'generation:',
    '  page_concurrency: auto',
    '  image_policy: placeholder',
    '',
    '# 直接注入 settings 的键值对',
    'settings:',
    '  theme: coral'
  ].join('\n')
}
