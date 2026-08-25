/**
 * 模型 Provider 注册表（DeepSeek Harness 插件化模式的轻量实现）。
 *
 * 每个 Provider 是一个自注册模块：定义接口 + 工厂函数 + UI 元数据。
 * 新增 Provider = 新建一个文件导出 ModelProviderDefinition，
 * 在 providers/index.ts 中导入并注册——不修改任何现有文件。
 */

import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import type { ModelUsageCallbackHandler } from '../model/usage'

export interface ProviderModelArgs {
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens: number
  usageCallback: ModelUsageCallbackHandler
  temperatureOptions: { temperature?: number }
  thinkingParameterMode: string
}

export interface ModelProviderDefinition {
  /** Provider ID（与数据库存储一致）。 */
  id: string
  /** UI 显示名。 */
  label: string
  /** 工厂：创建 LangChain 模型实例。 */
  createModel(args: ProviderModelArgs): BaseLanguageModel
  /** 设置页自动填充的官方地址。 */
  defaultBaseUrl?: string
  /** 设置页自动填充的推荐模型名。 */
  defaultModel?: string
  /** 设置页 baseUrl 提示的 i18n key（可选，无则用通用提示）。 */
  baseUrlHintKey?: string
  /** 是否支持 thinking 参数选择器。 */
  supportsThinkingParameter?: boolean
  /** 设置页官方文档链接。 */
  docsUrl?: string
}

const registry = new Map<string, ModelProviderDefinition>()

export function registerModelProvider(provider: ModelProviderDefinition): void {
  if (registry.has(provider.id)) {
    throw new Error(`Model provider already registered: ${provider.id}`)
  }
  registry.set(provider.id, provider)
}

export function getModelProvider(id: string): ModelProviderDefinition | undefined {
  return registry.get(id)
}

export function listModelProviders(): ModelProviderDefinition[] {
  return Array.from(registry.values())
}

export function listModelProviderIds(): string[] {
  return Array.from(registry.keys())
}

export function isRegisteredModelProvider(id: string): boolean {
  return registry.has(id)
}
