import type { AnimationPreferencesPayload } from '@shared/generation'
import { DATA_ANIM_SUPPORTED_TYPES } from '@shared/element-animation'

const PREFERENCE_LINES: Record<string, string> = {
  fade: '- Prefer data-anim="fade" for quiet text blocks, notes, and low-distraction entrances.',
  'fade-up':
    '- Prefer data-anim="fade-up" as the standard entrance for cards, sections, and readable content groups.',
  'fade-down':
    '- Prefer data-anim="fade-down" when content should enter from above, such as top labels or header-adjacent elements.',
  'fade-left':
    '- Prefer data-anim="fade-left" when content should enter from the right side into position.',
  'fade-right':
    '- Prefer data-anim="fade-right" when content should enter from the left side into position.',
  'scale-in':
    '- Prefer data-anim="scale-in" for compact focal elements that should appear with a soft scale entrance.',
  'slide-up':
    '- Prefer data-anim="slide-up" for stronger upward entrances when fade-up is too subtle.',
  'slide-down':
    '- Prefer data-anim="slide-down" for stronger downward entrances when the visual flow starts near the top.',
  'slide-left': '- Prefer data-anim="slide-left" for stronger entrances from the right side.',
  'slide-right': '- Prefer data-anim="slide-right" for stronger entrances from the left side.',
  'fly-in':
    '- Prefer data-anim="fly-in" only for directional emphasis; set data-anim-from to left, right, top, or bottom intentionally.',
  wipe: '- Prefer data-anim="wipe" for bars, timelines, progress strips, or section reveals; set data-anim-from intentionally.',
  'zoom-in':
    '- Prefer data-anim="zoom-in" for a single dramatic focal number or key callout; avoid using it on many elements.',
  'spin-in':
    '- Prefer data-anim="spin-in" only as a sparing playful entrance for one accent element.',
  'pulse-soft': '- Prefer data-anim="pulse-soft" for very subtle attention on one KPI or key word.',
  pulse: '- Prefer data-anim="pulse" for bounded emphasis on important metrics or callouts.',
  'pulse-strong':
    '- Prefer data-anim="pulse-strong" only for urgent or high-priority callouts, at most one per slide.',
  'grow-shrink-soft':
    '- Prefer data-anim="grow-shrink-soft" for gentle emphasis that settles quickly.',
  'grow-shrink':
    '- Prefer data-anim="grow-shrink" for important callouts that need more presence than pulse-soft.',
  'grow-shrink-strong':
    '- Prefer data-anim="grow-shrink-strong" only for rare high-priority emphasis, at most one per slide.'
}

export function formatAnimationPreferencesForPageWriting(
  preferences: AnimationPreferencesPayload | null | undefined
): string {
  const ids = preferences?.ids || []
  const lines = ids.map((id) => PREFERENCE_LINES[id]).filter(Boolean)
  if (lines.length === 0) return ''

  return [
    '## Animation preferences for page writing only',
    '- Follow the amy-ppt-data-anim skill. Use exportable data-anim attributes on slide elements.',
    '- Do not change slide outline, page count, slide titles, source facts, or content structure solely to satisfy animation.',
    '- Animation is downstream only: follow the already-decided page form, content enrichment, source grounding, and layout density. Never reduce, skip, or reshape warranted content enrichment to satisfy an animation preference.',
    '- Prefer subtle reading-order entrance animations.',
    `- Hard contract: data-anim only accepts these exact values — ${DATA_ANIM_SUPPORTED_TYPES.join(', ')}. Never invent variants like fade-in or slide-in; when unsure use fade or fade-up.`,
    ...lines,
    '- Avoid runtime-only attributes and custom anime timelines in normal editable/exportable pages.'
  ].join('\n')
}
