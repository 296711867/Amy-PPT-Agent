import { CompatibleChatOpenAIResponses } from '../../model/responses-compat'
import { buildOpenAIModelOptions } from '../../model/options'
import type { ModelProviderDefinition } from '../provider-registry'

export const openaiResponsesProvider: ModelProviderDefinition = {
  id: 'openai-responses',
  label: 'OpenAI Responses',
  createModel(args) {
    return new CompatibleChatOpenAIResponses({
      ...buildOpenAIModelOptions({
        model: args.model,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        temperatureOptions: args.temperatureOptions,
        maxTokens: args.maxTokens,
        useResponsesApi: true,
        thinkingParameterMode: args.thinkingParameterMode as never
      }),
      callbacks: [args.usageCallback]
    })
  },
  docsUrl: 'https://platform.openai.com',
  supportsThinkingParameter: true
}
