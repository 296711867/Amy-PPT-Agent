import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prepareDeckImageAssets,
  resolveDeckImageGenerationSize
} from '../../../src/main/generation/deck-images'

const generateImage = vi.fn(async () => [
  {
    bytes: Buffer.from('generated-image'),
    mimeType: 'image/png',
    extension: '.png'
  }
])

vi.mock('../../../src/main/agent-runtime/provider/image', () => ({
  resolveImageGenerationProvider: () => ({ generate: generateImage })
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  generateImage.mockClear()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true })
    )
  )
})

describe('deck image preparation', () => {
  const imageOutline = [
    {
      title: 'Five-part overview',
      contentOutline: 'One; Two; Three; Four; Five',
      layoutIntent: 'image-focus' as const,
      layoutId: 'five-cards-2-3-image'
    },
    {
      title: 'Four points',
      contentOutline: 'One; Two; Three; Four',
      layoutIntent: 'concept' as const,
      layoutId: 'four-cards-grid'
    }
  ]

  it('derives image generation size from the selected layout geometry', () => {
    expect(resolveDeckImageGenerationSize('six-images-row-portrait')).toBe('3:4')
    expect(resolveDeckImageGenerationSize('image-left-two-cards')).toBe('3:4')
    expect(resolveDeckImageGenerationSize('four-images-grid-square')).toBe('1:1')
    expect(resolveDeckImageGenerationSize('five-images-2-3')).toBe('16:9')
    expect(resolveDeckImageGenerationSize('four-cards-grid')).toBe('16:9')
  })

  it('uses the bundled placeholder when AI image generation is disabled', async () => {
    const onStatus = vi.fn()
    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig: vi.fn() },
      decryptApiKey: (value) => value,
      projectDir: process.cwd(),
      imagePolicy: 'placeholder',
      outlineItems: imageOutline,
      signal: new AbortController().signal,
      onStatus
    })

    expect(result[0].imageAssetPath).toBe('./assets/amy-image-placeholder.png')
    expect(result[1].imageAssetPath).toBeUndefined()
    expect(onStatus).toHaveBeenCalledWith({ pageNumber: 1, state: 'placeholder' })
  })

  it("injects nothing under the 'none' policy, even for image-slot layouts", async () => {
    const onStatus = vi.fn()
    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig: vi.fn() },
      decryptApiKey: (value) => value,
      projectDir: process.cwd(),
      imagePolicy: 'none',
      outlineItems: imageOutline,
      signal: new AbortController().signal,
      onStatus
    })

    expect(result).toEqual(imageOutline)
    expect(result[0].imageAssetPath).toBeUndefined()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('falls back to the placeholder when no image model is configured', async () => {
    const onStatus = vi.fn()
    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig: vi.fn().mockResolvedValue(undefined) },
      decryptApiKey: (value) => value,
      projectDir: process.cwd(),
      imagePolicy: 'ai',
      outlineItems: imageOutline,
      signal: new AbortController().signal,
      onStatus
    })

    expect(result[0]).toMatchObject({
      imagePolicy: 'ai',
      imageAssetPath: './assets/amy-image-placeholder.png'
    })
    expect(onStatus).toHaveBeenCalledWith({
      pageNumber: 1,
      state: 'placeholder',
      detail: 'No active image model'
    })
  })

  it('replaces a retry placeholder with a generated BBT image for the original page number', async () => {
    vi.stubEnv('BBT_IMAGE_API_KEY', 'environment-key')
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-retry-image-'))
    temporaryDirectories.push(projectDir)
    const onStatus = vi.fn()
    const decryptApiKey = vi.fn(() => {
      throw new Error('the BBT environment profile must not decrypt old ciphertext')
    })

    const result = await prepareDeckImageAssets({
      db: {
        getActiveImageModelConfig: vi.fn(async () => ({
          id: 'codex-bbt-image-model',
          name: 'BBT · GPT Image 2',
          provider: 'agnes',
          active: 1,
          modelConfig: 'enc:v1:old-user-ciphertext'
        }))
      },
      decryptApiKey,
      projectDir,
      imagePolicy: 'ai',
      outlineItems: [
        {
          title: 'Lake environments',
          contentOutline: 'Three distinct fishing locations',
          layoutIntent: 'image-focus',
          layoutId: 'image-left-two-cards',
          imageAssetPath: './assets/amy-image-placeholder.png',
          imageAssetPaths: ['./assets/amy-image-placeholder.png']
        }
      ],
      pageNumbers: [5],
      signal: new AbortController().signal,
      onStatus
    })

    expect(result[0].imageAssetPath).toMatch(/^\.\/images\/deck-5-slot-1-/)
    expect(result[0].imageAssetPath).not.toBe('./assets/amy-image-placeholder.png')
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: expect.objectContaining({ model: 'gpt-image-2' })
      }),
      expect.objectContaining({ count: 1 })
    )
    expect(onStatus).toHaveBeenCalledWith({ pageNumber: 5, state: 'generated' })
    expect(decryptApiKey).not.toHaveBeenCalled()
  })

  it('creates one replaceable placeholder per gallery slot', async () => {
    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig: vi.fn() },
      decryptApiKey: (value) => value,
      projectDir: process.cwd(),
      imagePolicy: 'placeholder',
      outlineItems: [
        {
          title: 'Six examples',
          contentOutline: 'One; Two; Three; Four; Five; Six',
          layoutIntent: 'image-focus',
          layoutId: 'six-images-grid'
        }
      ],
      signal: new AbortController().signal
    })

    expect(result[0].imageAssetPaths).toHaveLength(6)
    expect(result[0].imageAssetPaths).toEqual(
      Array.from({ length: 6 }, () => './assets/amy-image-placeholder.png')
    )
  })

  it('reuses a complete generated image set instead of regenerating it', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-existing-images-'))
    temporaryDirectories.push(projectDir)
    await fs.promises.mkdir(path.join(projectDir, 'images'), { recursive: true })
    await Promise.all([
      fs.promises.writeFile(path.join(projectDir, 'images', 'one.png'), 'one'),
      fs.promises.writeFile(path.join(projectDir, 'images', 'two.png'), 'two')
    ])
    const getActiveImageModelConfig = vi.fn()
    const existingPaths = ['./images/one.png', './images/two.png']
    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig },
      decryptApiKey: (value) => value,
      projectDir,
      imagePolicy: 'ai',
      outlineItems: [
        {
          title: 'Two examples',
          contentOutline: 'One; Two',
          layoutIntent: 'image-focus',
          layoutId: 'two-images-caption',
          imageAssetPath: existingPaths[0],
          imageAssetPaths: existingPaths
        }
      ],
      signal: new AbortController().signal
    })

    expect(result[0].imageAssetPaths).toEqual(existingPaths)
    expect(getActiveImageModelConfig).not.toHaveBeenCalled()
  })

  it('regenerates image paths whose files are missing from the session project', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-missing-images-'))
    temporaryDirectories.push(projectDir)

    const result = await prepareDeckImageAssets({
      db: {
        getActiveImageModelConfig: vi.fn(async () => ({
          id: 'active-image-model',
          name: 'Image model',
          provider: 'agnes',
          active: 1,
          modelConfig: JSON.stringify({ model: 'image-model', apiKey: 'key' })
        }))
      },
      decryptApiKey: (value) => value,
      projectDir,
      imagePolicy: 'ai',
      outlineItems: [
        {
          title: 'Missing image file',
          contentOutline: 'The database path exists but the file does not',
          layoutIntent: 'image-focus',
          layoutId: 'image-left-two-cards',
          imageAssetPath: './images/missing.png',
          imageAssetPaths: ['./images/missing.png']
        }
      ],
      signal: new AbortController().signal
    })

    expect(generateImage).toHaveBeenCalledTimes(1)
    expect(result[0].imageAssetPath).toMatch(/^\.\/images\/deck-1-slot-1-/)
  })

  it('keeps complete image pages when another page falls back to placeholders', async () => {
    const projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amy-mixed-images-'))
    temporaryDirectories.push(projectDir)
    await fs.promises.mkdir(path.join(projectDir, 'images'), { recursive: true })
    await Promise.all([
      fs.promises.writeFile(path.join(projectDir, 'images', 'one.png'), 'one'),
      fs.promises.writeFile(path.join(projectDir, 'images', 'two.png'), 'two')
    ])
    const existingPaths = ['./images/one.png', './images/two.png']

    const result = await prepareDeckImageAssets({
      db: { getActiveImageModelConfig: vi.fn().mockResolvedValue(undefined) },
      decryptApiKey: (value) => value,
      projectDir,
      imagePolicy: 'ai',
      outlineItems: [
        {
          title: 'Complete gallery',
          contentOutline: 'Two existing visuals',
          layoutIntent: 'image-focus',
          layoutId: 'two-images-caption',
          imageAssetPath: existingPaths[0],
          imageAssetPaths: existingPaths
        },
        {
          title: 'Missing visual',
          contentOutline: 'One unavailable visual',
          layoutIntent: 'image-focus',
          layoutId: 'image-left-two-cards'
        }
      ],
      signal: new AbortController().signal
    })

    expect(result[0].imageAssetPaths).toEqual(existingPaths)
    expect(result[1].imageAssetPaths).toEqual(['./assets/amy-image-placeholder.png'])
  })
})
