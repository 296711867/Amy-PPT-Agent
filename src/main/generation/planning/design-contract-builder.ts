import log from 'electron-log/main.js'
import {
  assertModelText,
  resolveModel,
  runWithModelTemperatureControl,
  type ModelRuntimeConfig
} from '../../agent-runtime/model'
import {
  buildDesignContractSystemPrompt,
  buildDesignContractUserPrompt
} from '../../agent-runtime/prompt'
import type { DesignContract, FontSelection, GenerateChunkEvent } from '@shared/generation'
import type { SlideSizePreset } from '@shared/slide-size'
import { resolveModelTimeoutMs } from '@shared/model-timeout'
import { progressText } from '@shared/progress'
import type { GenerationModelControl } from '../context'
import {
  assertFontFamilyAvailable,
  buildAvailableFontsForPrompt,
  type AvailableFont
} from '../../presentation/fonts/font-registry'
import { normalizeDesignContract, parseModelJson } from './model-response'

type AppLocale = 'zh' | 'en'

const uiText = (locale: AppLocale | undefined, zh: string, en: string): string =>
  locale === 'en' ? en : zh

const withModelControl = <T>(
  modelControl: GenerationModelControl | undefined,
  task: () => T
): T => (modelControl ? runWithModelTemperatureControl(modelControl, task) : task())

const modelCallSignal = (timeoutMs: unknown, upstreamSignal?: AbortSignal): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs(timeoutMs, 'design'))
  return upstreamSignal ? AbortSignal.any([timeoutSignal, upstreamSignal]) : timeoutSignal
}

const buildDesignContractRetryUserPrompt = (userPrompt: string, previousError: string): string =>
  [
    userPrompt,
    '',
    'Design contract retry requirement:',
    `- The previous design contract response failed validation: ${previousError}`,
    '- Retry now and return only a raw JSON object. Do not wrap it in Markdown. Do not add explanations.',
    '- Use exactly these fields: theme, background, palette, titleStyle, layoutMotif, chartStyle, shapeLanguage, titleFont, bodyFont.',
    '- palette must be an array with 3-6 color strings.',
    '- titleFont and bodyFont must be exact family values from availableFonts in the original system prompt.',
    '- titleStyle must follow explicit typography targets in the original style specification when supplied. Otherwise use text-4xl or text-5xl. Do not exceed 88px unless the user explicitly requested oversized typography.'
  ].join('\n')

const detectFontLanguageHint = (text: string): string => {
  if (/[\u3400-\u9fff]/.test(text)) return 'cjk'
  return 'latin'
}

const resolveFontPair = (
  value: FontSelection | undefined
): { titleFont: string; subtitleFont: string; bodyFont: string } | null => {
  if (!value || value.mode !== 'pair') return null
  const titleFont = String(value.title?.family || '').trim()
  const bodyFont = String(value.body?.family || '').trim()
  const subtitleFont = String(value.subtitle?.family || bodyFont).trim()
  return titleFont && subtitleFont && bodyFont ? { titleFont, subtitleFont, bodyFont } : null
}

