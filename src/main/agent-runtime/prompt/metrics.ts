import { createHash } from 'crypto'
import { estimateTextTokens } from '../token-estimate'

export type PromptTextMetrics = {
  characterCount: number
  utf8ByteCount: number
  estimatedTokens: number
  fingerprint: string
}

/**
 * Produces log-safe prompt telemetry without retaining or exposing prompt text.
 * ASCII-heavy text is approximated at four characters per token; CJK and other
 * non-ASCII code points are counted individually to avoid severe underestimation.
 */
export function measurePromptText(value: string): PromptTextMetrics {
  return {
    characterCount: value.length,
    utf8ByteCount: Buffer.byteLength(value, 'utf8'),
    estimatedTokens: estimateTextTokens(value),
    fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 12)
  }
}
