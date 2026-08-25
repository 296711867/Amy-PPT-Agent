import { ChatOpenAICompletions } from '@langchain/openai'
import { buildOpenAIModelOptions } from '../../model/options'
import type { ModelProviderDefinition } from '../provider-registry'

// Kimi（Moonshot）OpenAI 兼容端点 https://api.kimi.com/coding/v1
export const kimiProvider: ModelProviderDefinition = {
  id: 'kimi',
  label: 'Kimi (Moonshot)',
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
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  defaultModel: 'kimi-for-coding',
  baseUrlHintKey: 'settings.baseUrlHintKimi',
  supportsThinkingParameter: true
}
