import { describe, expect, it } from 'vitest'
import {
  buildLayoutAssetFromPageHtml,
  classifyBlocks,
  extractBlocks,
  parametrizePageHtml
} from '../../../src/main/layout-assets/parametrize'
import { fillLayoutAsset } from '../../../src/main/layout-assets/fill'
import {
  normalizeLayoutAsset,
  queryLayoutAssets,
  assignLayoutAssetsToOutline,
  type LayoutAsset
} from '../../../src/shared/layout-asset'

/** 模拟 pptx-import 产出的扁平块页面：标题 + 副标题 + 3 个同带列表项 + 1 个指标 + 1 张图。 */
const fixturePage = `<!doctype html>
<html><head><style>section,figure{position:absolute;}</style></head>
<body>
<main class="ppt-page-root" data-ppt-slide-size-id="wide-16-9">
<section data-block-id="title-1" style="position:absolute;left:80px;top:48px;width:900px;height:70px;font-size:44px;z-index:2">伺服电机市场洞察</section>
<section data-block-id="kicker-1" style="position:absolute;left:80px;top:20px;width:400px;height:24px;font-size:14px;z-index:2">行业研究</section>
<section data-block-id="item-1" style="position:absolute;left:80px;top:300px;width:260px;height:180px;font-size:18px;z-index:2">能效标准趋严</section>
<section data-block-id="item-2" style="position:absolute;left:380px;top:302px;width:262px;height:179px;font-size:18px;z-index:2">国产替代加速</section>
<section data-block-id="item-3" style="position:absolute;left:680px;top:301px;width:258px;height:181px;font-size:18px;z-index:2">高端产能紧缺</section>
<section data-block-id="metric-1" style="position:absolute;left:80px;top:150px;width:200px;height:60px;font-size:36px;z-index:2">42.7%</section>
<section data-block-id="body-1" style="position:absolute;left:80px;top:560px;width:860px;height:120px;font-size:16px;z-index:2">2024-2026 年中国伺服电机市场保持高速增长，下游工业自动化与机器人需求持续拉动高端产能扩张。</section>
<figure data-block-id="vector-1" data-pptx-kind="vector-shape" style="position:absolute;left:0px;top:0px;width:1600px;height:900px;z-index:0"><svg viewBox="0 0 1600 900" aria-hidden="true"><g><rect fill="#f5f1e8" width="1600" height="900"></rect></g></svg></figure>
<figure data-block-id="img-1" style="position:absolute;left:1100px;top:120px;width:400px;height:300px;z-index:1"><img src="./images/photo-1.png" alt="" style="width:100%;height:100%;object-fit:contain;display:block;" /></figure>
</main>
</body></html>`

describe('extractBlocks', () => {
  it('captures flat data-block-id blocks with geometry', () => {
    const blocks = extractBlocks(fixturePage)
    expect(blocks.map((block) => block.slotId)).toEqual([
      'title-1',
      'kicker-1',
      'item-1',
      'item-2',
      'item-3',
      'metric-1',
      'body-1',
      'vector-1',
      'img-1'
    ])
    const title = blocks[0]
    expect(title.kind).toBe('text')
    expect(title.text).toBe('伺服电机市场洞察')
    expect(title.rect.width).toBe(900)
    expect(title.fontSize).toBe(44)
    expect(blocks[7].kind).toBe('vector-shape')
    expect(blocks[8].kind).toBe('image')
  })
})

describe('classifyBlocks', () => {
  it('groups same-band similar blocks into a list slot', () => {
    const blocks = extractBlocks(fixturePage)
    const slots = classifyBlocks(blocks)
    const list = slots.find((slot) => slot.kind === 'list')
    expect(list).toBeTruthy()
    expect((list as { itemSlotIds: string[] }).itemSlotIds).toEqual(['item-1', 'item-2', 'item-3'])

    const title = slots.find((slot) => slot.kind === 'title') as { slotId: string }
    expect(title.slotId).toBe('title-1')

    const metric = slots.find((slot) => slot.kind === 'metric') as { slotId: string }
    expect(metric.slotId).toBe('metric-1')

    const body = slots.find((slot) => slot.kind === 'body') as { slotId: string }
    expect(body.slotId).toBe('body-1')

    const media = slots.find((slot) => slot.kind === 'media') as { aspect: string }
    expect(media.aspect).toBe('landscape')

    // 矢量装饰不成为槽
    expect(slots.some((slot) => slot.slotId === 'vector-1')).toBe(false)
  })
})

