import {
  DEFAULT_THINKING_PARAMETER_MODE,
  normalizeThinkingParameterMode,
  type ThinkingParameterMode
} from '@shared/model-config'

export interface OpenAIModelOptionsInput {
  model: string
  apiKey: string
  baseUrl: string
  temperatureOptions: { temperature?: number }
  maxTokens: number
  useResponsesApi?: boolean
  thinkingParameterMode?: ThinkingParameterMode
}

// GLM-5.x 起官方不再支持关闭思考：thinking.type=disabled 属于未定义行为，
// coding 端点上实测会随机返回「只有思考、无正文、无 tool_calls」的空回合，
// 直接表现为页面生成的「页面未写入」。对这类模型一律不发 thinking 参数。
const ALWAYS_THINKING_MODEL_RE = /^glm[-_]?([5-9]|[1-9]\d)/i

export const shouldDisableOpenAICompatibleThinking = (baseUrl: string, model?: string): boolean => {
  if (ALWAYS_THINKING_MODEL_RE.test((model || '').trim())) return false

  const resolvedBaseUrl = baseUrl.trim()
  if (!resolvedBaseUrl) return false

  try {
    const hostname = new URL(resolvedBaseUrl).hostname.toLowerCase().replace(/\.$/, '')
    return hostname !== 'api.openai.com'
  } catch {
    return true
  }
}

export const normalizeOpenAIBaseUrl = (baseUrl: string, useResponsesApi = false): string => {
  const resolvedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  if (!useResponsesApi) return resolvedBaseUrl
  return resolvedBaseUrl.replace(/\/responses$/i, '')
}

export const resolveOpenAIThinkingModelKwargs = ({
  baseUrl,
  model,
  useResponsesApi = false,
  thinkingParameterMode = DEFAULT_THINKING_PARAMETER_MODE
}: {
  baseUrl: string
  model?: string
  useResponsesApi?: boolean
  thinkingParameterMode?: ThinkingParameterMode
}): Record<string, unknown> => {
  if (useResponsesApi) return {}

  const mode = normalizeThinkingParameterMode(thinkingParameterMode)
  if (mode === 'omit') return {}

  return shouldDisableOpenAICompatibleThinking(baseUrl, model)
    ? { thinking: { type: 'disabled' } }
    : {}
}

export const buildOpenAIModelOptions = ({
  model,
  apiKey,
  baseUrl,
  temperatureOptions,
  maxTokens,
  useResponsesApi = false,
  thinkingParameterMode = DEFAULT_THINKING_PARAMETER_MODE
}: OpenAIModelOptionsInput) => {
  const resolvedBaseUrl = normalizeOpenAIBaseUrl(baseUrl, useResponsesApi)
  const modelKwargs = resolveOpenAIThinkingModelKwargs({
    baseUrl: resolvedBaseUrl,
    model,
    useResponsesApi,
    thinkingParameterMode
  })

  return {
    model,
    apiKey,
    ...temperatureOptions,
    maxTokens,
    configuration: resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : undefined,
    modelKwargs
  }
}

export const isOpenAIResponsesProvider = (provider: string): boolean => {
  return provider === 'openai-responses'
}
