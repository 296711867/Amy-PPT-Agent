import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEV_LOG_KEEP_DAYS,
  pruneDevLogs,
  resolveDevLogPath
} from '../../../src/main/app/dev-log-rotation'

const cleanup: string[] = []

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true })
})

describe('dev log rotation', () => {
  it('names log files by date', () => {
    const path1 = resolveDevLogPath('/logs', new Date(2026, 7, 29, 9, 30))
    const path2 = resolveDevLogPath('/logs', new Date(2025, 0, 5, 23, 59))

    expect(path1).toBe(path.join('/logs', 'main-2026-08-29.log'))
    expect(path2).toBe(path.join('/logs', 'main-2025-01-05.log'))
  })

  it('prunes logs older than the retention window and keeps recent ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-devlog-'))
    cleanup.push(dir)
    const now = new Date(2026, 7, 29)
    const day = (offset: number) => {
      const d = new Date(2026, 7, 29 + offset)
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`
      return `main-${stamp}.log`
    }
    for (const name of [day(-30), day(-8), day(-7), day(-3), day(0), 'main.log', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, name), 'x')
    }

    const removed = pruneDevLogs(dir, now, DEV_LOG_KEEP_DAYS)

    expect(removed).toBe(2)
    expect(fs.existsSync(path.join(dir, day(-30)))).toBe(false)
    expect(fs.existsSync(path.join(dir, day(-8)))).toBe(false)
    // 保留期内与边界文件、非日志文件全部保留
    expect(fs.existsSync(path.join(dir, day(-7)))).toBe(true)
    expect(fs.existsSync(path.join(dir, day(-3)))).toBe(true)
    expect(fs.existsSync(path.join(dir, day(0)))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
  })

  it('tolerates a missing log directory', () => {
    expect(pruneDevLogs(path.join(os.tmpdir(), 'no-such-devlog-dir'))).toBe(0)
  })
})