export const buildDesignContractWithLLM = async (args: {
  provider: string
  apiKey: string
  model: string
  baseUrl: string
  temperature?: number
  maxTokens?: number
  modelRuntime?: ModelRuntimeConfig
  modelControl?: GenerationModelControl
  styleId: string | null | undefined
  styleSkillPrompt: string
  layoutRulesPrompt?: string
  styleKey?: string
  styleName?: string
  styleVersion?: string
  appLocale?: AppLocale
  modelTimeoutMs?: number
  totalPages: number
  slideSize: SlideSizePreset
  topic?: string
  userMessage?: string
  fontSelection?: FontSelection
  emit?: (chunk: GenerateChunkEvent) => void
  runId?: string
  signal?: AbortSignal
}): Promise<DesignContract> => {
  const client = withModelControl(args.modelControl, () =>
    resolveModel(
      args.provider,
      args.apiKey,
      args.model,
      args.baseUrl,
      args.temperature,
      args.maxTokens,
      args.modelRuntime
    )
  )
  const totalPages = Math.max(1, args.totalPages)
  const availableFonts: AvailableFont[] = await buildAvailableFontsForPrompt()
  const requestedFontPair = resolveFontPair(args.fontSelection)
  if (requestedFontPair) {
    await assertFontFamilyAvailable(requestedFontPair.titleFont, 'titleFont')
    await assertFontFamilyAvailable(requestedFontPair.subtitleFont, 'subtitleFont')
    await assertFontFamilyAvailable(requestedFontPair.bodyFont, 'bodyFont')
  }
  const languageHint = detectFontLanguageHint(
    [args.topic || '', args.userMessage || '', args.styleSkillPrompt || ''].join('\n')
  )
  const systemPrompt = buildDesignContractSystemPrompt({
    styleSkill: [args.styleSkillPrompt, args.layoutRulesPrompt].filter(Boolean).join('\n\n'),
    availableFonts,
    requestedFontPair,
    languageHint,
    slideSize: args.slideSize
  })
  const userPrompt = buildDesignContractUserPrompt()
  const parseDesignContract = async (responseText: string): Promise<DesignContract> => {
    const parsed = parseModelJson(responseText, args.appLocale)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM design_contract 返回格式不正确，期望 JSON object。',
          'LLM design_contract returned an invalid format; expected a JSON object.'
        )
      )
    }
    const record = parsed as Record<string, unknown>
    const requiredKeys = [
      'theme',
      'background',
      'palette',
      'titleStyle',
      'layoutMotif',
      'chartStyle',
      'shapeLanguage',
      'titleFont',
      'bodyFont'
    ]
    const missingKeys = requiredKeys.filter(
      (key) => record[key] === undefined || record[key] === ''
    )
    if (missingKeys.length > 0) {
      throw new Error(
        uiText(
          args.appLocale,
          `LLM design_contract 缺少字段：${missingKeys.join(', ')}`,
          `LLM design_contract is missing fields: ${missingKeys.join(', ')}`
        )
      )
    }
    if (!Array.isArray(record.palette) || record.palette.length < 3) {
      throw new Error(
        uiText(
          args.appLocale,
          'LLM design_contract palette 至少需要 3 个颜色。',
          'LLM design_contract palette must contain at least 3 colors.'
        )
      )
    }
    const contract = normalizeDesignContract(parsed)
    if (requestedFontPair) {
      if (
        contract.titleFont !== requestedFontPair.titleFont ||
        contract.subtitleFont !== requestedFontPair.subtitleFont ||
        contract.bodyFont !== requestedFontPair.bodyFont
      ) {
        throw new Error(
          uiText(
            args.appLocale,
            `LLM design_contract 字体与用户选择不一致：titleFont=${contract.titleFont}, bodyFont=${contract.bodyFont}`,
            `LLM design_contract fonts do not match the user selection: titleFont=${contract.titleFont}, bodyFont=${contract.bodyFont}`
          )
        )
      }
    }
    await assertFontFamilyAvailable(contract.titleFont, 'titleFont')
    await assertFontFamilyAvailable(contract.bodyFont, 'bodyFont')
    return contract
  }
  args.emit?.({
    type: 'llm_status',
    payload: {
      runId: args.runId || '',
      stage: 'planning',
      label: progressText(args.appLocale, 'planning'),
      progress: 9,
      totalPages,
      provider: args.provider,
      model: args.model,
      detail: uiText(args.appLocale, '正在生成独立设计契约', 'Generating design contract')
    }
  })
  const maxAttempts = 2
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 9,
          totalPages,
          provider: args.provider,
          model: args.model,
          detail: uiText(
            args.appLocale,
            '设计契约格式异常，正在自动重试一次',
            'The design contract format was invalid; retrying once'
          )
        }
      })
    }
    const previousError =
      lastError instanceof Error ? lastError.message : lastError ? String(lastError) : ''
    const effectiveUserPrompt =
      attempt === 1 ? userPrompt : buildDesignContractRetryUserPrompt(userPrompt, previousError)
    try {
      const combinedSignal = modelCallSignal(args.modelTimeoutMs, args.signal)
      const response = await client.invoke(
        [
          {
            role: 'system' as const,
            content: systemPrompt
          },
          {
            role: 'user' as const,
            content: effectiveUserPrompt
          }
        ],
        { signal: combinedSignal }
      )
      const responseText = assertModelText(response, {
        maxTokens: args.maxTokens,
        locale: args.appLocale
      })
      log.info('[llm] design_contract response', {
        attempt,
        textLength: responseText.length,
        preview: JSON.stringify(
          responseText.length > 240 ? `${responseText.slice(0, 240)}…` : responseText
        )
      })
      const contract = await parseDesignContract(responseText)
      args.emit?.({
        type: 'llm_status',
        payload: {
          runId: args.runId || '',
          stage: 'planning',
          label: progressText(args.appLocale, 'planning'),
          progress: 10,
          totalPages,
          provider: args.provider,
          model: args.model,
          detail: contract.theme
        }
      })
      return contract
    } catch (error) {
      if (args.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      lastError = error
      if (attempt < maxAttempts) {
        log.warn('[llm] design_contract retry scheduled', {
          provider: args.provider,
          model: args.model,
          attempt,
          maxAttempts,
          message: error instanceof Error ? error.message : String(error)
        })
        continue
      }
    }
  }
  log.warn('[llm] design_contract failed', {
    provider: args.provider,
    model: args.model,
    temperature: args.temperature ?? null,
    styleId: args.styleId || '',
    message: lastError instanceof Error ? lastError.message : String(lastError)
  })
  throw new Error(
    uiText(
      args.appLocale,
      `设计契约生成失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      `Failed to generate design contract: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    )
  )
}

