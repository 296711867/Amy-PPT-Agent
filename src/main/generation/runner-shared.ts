/** agent-runner 拆分后各子模块共用的小工具（无状态、无业务语义）。 */
import fs from 'fs'
import type { GenerationModelControl } from './context'
import { runWithModelTemperatureControl } from '../agent-runtime/model'
import { resolveModelTimeoutMs, type ModelTimeoutProfile } from '@shared/model-timeout'

export type AppLocale = 'zh' | 'en'

export const uiText = (locale: AppLocale | undefined, zh: string, en: string): string =>
  locale === 'en' ? en : zh

export const withModelControl = <T>(
  modelControl: GenerationModelControl | undefined,
  task: () => T
): T => (modelControl ? runWithModelTemperatureControl(modelControl, task) : task())

export async function readPageHtmlIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export const modelCallSignal = (
  timeoutMs: unknown,
  profile: ModelTimeoutProfile,
  upstreamSignal?: AbortSignal
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(resolveModelTimeoutMs(timeoutMs, profile))
  return upstreamSignal ? AbortSignal.any([timeoutSignal, upstreamSignal]) : timeoutSignal
}
