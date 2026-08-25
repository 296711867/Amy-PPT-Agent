import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { resolveModel } from '../agent-runtime/model'
import { applyProxy } from '../utils/proxy'
import type { IpcContext } from '../ipc/context'
import { applyWindowUiTheme } from '../app/window'
import { normalizeUiThemeId } from '@shared/ui-theme'
import {
  CONFIGURABLE_MODEL_TIMEOUT_PROFILES,
  type ConfigurableModelTimeoutProfile,
  resolveModelTimeoutMs
} from '@shared/model-timeout'
import { readAppLocale, uiText } from './locale-utils'
import {
  OPENAI_RESPONSES_FORMAT_ERROR_EN,
  OPENAI_RESPONSES_FORMAT_ERROR_ZH,
  isOpenAIResponsesFormatError,
  runWithModelTemperatureControl
} from '../agent-runtime/model'
import type { ModelUsagePeriod } from '@shared/model-usage'
import { normalizeThinkingParameterMode } from '@shared/model-config'
import { LAYOUT_RULES_SETTING_KEY, normalizeLayoutRules } from '@shared/layout-rules'
import {
  normalizePageConcurrencyPreference,
  PAGE_CONCURRENCY_SETTING_KEY
} from '@shared/page-concurrency'
import { buildTextCredentialScope, redactSensitiveText } from './credential-redaction'

const readGlobalTimeouts = (
  settings: Record<string, unknown>
): Record<ConfigurableModelTimeoutProfile, number> =>
  Object.fromEntries(
    CONFIGURABLE_MODEL_TIMEOUT_PROFILES.map((profile) => [
      profile,
      resolveModelTimeoutMs(settings[`timeout_ms_${profile}`], profile)
    ])
  ) as Record<ConfigurableModelTimeoutProfile, number>

// Provider 注册表驱动：从注册表枚举，不再硬编码列表
import { listModelProviderIds } from '../agent-runtime/registry/provider-registry'
import '../agent-runtime/registry/providers' // import 副作用：注册全部 Provider

const VALID_PROVIDERS = listModelProviderIds() as unknown as readonly string[]
type Provider = (typeof VALID_PROVIDERS)[number]
const normalizeProvider = (provider: unknown): Provider =>
  VALID_PROVIDERS.includes(provider as Provider) ? (provider as Provider) : 'openai'
const normalizeMaxTokens = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 4096
  // 上限放大到 64K：思考模型（GLM-5.x 等）的推理与页面 HTML 共享输出预算，
  // 16K 会把整页截断成废稿并触发昂贵的整页重试。
  return Math.max(256, Math.min(65536, Math.floor(value)))
}

const isMandatoryThinkingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : ''
  return [
    /始终思考/i,
    /不支持(?:关闭|禁用)(?:思考|推理)/i,
    /(?:思考|推理).*(?:不能|无法).*(?:关闭|禁用)/i,
    /(?:always[- ]on|mandatory)\s+(?:thinking|reasoning)/i,
    /(?:thinking|reasoning).*(?:cannot|can't|does not support|unsupported).*(?:disable|disabled|off)/i,
    /(?:cannot|can't|does not support|unsupported).*(?:disable|disabled|turn(?:ing)? off).*(?:thinking|reasoning)/i
  ].some((pattern) => pattern.test(message))
}

const normalizeVerifyErrorMessage = (
  error: unknown,
  options: {
    locale: 'zh' | 'en'
    provider: unknown
  }
): string | null => {
  const message = error instanceof Error ? error.message : ''
  const unsupportedThinkingPattern = [
    /(?:unsupported|unknown|unrecognized|invalid|unexpected).*(?:argument|parameter|field).*thinking/i,
    /thinking.*(?:unsupported|unknown|unrecognized|invalid)/i
  ]
  const isThinkingParameterError =
    unsupportedThinkingPattern.some((pattern) => pattern.test(message)) ||
    (/(?:argument|parameter|field)/i.test(message) && /thinking/i.test(message))
  if (options.provider === 'openai-responses' && isOpenAIResponsesFormatError(error)) {
    return uiText(
      options.locale,
      OPENAI_RESPONSES_FORMAT_ERROR_ZH,
      OPENAI_RESPONSES_FORMAT_ERROR_EN
    )
  }
  if (options.provider === 'openai' && isThinkingParameterError) {
    return uiText(
      options.locale,
      '当前模型不支持 thinking 参数，请在模型设置中改为“不发送 thinking 参数”。',
      'This model does not support the thinking parameter. In model settings, choose "Do not send thinking".'
    )
  }
  if (options.provider === 'zhipu' && isThinkingParameterError) {
    return uiText(
      options.locale,
      '智谱 GLM 接口不支持 thinking 参数，请在模型设置中改为“不发送 thinking 参数”。',
      'Zhipu GLM does not support the thinking parameter. In model settings, choose "Do not send thinking".'
    )
  }
  return message || null
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { mainWindow, db, encryptApiKey, decryptApiKey } = ctx

  const resolveStoredApiKey = (
    rawValue: unknown
  ): { value: string; unavailable: boolean } => {
    const rawApiKey = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!rawApiKey) return { value: '', unavailable: false }
    try {
      const decrypted = decryptApiKey(rawApiKey)
      const value = typeof decrypted === 'string' ? decrypted.trim() : ''
      return { value, unavailable: value.length === 0 }
    } catch {
      return { value: '', unavailable: true }
    }
  }

  const storedApiKeyReentryMessage = (locale: 'zh' | 'en'): string =>
    uiText(
      locale,
      '已保存的 api_key 无法解密，请重新填写 api_key 后再保存。',
      'The saved api_key could not be decrypted. Enter api_key again and save.'
    )

  ipcMain.handle('app:getVersion', async () => {
    return { version: app.getVersion() }
  })

  ipcMain.handle('settings:get', async () => {
    log.info('[settings:get] requested')
    const settings = await db.getAllSettings()
    const storagePath =
      typeof settings.storage_path === 'string' && settings.storage_path.trim().length > 0
        ? settings.storage_path.trim()
        : ''
    const proxyUrl =
      typeof settings.proxy_url === 'string' && settings.proxy_url.trim().length > 0
        ? settings.proxy_url.trim()
        : ''
    return {
      theme: normalizeUiThemeId(settings.theme),
      locale: settings.locale === 'en' ? 'en' : 'zh',
      storagePath,
      timeouts: readGlobalTimeouts(settings),
      proxyUrl,
      pageConcurrency: normalizePageConcurrencyPreference(
        settings[PAGE_CONCURRENCY_SETTING_KEY]
      ),
      layoutRules: normalizeLayoutRules(settings[LAYOUT_RULES_SETTING_KEY])
    }
  })

  ipcMain.handle('settings:listModelConfigs', async () => {
    return (await db.listModelConfigs()).map((config) => {
      const storedApiKey = resolveStoredApiKey(config.apiKey)
      return {
        id: config.id,
        name: config.name,
        provider: config.provider,
        model: config.model,
        // API keys stay in the main process. Editing an existing config with an empty field
        // tells the upsert handler to retain the encrypted value already stored for this id.
        apiKey: '',
        hasApiKey: storedApiKey.value.length > 0,
        baseUrl: config.baseUrl,
        maxTokens: config.maxTokens || 4096,
        disableTemperature: config.disableTemperature === 1,
        thinkingParameterMode: normalizeThinkingParameterMode(config.thinkingParameterMode),
        active: config.active === 1,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt
      }
    })
  })

  ipcMain.handle('settings:getModelUsage', async (_event, requestedPeriod) => {
    const period: ModelUsagePeriod =
      requestedPeriod === 'today' ||
      requestedPeriod === '7d' ||
      requestedPeriod === '30d' ||
      requestedPeriod === 'all'
        ? requestedPeriod
        : '30d'
    return db.getModelUsageStats(period)
  })

  ipcMain.handle('settings:validateUploadPrerequisites', async () => {
    const locale = await readAppLocale(ctx)
    const settings = await db.getAllSettings()
    const storagePath =
      typeof settings.storage_path === 'string' && settings.storage_path.trim().length > 0
        ? settings.storage_path.trim()
        : ''
    const activeModel = (await db.listModelConfigs()).find((config) => config.active === 1)
    const hasModel = !!activeModel
    const hasApiKey =
      typeof activeModel?.apiKey === 'string' && decryptApiKey(activeModel.apiKey).trim().length > 0
    const hasModelName =
      typeof activeModel?.model === 'string' && activeModel.model.trim().length > 0

    const missing: Array<'storagePath' | 'activeModel' | 'apiKey' | 'model'> = []
    if (!storagePath) missing.push('storagePath')
    if (!hasModel) missing.push('activeModel')
    if (hasModel && !hasApiKey) missing.push('apiKey')
    if (hasModel && !hasModelName) missing.push('model')

    return {
      ready: missing.length === 0,
      missing,
      message:
        missing.length === 0
          ? ''
          : uiText(
              locale,
              '请先前往系统设置完成模型与存储目录配置。',
              'Please complete model and storage configuration in Settings first.'
            )
    }
  })

  ipcMain.handle('settings:save', async (_event, settings) => {
    log.info('[settings:save] received', {
      hasStoragePath:
        typeof settings?.storagePath === 'string' && settings.storagePath.trim().length > 0
    })
    if (settings.theme !== undefined) {
      const theme = normalizeUiThemeId(settings.theme)
      await db.setSetting('theme', theme)
      applyWindowUiTheme(mainWindow, theme)
    }
    if (settings.locale === 'zh' || settings.locale === 'en')
      await db.setSetting('locale', settings.locale)
    if (typeof settings.storagePath === 'string' && settings.storagePath.trim().length > 0) {
      await db.setStoragePath(settings.storagePath)
    }
    if (settings.timeouts && typeof settings.timeouts === 'object') {
      const timeouts = settings.timeouts as Partial<
        Record<ConfigurableModelTimeoutProfile, unknown>
      >
      for (const profile of CONFIGURABLE_MODEL_TIMEOUT_PROFILES) {
        const value = timeouts[profile]
        if (value !== undefined) {
          await db.setSetting(`timeout_ms_${profile}`, resolveModelTimeoutMs(value, profile))
        }
      }
    }
    if ('proxyUrl' in settings) {
      const nextProxy = typeof settings.proxyUrl === 'string' ? settings.proxyUrl.trim() : ''
      try {
        applyProxy(nextProxy || undefined)
      } catch (proxyError) {
        log.error('[settings:save] failed to apply proxy', {
          proxyUrl: redactSensitiveText(nextProxy),
          message: redactSensitiveText(proxyError)
        })
        throw new Error(
          uiText(
            await readAppLocale(ctx),
            `代理设置无效：${proxyError instanceof Error ? proxyError.message : '请检查地址格式'}`,
            `Invalid proxy: ${proxyError instanceof Error ? proxyError.message : 'check the address format'}`
          )
        )
      }
      await db.setSetting('proxy_url', nextProxy)
    }
    if (settings.pageConcurrency !== undefined) {
      await db.setSetting(
        PAGE_CONCURRENCY_SETTING_KEY,
        normalizePageConcurrencyPreference(settings.pageConcurrency)
      )
    }
    if (settings.layoutRules !== undefined) {
      await db.setSetting(LAYOUT_RULES_SETTING_KEY, normalizeLayoutRules(settings.layoutRules))
    }
    return { success: true }
  })

  ipcMain.handle('settings:upsertModelConfig', async (_event, payload) => {
    const locale = await readAppLocale(ctx)
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const provider = normalizeProvider(record.provider)
    const model = typeof record.model === 'string' ? record.model.trim() : ''
    const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
    const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
    const id =
      typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : undefined
    if (!name) throw new Error(uiText(locale, '请填写模型名称。', 'Enter model name.'))
    if (!model) throw new Error(uiText(locale, '请填写 model。', 'Enter model.'))
    let encryptedApiKey = ''
    let storedApiKeyUnavailable = false
    if (apiKey) {
      encryptedApiKey = encryptApiKey(apiKey)
    } else if (id) {
      const existing = (await db.listModelConfigs()).find((config) => config.id === id)
      if (
        existing?.apiKey &&
        buildTextCredentialScope(existing.provider, existing.baseUrl) ===
          buildTextCredentialScope(record.provider, baseUrl)
      ) {
        const storedApiKey = resolveStoredApiKey(existing.apiKey)
        if (storedApiKey.value) encryptedApiKey = existing.apiKey
        storedApiKeyUnavailable = storedApiKey.unavailable
      }
    }
    if (!encryptedApiKey) {
      throw new Error(
        storedApiKeyUnavailable
          ? storedApiKeyReentryMessage(locale)
          : uiText(locale, '请填写 api_key。', 'Enter api_key.')
      )
    }
    const maxTokens = normalizeMaxTokens(record.maxTokens)
    const thinkingParameterMode = normalizeThinkingParameterMode(record.thinkingParameterMode)
    const savedId = await db.upsertModelConfig({
      id,
      name,
      provider,
      model,
      apiKey: encryptedApiKey,
      baseUrl,
      maxTokens,
      disableTemperature: record.disableTemperature === true,
      thinkingParameterMode,
      active: record.active === true
    })
    return { success: true, id: savedId }
  })

  ipcMain.handle('settings:setActiveModelConfig', async (_event, id) => {
    const locale = await readAppLocale(ctx)
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(uiText(locale, '模型配置 ID 不能为空。', 'Model config ID is required.'))
    }
    const modelId = id.trim()
    try {
      await db.setActiveModelConfig(modelId)
    } catch (error) {
      if (error instanceof Error && error.message === 'Model config does not exist') {
        throw new Error(uiText(locale, '模型配置不存在。', 'Model config does not exist.'))
      }
      throw error
    }
    return { success: true }
  })

  ipcMain.handle('settings:deleteModelConfig', async (_event, id) => {
    const locale = await readAppLocale(ctx)
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(uiText(locale, '模型配置 ID 不能为空。', 'Model config ID is required.'))
    }
    try {
      await db.deleteModelConfig(id.trim())
    } catch (error) {
      if (error instanceof Error && error.message === 'Model config does not exist') {
        throw new Error(uiText(locale, '模型配置不存在。', 'Model config does not exist.'))
      }
      throw error
    }
    return { success: true }
  })

  ipcMain.handle(
    'settings:verifyApiKey',
    async (
      _event,
      {
        id,
        provider,
        apiKey,
        model,
        baseUrl,
        maxTokens,
        disableTemperature,
        thinkingParameterMode,
        timeoutMs
      }
    ) => {
      const locale = await readAppLocale(ctx)
      const resolvedTimeoutMs = resolveModelTimeoutMs(timeoutMs, 'verify')
      const resolvedMaxTokens = normalizeMaxTokens(maxTokens)
      const resolvedThinkingParameterMode = normalizeThinkingParameterMode(thinkingParameterMode)
      const requestedApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''
      const requestedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : ''
      log.info('[settings:verifyApiKey] received', {
        provider,
        model,
        hasApiKey: requestedApiKey.length > 0,
        baseUrl: redactSensitiveText(requestedBaseUrl),
        maxTokens: resolvedMaxTokens,
        thinkingParameterMode: resolvedThinkingParameterMode,
        timeoutMs: resolvedTimeoutMs
      })

      if (typeof model !== 'string' || model.trim().length === 0) {
        return { valid: false, message: uiText(locale, '请先填写 model。', 'Enter model first.') }
      }

      let resolvedApiKey = requestedApiKey
      let storedApiKeyUnavailable = false
      if (!resolvedApiKey && typeof id === 'string' && id.trim().length > 0) {
        const existing = (await db.listModelConfigs()).find((config) => config.id === id.trim())
        const sameScope =
          existing &&
          buildTextCredentialScope(existing.provider, existing.baseUrl) ===
            buildTextCredentialScope(provider, requestedBaseUrl)
        if (!sameScope) {
          return {
            valid: false,
            message: uiText(
              locale,
              'provider 或 base_url 已变化，请重新填写 api_key。',
              'Provider or base_url changed. Enter api_key again.'
            )
          }
        }
        const storedApiKey = resolveStoredApiKey(existing?.apiKey)
        resolvedApiKey = storedApiKey.value
        storedApiKeyUnavailable = storedApiKey.unavailable
      }

      if (!resolvedApiKey) {
        return {
          valid: false,
          message: storedApiKeyUnavailable
            ? storedApiKeyReentryMessage(locale)
            : uiText(locale, '请先填写 api_key。', 'Enter api_key first.')
        }
      }

      const invokeVerification = async (
        verificationThinkingParameterMode: 'auto' | 'omit'
      ): Promise<void> => {
        const client = runWithModelTemperatureControl(
          {
            disableTemperature: disableTemperature === true,
            thinkingParameterMode: verificationThinkingParameterMode
          },
          () =>
            resolveModel(
              provider,
              resolvedApiKey,
              model.trim(),
              requestedBaseUrl,
              undefined,
              resolvedMaxTokens,
              ctx.modelRuntime
            )
        )
        // 流式验证：思考模型对简单问题也可能推理很久，等完整响应会白白触发
        // 超时。收到第一个分片就证明连通与鉴权正常，立即结束。
        const stream = await client.stream('Reply with OK.', {
          signal: AbortSignal.timeout(resolvedTimeoutMs)
        })
        let receivedChunk = false
        try {
          for await (const _chunk of stream) {
            receivedChunk = true
            break
          }
        } catch (error) {
          if (receivedChunk) return
          throw error
        }
      }

      try {
        await invokeVerification(resolvedThinkingParameterMode)
        log.info('[settings:verifyApiKey] success', { provider, model })
        return { valid: true, message: uiText(locale, '连接验证成功。', 'Connection verified.') }
      } catch (error) {
        if (
          resolvedThinkingParameterMode === 'auto' &&
          (provider === 'openai' ||
            provider === 'zhipu' ||
            provider === 'deepseek' ||
            provider === 'kimi') &&
          requestedBaseUrl.length > 0 &&
          isMandatoryThinkingError(error)
        ) {
          try {
            await invokeVerification('omit')
            log.info('[settings:verifyApiKey] success after omitting thinking parameter', {
              provider,
              model
            })
            return {
              valid: true,
              message: uiText(
                locale,
                '连接验证成功。当前表单已切换为不发送 thinking 参数，请点击保存使其生效。',
                'Connection verified. The form now omits the thinking parameter; click Save to apply it.'
              ),
              thinkingParameterMode: 'omit' as const
            }
          } catch (retryError) {
            error = retryError
          }
        }
        const message = redactSensitiveText(
          normalizeVerifyErrorMessage(error, { locale, provider }) ||
            uiText(
              locale,
              '连接验证失败，请检查 api_key、model 或 base_url。',
              'Connection verification failed. Check api_key, model, or base_url.'
            ),
          [resolvedApiKey, requestedBaseUrl]
        )
        log.error('[settings:verifyApiKey] failed', {
          provider,
          model,
          baseUrl: redactSensitiveText(requestedBaseUrl, [resolvedApiKey]),
          message
        })
        return { valid: false, message }
      }
    }
  )

  ipcMain.handle('settings:chooseStoragePath', async (event) => {
    log.info('[settings:chooseStoragePath] received')
    const targetWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? mainWindow

    try {
      const settings = await db.getAllSettings()
      const currentStoragePath =
        typeof settings.storage_path === 'string' && settings.storage_path.trim().length > 0
          ? settings.storage_path.trim()
          : ''
      const result = await dialog.showOpenDialog(targetWindow, {
        title: '选择 Amy-PPT 存储目录',
        buttonLabel: '选择目录',
        ...(currentStoragePath ? { defaultPath: currentStoragePath } : {}),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate']
      })
      if (!result.canceled && result.filePaths.length > 0) {
        return { path: result.filePaths[0] }
      }
      return { path: null }
    } catch (error) {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : '无法打开系统目录选择器。'
      log.error('[settings:chooseStoragePath] failed', { message })
      return { path: null, error: message }
    }
  })
}
