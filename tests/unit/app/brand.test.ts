import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_ID,
  APP_NAME,
  APP_PACKAGE_NAME,
  APP_VERSION,
  DEFAULT_UPDATE_MANIFEST_URL,
  resolveUpdateManifestUrl
} from '../../../src/shared/brand'
import { resolveBrandDatabasePath } from '../../../src/main/app/database-path'

const cleanup: string[] = []

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true })
})

describe('Amy-PPT brand contract', () => {
  it('uses an independent application identity and update source', () => {
    expect(APP_NAME).toBe('Amy-PPT')
    expect(APP_PACKAGE_NAME).toBe('amy-ppt')
    expect(APP_ID).toBe('com.amyppt.app')
    expect(APP_VERSION).toBe('1.0.4')
    expect(DEFAULT_UPDATE_MANIFEST_URL).toContain('/296711867/Amy-PPT/')
    expect(DEFAULT_UPDATE_MANIFEST_URL).not.toContain('oh-my-ppt')
  })

  it('allows a private update manifest override', () => {
    expect(
      resolveUpdateManifestUrl({ AMY_PPT_UPDATE_MANIFEST_URL: 'https://updates.example/amy.json' })
    ).toBe('https://updates.example/amy.json')
  })

  it('keeps the development package ahead of the last published update manifest', () => {
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as { name?: string; version?: string; homepage?: string }
    const updateManifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'version.json'), 'utf8')
    ) as { version?: string; downloadhome?: string }

    expect(packageMetadata).toMatchObject({
      name: APP_PACKAGE_NAME,
      version: APP_VERSION,
      homepage: 'https://github.com/296711867/Amy-PPT-Agent'
    })
    expect(updateManifest).toMatchObject({
      version: '1.0.4',
      downloadhome: 'https://github.com/296711867/Amy-PPT-Agent/releases'
    })
  })

  it('uses the Amy-PPT logo animation instead of the legacy generation video', () => {
    const generationPage = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/pages/session-generating.tsx'),
      'utf8'
    )
    const sidebar = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/src/components/layout/Sidebar.tsx'),
      'utf8'
    )

    expect(generationPage).toContain('<AmyLogoMotion />')
    expect(generationPage).not.toContain('video.mp4')
    expect(generationPage).not.toContain('<video')
    expect(sidebar).toContain('alt="Amy-PPT"')
  })

  it('copies the legacy development database once without deleting it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-ppt-brand-'))
    cleanup.push(root)
    const legacyPath = path.join(root, 'ohmyppt.dev.db')
    fs.writeFileSync(legacyPath, 'legacy-settings')

    const resolved = resolveBrandDatabasePath({ isDev: true, cwd: root, userDataPath: root })

    expect(path.basename(resolved.path)).toBe('amy-ppt.dev.db')
    expect(resolved.migratedFrom).toBe(legacyPath)
    expect(fs.readFileSync(resolved.path, 'utf8')).toBe('legacy-settings')
    expect(fs.existsSync(legacyPath)).toBe(true)
    expect(resolveBrandDatabasePath({ isDev: true, cwd: root, userDataPath: root })).toEqual({
      path: resolved.path
    })
  })
})
