import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsHandlersState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  return {
    appMock: {
      getVersion: vi.fn(() => '1.0.0')
    },
    applyProxyMock: vi.fn(),
    applyWindowThemeMock: vi.fn(),
    dialogMock: {
      showOpenDialog: vi.fn()
    },
    handlers,
    ipcMainMock: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler)
      })
    },
    localeMock: {
      readAppLocale: vi.fn(async () => 'zh'),
      uiText: vi.fn((locale: string, zh: string, en: string) => (locale === 'en' ? en : zh))
    },
    logMock: {
      error: vi.fn(),
      info: vi.fn()
    },
    modelRuntimeControls: [] as Array<Record<string, unknown>>,
    resolveModelMock: vi.fn(),
    encryptApiKeyMock: vi.fn((value: string) => value),
    decryptApiKeyMock: vi.fn((value: unknown) => String(value ?? ''))
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn()
  },
  app: settingsHandlersState.appMock,
  dialog: settingsHandlersState.dialogMock,
  ipcMain: settingsHandlersState.ipcMainMock
}))

vi.mock('electron-log/main.js', () => ({
  default: settingsHandlersState.logMock
}))

vi.mock('../../../src/main/agent-runtime/model', () => ({
  resolveModel: settingsHandlersState.resolveModelMock,
  runWithModelTemperatureControl: <T>(config: Record<string, unknown>, task: () => T): T => {
    settingsHandlersState.modelRuntimeControls.push(config)
    return task()
  },
  OPENAI_RESPONSES_FORMAT_ERROR_EN: 'Invalid OpenAI Responses API payload.',
  OPENAI_RESPONSES_FORMAT_ERROR_ZH: '当前 provider 返回的不是 OpenAI Responses API 格式。',
  isOpenAIResponsesFormatError: (error: unknown) =>
    /Cannot read propert(?:y|ies).*undefined.*map|Cannot read propert(?:y|ies).*map.*undefined/i.test(
      error instanceof Error ? error.message : ''
    )
}))

vi.mock('../../../src/main/utils/proxy', () => ({
  applyProxy: settingsHandlersState.applyProxyMock
}))

vi.mock('../../../src/main/app/window', () => ({
  applyWindowUiTheme: settingsHandlersState.applyWindowThemeMock
}))

vi.mock('../../../src/main/config/locale-utils', () => ({
  readAppLocale: settingsHandlersState.localeMock.readAppLocale,
  uiText: settingsHandlersState.localeMock.uiText
}))

vi.mock('@shared/model-timeout', () => ({
  CONFIGURABLE_MODEL_TIMEOUT_PROFILES: ['planning', 'design', 'agent', 'document'],
  resolveModelTimeoutMs: vi.fn((value: unknown, profile: string) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const defaults: Record<string, number> = {
      planning: 300000,
      design: 300000,
      agent: 600000,
      document: 600000
    }
    return defaults[profile] ?? 300000
  })
}))

async function registerWithDb(overrides: Partial<Record<string, unknown>> = {}) {
  vi.resetModules()
  settingsHandlersState.handlers.clear()

  const { registerSettingsHandlers } = await import('../../../src/main/config/settings-handlers')

  const db = {
    getAllSettings: vi.fn(async () => ({})),
    listModelConfigs: vi.fn(async () => []),
    setSetting: vi.fn(async () => undefined),
    setStoragePath: vi.fn(async () => undefined),
    ...overrides
  }

  const ctx = {
    mainWindow: {} as never,
    db,
    encryptApiKey: settingsHandlersState.encryptApiKeyMock,
    decryptApiKey: settingsHandlersState.decryptApiKeyMock
  }

  registerSettingsHandlers(ctx as never)

  return {
    db,
    getHandler: (channel: string) => settingsHandlersState.handlers.get(channel)
  }
}

