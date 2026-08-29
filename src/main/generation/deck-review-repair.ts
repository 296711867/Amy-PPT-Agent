/** 整套评审与定向修复：跨页质量检查 → 硬违规修复 → 叙事检查 → 叙事修复。 */
import log from 'electron-log/main.js'
import { progressLabel } from '@shared/progress'
import {
  formatDeckQualityFeedback,
  inspectPresentationDeckQuality,
  type DeckQualityViolation
} from '../presentation/html/deck-quality-validator'
import { resolveIncompleteDeckRenderPages } from './deck-render-gate'
import {
  formatDeckNarrativeFeedback,
  inspectPresentationDeckNarrative,
  type DeckNarrativeViolation
} from '../presentation/html/deck-narrative-validator'
import {
  reviewDeckNarrativeWithLLM,
  selectNarrativeRepairPageIds,
  type NarrativeReviewIssue
} from './deck-narrative-reviewer'
import { uiText } from './runner-shared'
import type { PageProgressTracker } from './page-progress-tracker'
import type { PageRef } from './page-refs'
import type { DeckGenerationArgs } from './deck-generation-types'
import type { SinglePageGenerator } from './single-page-generator'

export type DeckPageFailure = { pageId: string; title: string; reason: string }

export const runDeckReviewAndRepair = async (context: {
  args: DeckGenerationArgs
  pageRefs: PageRef[]
  failedPages: DeckPageFailure[]
  generateSinglePage: SinglePageGenerator['generateSinglePage']
  progress: PageProgressTracker
  circuitPaused: boolean
}): Promise<{
  deckQualityWarnings: DeckQualityViolation[]
  deckNarrativeWarnings: Array<DeckNarrativeViolation | NarrativeReviewIssue>
}> => {
  const { args, pageRefs, failedPages, generateSinglePage, progress } = context
  let deckQualityWarnings: DeckQualityViolation[] = []
  let deckNarrativeWarnings: Array<DeckNarrativeViolation | NarrativeReviewIssue> = []
  const canReviewCompleteDeck =
    args.generationMode !== 'retry' &&
    !context.circuitPaused &&
    failedPages.length === 0 &&
    pageRefs.length >= 2
  if (canReviewCompleteDeck) {
    progress.emitRenderingStatus({
      label: progressLabel(args.appLocale, '检查整套一致性'),
      detail: uiText(
        args.appLocale,
        '正在检查跨页字体、配色、标题、留白、密度和版式节奏',
        'Checking cross-slide typography, palette, titles, margins, density, and layout rhythm'
      ),
      progress: 90
    })
    const inspectDeck = (): ReturnType<typeof inspectPresentationDeckQuality> =>
      inspectPresentationDeckQuality({
        pages: pageRefs.map((page) => ({
          pageId: page.pageId,
          pageNumber: page.pageNumber,
          title: page.title,
          htmlPath: args.pageFileMap[page.pageId] || '',
          layoutIntent: page.layoutIntent
        })),
        slideSize: args.slideSize,
        designContract: args.designContract,
        preserveTemplate: args.requireTemplatePageRead
      })
    let deckReport = await inspectDeck()
    log.info('[deepagent] deck quality review completed', {
      sessionId: args.sessionId,
      styleId: args.styleId || '',
      reviewedPages: deckReport.pages.length,
      unavailablePages: deckReport.unavailablePages,
      violations: deckReport.violations.map((violation) => ({
        code: violation.code,
        severity: violation.severity,
        pageIds: violation.pageIds
      }))
    })

    const incompleteRenderPages = resolveIncompleteDeckRenderPages(deckReport)
    for (const unavailable of incompleteRenderPages) {
      const page = pageRefs.find((candidate) => candidate.pageId === unavailable.pageId)
      if (!page || failedPages.some((failure) => failure.pageId === page.pageId)) continue
      const reason = uiText(
        args.appLocale,
        `浏览器渲染验收不可用：${unavailable.reason}。本页未被视为生成完成。`,
        `Browser render validation was unavailable: ${unavailable.reason}. This slide was not accepted as complete.`
      )
      failedPages.push({ pageId: page.pageId, title: page.title, reason })
      await args.onPageFailed?.({
        pageNumber: page.pageNumber,
        pageId: page.pageId,
        title: page.title,
        contentOutline: page.outline,
        layoutIntent: page.layoutIntent,
        layoutId: page.layoutId,
        imageAssetPath: page.imageAssetPath,
        imageAssetPaths: page.imageAssetPaths,
        htmlPath: args.pageFileMap[page.pageId] || '',
        reason
      })
    }

    const hardViolations = deckReport.available
      ? deckReport.violations.filter((violation) => violation.severity === 'error')
      : []
    const repairPageIds = Array.from(
      new Set(hardViolations.flatMap((violation) => violation.pageIds))
    )
    for (const pageId of repairPageIds) {
      if (args.signal?.aborted) {
        throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
      }
      const page = pageRefs.find((candidate) => candidate.pageId === pageId)
      if (!page) continue
      const feedback = formatDeckQualityFeedback(hardViolations, pageId)
      progress.emitPageStatus({
        pageId,
        label: progressLabel(args.appLocale, '修复整套一致性'),
        detail: uiText(
          args.appLocale,
          `${page.title} · 正在按 Deck 评审修复`,
          `${page.title} · repairing deck-level consistency`
        ),
        pageProgress: 18
      })
      try {
        await generateSinglePage(
          page,
          'deck-quality-repair',
          { attempt: 1, maxRetries: 1, previousError: feedback },
          [
            'You are performing one bounded deck-level quality repair.',
            "Keep this slide's narrative job, facts, and intended layout. Do not redesign unrelated content.",
            'IMPORTANT: First read the existing page HTML with read_file, then make ONLY the targeted fixes listed below.',
            'Preserve all content, facts, and layout elements that were correct in the previous version.',
            'Do not rewrite the entire page from scratch — fix only the failing elements.',
            feedback
          ].join('\n')
        )
      } catch (error) {
        const reason = `Deck 质量定向修复失败：${error instanceof Error ? error.message : String(error)}`
        failedPages.push({ pageId, title: page.title, reason })
        await args.onPageFailed?.({
          pageNumber: page.pageNumber,
          pageId,
          title: page.title,
          contentOutline: page.outline,
          layoutIntent: page.layoutIntent,
          layoutId: page.layoutId,
          imageAssetPath: page.imageAssetPath,
          imageAssetPaths: page.imageAssetPaths,
          htmlPath: args.pageFileMap[pageId] || '',
          reason
        })
      }
    }

    if (repairPageIds.length > 0 && failedPages.length === 0) {
      deckReport = await inspectDeck()
    }
    const remainingHardViolations = deckReport.violations.filter(
      (violation) => violation.severity === 'error'
    )
    for (const pageId of new Set(remainingHardViolations.flatMap((item) => item.pageIds))) {
      if (failedPages.some((failure) => failure.pageId === pageId)) continue
      const page = pageRefs.find((candidate) => candidate.pageId === pageId)
      if (!page) continue
      const reason = formatDeckQualityFeedback(remainingHardViolations, pageId)
      failedPages.push({ pageId, title: page.title, reason })
      await args.onPageFailed?.({
        pageNumber: page.pageNumber,
        pageId,
        title: page.title,
        contentOutline: page.outline,
        layoutIntent: page.layoutIntent,
        layoutId: page.layoutId,
        imageAssetPath: page.imageAssetPath,
        imageAssetPaths: page.imageAssetPaths,
        htmlPath: args.pageFileMap[pageId] || '',
        reason
      })
    }
    deckQualityWarnings = deckReport.violations.filter((violation) => violation.severity === 'warn')
    progress.emitRenderingStatus({
      label: progressLabel(
        args.appLocale,
        deckReport.available ? '整套一致性检查完成' : '整套一致性检查未完成'
      ),
      detail: !deckReport.available
        ? incompleteRenderPages.length > 0
          ? uiText(
              args.appLocale,
              `跨页浏览器验收未完成，${incompleteRenderPages.length} 页已标记为失败，待渲染恢复后重试`,
              `Cross-slide browser validation was incomplete; ${incompleteRenderPages.length} slides were marked failed for retry`
            )
          : uiText(
              args.appLocale,
              '跨页浏览器验收暂不可用，已保留通过落盘校验的页面并记录非阻断警告',
              'Cross-slide browser validation was unavailable; statically valid slides were kept with a non-blocking advisory'
            )
        : deckQualityWarnings.length > 0
          ? uiText(
              args.appLocale,
              `已完成 Deck 评审，记录 ${deckQualityWarnings.length} 项非阻断优化建议`,
              `Deck review completed with ${deckQualityWarnings.length} non-blocking advisories`
            )
          : uiText(
              args.appLocale,
              '跨页字体、配色、标题、留白和版式节奏检查通过',
              'Cross-slide typography, palette, title, margin, and rhythm checks passed'
            ),
      progress: 90
    })

    if (failedPages.length === 0) {
      progress.emitRenderingStatus({
        label: progressLabel(args.appLocale, '检查内容与叙事'),
        detail: uiText(
          args.appLocale,
          '正在检查开场、页面职责、证据解释、叙事推进与结尾行动',
          'Checking the opening, slide jobs, evidence interpretation, narrative flow, and close'
        ),
        progress: 91
      })
      const inspectNarrative = (): ReturnType<typeof inspectPresentationDeckNarrative> =>
        inspectPresentationDeckNarrative({
          pages: pageRefs.map((page) => ({
            pageId: page.pageId,
            pageNumber: page.pageNumber,
            title: page.title,
            htmlPath: args.pageFileMap[page.pageId] || '',
            layoutIntent: page.layoutIntent
          }))
        })
      let narrativeReport = await inspectNarrative()
      const semanticReview = await reviewDeckNarrativeWithLLM({
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        baseUrl: args.baseUrl,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        modelRuntime: args.agentManager.getSession(args.sessionId)?.modelRuntime,
        modelTimeoutMs: args.modelTimeoutMs,
        signal: args.signal,
        topic: args.topic,
        deckTitle: args.deckTitle,
        userMessage: args.userMessage,
        outlineItems: pageRefs.map((page) => ({
          title: page.title,
          contentOutline: page.outline,
          layoutIntent: page.layoutIntent
        })),
        pages: narrativeReport.pages
      })
      if (args.signal?.aborted) {
        throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
      }
      if (!semanticReview.available) {
        log.warn('[deepagent] semantic narrative review unavailable', {
          sessionId: args.sessionId,
          reason: semanticReview.unavailableReason
        })
      }
      const deterministicHardIssues = narrativeReport.violations.filter(
        (violation) => violation.severity === 'error'
      )
      const semanticHardIssues = semanticReview.issues.filter(
        (violation) => violation.severity === 'error'
      )
      const repairPageIds = selectNarrativeRepairPageIds({
        deterministicIssues: deterministicHardIssues,
        semanticIssues: semanticHardIssues,
        maxPages: 2
      })
      for (const pageId of repairPageIds) {
        if (args.signal?.aborted) {
          throw new Error(uiText(args.appLocale, '生成已取消', 'Generation canceled'))
        }
        const page = pageRefs.find((candidate) => candidate.pageId === pageId)
        if (!page) continue
        const assignedIssues = [...deterministicHardIssues, ...semanticHardIssues].filter(
          (violation) => violation.pageIds.includes(pageId)
        )
        const feedback = formatDeckNarrativeFeedback(assignedIssues, pageId)
        progress.emitPageStatus({
          pageId,
          label: progressLabel(args.appLocale, '修复内容与叙事'),
          detail: uiText(
            args.appLocale,
            `${page.title} · 正在按叙事评审定向修复`,
            `${page.title} · repairing narrative findings`
          ),
          pageProgress: 18
        })
        try {
          await generateSinglePage(
            page,
            'deck-narrative-repair',
            { attempt: 1, maxRetries: 1, previousError: feedback },
            [
              'You are performing one bounded narrative repair on this slide.',
              "Preserve verified facts, the slide's visual system, and its intended role.",
              'IMPORTANT: First read the existing page HTML with read_file, then fix only the narrative defects listed below.',
              'Do not rewrite the entire page from scratch — preserve all correct content and make surgical fixes.',
              feedback
            ].join('\n')
          )
        } catch (error) {
          log.warn('[deepagent] narrative repair failed without aborting deck generation', {
            sessionId: args.sessionId,
            pageId,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (repairPageIds.length > 0) narrativeReport = await inspectNarrative()
      deckNarrativeWarnings = [
        ...narrativeReport.violations.filter((violation) => violation.severity === 'warn'),
        ...semanticReview.issues.filter((violation) => violation.severity === 'warn')
      ]
      const remainingNarrativeErrors = narrativeReport.violations.filter(
        (violation) => violation.severity === 'error'
      )
      deckNarrativeWarnings.push(...remainingNarrativeErrors)
      log.info('[deepagent] deck narrative review completed', {
        sessionId: args.sessionId,
        staticIssues: narrativeReport.violations.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          pageIds: issue.pageIds
        })),
        semanticAvailable: semanticReview.available,
        semanticIssues: semanticReview.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          confidence: issue.confidence,
          pageIds: issue.pageIds
        })),
        repairedPageIds: repairPageIds
      })
    }
  }
  return { deckQualityWarnings, deckNarrativeWarnings }
}
