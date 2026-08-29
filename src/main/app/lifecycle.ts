import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'
import dayjs from 'dayjs'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { UpdateAvailablePayload } from '@shared/app-update'
import { isRepeatedRendererCrash, shouldRecoverRenderer } from './renderer-recovery'
import { canUseConsoleTransport, installLoggingStreamGuards } from './logging-stream-guard'
import { pruneDevLogs, resolveDevLogPath } from './dev-log-rotation'
import { APP_NAME, resolveUpdateManifestUrl } from '@shared/brand'

const UPDATE_MANIFEST_URL = resolveUpdateManifestUrl()

export function configureLogging(): void {
  const loggingStreams = [process.stdout, process.stderr]
  if (!canUseConsoleTransport(loggingStreams)) {
    log.transports.console.level = false
  }
  installLoggingStreamGuards(loggingStreams, () => {
    log.transports.console.level = false
  })

  log.transports.file.level = 'info'
  log.transports.file.maxSize = 20 * 1024 * 1024
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

  if (is.dev) {
    // dev 日志按日期分文件并在启动时剪枝，避免单文件无限增长。
    const logDir = join(process.cwd(), 'logs')
    mkdirSync(logDir, { recursive: true })
    log.transports.file.resolvePathFn = () => resolveDevLogPath(logDir)
    pruneDevLogs(logDir)
  } else {
    log.transports.file.resolvePathFn = () => {
      const now = dayjs()
      const yearMonth = now.format('YYYY-MM')
      const yearMonthDay = now.format('YYYY-MM-DD')
      return join(
        app.getPath('userData'),
        'amy-ppt-logs',
        yearMonth,
        `${yearMonthDay}-v${app.getVersion()}.log`
      )
    }
  }

  log.initialize()
  log.info('[app] logger initialized', {
    env: is.dev ? 'dev' : 'prod',
    version: app.getVersion(),
    file: log.transports.file.getFile().path
  })
}

const parseVersion = (version: string): number[] =>
  version
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })

const isNewerVersion = (latestVersion: string, currentVersion: string): boolean => {
  const latest = parseVersion(latestVersion)
  const current = parseVersion(currentVersion)
  for (let index = 0; index < Math.max(latest.length, current.length, 3); index += 1) {
    const latestPart = latest[index] ?? 0
    const currentPart = current[index] ?? 0
    if (latestPart > currentPart) return true
    if (latestPart < currentPart) return false
  }
  return false
}

const fetchLatestRelease = async (): Promise<UpdateAvailablePayload | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `${APP_NAME}/${app.getVersion()}`
      },
      signal: controller.signal
    })
    if (!response.ok) {
      log.warn('[update] latest release request failed', {
        status: response.status,
        statusText: response.statusText
      })
      return null
    }
    const manifest = (await response.json()) as {
      version?: unknown
      downloadhome?: unknown
      changeLog?: unknown
    }
    const latestVersion = String(manifest.version || '').trim()
    const currentVersion = app.getVersion()
    const rawDownloadhome =
      typeof manifest.downloadhome === 'string' ? manifest.downloadhome.trim() : ''
    const downloadhome =
      rawDownloadhome && !/^https?:\/\//i.test(rawDownloadhome)
        ? `http://${rawDownloadhome}`
        : rawDownloadhome
    const changeLog = typeof manifest.changeLog === 'string' ? manifest.changeLog.trim() : ''

    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return null
    return {
      currentVersion,
      latestVersion,
      downloadUrl: downloadhome || undefined,
      changeLog: changeLog || undefined
    }
  } catch (error) {
    log.warn('[update] latest release check failed', {
      message: error instanceof Error ? error.message : String(error)
    })
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export function scheduleUpdateNotification(window: BrowserWindow): void {
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void fetchLatestRelease().then((update) => {
        if (!update || window.isDestroyed() || window.webContents.isDestroyed()) return
        log.info('[update] new release available', update)
        window.webContents.send('app:update-available', update)
      })
    }, 2500)
  })
}

export function attachRendererCrashRecovery(
  window: BrowserWindow,
  options: {
    isShuttingDown(): boolean
    loadHome(): void
  }
): void {
  let lastRendererCrashAt = 0
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('[renderer] process gone', details)
    if (options.isShuttingDown() || !shouldRecoverRenderer(details.reason)) return

    const now = Date.now()
    const repeatedCrash = isRepeatedRendererCrash(lastRendererCrashAt, now)
    lastRendererCrashAt = now

    setTimeout(() => {
      if (options.isShuttingDown() || window.isDestroyed() || window.webContents.isDestroyed())
        return
      if (!repeatedCrash) {
        window.webContents.reload()
        return
      }

      log.warn('[renderer] repeated crash; recovering at home route')
      options.loadHome()
    }, 250)
  })
}
