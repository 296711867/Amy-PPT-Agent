import { useEffect, useState } from 'react'
import { BookOpenText, Frame, LayoutTemplate, RotateCcw, Save, Shapes, Type } from 'lucide-react'
import {
  DEFAULT_LAYOUT_RULES,
  PPT_PATTERN_GROUPS,
  normalizeLayoutRules,
  type ContentModuleStyle,
  type LayoutDensity,
  type LayoutRulePreset,
  type LayoutRulesProfile,
  type PptCompositionMode,
  type PptPatternId,
  type SummaryLineMode,
  type SlideSubtitleMode
} from '@shared/layout-rules'
import { useLang } from '@renderer/i18n'
import { useSettingsStore, useToastStore } from '@renderer/store'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Input, Textarea } from '../ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select'

type SelectOption<T extends string> = {
  value: T
  label: string
}

const PATTERN_COPY: Record<
  PptPatternId,
  { zh: [name: string, description: string]; en: [name: string, description: string] }
> = {
  'hero-title-center': {
    zh: ['居中主标题', '封面、章节页或一句核心主张'],
    en: ['Centered hero title', 'Cover, section opener, or one central claim']
  },
  'hero-title-asymmetric': {
    zh: ['非对称主标题', '标题与短说明形成主次分区'],
    en: ['Asymmetric hero title', 'Unequal title and context zones']
  },
  'hero-big-number': {
    zh: ['封面大数字', '用一个数字或年份建立第一焦点'],
    en: ['Hero number', 'One metric or year as the first focal point']
  },
  'section-divider': {
    zh: ['章节过渡', '低密度章节名称与范围提示'],
    en: ['Section divider', 'Low-density chapter transition']
  },
  'hero-quote': {
    zh: ['引语主视觉', '一句原话、判断或品牌主张'],
    en: ['Hero quote', 'One quote, assertion, or brand statement']
  },
  'summary-takeaways': {
    zh: ['结论与要点', '一条结论带 2–4 个支撑要点'],
    en: ['Summary takeaways', 'One conclusion with 2–4 supports']
  },
  'executive-brief': {
    zh: ['高管摘要', '结论、关键数据与行动三层结构'],
    en: ['Executive brief', 'Conclusion, evidence, and action bands']
  },
  'conclusion-with-proof': {
    zh: ['结论与证据', '强结论配一组精简证明材料'],
    en: ['Conclusion with proof', 'Strong conclusion with concise proof']
  },
  'kpi-hero': {
    zh: ['核心 KPI', '一个指标主导，少量基准辅助'],
    en: ['KPI hero', 'One dominant KPI with compact context']
  },
  'metric-band': {
    zh: ['指标带', '3–6 个同权重指标横向展开'],
    en: ['Metric band', '3–6 equal-weight metrics in one band']
  },
  'trend-exhibit': {
    zh: ['趋势展板', '主图表占据视觉中心，旁带洞察'],
    en: ['Trend exhibit', 'Dominant chart with compact insight support']
  },
  'chart-annotated': {
    zh: ['标注图表', '用 1–3 条标注解释图表关键点'],
    en: ['Annotated chart', 'Chart explained by 1–3 callouts']
  },
  'big-number-evidence': {
    zh: ['大数字证据', '一个核心数字带依据、变化或意义'],
    en: ['Big number evidence', 'Hero metric with basis, delta, or meaning']
  },
  'compare-two-zone': {
    zh: ['双区对比', '前后、A/B 或两种状态公平比较'],
    en: ['Two-zone comparison', 'Before/after, A/B, or two states']
  },
  'compare-options': {
    zh: ['多方案比较', '3–4 个方案按相同维度比较'],
    en: ['Option comparison', 'Compare 3–4 options on shared dimensions']
  },
  'decision-matrix': {
    zh: ['决策矩阵', '选项与评价标准形成矩阵'],
    en: ['Decision matrix', 'Options evaluated against shared criteria']
  },
  'comparison-axis': {
    zh: ['对比轴', '沿一条尺度展示差异与位置'],
    en: ['Comparison axis', 'Differences positioned along one scale']
  },
  'concept-center-satellites': {
    zh: ['中心与卫星', '一个核心概念连接 3–6 个侧面'],
    en: ['Center and satellites', 'One concept with 3–6 facets']
  },
  'framework-2x2': {
    zh: ['2×2 框架', '双轴四象限定位问题或策略'],
    en: ['2x2 framework', 'Two axes and four quadrants']
  },
  'framework-pyramid': {
    zh: ['层级金字塔', '3–5 层递进、依赖或优先级'],
    en: ['Framework pyramid', '3–5 levels of hierarchy or priority']
  },
  'central-radiation': {
    zh: ['中心辐射', '中心主题向外展开多个关系节点'],
    en: ['Central radiation', 'A central idea radiating to related nodes']
  },
  'process-linear': {
    zh: ['线性流程', '3–6 个有明确先后关系的步骤'],
    en: ['Linear process', '3–6 clearly ordered steps']
  },
  'process-loop': {
    zh: ['循环流程', '持续改进、生命周期等闭环关系'],
    en: ['Process loop', 'Recurring cycle or continuous improvement']
  },
  'staircase-strips': {
    zh: ['阶梯信息条', '3–5 个横向扁平模块逐级错位'],
    en: ['Staircase strips', '3–5 flat strips with progressive offsets']
  },
  'diagonal-progression': {
    zh: ['斜向递进', '用斜向阅读动线表达演进或升级'],
    en: ['Diagonal progression', 'Evolution or growth on a diagonal path']
  },
  'timeline-strip': {
    zh: ['时间轴', '阶段、里程碑或路线图'],
    en: ['Timeline strip', 'Phases, milestones, or roadmap']
  },
  'asset-image-hero': {
    zh: ['图片主视觉', '已有图片或截图承担主要论证'],
    en: ['Image hero', 'Existing image or screenshot as the argument']
  },
  'asset-text-visual-split': {
    zh: ['图文分区', '图片与叙事文字同等重要'],
    en: ['Text-visual split', 'Image and narrative carry equal weight']
  },
  'image-led-story': {
    zh: ['图片叙事', '图片先建立情境，文字只做解释'],
    en: ['Image-led story', 'Image establishes context before the copy']
  }
}

