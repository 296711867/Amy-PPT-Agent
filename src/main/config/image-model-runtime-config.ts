import type { ImageModelConfigRow } from '../db/records'

const BBT_IMAGE_MODEL_CONFIG_ID = 'codex-bbt-image-model'
const BBT_IMAGE_MODEL = 'gpt-image-2'
const BBT_IMAGE_BASE_URL = 'http://192.168.177.54:3002/v1'

const parseConfig = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const readEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
  key: string
): string => environment[key]?.trim() || ''

export const isBbtImageModelConfig = (
  config: Pick<ImageModelConfigRow, 'id' | 'provider'>
): boolean => config.id === BBT_IMAGE_MODEL_CONFIG_ID && config.provider === 'agnes'

export const resolveImageModelRuntimeConfig = (args: {
  config: Pick<ImageModelConfigRow, 'id' | 'provider' | 'modelConfig'>
  decryptConfig(value: string): string
  environment?: NodeJS.ProcessEnv
}): Record<string, unknown> => {
  if (isBbtImageModelConfig(args.config)) {
    const environment = args.environment || process.env
    return {
      model: BBT_IMAGE_MODEL,
      baseUrl: readEnvironmentValue(environment, 'BBT_IMAGE_BASE_URL') || BBT_IMAGE_BASE_URL,
      apiKey: readEnvironmentValue(environment, 'BBT_IMAGE_API_KEY')
    }
  }

  return parseConfig(args.decryptConfig(args.config.modelConfig || '{}'))
}