describe('parametrizePageHtml + buildLayoutAssetFromPageHtml', () => {
  it('derives capacity and fingerprint, rejecting slot-less pages', () => {
    const result = parametrizePageHtml(fixturePage)
    expect(result).toBeTruthy()
    expect(result!.capacity.moduleMax).toBe(3)
    expect(result!.capacity.moduleMin).toBe(2)
    expect(result!.capacity.mediaSlots).toBe(1)
    expect(result!.structureFingerprint).toMatch(/^v1-/)

    const asset = buildLayoutAssetFromPageHtml({
      html: fixturePage,
      id: 'layout-test-1',
      title: '伺服页',
      roles: ['content'],
      slideSizeId: 'wide-16-9',
      source: 'template',
      skeletonPath: 'skeletons/layout-test-1.html'
    })
    expect(asset).toBeTruthy()
    expect(normalizeLayoutAsset(asset)).toBeTruthy()

    // 纯装饰页（无文本块）不成为版式
    const decorative = parametrizePageHtml(
      '<figure data-block-id="v" data-pptx-kind="vector-shape" style="left:0"><svg></svg></figure>'
    )
    expect(decorative).toBeNull()
  })
})

describe('fillLayoutAsset', () => {
  const asset = buildLayoutAssetFromPageHtml({
    html: fixturePage,
    id: 'layout-fill',
    title: 'fill',
    roles: ['content'],
    slideSizeId: 'wide-16-9',
    source: 'template',
    skeletonPath: 'skeletons/layout-fill.html'
  })!

  it('replaces title/body/metric text deterministically', () => {
    const filled = fillLayoutAsset(asset, fixturePage, {
      title: '新能源行业展望',
      body: '全新正文内容，替换原始长文本。',
      metrics: ['18.2%']
    })
    expect(filled).toContain('新能源行业展望')
    expect(filled).toContain('全新正文内容，替换原始长文本。')
    expect(filled).toContain('18.2%')
    expect(filled).not.toContain('伺服电机市场洞察')
    expect(filled).not.toContain('42.7%')
  })

  it('rebuilds list items with cloned geometry and hides nothing extra', () => {
    const filled = fillLayoutAsset(asset, fixturePage, {
      listItems: ['第一条', '第二条']
    })
    expect(filled).toContain('第一条')
    expect(filled).toContain('第二条')
    expect(filled).not.toContain('能效标准趋严')
    // 两个克隆项，间距来自原布局
    expect(filled).toContain('item-1-item-1')
    expect(filled).toContain('item-1-item-2')
    expect(filled).not.toContain('item-1-item-3')
  })

  it('swaps media src while keeping geometry', () => {
    const filled = fillLayoutAsset(asset, fixturePage, {
      media: [{ src: './images/replaced.png' }]
    })
    expect(filled).toContain('./images/replaced.png')
    expect(filled).toContain('object-fit:contain')
    expect(filled).not.toContain('./images/photo-1.png')
  })

  it('keeps the original sample content when a slot is not provided', () => {
    const filled = fillLayoutAsset(asset, fixturePage, {})
    expect(filled).toContain('伺服电机市场洞察')
    expect(filled).toContain('能效标准趋严')
  })
})

