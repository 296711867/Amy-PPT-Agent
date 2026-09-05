import { describe, expect, it } from 'vitest'
import {
  buildOpenAIModelOptions,
  normalizeOpenAIBaseUrl,
  resolveOpenAIThinkingModelKwargs
} from '../../src/main/agent-runtime/model'

describe('buildOpenAIModelOptions', () => {
  it.each(['', 'https://api.openai.com', 'https://api.openai.com/v1', 'https://API.OPENAI.COM/v1/'])(
    'does not inject compatibility thinking parameters for official OpenAI: %s',
    (baseUrl) => {
      const options = buildOpenAIModelOptions({
        model: 'test-model',
        apiKey: 'secret',
        baseUrl,
        temperatureOptions: { temperature: 0.7 },
        maxTokens: 4096
      })

      expect(options).toEqual({
        model: 'test-model',
        apiKey: 'secret',
        temperature: 0.7,
        maxTokens: 4096,
        configuration: baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') } : undefined,
        modelKwargs: {}
      })
    }
  )

  it('keeps thinking disabled for custom OpenAI-compatible endpoints', () => {
    expect(
      buildOpenAIModelOptions({
        model: 'test-model',
        apiKey: 'secret',
        baseUrl: 'https://api.example-compatible.com/v1',
        temperatureOptions: {},
        maxTokens: 2048
      })
    ).toEqual({
      model: 'test-model',
      apiKey: 'secret',
      maxTokens: 2048,
      configuration: { baseURL: 'https://api.example-compatible.com/v1' },
      modelKwargs: { thinking: { type: 'disabled' } }
    })
  })

  it('omits thinking parameters for custom endpoints when configured', () => {
    expect(
      buildOpenAIModelOptions({
        model: 'test-model',
        apiKey: 'secret',
        baseUrl: 'https://api.example-compatible.com/v1',
        temperatureOptions: {},
        maxTokens: 2048,
        thinkingParameterMode: 'omit'
      })
    ).toEqual({
      model: 'test-model',
      apiKey: 'secret',
      maxTokens: 2048,
      configuration: { baseURL: 'https://api.example-compatible.com/v1' },
      modelKwargs: {}
    })
  })

  it('does not inject Chat Completions compatibility kwargs for Responses API models', () => {
    expect(
      buildOpenAIModelOptions({
        model: 'gpt-5.1',
        apiKey: 'secret',
        baseUrl: 'https://api.example-compatible.com/v1',
        temperatureOptions: {},
        maxTokens: 2048,
        useResponsesApi: true
      })
    ).toEqual({
      model: 'gpt-5.1',
      apiKey: 'secret',
      maxTokens: 2048,
      configuration: { baseURL: 'https://api.example-compatible.com/v1' },
      modelKwargs: {}
    })
  })

  it('normalizes accidental /responses suffix only for Responses API models', () => {
    expect(normalizeOpenAIBaseUrl('https://api.example.com/v1/responses', true)).toBe(
      'https://api.example.com/v1'
    )
    expect(normalizeOpenAIBaseUrl('https://api.example.com/v1/responses/', true)).toBe(
      'https://api.example.com/v1'
    )
    expect(normalizeOpenAIBaseUrl('https://api.example.com/v1/responses', false)).toBe(
      'https://api.example.com/v1/responses'
    )
  })

  it('centralizes thinking model kwargs resolution', () => {
    expect(
      resolveOpenAIThinkingModelKwargs({
        baseUrl: 'https://api.example-compatible.com/v1',
        thinkingParameterMode: 'auto'
      })
    ).toEqual({ thinking: { type: 'disabled' } })
    expect(
      resolveOpenAIThinkingModelKwargs({
        baseUrl: 'https://api.example-compatible.com/v1',
        thinkingParameterMode: 'omit'
      })
    ).toEqual({})
  })

  it.each([
    'glm-5.2',
    'GLM-5.2',
    'glm-5.3',
    'GLM-5',
    'glm-6',
    'glm_5_air',
    'glm-10'
  ])(
    'never sends thinking:disabled to always-thinking GLM models on any host: %s',
    (model) => {
      // GLM-5.x 起官方不再支持关闭思考；coding 端点收到 thinking.type=disabled
      // 会随机返回「只有思考、无正文、无 tool_calls」的空回合，直接表现为
      // 页面生成的「页面未写入」。
      expect(
        buildOpenAIModelOptions({
          model,
          apiKey: 'secret',
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          temperatureOptions: {},
          maxTokens: 32768
        }).modelKwargs
      ).toEqual({})
      expect(
        buildOpenAIModelOptions({
          model,
          apiKey: 'secret',
          baseUrl: 'https://proxy.example.com/v1',
          temperatureOptions: {},
          maxTokens: 32768
        }).modelKwargs
      ).toEqual({})
    }
  )

  it.each(['glm-4.6', 'GLM-4.5', 'glm-4-plus'])(
    'keeps thinking:disabled for GLM-4.x models that support it: %s',
    (model) => {
      expect(
        buildOpenAIModelOptions({
          model,
          apiKey: 'secret',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          temperatureOptions: {},
          maxTokens: 8192
        }).modelKwargs
      ).toEqual({ thinking: { type: 'disabled' } })
    }
  )
})
