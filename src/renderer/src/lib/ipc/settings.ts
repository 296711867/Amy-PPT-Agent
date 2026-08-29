/** 配置域 IPC：设置、模型/图像模型配置、字体注册表、图像生成。 */
import { getIpc } from "./core"
import type {
  FontListItem,
  FontRegistryResponse,
  FontRole,
  FontScript,
  ModelConfig,
  UploadFontPayload,
  UploadPrerequisitesResult
} from "./types"
import type { ThinkingParameterMode } from "@shared/model-config.js"
import type { ModelUsagePeriod, ModelUsageStats } from "@shared/model-usage"
import type {
  ImageGeneratePayload,
  ImageGenerateResult,
  ImageGenerationHistoryRecord,
  ImageModelConfig,
  ImageModelProvider,
  ImagePromptGeneratePayload,
  ImagePromptGenerateResult
} from "@shared/image-generation.js"
export const settingsIpc = {
  getSettings: () => getIpc().invoke('settings:get') as Promise<Record<string, unknown>>,
  getModelUsage: (period: ModelUsagePeriod) =>
    getIpc().invoke('settings:getModelUsage', period) as Promise<ModelUsageStats>,
  listModelConfigs: () => getIpc().invoke('settings:listModelConfigs') as Promise<ModelConfig[]>,
  listImageModelConfigs: () => getIpc().invoke('imageModels:list') as Promise<ImageModelConfig[]>,
  validateUploadPrerequisites: () =>
    getIpc().invoke('settings:validateUploadPrerequisites') as Promise<UploadPrerequisitesResult>,
  listFonts: () => getIpc().invoke('fonts:list') as Promise<FontRegistryResponse>,
  uploadFont: (payload: UploadFontPayload) =>
    getIpc().invoke('fonts:upload', payload) as Promise<{ success: true; font: FontListItem }>,
  updateFont: (payload: {
    id: string
    family?: string
    category?: string
    role?: FontRole[]
    scripts?: FontScript[]
  }) => getIpc().invoke('fonts:update', payload) as Promise<{ success: true; font: FontListItem }>,
  deleteFont: (fontId: string) =>
    getIpc().invoke('fonts:delete', fontId) as Promise<{ success: true }>,
  revealFontsFolder: () => getIpc().invoke('fonts:revealFolder') as Promise<{ success: true }>,
  chooseFontFiles: () =>
    getIpc().invoke('fonts:chooseFiles') as Promise<{ canceled: boolean; filePaths: string[] }>,
  loadFontPreviewCss: () => getIpc().invoke('fonts:previewCss') as Promise<string>,
  listFontSchemes: () =>
    getIpc().invoke('fonts:listSchemes') as Promise<{
      items: import('@shared/font-schemes').AvailableFontScheme[]
    }>,
  saveFontScheme: (payload: import('@shared/font-schemes').FontScheme) =>
    getIpc().invoke('fonts:saveScheme', payload) as Promise<{
      success: true
      scheme: import('@shared/font-schemes').AvailableFontScheme
    }>,
  deleteFontScheme: (schemeId: string) =>
    getIpc().invoke('fonts:deleteScheme', schemeId) as Promise<{ success: true }>,
  saveSettings: (settings: Record<string, unknown>) =>
    getIpc().invoke('settings:save', settings) as Promise<{ success: boolean }>,
  upsertModelConfig: (payload: {
    id?: string
    name: string
    provider: 'anthropic' | 'openai' | 'openai-responses' | 'google' | 'zhipu' | 'deepseek' | 'kimi'
    model: string
    apiKey: string
    baseUrl: string
    maxTokens?: number
    disableTemperature?: boolean
    thinkingParameterMode?: ThinkingParameterMode
    active?: boolean
  }) =>
    getIpc().invoke('settings:upsertModelConfig', payload) as Promise<{
      success: boolean
      id: string
    }>,
  setActiveModelConfig: (id: string) =>
    getIpc().invoke('settings:setActiveModelConfig', id) as Promise<{ success: boolean }>,
  deleteModelConfig: (id: string) =>
    getIpc().invoke('settings:deleteModelConfig', id) as Promise<{ success: boolean }>,
  upsertImageModelConfig: (payload: {
    id?: string
    name: string
    provider: ImageModelProvider
    active?: boolean
    modelConfig: string
  }) =>
    getIpc().invoke('imageModels:upsert', payload) as Promise<{
      success: boolean
      id: string
    }>,
  setActiveImageModelConfig: (id: string) =>
    getIpc().invoke('imageModels:setActive', id) as Promise<{ success: boolean }>,
  deleteImageModelConfig: (id: string) =>
    getIpc().invoke('imageModels:delete', id) as Promise<{ success: boolean }>,
  verifyImageModel: (payload: { provider: ImageModelProvider; modelConfig: string }) =>
    getIpc().invoke('imageModels:verify', payload) as Promise<{
      valid: boolean
      message?: string
    }>,
  verifyApiKey: (payload: {
    id?: string
    provider: string
    apiKey: string
    model: string
    baseUrl: string
    maxTokens?: number
    disableTemperature?: boolean
    thinkingParameterMode?: ThinkingParameterMode
    timeoutMs: number
  }) =>
    getIpc().invoke('settings:verifyApiKey', payload) as Promise<{
      valid: boolean
      message?: string
      thinkingParameterMode?: ThinkingParameterMode
    }>,
  chooseStoragePath: () =>
    getIpc().invoke('settings:chooseStoragePath') as Promise<{
      path: string | null
      error?: string
    }>,
  generateImage: (payload: ImageGeneratePayload) =>
    getIpc().invoke('images:generate', payload) as Promise<ImageGenerateResult>,
  generateImagePrompt: (payload: ImagePromptGeneratePayload) =>
    getIpc().invoke('images:generatePrompt', payload) as Promise<ImagePromptGenerateResult>,
  listImageGenerationHistory: (payload: { sessionId: string; pageId: string }) =>
    getIpc().invoke('images:listHistory', payload) as Promise<ImageGenerationHistoryRecord[]>,
  cancelImageGeneration: (sessionId: string) =>
    getIpc().invoke('images:cancel', sessionId) as Promise<{ success: boolean }>,
  getImageGenerationState: (sessionId: string) =>
    getIpc().invoke('images:getState', sessionId) as Promise<{
      runId: string
      sessionId: string
      pageId: string
      progress: number
      label: string
      status: 'running' | 'completed' | 'failed' | 'cancelled'
      error: string | null
      updatedAt: number
    } | null>,
}