describe('registerSettingsHandlers proxy settings', () => {
  beforeEach(() => {
    settingsHandlersState.applyProxyMock.mockReset()
    settingsHandlersState.applyWindowThemeMock.mockReset()
    settingsHandlersState.appMock.getVersion.mockClear()
    settingsHandlersState.dialogMock.showOpenDialog.mockReset()
    settingsHandlersState.handlers.clear()
    settingsHandlersState.ipcMainMock.handle.mockClear()
    settingsHandlersState.localeMock.readAppLocale.mockReset()
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.localeMock.uiText.mockClear()
    settingsHandlersState.logMock.error.mockClear()
    settingsHandlersState.logMock.info.mockClear()
    settingsHandlersState.modelRuntimeControls.length = 0
    settingsHandlersState.resolveModelMock.mockReset()
    settingsHandlersState.encryptApiKeyMock.mockReset()
    settingsHandlersState.encryptApiKeyMock.mockImplementation((value: string) => value)
    settingsHandlersState.decryptApiKeyMock.mockReset()
    settingsHandlersState.decryptApiKeyMock.mockImplementation((value: unknown) =>
      String(value ?? '')
    )
  })

  it('returns trimmed proxyUrl from settings:get', async () => {
    const { getHandler } = await registerWithDb({
      getAllSettings: vi.fn(async () => ({
        locale: 'en',
        proxy_url: '  http://127.0.0.1:7890  ',
        storage_path: '  /tmp/workspace  '
      }))
    })

    const getSettings = getHandler('settings:get')
    const result = await getSettings?.()

    expect(result).toMatchObject({
      locale: 'en',
      proxyUrl: 'http://127.0.0.1:7890',
      storagePath: '/tmp/workspace'
    })
  })

  it('applies proxy before persisting proxy_url in settings:save', async () => {
    const callOrder: string[] = []
    settingsHandlersState.applyProxyMock.mockImplementation(() => {
      callOrder.push('apply')
    })
    const db = {
      setSetting: vi.fn(async (key: string) => {
        if (key === 'proxy_url') {
          callOrder.push('persist')
        }
      })
    }
    const { getHandler } = await registerWithDb(db)

    const saveSettings = getHandler('settings:save')
    const result = await saveSettings?.(undefined, {
      proxyUrl: '  http://127.0.0.1:7890  '
    })

    expect(result).toEqual({ success: true })
    expect(settingsHandlersState.applyProxyMock).toHaveBeenCalledWith('http://127.0.0.1:7890')
    expect(db.setSetting).toHaveBeenCalledWith('proxy_url', 'http://127.0.0.1:7890')
    expect(callOrder).toEqual(['apply', 'persist'])
  })

  it('does not persist proxy_url when applyProxy fails', async () => {
    settingsHandlersState.applyProxyMock.mockImplementation(() => {
      throw new Error('bad proxy')
    })
    const db = {
      setSetting: vi.fn(async () => undefined)
    }
    const { getHandler } = await registerWithDb(db)

    const saveSettings = getHandler('settings:save')

    await expect(
      saveSettings?.(undefined, {
        proxyUrl: 'http://broken-proxy'
      })
    ).rejects.toThrow('代理设置无效：bad proxy')

    expect(settingsHandlersState.localeMock.readAppLocale).toHaveBeenCalled()
    expect(db.setSetting).not.toHaveBeenCalledWith('proxy_url', expect.anything())
  })

  it('clears persisted proxy when saving an empty proxyUrl', async () => {
    const db = {
      setSetting: vi.fn(async () => undefined)
    }
    const { getHandler } = await registerWithDb(db)

    const saveSettings = getHandler('settings:save')
    await saveSettings?.(undefined, { proxyUrl: '   ' })

    expect(settingsHandlersState.applyProxyMock).toHaveBeenCalledWith(undefined)
    expect(db.setSetting).toHaveBeenCalledWith('proxy_url', '')
  })
})

describe('registerSettingsHandlers UI theme settings', () => {
  beforeEach(() => {
    settingsHandlersState.handlers.clear()
    settingsHandlersState.ipcMainMock.handle.mockClear()
    settingsHandlersState.applyWindowThemeMock.mockReset()
  })

  it('normalizes a legacy stored theme to the current default', async () => {
    const { getHandler } = await registerWithDb({
      getAllSettings: vi.fn(async () => ({ theme: 'light' }))
    })

    await expect(getHandler('settings:get')?.()).resolves.toMatchObject({ theme: 'coral' })
  })

  it('persists a valid theme and applies it to the main window', async () => {
    const setSetting = vi.fn(async () => undefined)
    const { getHandler } = await registerWithDb({ setSetting })

    await expect(getHandler('settings:save')?.(undefined, { theme: 'pastel' })).resolves.toEqual({
      success: true
    })
    expect(setSetting).toHaveBeenCalledWith('theme', 'pastel')
    expect(settingsHandlersState.applyWindowThemeMock).toHaveBeenCalledWith(
      expect.anything(),
      'pastel'
    )
  })

  it('does not persist arbitrary theme identifiers', async () => {
    const setSetting = vi.fn(async () => undefined)
    const { getHandler } = await registerWithDb({ setSetting })

    await getHandler('settings:save')?.(undefined, { theme: 'unknown-theme' })

    expect(setSetting).toHaveBeenCalledWith('theme', 'coral')
    expect(settingsHandlersState.applyWindowThemeMock).toHaveBeenCalledWith(
      expect.anything(),
      'coral'
    )
  })
})

