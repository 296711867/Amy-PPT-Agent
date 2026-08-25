import { ChatOpenAICompletions } from '@langchain/openai'
import { buildOpenAIModelOptions } from '../../model/options'
import type { ModelProviderDefinition } from '../provider-registry'

// 智谱 AI（BigModel）提供 OpenAI 兼容的 Chat Completions 接口，复用 OpenAI 链路。
export const zhipuProvider: ModelProviderDefinition = {
  id: 'zhipu',
  label: '智谱 GLM',
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
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
  defaultModel: 'glm-4.6',
  baseUrlHintKey: 'settings.baseUrlHintZhipu',
  supportsThinkingParameter: true
}
