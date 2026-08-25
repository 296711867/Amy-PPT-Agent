import { ChatOpenAICompletions } from '@langchain/openai'
import { buildOpenAIModelOptions } from '../../model/options'
import type { ModelProviderDefinition } from '../provider-registry'

export const openaiProvider: ModelProviderDefinition = {
  id: 'openai',
  label: 'OpenAI',
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
  defaultModel: 'gpt-4o',
  docsUrl: 'https://platform.openai.com',
  supportsThinkingParameter: true
}