describe('registerSettingsHandlers layout rules settings', () => {
  beforeEach(() => {
    settingsHandlersState.handlers.clear()
    settingsHandlersState.ipcMainMock.handle.mockClear()
  })

  it('returns a normalized layout profile from settings:get', async () => {
    const { getHandler } = await registerWithDb({
      getAllSettings: vi.fn(async () => ({
        layout_rules_profile: {
          preset: 'keynote',
          maxContentBlocks: 99,
          heroMinPercent: 45
        }
      }))
    })

    await expect(getHandler('settings:get')?.()).resolves.toMatchObject({
      layoutRules: {
        enabled: true,
        schemaVersion: 3,
        preset: 'keynote',
        maxContentBlocks: 6,
        heroMinPercent: 45,
        compositionMode: 'native-ppt',
        moduleTitleSize: 28
      }
    })
  })

  it('normalizes and persists layout rules in settings:save', async () => {
    const setSetting = vi.fn(async () => undefined)
    const { getHandler } = await registerWithDb({ setSetting })

    await getHandler('settings:save')?.(undefined, {
      layoutRules: {
        preset: 'consulting',
        maxContentBlocks: 1,
        heroMinPercent: 80,
        expertMarkdown: '\0# Team rule'
      }
    })

    expect(setSetting).toHaveBeenCalledWith(
      'layout_rules_profile',
      expect.objectContaining({
        preset: 'consulting',
        maxContentBlocks: 2,
        heroMinPercent: 70,
        schemaVersion: 3,
        expertMarkdown: '# Team rule'
      })
    )
  })
})