describe('queryLayoutAssets', () => {
  const makeAsset = (id: string, moduleMax: number, roles: string[]): LayoutAsset =>
    normalizeLayoutAsset({
      id,
      version: 1,
      source: 'template',
      roles,
      slideSizeId: 'wide-16-9',
      title: `版式 ${id}`,
      skeletonPath: `skeletons/${id}.html`,
      slots: [
        { kind: 'title', slotId: 't', maxChars: 20, sample: 'x' },
        {
          kind: 'list',
          slotId: 'l',
          itemSlotIds: ['a', 'b', 'c'].map((x) => `${id}-${x}`),
          minItems: 2,
          maxItems: moduleMax,
          perItemMaxChars: 10,
          sample: ['a', 'b']
        }
      ],
      capacity: { titleMaxChars: 20, moduleMin: 2, moduleMax, mediaSlots: 0, hasChart: false },
      structureFingerprint: `v1-${id}`
    })!

  const assets = [
    makeAsset('cover-1', 0, ['cover']),
    makeAsset('content-3', 3, ['content']),
    makeAsset('content-4', 4, ['content']),
    makeAsset('content-6', 6, ['content']),
    makeAsset('ending-1', 0, ['ending'])
  ]

  it('filters by role and module capacity, excluding used ids', () => {
    const matched = queryLayoutAssets(assets, {
      roles: ['content'],
      moduleCount: 3,
      excludeIds: ['content-3']
    })
    // moduleCount=3 落在 content-4/content-6 的 [2,4]/[2,6] 区间；content-3 被排除
    expect(matched.map((asset) => asset.id)).toContain('content-4')
    expect(matched.map((asset) => asset.id)).not.toContain('content-3')
    expect(matched.map((asset) => asset.id)).not.toContain('cover-1')
  })

  it('requires media capacity when requested', () => {
    const matched = queryLayoutAssets(assets, { mediaSlots: 1 })
    expect(matched).toHaveLength(0)
  })

  it('returns deterministic order for the same seed', () => {
    const pool = Array.from({ length: 8 }, (_unused, index) => makeAsset(`m-${index}`, 6, ['content']))
    const first = queryLayoutAssets(pool, { limit: 3, seed: 'deck-1' })
    const second = queryLayoutAssets(pool, { limit: 3, seed: 'deck-1' })
    expect(first.map((asset) => asset.id)).toEqual(second.map((asset) => asset.id))
  })
})

describe('assignLayoutAssetsToOutline', () => {
  const makeAsset = (id: string, roles: string[], moduleMax: number): LayoutAsset =>
    normalizeLayoutAsset({
      id,
      version: 1,
      source: 'template',
      roles,
      slideSizeId: 'wide-16-9',
      title: `版式 ${id}`,
      skeletonPath: `skeletons/${id}.html`,
      slots: [
        { kind: 'title', slotId: 't', maxChars: 20, sample: 'x' },
        {
          kind: 'list',
          slotId: 'l',
          itemSlotIds: ['a', 'b', 'c'].map((x) => `${id}-${x}`),
          minItems: 2,
          maxItems: moduleMax,
          perItemMaxChars: 10,
          sample: ['a', 'b']
        }
      ],
      capacity: { titleMaxChars: 20, moduleMin: 2, moduleMax, mediaSlots: 0, hasChart: false },
      structureFingerprint: `v1-${id}`
    })!

  const library = [
    makeAsset('cover-a', ['cover'], 3),
    makeAsset('content-a', ['content'], 3),
    makeAsset('content-b', ['content'], 4),
    makeAsset('ending-a', ['ending'], 3)
  ]

  it('assigns cover/content/ending by position without reuse and falls back to content', () => {
    const outline = [
      { moduleCount: 3, items: ['a', 'b', 'c'] },
      { moduleCount: 3, items: ['a', 'b', 'c'] },
      { moduleCount: 3, items: ['a', 'b', 'c'] }
    ]
    const assigned = assignLayoutAssetsToOutline(outline, library, { seed: 's' })
    expect(assigned[0]?.roles).toContain('cover')
    expect(assigned[1]?.roles).toContain('content')
    expect(assigned[2]?.roles).toContain('ending')
    // 整 deck 不重复
    const ids = assigned.filter(Boolean).map((asset) => asset!.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves pages null when items cannot satisfy list capacity', () => {
    const assigned = assignLayoutAssetsToOutline(
      [{ moduleCount: 3, items: ['only-one'] }],
      library,
      { seed: 's' }
    )
    // 唯一列表版式 minItems=2，单要点配不上
    expect(assigned[0]).toBeNull()
  })

  it('returns all null for an empty library (creative fallback)', () => {
    const assigned = assignLayoutAssetsToOutline(
      [
        { moduleCount: 3, items: ['a', 'b', 'c'] },
        { moduleCount: 3, items: ['a', 'b', 'c'] }
      ],
      [],
      { seed: 's' }
    )
    expect(assigned).toEqual([null, null])
  })
})

describe('blankMetricSlots', () => {
  it('replaces metric samples with a dash to avoid fabricated numbers', async () => {
    const { blankMetricSlots } = await import('../../../src/main/layout-assets/fill')
    const asset = buildLayoutAssetFromPageHtml({
      html: fixturePage,
      id: 'layout-metric',
      title: 'm',
      roles: ['content'],
      slideSizeId: 'wide-16-9',
      source: 'template',
      skeletonPath: 'skeletons/m.html'
    })!
    const blanked = blankMetricSlots(asset, fixturePage)
    expect(blanked).toContain('—')
    expect(blanked).not.toContain('42.7%')
  })
})
