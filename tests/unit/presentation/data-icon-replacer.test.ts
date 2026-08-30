import { describe, expect, it } from 'vitest'
import { replaceDataIcons } from '../../../src/main/presentation/icons/data-icon-replacer'

describe('replaceDataIcons', () => {
  it('auto-corrects an unknown id with a unique prefix match (I-9)', () => {
    // 实测：模型反复写 data-icon="graduation"，三次重试全部耗尽整页失败
    const html = '<svg data-icon="graduation" class="w-12 h-12"></svg>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toEqual([])
    expect(out).toMatch(/<path[^>]*d="/)
    expect(out).not.toContain('data-icon')
  })

  it('keeps an ambiguous unknown id for the validator to report', () => {
    // "arrow" 有多个前缀命中（arrow-up/arrow-down/...），不能猜
    const html = '<svg data-icon="arrow"></svg>'
    const { unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toContain('arrow')
  })

  it('replaces a known icon id with inline lucide svg, preserving class', () => {
    const html = '<div><svg data-icon="rocket" class="w-12 h-12 text-blue-500"></svg></div>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toEqual([])
    // 替换后含真实 path
    expect(out).toMatch(/<path[^>]*d="/)
    // 保留原 class
    expect(out).toContain('w-12 h-12 text-blue-500')
    // 注入 viewBox 和描边属性
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('stroke="currentColor"')
    // 移除 data-icon
    expect(out).not.toContain('data-icon')
  })

  it('preserves presentation, accessibility, and animation metadata', () => {
    const html =
      '<svg data-icon="star" class="w-10 h-10" style="color:red" aria-label="Featured" data-motion="bounce"></svg>'
    const { html: out } = replaceDataIcons(html)
    expect(out).toContain('style="color:red"')
    expect(out).toContain('w-10 h-10')
    expect(out).toContain('aria-label="Featured"')
    expect(out).toContain('data-motion="bounce"')
    expect(out).toMatch(/<path/)
  })

  it('keeps only safe root attributes and replaces untrusted children', () => {
    const html =
      '<svg data-icon="rocket" class="w-12 h-12" aria-label="Launch" data-anim="fade-up" data-unknown="drop" onclick="alert(1)" href="https://example.com/icon.svg" xlink:href="https://example.com/sprite.svg#rocket"><script>alert(2)</script><circle data-old-child="1"/></svg>'
    const { html: out, unknownIds } = replaceDataIcons(html)

    expect(unknownIds).toEqual([])
    expect(out).not.toMatch(/onclick=/i)
    expect(out).not.toMatch(/(?:xlink:)?href=/i)
    expect(out).not.toContain('data-unknown')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('data-old-child')
    expect(out).toContain('aria-label="Launch"')
    expect(out).toContain('data-anim="fade-up"')
    expect(out).toMatch(/<path[^>]*d="/)
  })

  it('drops styles that can load external resources while preserving normal color styles', () => {
    const unsafe = replaceDataIcons(
      '<svg data-icon="rocket" style="filter:url(https://example.com/filter.svg#x);color:red"></svg>'
    ).html
    const safe = replaceDataIcons('<svg data-icon="rocket" style="color:red"></svg>').html

    expect(unsafe).not.toContain('style=')
    expect(unsafe).not.toContain('example.com')
    expect(safe).toContain('style="color:red"')
  })

  it('keeps an empty id for validation instead of silently deleting it', () => {
    const html = '<svg data-icon="  " class="w-8 h-8"></svg>'
    const { html: out, unknownIds } = replaceDataIcons(html)

    expect(unknownIds).toEqual(['(empty)'])
    expect(out).toContain('data-icon="  "')
  })

  it('does not convert data-icon references on non-svg elements', () => {
    const html = '<div data-icon="rocket" class="w-12 h-12"></div>'
    const { html: out, unknownIds } = replaceDataIcons(html)

    expect(unknownIds).toEqual(['rocket'])
    expect(out).toContain('<div data-icon="rocket"')
    expect(out).not.toMatch(/<path/)
  })

  it('leaves unknown icon ids untouched and reports them', () => {
    const html = '<svg data-icon="totally-fake-icon-xyz" class="w-8 h-8"></svg>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toEqual(['totally-fake-icon-xyz'])
    // 原样保留（未替换）
    expect(out).toContain('data-icon="totally-fake-icon-xyz"')
    expect(out).not.toMatch(/<path/)
  })

  it('handles a mix of known and unknown icons', () => {
    const html =
      '<div><svg data-icon="rocket" class="w-12 h-12"></svg><svg data-icon="fake-xyz"></svg></div>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toEqual(['fake-xyz'])
    // rocket 已替换
    expect(out).toMatch(/<path/)
    // fake 保留
    expect(out).toContain('data-icon="fake-xyz"')
  })

  it('returns html unchanged when no data-icon present (fast path)', () => {
    const html = '<div><p>no icons here</p><svg><circle cx="12" cy="12" r="10"/></svg></div>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(out).toBe(html)
    expect(unknownIds).toEqual([])
  })

  it('works on a full persisted-style document with section/main', () => {
    const html =
      '<div class="ppt-page-root"><section data-page-scaffold="1"><main data-role="content">' +
      '<div class="px-24"><svg data-icon="check" class="w-6 h-6 text-green-600"></svg></div>' +
      '</main></section></div>'
    const { html: out, unknownIds } = replaceDataIcons(html)
    expect(unknownIds).toEqual([])
    expect(out).toMatch(/<path/)
    expect(out).toContain('text-green-600')
    expect(out).toContain('px-24')
    expect(out).not.toContain('data-icon')
  })
})
