import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import log from 'electron-log/main.js'
import { isOpenAIResponsesProvider, normalizeOpenAIBaseUrl, resolveOpenAIThinkingModelKwargs } from './options'
import {
  getCurrentModelTemperatureControl,
  isCurrentModelTemperatureEnabled,
  resolveCurrentModelThinkingParameterMode,
  resolveCurrentModelTemperatureOptions
} from './runtime'
import { ModelUsageCallbackHandler } from './usage'
import type { ModelRuntimeConfig } from './usage'
// Provider 注册表：import 即注册全部内置 Provider
import '../registry/providers'
import { getModelProvider } from '../registry/provider-registry'

export function resolveModel(
  provider: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
  temperature?: number,
  maxTokens?: number,
  runtime?: Pick<ModelRuntimeConfig, 'recorder' | 'sessionId'>
): BaseLanguageModel {
  const resolvedModel = model.trim()
  if (!resolvedModel) {
    throw new Error('model 不能为空，请先在系统设置中配置模型。')
  }

  const providerDef = getModelProvider(provider)
  if (!providerDef) {
    throw new Error(`Unknown provider: ${provider}`)
  }

  const temperatureOptions = resolveCurrentModelTemperatureOptions(temperature)
  const temperatureControl = getCurrentModelTemperatureControl()
  const thinkingParameterMode = resolveCurrentModelThinkingParameterMode()
  const resolvedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const resolvedMaxTokens = maxTokens && maxTokens > 0 ? maxTokens : 4096
  const useOpenAIResponsesApi = isOpenAIResponsesProvider(provider)
  const openAIProtocol =
    provider === 'openai' || provider === 'zhipu' || provider === 'deepseek' || provider === 'kimi'
      ? 'chat-completions'
      : useOpenAIResponsesApi
        ? 'responses'
        : undefined
  const openAIThinkingModelKwargs =
    provider === 'openai' || provider === 'openai-responses'
      ? resolveOpenAIThinkingModelKwargs({
          baseUrl: normalizeOpenAIBaseUrl(resolvedBaseUrl, useOpenAIResponsesApi),
          model: resolvedModel,
          useResponsesApi: useOpenAIResponsesApi,
          thinkingParameterMode
        })
      : {}
  const usageCallback = new ModelUsageCallbackHandler({
    provider,
    model: resolvedModel,
    modelConfigId: temperatureControl?.modelConfigId,
    sessionId: runtime?.sessionId
  }, runtime?.recorder ?? null)

  log.info('[llm] resolveModel', {
    provider,
    model: resolvedModel,
    baseUrl: resolvedBaseUrl,
    temperature: temperatureOptions.temperature ?? null,
    temperatureEnabled: isCurrentModelTemperatureEnabled(),
    temperatureControlBound: temperatureControl !== undefined,
    modelConfigId: temperatureControl?.modelConfigId ?? null,
    thinkingParameterMode,
    maxTokens: resolvedMaxTokens,
    openAIProtocol,
    openAICompatibility: 'thinking' in openAIThinkingModelKwargs ? ['thinking.type=disabled'] : []
  })

  return providerDef.createModel({
    apiKey,
    model: resolvedModel,
    baseUrl: resolvedBaseUrl,
    temperature,
    maxTokens: resolvedMaxTokens,
    usageCallback,
    temperatureOptions,
    thinkingParameterMode
  })
}
