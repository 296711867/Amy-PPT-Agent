import type { ModelProviderDefinition } from '../provider-registry'

export const googleProvider: ModelProviderDefinition = {
  id: 'google',
  label: 'Google Gemini',
  createModel(args) {
    // 动态导入避免非 Google 用户加载此依赖
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai')
    return new ChatGoogleGenerativeAI({
      model: args.model,
      apiKey: args.apiKey,
      ...args.temperatureOptions,
      maxOutputTokens: args.maxTokens,
      baseUrl: args.baseUrl || undefined,
      callbacks: [args.usageCallback]
    })
  },
  docsUrl: 'https://ai.google.dev'
}
