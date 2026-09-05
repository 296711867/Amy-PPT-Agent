import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuardedFilesystemBackend } from '../../../src/main/agent-runtime/agent/backend'

vi.mock('../../../src/main/agent-runtime/skills/backend', () => ({
  createProductSkillsMiddlewareSet: vi.fn(() => [])
}))

const temporaryDirectories: string[] = []

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ohmyppt-backend-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true }))
  )
})

describe('GuardedFilesystemBackend selector edit validation', () => {
  it('returns only the editable fragment when a template page is inspected', async () => {
    const projectDir = await createTemporaryDirectory()
    const pagePath = path.join(projectDir, 'page-template.html')
    await fs.promises.writeFile(
      pagePath,
      '<!doctype html><html><head><script>largeRuntime()</script></head><body><main class="ppt-page-root"><div class="ppt-page-content"><section data-page-scaffold="1"><main data-role="content"><figure style="position:absolute">background</figure><section style="position:absolute">editable</section></main></section></div></main><script>largeFooterRuntime()</script></body></html>',
      'utf-8'
    )
    const backend = new GuardedFilesystemBackend({
      rootDir: projectDir,
      virtualMode: true,
      compactTemplatePagePath: '/page-template.html'
    })

    const result = await backend.read('/page-template.html', 0, 1200)

    expect(result.content).toContain('position:absolute')
    expect(result.content).toContain('editable')
    expect(result.content).not.toContain('largeRuntime')
    expect(result.content).not.toContain('data-page-scaffold')
    expect(result.content).not.toContain('data-role="content"')
  })

  it('keeps an accepted selector edit', async () => {
    const rootDir = await createTemporaryDirectory()
    const pagePath = path.join(rootDir, 'page-1.html')
    await fs.promises.writeFile(pagePath, '<p>Old copy</p>', 'utf-8')
    const validateEditedFile = vi.fn(async () => undefined)
    const backend = new GuardedFilesystemBackend({
      rootDir,
      virtualMode: true,
      validateEditedFile
    })

    await expect(backend.edit('/page-1.html', 'Old copy', 'New copy')).resolves.toMatchObject({
      path: '/page-1.html',
      occurrences: 1
    })
    expect(validateEditedFile).toHaveBeenCalledWith('/page-1.html')
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe('<p>New copy</p>')
  })

  it('restores the exact old file when post-edit validation fails', async () => {
    const rootDir = await createTemporaryDirectory()
    const pagePath = path.join(rootDir, 'page-1.html')
    const previousHtml = '<p>Old copy</p><p>Keep this exact shell</p>'
    await fs.promises.writeFile(pagePath, previousHtml, 'utf-8')
    const backend = new GuardedFilesystemBackend({
      rootDir,
      virtualMode: true,
      validateEditedFile: async () => {
        throw new Error('render-text-clipped: body copy is clipped')
      }
    })

    await expect(backend.edit('/page-1.html', 'Old copy', 'New copy')).resolves.toEqual({
      error: 'render-text-clipped: body copy is clipped'
    })
    await expect(fs.promises.readFile(pagePath, 'utf-8')).resolves.toBe(previousHtml)
  })
})
