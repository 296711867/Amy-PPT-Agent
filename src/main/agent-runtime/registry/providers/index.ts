/**
 * Provider 自注册入口：import 此文件即完成所有内置 Provider 的注册。
 * 新增 Provider = 新建一个文件导出 ModelProviderDefinition + 在此导入。
 */
import { registerModelProvider } from '../provider-registry'
import { anthropicProvider } from './anthropic'
import { openaiProvider } from './openai'
import { openaiResponsesProvider } from './openai-responses'
import { googleProvider } from './google'
import { zhipuProvider } from './zhipu'
import { deepseekProvider } from './deepseek'
import { kimiProvider } from './kimi'

for (const provider of [
  anthropicProvider,
  openaiProvider,
  openaiResponsesProvider,
  googleProvider,
  zhipuProvider,
  deepseekProvider,
  kimiProvider
]) {
  registerModelProvider(provider)
}
