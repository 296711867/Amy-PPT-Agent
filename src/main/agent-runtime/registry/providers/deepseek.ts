import { ChatOpenAICompletions } from '@langchain/openai'
import { buildOpenAIModelOptions } from '../../model/options'
import type { ModelProviderDefinition } from '../provider-registry'

// DeepSeek 官方 OpenAI 兼容端点 https://api.deepseek.com
export const deepseekProvider: ModelProviderDefinition = {
  id: 'deepseek',
  label: 'DeepSeek',
  createModel(args) {
    return new ChatOpenAICompletions({
      ...buildOpenAIModelOptions({
        model: args.model,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        temperatureOptions: args.temperatureOptions,
        maxTokens: args.maxTokens,
        thinkingParameterMode: args.thinkingParameterMode as never
      }),
      callbacks: [args.usageCallback]
    })
  },
  defaultBaseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-pro',
  baseUrlHintKey: 'settings.baseUrlHintDeepSeek',
  supportsThinkingParameter: true
}
