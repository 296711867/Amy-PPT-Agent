import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8')

/**
 * 模板生成链路的选项契约（源码契约测试）：
 * - 大纲在创建会话时随元数据持久化，生成页在路由 state 缺失时兜底；
 * - 配图策略显式落库，模板链路默认 'none'（沿用模板视觉）；
 * - 动画偏好贯穿 renderer payload → run 持久化 → 模板重试继承 → 单页 runner。
 */
describe('template generation option contracts', () => {
  it('persists the initial prompt and image policy on session creation', () => {
    const service = readSource('src/main/templates/template-service.ts')

    expect(service).toContain('record.initialPrompt')
    expect(service).toContain('templateInitialPrompt')
    expect(service).toContain("normalizeImagePolicy(record.imagePolicy)")
    expect(service).toContain("'none' as const")
  })

  it('carries animation preferences through the template deck flow', () => {
    const flow = readSource('src/main/generation/template-deck-flow.ts')

    // run 持久化：与 deck-flow 一致，写入 generation run 供重试继承
    expect(flow).toContain('animationPreferences: context.animationPreferences')
    // 模板重试：路由 state 丢失时从最近 run 继承
    expect(flow).toContain('resolveInheritedAnimationPreferences(')
  })

  it('recovers the persisted template prompt when router state is gone', () => {
    const page = readSource('src/renderer/src/pages/session-generating.tsx')

    expect(page).toContain('parseSessionMetadata(snapshot.metadata).templateInitialPrompt')
    // 手动开始意图包含恢复出来的模板大纲，避免被“已完成/无有效页面”分支拦截
    expect(page).toContain('templateInitialPrompt')
    // 模板分支同样传动画偏好
    expect(page.match(/startTemplateGenerate\(/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('sends the options from the template use dialog', () => {
    const dialog = readSource('src/renderer/src/components/templates/TemplateUseDialog.tsx')

    expect(dialog).toContain('initialPrompt,')
    expect(dialog).toContain('imagePolicy')
    expect(dialog).toContain('AnimationPreferenceChips')
    expect(dialog).toContain('normalizeAnimationPreferences(selectedAnimationPreferenceIds)')
  })

  it('keeps the none policy out of image-slot forcing and deck-image injection', () => {
    const assignment = readSource('src/main/generation/image-slot-assignment.ts')
    const images = readSource('src/main/generation/deck-images.ts')
    const deckFlow = readSource('src/main/generation/deck-flow.ts')

    expect(assignment).toContain("imagePolicy !== 'placeholder' && imagePolicy !== 'ai'")
    expect(images).toContain("args.imagePolicy === 'none'")
    // 'none' 明确不要求配图，不应触发“要图不给图”告警
    expect(deckFlow).toContain("context.imagePolicy !== 'none'")
  })

  it('teaches the model edit-in-place for imported template pages (I-17)', () => {
    const addenda = readSource('src/main/generation/template-prompt-addenda.ts')
    const writer = readSource('src/main/agent-runtime/tools/page-writer.ts')
    const feedback = readSource('src/main/presentation/html/page-writer-core.ts')

    // 提示词与工具描述必须教“保留顶层分区容器、原位替换文字、克隆条目、禁止自带 main 包裹”
    for (const source of [addenda, writer]) {
      expect(source).toMatch(/edit[- ]in[- ]place/i)
      expect(source).toMatch(/clone (?:or delete |existing )?entry containers|克隆.{0,12}条目容器/)
      expect(source).toMatch(/your own <main>|自定义 <main>/)
    }
    // 写入失败反馈同样要给出可执行的原位编辑策略
    expect(feedback).toContain('原位编辑')
    expect(feedback).toContain('直接子元素')
  })
})
