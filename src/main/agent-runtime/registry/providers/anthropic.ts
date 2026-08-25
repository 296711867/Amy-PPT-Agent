import { ChatAnthropic } from '@langchain/anthropic'
import type { ModelProviderDefinition } from '../provider-registry'

export const anthropicProvider: ModelProviderDefinition = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  createModel(args) {
    return new ChatAnthropic({
      model: args.model,
      apiKey: args.apiKey,
      ...args.temperatureOptions,
      maxTokens: args.maxTokens,
      anthropicApiUrl: args.baseUrl || undefined,
      callbacks: [args.usageCallback]
    })
  },
  docsUrl: 'https://console.anthropic.com'
}
