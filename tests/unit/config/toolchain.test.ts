import fs from 'fs'
import { describe, expect, it } from 'vitest'

describe('repository toolchain contract', () => {
  it('pins pnpm and keeps pnpm settings in the workspace configuration', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const workspace = fs.readFileSync('pnpm-workspace.yaml', 'utf8')

    expect(packageJson.packageManager).toBe('pnpm@10.10.0')
    expect(packageJson.engines.pnpm).toBe('>=10.0.0 <11.0.0')
    expect(packageJson.pnpm).toBeUndefined()
    expect(workspace).toContain('onlyBuiltDependencies:')
    expect(workspace).toContain('overrides:')
    expect(workspace).toContain("'@langchain/core': ^1.1.47")
  })

  it('uses npmrc syntax for Electron mirrors and pnpm for nested scripts', () => {
    const npmrc = fs.readFileSync('.npmrc', 'utf8')
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))

    expect(npmrc).not.toContain('export ')
    expect(npmrc).toContain('electron_mirror=https://')
    expect(npmrc).toContain('electron_builder_binaries_mirror=https://')
    expect(packageJson.scripts.typecheck).toContain('pnpm run typecheck:node')
    expect(packageJson.scripts['build:win']).toContain('pnpm run build')
  })

  it('does not ship the unused in-app updater dependency', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')

    expect(packageJson.dependencies['electron-updater']).toBeUndefined()
    expect(lockfile).not.toContain('electron-updater@')
    expect(lockfile).not.toMatch(/^\s+electron-updater:/m)
  })

  it('does not keep retired UI and preload packages as direct dependencies', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
    const retiredDirectDependencies = [
      '@electron-toolkit/preload',
      '@radix-ui/react-progress',
      '@radix-ui/react-slot',
      '@radix-ui/react-toast',
      '@tanstack/react-virtual',
      'class-variance-authority'
    ]

    for (const dependency of retiredDirectDependencies) {
      expect(packageJson.dependencies[dependency], dependency).toBeUndefined()
      expect(lockfile, dependency).not.toMatch(
        new RegExp(`^ {6}${dependency.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:`, 'm')
      )
    }
  })
})
