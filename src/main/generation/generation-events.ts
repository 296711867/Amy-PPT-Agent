/**
 * 生成工作流事件总线：把 deck-flow 的各阶段变成可插拔的扩展点。
 * 视觉审阅、资产完整性校验、前置规格拦截等关注点从主流程解耦为事件监听器。
 *
 * 事件域：
 *   generate:before-planning  → 可修改规划输入
 *   generate:after-planning   → 可修改规划结果
 *   generate:after-design     → 可修改设计契约
 *   page:before-generate      → 可修改页面 prompt（拦截/注入上下文）
 *   page:after-generate       → 可校验/修改页面 HTML
 *   deck:before-finalize      → 可修改最终交付物
 *   deck:asset-integrity      → 资产完整性检查
 *   deck:visual-review        → 渲染级视觉审阅
 */

import type { OutlineItem, DesignContract } from '@shared/generation'

// ── 事件载荷类型 ─────────────────────────────────────────────

export interface GenerationLifecycleEvents {
  'generate:before-planning': {
    sessionId: string
    runId: string
    topic: string
    userMessage: string
    totalPages: number
  }

  'generate:after-planning': {
    sessionId: string
    runId: string
    outline: OutlineItem[]
    totalPages: number
    usedSourcePlan: boolean
  }

  'generate:after-design': {
    sessionId: string
    runId: string
    designContract: DesignContract
  }

  'page:before-generate': {
    sessionId: string
    runId: string
    pageId: string
    pageNumber: number
    title: string
    contentOutline: string
    layoutId?: string
    /** 监听器可注入的额外提示词片段。 */
    injectedContext: string[]
  }

  'page:after-generate': {
    sessionId: string
    runId: string
    pageId: string
    pageNumber: number
    title: string
    htmlPath: string
    /** 监听器可修改的校验结果。 */
    warnings: string[]
  }

  'deck:before-finalize': {
    sessionId: string
    runId: string
    totalPages: number
    completedPages: number
    failedPages: number
  }

  'deck:asset-integrity': {
    sessionId: string
    runId: string
    violations: Array<{
      pageId: string
      pageNumber: number
      assetPath: string
      kind: 'missing' | 'external'
    }>
    totalReferences: number
  }

  'deck:visual-review': {
    sessionId: string
    runId: string
    /** 监听器填充的审阅发现。 */
    findings: Array<{
      pageId: string
      pageNumber: number
      severity: 'info' | 'warn' | 'error'
      message: string
    }>
  }
}

export type GenerationEventName = keyof GenerationLifecycleEvents

export type GenerationEventListener<K extends GenerationEventName> = (
  event: GenerationLifecycleEvents[K]
) => void | Promise<void>

// ── 总线实现 ─────────────────────────────────────────────────

type ListenerEntry = {
  name: GenerationEventName
  listener: (event: unknown) => void | Promise<void>
  pluginName: string
}

class GenerationEventBus {
  private listeners = new Map<GenerationEventName, ListenerEntry[]>()
  private pluginNames = new Set<string>()

  /** 注册监听器；返回取消注册函数。 */
  on<K extends GenerationEventName>(
    name: K,
    listener: GenerationEventListener<K>,
    pluginName = 'anonymous'
  ): () => void {
    const entry: ListenerEntry = {
      name,
      listener: listener as (event: unknown) => void | Promise<void>,
      pluginName
    }
    const existing = this.listeners.get(name) || []
    existing.push(entry)
    this.listeners.set(name, existing)
    this.pluginNames.add(pluginName)

    return () => {
      const current = this.listeners.get(name) || []
      const filtered = current.filter((e) => e !== entry)
      this.listeners.set(name, filtered)
    }
  }

  /** 发射事件（等待所有监听器完成）。 */
  async emit<K extends GenerationEventName>(
    name: K,
    event: GenerationLifecycleEvents[K]
  ): Promise<void> {
    const entries = this.listeners.get(name)
    if (!entries || entries.length === 0) return

    for (const entry of entries) {
      try {
        await entry.listener(event)
      } catch (error) {
        // 监听器失败不阻塞主流程
        console.warn(`[generation-events] listener failed for ${name}`, {
          plugin: entry.pluginName,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /** 列出已注册的插件名。 */
  listPlugins(): string[] {
    return Array.from(this.pluginNames)
  }

  /** 列出某事件已注册的监听器数。 */
  listenerCount(name: GenerationEventName): number {
    return (this.listeners.get(name) || []).length
  }
}

// 单例总线（进程级共享）
export const generationBus = new GenerationEventBus()