describe('registerSettingsHandlers model temperature settings', () => {
  beforeEach(() => {
    settingsHandlersState.handlers.clear()
    settingsHandlersState.ipcMainMock.handle.mockClear()
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.logMock.error.mockClear()
    settingsHandlersState.logMock.info.mockClear()
    settingsHandlersState.modelRuntimeControls.length = 0
    settingsHandlersState.resolveModelMock.mockReset()
    settingsHandlersState.encryptApiKeyMock.mockReset()
    settingsHandlersState.encryptApiKeyMock.mockImplementation((value: string) => value)
    settingsHandlersState.decryptApiKeyMock.mockReset()
    settingsHandlersState.decryptApiKeyMock.mockImplementation((value: unknown) =>
      String(value ?? '')
    )
  })

  const verifyChunkStream = (
    chunks: unknown[] = [{ content: 'OK' }]
  ): AsyncGenerator<unknown> =>
    (async function* () {
      for (const chunk of chunks) yield chunk
    })()

  it('returns disableTemperature in the model config list', async () => {
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Reasoning model',
          provider: 'openai',
          model: 'reasoner',
          apiKey: 'secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 1,
          thinkingParameterMode: 'omit',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    const listModelConfigs = getHandler('settings:listModelConfigs')
    await expect(listModelConfigs?.()).resolves.toEqual([
      expect.objectContaining({
        id: 'model-1',
        disableTemperature: true,
        thinkingParameterMode: 'omit'
      })
    ])
  })

  it('does not return the stored API key from the model config list', async () => {
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    await expect(getHandler('settings:listModelConfigs')?.()).resolves.toEqual([
      expect.objectContaining({ apiKey: '', hasApiKey: true })
    ])
    expect(settingsHandlersState.decryptApiKeyMock).toHaveBeenCalledWith('encrypted-secret')
  })

  it('marks a model config without a decryptable API key as unavailable', async () => {
    settingsHandlersState.decryptApiKeyMock.mockReturnValue('')
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    await expect(getHandler('settings:listModelConfigs')?.()).resolves.toEqual([
      expect.objectContaining({ apiKey: '', hasApiKey: false })
    ])
    expect(settingsHandlersState.decryptApiKeyMock).toHaveBeenCalledWith('encrypted-secret')
  })

  it('retains an existing encrypted API key when an edit leaves it blank', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { db, getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'old-model',
          apiKey: 'encrypted-old-key',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]),
      upsertModelConfig
    })

    await getHandler('settings:upsertModelConfig')?.(undefined, {
      id: 'model-1',
      name: 'Edited model',
      provider: 'openai',
      model: 'new-model',
      apiKey: ''
    })

    expect(db.upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'model-1', apiKey: 'encrypted-old-key' })
    )
  })

  it('requires a new API key when the existing encrypted key cannot be decrypted', async () => {
    settingsHandlersState.decryptApiKeyMock.mockReturnValue('')
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { db, getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'old-model',
          apiKey: 'encrypted-old-key',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]),
      upsertModelConfig
    })

    await expect(
      getHandler('settings:upsertModelConfig')?.(undefined, {
        id: 'model-1',
        name: 'Edited model',
        provider: 'openai',
        model: 'new-model',
        apiKey: ''
      })
    ).rejects.toThrow('已保存的 api_key 无法解密，请重新填写 api_key 后再保存。')

    expect(db.upsertModelConfig).not.toHaveBeenCalled()
  })

  it('does not reuse an API key when an edited endpoint changes', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { db, getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'old-model',
          apiKey: 'encrypted-old-key',
          baseUrl: 'https://trusted.example/v1',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]),
      upsertModelConfig
    })

    await expect(
      getHandler('settings:upsertModelConfig')?.(undefined, {
        id: 'model-1',
        name: 'Edited model',
        provider: 'openai',
        model: 'new-model',
        baseUrl: 'https://attacker.example/v1',
        apiKey: ''
      })
    ).rejects.toThrow('请填写 api_key')

    expect(db.upsertModelConfig).not.toHaveBeenCalled()
  })

  it('does not reuse an API key when an edited provider changes', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { db, getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'old-model',
          apiKey: 'encrypted-old-key',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]),
      upsertModelConfig
    })

    await expect(
      getHandler('settings:upsertModelConfig')?.(undefined, {
        id: 'model-1',
        name: 'Edited model',
        provider: 'evil-provider',
        model: 'new-model',
        apiKey: ''
      })
    ).rejects.toThrow('请填写 api_key')

    expect(db.upsertModelConfig).not.toHaveBeenCalled()
  })

  it('allows an explicit new API key to change the endpoint', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { db, getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'old-model',
          apiKey: 'encrypted-old-key',
          baseUrl: 'https://trusted.example/v1',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]),
      upsertModelConfig
    })

    await getHandler('settings:upsertModelConfig')?.(undefined, {
      id: 'model-1',
      name: 'Edited model',
      provider: 'openai',
      model: 'new-model',
      baseUrl: 'https://new.example/v1',
      apiKey: 'new-key'
    })

    expect(db.upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'model-1',
        apiKey: 'new-key',
        baseUrl: 'https://new.example/v1'
      })
    )
  })

  it('still requires an API key when creating a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    await expect(
      getHandler('settings:upsertModelConfig')?.(undefined, {
        name: 'New model',
        provider: 'openai',
        model: 'model',
        apiKey: ''
      })
    ).rejects.toThrow('请填写 api_key')
    expect(upsertModelConfig).not.toHaveBeenCalled()
  })

  it('verifies an existing stored API key by id without returning it', async () => {
    settingsHandlersState.decryptApiKeyMock.mockReturnValue('stored-secret')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => verifyChunkStream())
    })
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-stored-secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      id: 'model-1',
      provider: 'openai',
      model: 'model',
      apiKey: ''
    })

    expect(result).toEqual({ valid: true, message: '连接验证成功。' })
    expect(settingsHandlersState.resolveModelMock).toHaveBeenCalledWith(
      'openai',
      'stored-secret',
      'model',
      '',
      undefined,
      4096,
      undefined
    )
  })

  it('explains when an existing API key cannot be decrypted during verification', async () => {
    settingsHandlersState.decryptApiKeyMock.mockReturnValue('')
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-stored-secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      id: 'model-1',
      provider: 'openai',
      model: 'model',
      apiKey: ''
    })

    expect(result).toEqual({
      valid: false,
      message: '已保存的 api_key 无法解密，请重新填写 api_key 后再保存。'
    })
    expect(settingsHandlersState.resolveModelMock).not.toHaveBeenCalled()
  })

  it('rejects verification before decrypting when the endpoint changes', async () => {
    settingsHandlersState.decryptApiKeyMock.mockImplementation(() => {
      throw new Error('decrypt should not run')
    })
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-stored-secret',
          baseUrl: 'https://trusted.example/v1',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      id: 'model-1',
      provider: 'openai',
      model: 'model',
      baseUrl: 'https://attacker.example/v1',
      apiKey: ''
    })

    expect(result).toEqual({
      valid: false,
      message: 'provider 或 base_url 已变化，请重新填写 api_key。'
    })
    expect(settingsHandlersState.decryptApiKeyMock).not.toHaveBeenCalled()
    expect(settingsHandlersState.resolveModelMock).not.toHaveBeenCalled()
  })

  it('rejects verification before decrypting when the provider changes', async () => {
    settingsHandlersState.decryptApiKeyMock.mockImplementation(() => {
      throw new Error('decrypt should not run')
    })
    const { getHandler } = await registerWithDb({
      listModelConfigs: vi.fn(async () => [
        {
          id: 'model-1',
          name: 'Existing model',
          provider: 'openai',
          model: 'model',
          apiKey: 'encrypted-stored-secret',
          baseUrl: '',
          maxTokens: 4096,
          disableTemperature: 0,
          thinkingParameterMode: 'auto',
          active: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ])
    })

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      id: 'model-1',
      provider: 'evil-provider',
      model: 'model',
      apiKey: ''
    })

    expect(result).toEqual({
      valid: false,
      message: 'provider 或 base_url 已变化，请重新填写 api_key。'
    })
    expect(settingsHandlersState.decryptApiKeyMock).not.toHaveBeenCalled()
    expect(settingsHandlersState.resolveModelMock).not.toHaveBeenCalled()
  })

  it('does not leak an API key through verification error logs', async () => {
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new Error('request failed apiKey=secret-key')
      })
    })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'openai',
      model: 'model',
      apiKey: 'secret-key',
      baseUrl: 'https://api.example.com/v1'
    })

    expect(result).toEqual({ valid: false, message: 'request failed apiKey=[REDACTED]' })
    expect(JSON.stringify(settingsHandlersState.logMock.error.mock.calls)).not.toContain(
      'secret-key'
    )
  })

  it('persists parameter controls when saving a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'Reasoning model',
      provider: 'openai',
      model: 'reasoner',
      apiKey: 'secret',
      baseUrl: '',
      maxTokens: 4096,
      disableTemperature: true,
      thinkingParameterMode: 'omit'
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        disableTemperature: true,
        thinkingParameterMode: 'omit'
      })
    )
  })

  it('allows large thinking-model token budgets up to 65536', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'GLM 5.2',
      provider: 'zhipu',
      model: 'glm-5.2',
      apiKey: 'secret',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      maxTokens: 32768
    })
    await saveModelConfig?.(undefined, {
      name: 'Greedy',
      provider: 'zhipu',
      model: 'glm-5.2',
      apiKey: 'secret',
      baseUrl: '',
      maxTokens: 100000
    })

    expect(upsertModelConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxTokens: 32768 })
    )
    expect(upsertModelConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ maxTokens: 65536 })
    )
  })

  it('accepts the OpenAI Responses provider when saving a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-1')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'Responses model',
      provider: 'openai-responses',
      model: 'gpt-5.1',
      apiKey: 'secret',
      baseUrl: 'https://api.openai.com/v1',
      maxTokens: 4096,
      disableTemperature: false,
      thinkingParameterMode: 'not-valid'
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-responses',
        thinkingParameterMode: 'auto'
      })
    )
  })

  it('accepts the Zhipu GLM provider when saving a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-zhipu')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'Zhipu GLM',
      provider: 'zhipu',
      model: 'glm-4.6',
      apiKey: 'secret',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      maxTokens: 4096,
      disableTemperature: false,
      thinkingParameterMode: 'auto'
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'zhipu',
        model: 'glm-4.6',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/'
      })
    )
  })

  it('accepts the DeepSeek provider when saving a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-deepseek')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'DeepSeek V4',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      apiKey: 'secret',
      baseUrl: 'https://api.deepseek.com',
      maxTokens: 4096,
      disableTemperature: false,
      thinkingParameterMode: 'auto'
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com'
      })
    )
  })

  it('accepts the Kimi provider when saving a model config', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-kimi')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'Kimi Code',
      provider: 'kimi',
      model: 'kimi-for-coding',
      apiKey: 'secret',
      baseUrl: 'https://api.kimi.com/coding/v1',
      maxTokens: 4096,
      disableTemperature: false,
      thinkingParameterMode: 'auto'
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'kimi',
        model: 'kimi-for-coding',
        baseUrl: 'https://api.kimi.com/coding/v1'
      })
    )
  })

  it('normalizes an unknown provider back to openai', async () => {
    const upsertModelConfig = vi.fn(async () => 'model-x')
    const { getHandler } = await registerWithDb({ upsertModelConfig })

    const saveModelConfig = getHandler('settings:upsertModelConfig')
    await saveModelConfig?.(undefined, {
      name: 'Unknown',
      provider: 'some-unknown-provider',
      model: 'm',
      apiKey: 'secret',
      baseUrl: '',
      maxTokens: 4096
    })

    expect(upsertModelConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }))
  })

  it('explains invalid Responses API payloads during model verification', async () => {
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'map')")
      })
    })
    const { getHandler } = await registerWithDb()

    const verifyApiKey = getHandler('settings:verifyApiKey')
    const result = await verifyApiKey?.(undefined, {
      provider: 'openai-responses',
      model: 'gpt-5.5',
      apiKey: 'secret',
      baseUrl: 'https://www.toumingren.xyz/v1',
      maxTokens: 4096,
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('不是 OpenAI Responses API 格式')
    })
  })

  it('retries mandatory-thinking models without the compatibility thinking parameter', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('400 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。')
      )
      .mockResolvedValueOnce(verifyChunkStream())
    settingsHandlersState.resolveModelMock.mockReturnValue({ stream })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'openai',
      model: 'mandatory-reasoner',
      apiKey: 'secret',
      baseUrl: 'https://api.example-compatible.com/v1',
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: true,
      message: expect.stringContaining('请点击保存使其生效'),
      thinkingParameterMode: 'omit'
    })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(settingsHandlersState.modelRuntimeControls).toEqual([
      expect.objectContaining({ thinkingParameterMode: 'auto' }),
      expect.objectContaining({ thinkingParameterMode: 'omit' })
    ])
  })

  it('returns the retry error when mandatory-thinking verification still fails', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new Error('cannot disable reasoning; use low, high, or max'))
      .mockRejectedValueOnce(new Error('model is unavailable'))
    settingsHandlersState.resolveModelMock.mockReturnValue({ stream })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'openai',
      model: 'mandatory-reasoner',
      apiKey: 'secret',
      baseUrl: 'https://api.example-compatible.com/v1',
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({ valid: false, message: 'model is unavailable' })
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('redacts credentials when the mandatory-thinking retry fails', async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new Error('mandatory reasoning cannot be disabled'))
      .mockRejectedValueOnce(new Error('retry failed apiKey=secret-key'))
    settingsHandlersState.resolveModelMock.mockReturnValue({ stream })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'openai',
      model: 'mandatory-reasoner',
      apiKey: 'secret-key',
      baseUrl: 'https://api.example-compatible.com/v1',
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({ valid: false, message: 'retry failed apiKey=[REDACTED]' })
    expect(JSON.stringify(settingsHandlersState.logMock.error.mock.calls)).not.toContain(
      'secret-key'
    )
  })

  it('does not retry mandatory-thinking errors when thinking is already omitted', async () => {
    const stream = vi.fn(async () => {
      throw new Error('cannot disable reasoning; use low, high, or max')
    })
    settingsHandlersState.resolveModelMock.mockReturnValue({ stream })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'openai',
      model: 'mandatory-reasoner',
      apiKey: 'secret',
      baseUrl: 'https://api.example-compatible.com/v1',
      thinkingParameterMode: 'omit',
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: 'cannot disable reasoning; use low, high, or max'
    })
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('verifies successfully on the first streamed chunk without draining the stream', async () => {
    // 思考模型流式验证：第一个分片到达即成功，流被提前终止的噪音不算失败。
    const stream = vi.fn(async () =>
      (async function* () {
        yield { content: 'O' }
        throw new Error('teardown noise after first chunk')
      })()
    )
    settingsHandlersState.resolveModelMock.mockReturnValue({ stream })
    const { getHandler } = await registerWithDb()

    const result = await getHandler('settings:verifyApiKey')?.(undefined, {
      provider: 'zhipu',
      model: 'glm-5.2',
      apiKey: 'secret',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      thinkingParameterMode: 'omit',
      timeoutMs: 60000
    })

    expect(result).toEqual({ valid: true, message: '连接验证成功。' })
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('explains unsupported thinking parameter errors during model verification', async () => {
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new Error('Unsupported parameter: thinking')
      })
    })
    const { getHandler } = await registerWithDb()

    const verifyApiKey = getHandler('settings:verifyApiKey')
    const result = await verifyApiKey?.(undefined, {
      provider: 'openai',
      model: 'compatible-model',
      apiKey: 'secret',
      baseUrl: 'https://api.example-compatible.com/v1',
      maxTokens: 4096,
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('不发送 thinking 参数')
    })
  })

  it('explains unrecognized thinking argument errors during model verification', async () => {
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new Error('Unrecognized request argument supplied: thinking')
      })
    })
    const { getHandler } = await registerWithDb()

    const verifyApiKey = getHandler('settings:verifyApiKey')
    const result = await verifyApiKey?.(undefined, {
      provider: 'openai',
      model: 'compatible-model',
      apiKey: 'secret',
      baseUrl: 'https://api.example-compatible.com/v1',
      maxTokens: 4096,
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('不发送 thinking 参数')
    })
  })

  it('explains thinking parameter errors for the Zhipu GLM provider', async () => {
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new Error('Unsupported parameter: thinking')
      })
    })
    const { getHandler } = await registerWithDb()

    const verifyApiKey = getHandler('settings:verifyApiKey')
    const result = await verifyApiKey?.(undefined, {
      provider: 'zhipu',
      model: 'glm-4.6',
      apiKey: 'secret',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      maxTokens: 4096,
      thinkingParameterMode: 'auto',
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('智谱 GLM 接口不支持 thinking 参数')
    })
  })

  it('explains older undefined map errors during Responses API verification', async () => {
    settingsHandlersState.localeMock.readAppLocale.mockResolvedValue('zh')
    settingsHandlersState.resolveModelMock.mockReturnValue({
      stream: vi.fn(async () => {
        throw new TypeError("Cannot read property 'map' of undefined")
      })
    })
    const { getHandler } = await registerWithDb()

    const verifyApiKey = getHandler('settings:verifyApiKey')
    const result = await verifyApiKey?.(undefined, {
      provider: 'openai-responses',
      model: 'gpt-5.5',
      apiKey: 'secret',
      baseUrl: 'https://www.toumingren.xyz/v1',
      maxTokens: 4096,
      timeoutMs: 60000
    })

    expect(result).toEqual({
      valid: false,
      message: expect.stringContaining('OpenAI Responses API')
    })
  })
})

describe('registerSettingsHandlers model usage', () => {
  beforeEach(() => {
    settingsHandlersState.handlers.clear()
    settingsHandlersState.ipcMainMock.handle.mockClear()
  })

  it('delegates the selected usage period to the database', async () => {
    const stats = {
      period: '7d',
      startedAt: 1,
      totals: {
        callCount: 2,
        exactCallCount: 1,
        estimatedCallCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120
      },
      byModel: [],
      byDay: []
    }
    const getModelUsageStats = vi.fn(async () => stats)
    const { getHandler } = await registerWithDb({ getModelUsageStats })

    await expect(getHandler('settings:getModelUsage')?.(undefined, '7d')).resolves.toBe(stats)
    expect(getModelUsageStats).toHaveBeenCalledWith('7d')
  })

  it('falls back to 30 days for an invalid usage period', async () => {
    const getModelUsageStats = vi.fn(async () => ({ period: '30d' }))
    const { getHandler } = await registerWithDb({ getModelUsageStats })

    await getHandler('settings:getModelUsage')?.(undefined, 'invalid')
    expect(getModelUsageStats).toHaveBeenCalledWith('30d')
  })
})
