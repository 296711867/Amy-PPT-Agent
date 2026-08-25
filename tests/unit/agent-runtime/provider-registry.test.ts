import { describe, expect, it, vi } from 'vitest'

// Mock electron dependencies before any imports
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// Test the pure registry API (no provider auto-registration needed)
import {
  registerModelProvider,
  getModelProvider,
  listModelProviders,
  listModelProviderIds,
  isRegisteredModelProvider,
  type ModelProviderDefinition
} from '../../../src/main/agent-runtime/registry/provider-registry'

// Test double: a minimal provider for registry API testing
const testProvider: ModelProviderDefinition = {
  id: 'test-provider',
  label: 'Test Provider',
  createModel: () => ({ id: 'test' }) as never,
  defaultBaseUrl: 'https://test.example.com',
  defaultModel: 'test-model',
  supportsThinkingParameter: true
}

describe('provider registry API', () => {
  it('registers and retrieves a provider', () => {
    registerModelProvider(testProvider)
    const found = getModelProvider('test-provider')
    expect(found).toBeTruthy()
    expect(found!.id).toBe('test-provider')
    expect(found!.label).toBe('Test Provider')
    expect(found!.defaultBaseUrl).toBe('https://test.example.com')
    expect(found!.defaultModel).toBe('test-model')
    expect(found!.supportsThinkingParameter).toBe(true)
  })

  it('identifies registered vs unknown providers', () => {
    expect(isRegisteredModelProvider('test-provider')).toBe(true)
    expect(isRegisteredModelProvider('nonexistent')).toBe(false)
    expect(getModelProvider('nonexistent')).toBeUndefined()
  })

  it('rejects duplicate registration', () => {
    expect(() => registerModelProvider(testProvider)).toThrow(
      'Model provider already registered: test-provider'
    )
  })

  it('enumerates all registered providers', () => {
    const ids = listModelProviderIds()
    expect(ids).toContain('test-provider')

    const providers = listModelProviders()
    const testEntry = providers.find((p) => p.id === 'test-provider')
    expect(testEntry).toBeTruthy()
    expect(testEntry!.label).toBe('Test Provider')
  })

  it('creates model instances through the factory function', () => {
    const provider = getModelProvider('test-provider')
    expect(provider).toBeTruthy()
    const model = provider!.createModel({
      apiKey: 'key',
      model: 'test-model',
      baseUrl: 'https://test.example.com',
      maxTokens: 4096,
      usageCallback: {} as never,
      temperatureOptions: {},
      thinkingParameterMode: 'auto'
    })
    expect(model).toBeTruthy()
  })
})
