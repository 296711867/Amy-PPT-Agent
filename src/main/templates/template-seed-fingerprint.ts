import crypto from 'crypto'

export const createTemplateSeedFingerprint = (html: string): string =>
  crypto.createHash('sha1').update(html).digest('hex').slice(0, 12)

export const isUntouchedTemplateSeed = (html: string, seedFingerprint?: string): boolean =>
  Boolean(seedFingerprint && createTemplateSeedFingerprint(html) === seedFingerprint)

export const resolveUnconfirmedTemplatePageFailure = (args: {
  html: string
  seedFingerprint?: string
  completedCallbackObserved: boolean
}): string | null => {
  if (args.completedCallbackObserved) return null
  if (isUntouchedTemplateSeed(args.html, args.seedFingerprint)) {
    return '页面未被生成改写（仍为模板基底）'
  }
  return '页面生成未确认完成（缺少 completed 回调）'
}