const GROUP_COPY = {
  message: { zh: '封面、主张与结论', en: 'Message and conclusion' },
  evidence: { zh: '数据、证据与比较', en: 'Evidence and comparison' },
  structure: { zh: '概念、流程与演进', en: 'Concepts and progression' },
  visual: { zh: '图片叙事', en: 'Visual storytelling' }
} as const

export function LayoutRulesSettingsTab(): React.JSX.Element {
  const { lang, t } = useLang()
  const { settings, saveSettings, setVerificationMessage } = useSettingsStore()
  const { success, error, info } = useToastStore()
  const [draft, setDraft] = useState<LayoutRulesProfile>(() =>
    normalizeLayoutRules(useSettingsStore.getState().settings?.layoutRules)
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings?.layoutRules) setDraft(normalizeLayoutRules(settings.layoutRules))
  }, [settings?.layoutRules])

  const presetOptions: Array<SelectOption<LayoutRulePreset>> = [
    { value: 'professional', label: t('settings.layoutPresetProfessional') },
    { value: 'consulting', label: t('settings.layoutPresetConsulting') },
    { value: 'keynote', label: t('settings.layoutPresetKeynote') },
    { value: 'teaching', label: t('settings.layoutPresetTeaching') },
    { value: 'custom', label: t('settings.layoutPresetCustom') }
  ]
  const densityOptions: Array<SelectOption<LayoutDensity>> = [
    { value: 'spacious', label: t('settings.layoutDensitySpacious') },
    { value: 'balanced', label: t('settings.layoutDensityBalanced') },
    { value: 'compact', label: t('settings.layoutDensityCompact') }
  ]
  const compositionOptions: Array<SelectOption<PptCompositionMode>> = [
    { value: 'native-ppt', label: t('settings.layoutCompositionNative') },
    { value: 'balanced', label: t('settings.layoutCompositionBalanced') },
    { value: 'freeform', label: t('settings.layoutCompositionFreeform') }
  ]
  const moduleStyleOptions: Array<SelectOption<ContentModuleStyle>> = [
    { value: 'flat', label: t('settings.layoutModuleFlat') },
    { value: 'light-panels', label: t('settings.layoutModulePanels') },
    { value: 'adaptive', label: t('settings.layoutModuleAdaptive') }
  ]
  const summaryOptions: Array<SelectOption<SummaryLineMode>> = [
    { value: 'contextual', label: t('settings.layoutSummaryContextual') },
    { value: 'always', label: t('settings.layoutSummaryAlways') },
    { value: 'off', label: t('settings.layoutSummaryOff') }
  ]
  const subtitleOptions: Array<SelectOption<SlideSubtitleMode>> = [
    { value: 'on', label: t('settings.layoutSubtitleOn') },
    { value: 'content-off', label: t('settings.layoutSubtitleContentOff') },
    { value: 'off', label: t('settings.layoutSubtitleOff') }
  ]

  const updateDraft = (patch: Partial<LayoutRulesProfile>): void => {
    setDraft((current) => normalizeLayoutRules({ ...current, ...patch }))
    setVerificationMessage(null)
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setVerificationMessage(null)
    try {
      await saveSettings({ layoutRules: normalizeLayoutRules(draft) })
      const saveError = useSettingsStore.getState().verificationMessage
      if (saveError) {
        error(t('settings.layoutSaveFailed'), { description: saveError })
        return
      }
      success(t('settings.layoutSaved'), { description: t('settings.layoutSavedDescription') })
    } finally {
      setSaving(false)
    }
  }

  const handleRestoreDefaults = (): void => {
    setDraft({ ...DEFAULT_LAYOUT_RULES, enabledPatterns: [...DEFAULT_LAYOUT_RULES.enabledPatterns] })
    setVerificationMessage(null)
    info(t('settings.layoutDefaultsRestored'))
  }

  const renderSelect = <T extends string>(
    label: string,
    value: T,
    options: Array<SelectOption<T>>,
    onChange: (value: T) => void
  ): React.JSX.Element => (
    <div className="min-w-0">
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={!draft.enabled}>
        <SelectTrigger className="h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  type NumberKey = keyof Pick<
    LayoutRulesProfile,
    | 'safeAreaHorizontalPercent'
    | 'safeAreaVerticalPercent'
    | 'deckTitleSize'
    | 'slideTitleSize'
    | 'slideSubtitleSize'
    | 'moduleTitleSize'
    | 'bodySize'
    | 'emphasisSize'
    | 'auxiliarySize'
    | 'maxContentBlocks'
    | 'heroMinPercent'
    | 'cardGap'
    | 'cardPadding'
    | 'titleContentGap'
    | 'sectionGap'
    | 'staircaseOffset'
    | 'iconBoxSize'
    | 'moduleTitleBodyGap'
  >

  const renderNumberInput = (
    label: string,
    key: NumberKey,
    min: number,
    max: number,
    suffix: string
  ): React.JSX.Element => (
    <div className="min-w-0">
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          value={draft[key]}
          disabled={!draft.enabled}
          onChange={(event) => updateDraft({ [key]: Number(event.target.value) })}
          className="h-10 pr-12"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  )

  const togglePattern = (patternId: PptPatternId, checked: boolean): void => {
    const next = checked
      ? [...draft.enabledPatterns, patternId]
      : draft.enabledPatterns.filter((item) => item !== patternId)
    updateDraft({ enabledPatterns: next })
  }

  return (
    <div className="w-full min-w-0 max-w-full overflow-x-hidden divide-y divide-border">
      <section className="pb-7">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <LayoutTemplate className="h-4 w-4 text-primary" />
              {t('settings.layoutDirectionTitle')}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('settings.layoutDirectionHint')}
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={draft.enabled}
              onCheckedChange={(checked) => updateDraft({ enabled: checked === true })}
            />
            {t('settings.layoutEnabled')}
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {renderSelect(t('settings.layoutPreset'), draft.preset, presetOptions, (preset) =>
            updateDraft({ preset })
          )}
          {renderSelect(
            t('settings.layoutCompositionMode'),
            draft.compositionMode,
            compositionOptions,
            (compositionMode) => updateDraft({ compositionMode })
          )}
          {renderSelect(
            t('settings.layoutModuleStyle'),
            draft.contentModuleStyle,
            moduleStyleOptions,
            (contentModuleStyle) => updateDraft({ contentModuleStyle })
          )}
          {renderSelect(t('settings.layoutDensity'), draft.density, densityOptions, (density) =>
            updateDraft({ density })
          )}
          {renderNumberInput(t('settings.layoutMaxBlocks'), 'maxContentBlocks', 2, 6, '')}
          {renderNumberInput(t('settings.layoutHeroPercent'), 'heroMinPercent', 30, 70, '%')}
          {renderSelect(
            t('settings.layoutSummaryMode'),
            draft.summaryLineMode,
            summaryOptions,
            (summaryLineMode) => updateDraft({ summaryLineMode })
          )}
          {renderSelect(
            t('settings.layoutSubtitleMode'),
            draft.subtitleMode,
            subtitleOptions,
            (subtitleMode) => updateDraft({ subtitleMode })
          )}
        </div>
      </section>

      <section className="py-7">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Frame className="h-4 w-4 text-primary" />
          {t('settings.layoutSafeAreaTitle')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('settings.layoutCanvasHint')}
        </p>
        <div className="mt-5 grid gap-6 2xl:grid-cols-[minmax(0,1fr)_300px] 2xl:items-start">
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {renderNumberInput(
              t('settings.layoutSafeHorizontal'),
              'safeAreaHorizontalPercent',
              8,
              14,
              '%'
            )}
            {renderNumberInput(
              t('settings.layoutSafeVertical'),
              'safeAreaVerticalPercent',
              10,
              18,
              '%'
            )}
            {renderNumberInput(t('settings.layoutTitleContentGap'), 'titleContentGap', 24, 64, 'px')}
            {renderNumberInput(t('settings.layoutSectionGap'), 'sectionGap', 32, 80, 'px')}
            {renderNumberInput(t('settings.layoutModuleGap'), 'cardGap', 16, 40, 'px')}
            {renderNumberInput(t('settings.layoutModulePadding'), 'cardPadding', 16, 40, 'px')}
          </div>
          <div>
            <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-[var(--ui-surface-muted)] shadow-inner">
              <div
                className="absolute border border-dashed border-primary/70 bg-primary/10"
                style={{
                  left: `${draft.safeAreaHorizontalPercent}%`,
                  right: `${draft.safeAreaHorizontalPercent}%`,
                  top: `${draft.safeAreaVerticalPercent}%`,
                  bottom: `${draft.safeAreaVerticalPercent}%`
                }}
              >
                <div className="flex h-full items-center justify-center px-3 text-center text-xs font-medium text-foreground">
                  {t('settings.layoutSafeAreaPreview')}
                </div>
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              {t('settings.layoutSafeAreaPreviewHint')}
            </p>
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <h4 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Type className="h-4 w-4 text-primary" />
            {t('settings.layoutTypographyTitle')}
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            {renderNumberInput(t('settings.layoutDeckTitleSize'), 'deckTitleSize', 48, 88, 'px')}
            {renderNumberInput(t('settings.layoutSlideTitleSize'), 'slideTitleSize', 32, 56, 'px')}
            {renderNumberInput(
              t('settings.layoutSlideSubtitleSize'),
              'slideSubtitleSize',
              22,
              36,
              'px'
            )}
            {renderNumberInput(
              t('settings.layoutModuleTitleSize'),
              'moduleTitleSize',
              20,
              36,
              'px'
            )}
            {renderNumberInput(t('settings.layoutBodySize'), 'bodySize', 18, 30, 'px')}
            {renderNumberInput(t('settings.layoutEmphasisSize'), 'emphasisSize', 36, 80, 'px')}
            {renderNumberInput(t('settings.layoutAuxiliarySize'), 'auxiliarySize', 12, 20, 'px')}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {t('settings.layoutTypographyHint')}
          </p>
        </div>
      </section>

      <section className="py-7">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Shapes className="h-4 w-4 text-primary" />
          {t('settings.layoutPatternTitle')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('settings.layoutPatternHint')}
        </p>
        <div className="mt-5 space-y-6">
          {PPT_PATTERN_GROUPS.map((group) => (
            <div key={group.id}>
              <h4 className="mb-3 text-sm font-semibold">
                {GROUP_COPY[group.id][lang]}
              </h4>
              <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                {group.patternIds.map((patternId) => {
                  const [name, description] = PATTERN_COPY[patternId][lang]
                  return (
                    <label
                      key={patternId}
                      className="flex cursor-pointer items-start gap-3 border-b border-border/60 pb-3"
                    >
                      <Checkbox
                        checked={draft.enabledPatterns.includes(patternId)}
                        disabled={!draft.enabled}
                        onCheckedChange={(checked) => togglePattern(patternId, checked === true)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{name}</span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                          {description}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 border-t border-border pt-5">
          <h4 className="mb-4 text-sm font-semibold">{t('settings.layoutStaircaseTitle')}</h4>
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            {renderNumberInput(t('settings.layoutStaircaseOffset'), 'staircaseOffset', 32, 96, 'px')}
            {renderNumberInput(t('settings.layoutIconBoxSize'), 'iconBoxSize', 40, 72, 'px')}
            {renderNumberInput(
              t('settings.layoutModuleTitleBodyGap'),
              'moduleTitleBodyGap',
              4,
              20,
              'px'
            )}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {t('settings.layoutStaircaseHint')}
          </p>
        </div>
      </section>

      <section className="pt-7">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <BookOpenText className="h-4 w-4 text-primary" />
          {t('settings.layoutExpertTitle')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('settings.layoutExpertHint')}
        </p>
        <Textarea
          value={draft.expertMarkdown}
          disabled={!draft.enabled}
          onChange={(event) => updateDraft({ expertMarkdown: event.target.value })}
          placeholder={t('settings.layoutExpertPlaceholder')}
          spellCheck={false}
          className="mt-4 min-h-[360px] resize-y font-mono text-[13px] leading-6"
        />
        <div className="mt-2 flex justify-end text-xs text-muted-foreground">
          <span>{draft.expertMarkdown.length} / 12000</span>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={handleRestoreDefaults} disabled={saving}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            {t('settings.layoutRestoreDefaults')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            <Save className="mr-1.5 h-4 w-4" />
            {saving ? t('common.saving') : t('settings.layoutSave')}
          </Button>
        </div>
      </section>
    </div>
  )
}
