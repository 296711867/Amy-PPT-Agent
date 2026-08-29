/**
 * Lightweight fallback for providers that omit usage metadata.
 * ASCII-heavy text is approximated at four characters per token; CJK and other
 * non-ASCII code points count individually to avoid severe underestimation.
 */
export function estimateTextTokens(value: string): number {
  if (!value) return 0

  let asciiCount = 0
  let nonAsciiCount = 0
  for (const char of value) {
    if (char.codePointAt(0)! <= 0x7f) asciiCount += 1
    else nonAsciiCount += 1
  }

  return Math.max(1, Math.ceil(asciiCount / 4 + nonAsciiCount))
}
