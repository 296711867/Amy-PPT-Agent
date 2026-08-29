import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { ImageRegistry } from './types'

const getRegistryKey = (key: string, dataUrl: string): string => {
  const stableKey = key.trim()
  if (stableKey && stableKey.length < 512 && !stableKey.startsWith('data:')) return `ref:${stableKey}`
  return `sha256:${crypto.createHash('sha256').update(stableKey || dataUrl).digest('hex')}`
}

const getDataUrlInfo = (dataUrl: string): { mimeType: string; extension: string; data: string } => {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return { mimeType: 'application/octet-stream', extension: '.bin', data: dataUrl }
  const mimeType = match[1]
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'image/webp'
          ? '.webp'
          : mimeType === 'image/gif'
            ? '.gif'
            : mimeType === 'image/svg+xml'
              ? '.svg'
              : '.bin'
  return { mimeType, extension, data: match[2] }
}

export const writeImageDataUrl = async (
  imagesDir: string,
  registry: ImageRegistry,
  key: string,
  dataUrl: string
): Promise<string | null> => {
  if (!dataUrl) return null
  const registryKey = getRegistryKey(key, dataUrl)
  const existing = registry.byKey.get(registryKey)
  if (existing) return existing
  const info = getDataUrlInfo(dataUrl)
  if (!info.data || info.extension === '.bin') return null
  registry.index += 1
  const fileName = `imported-${String(registry.index).padStart(4, '0')}${info.extension}`
  const targetPath = path.join(imagesDir, fileName)
  await fs.promises.writeFile(targetPath, Buffer.from(info.data, 'base64'))
  const relativePath = `./images/${fileName}`
  registry.byKey.set(registryKey, relativePath)
  return relativePath
}
