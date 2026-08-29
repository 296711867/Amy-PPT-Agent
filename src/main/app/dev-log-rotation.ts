/** dev 日志轮转：按日期分文件，启动时剪枝超过保留期的旧日志。 */
import fs from 'fs'
import path from 'path'

export const DEV_LOG_KEEP_DAYS = 7

export const resolveDevLogPath = (logDir: string, now = new Date()): string => {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  return path.join(logDir, `main-${date}.log`)
}

const DEV_LOG_FILE_PATTERN = /^main-\d{4}-\d{2}-\d{2}\.log$/

const fileDate = (fileName: string): number => {
  const match = /^main-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(fileName)
  if (!match) return Number.NaN
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

/** 删除超过保留期的 dev 日志；解析失败的文件名忽略，任何 IO 错误静默吞掉。 */
export const pruneDevLogs = (logDir: string, now = new Date(), keepDays = DEV_LOG_KEEP_DAYS): number => {
  let removed = 0
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = fs.readdirSync(logDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!DEV_LOG_FILE_PATTERN.test(entry)) continue
    const time = fileDate(entry)
    if (!Number.isFinite(time) || time >= cutoff) continue
    try {
      fs.rmSync(path.join(logDir, entry), { force: true })
      removed += 1
    } catch {
      // 剪枝失败不影响启动
    }
  }
  return removed
}
