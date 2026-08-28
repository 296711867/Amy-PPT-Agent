import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildStyleSwitchUserMessage,
  collectFailedStyleSwitchPageIds
} from '../../../src/main/generation/style-switch'

describe('style switch generation', () => {
  it('builds a strict visual-only deck edit instruction', () => {
    const message = buildStyleSwitchUserMessage('极简白')
    expect(message).toContain('现有风格「极简白」')
    expect(message).toContain('禁止修改每页文字内容')
    expect(message).toContain('必须逐字逐项原样保留')
    expect(message).toContain('页面布局与视觉结构可以按现有风格重新设计')
    expect(message).not.toContain('禁止改变信息结构和内容层级')
  })

  it('preserves style names containing prompt delimiters', () => {
    const styleName = '「未来」“数据”\n第二行'
    const message = buildStyleSwitchUserMessage(styleName)

    expect(message).toContain(`现有风格「${styleName}」`)
    expect(message).toContain('禁止修改每页文字内容')
    expect(message).toContain('页面布局与视觉结构可以按现有风格重新设计')
  })

  it('collects failed retry page ids with legacy fallbacks', () => {
    expect(
      collectFailedStyleSwitchPageIds([
        { id: 'row-0', page_id: 'page-0', file_slug: 'slug-0', status: 'failed' },
        { id: 'row-1', file_slug: 'page-1', legacy_page_id: 'legacy-1', status: 'failed' },
        { id: 'row-2', file_slug: '', legacy_page_id: 'legacy-2', status: 'failed' },
        { id: 'row-3', file_slug: '', legacy_page_id: '', status: 'failed' },
        { id: 'row-4', file_slug: 'page-4', legacy_page_id: 'legacy-4', status: 'completed' },
        { id: '', file_slug: '', legacy_page_id: '', status: 'failed' }
      ])
    ).toEqual(['page-0', 'page-1', 'legacy-2', 'row-3'])
  })

  it('uses an independent persistent style-switch job with two workers', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-service.ts'),
      'utf8'
    )
    const typesSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-types.ts'),
      'utf8'
    )
    const flowSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-flow.ts'),
      'utf8'
    )
    const databaseSource = fs.readFileSync(path.resolve('src/main/db/database.ts'), 'utf8')
    const recordsSource = fs.readFileSync(path.resolve('src/main/db/records.ts'), 'utf8')

    expect(typesSource).toContain('const STYLE_SWITCH_CONCURRENCY = 2')
    expect(typesSource).toContain("jobType: 'style-switch'")
    expect(serviceSource).toContain("kind: 'style-switch'")
    expect(serviceSource).toContain("mode: 'style-switch'")
    expect(serviceSource).toContain('createGenerationRunWithSessionJobAndPages')
    expect(serviceSource).toContain('private reservedJobIds')
    expect(serviceSource).toContain("domain: 'style'")
    expect(serviceSource).toContain('sessionLockKey(sessionId)')
    expect(serviceSource).toContain('{ runId: lease.jobId, abortSignal: lease.signal }')
    expect(serviceSource).toContain('this.coordinator.cancel(job.lease.jobId)')
    expect(serviceSource).not.toContain('SessionJobCoordinator')
    expect(serviceSource).not.toContain('lease.controller')
    expect(serviceSource).not.toContain('agentManager.cancelSession')
    expect(serviceSource).toContain(
      'await this.ctx.db.replaceSessionStyleSnapshot(sessionId, styleId)'
    )
    expect(serviceSource).toContain('context = await resolveEditContext')
    expect(serviceSource).toContain('await this.runWorkers(job)')
    expect(serviceSource).toContain('restoreStyleSwitchFileSnapshot(indexPath, indexSnapshot)')
    expect(serviceSource).toContain('runStyleSwitchPageFlow')
    expect(flowSource).toContain('runDeepAgentEdit')
    expect(flowSource).toContain('projectDir: job.context.projectDir')
    expect(flowSource).toContain('signal: job.context.abortSignal')
    expect(flowSource).not.toContain('context.entry')
    expect(flowSource).toContain("editScope: 'page'")
    expect(flowSource).toContain('pageFileMap: { [page.pageId]: page.htmlPath }')
    expect(serviceSource).not.toContain('executeDeckAllPageEditGeneration')
    expect(recordsSource).toContain("| 'style-switch'")
    expect(databaseSource).toContain('createGenerationRunWithSessionJobAndPages')
  })

  it('does not carry the previous visual contract into the new style', () => {
    const message = buildStyleSwitchUserMessage('极简白')

    expect(message).toContain('禁止沿用此前风格的配色、装饰和布局语言')
    expect(message).toContain('视觉设计必须以当前现有风格规范为准')

    const flowSource = fs.readFileSync(
      path.resolve('src/main/generation/edit-deck-allpage-flow.ts'),
      'utf8'
    )
    expect(flowSource).toContain('!context.resetVisualStyle &&')
    expect(flowSource).toContain('!context.resetVisualStyle && page.layout_intent')
    expect(flowSource).toContain('normalizeUniversalLayoutId(page.layout_id)')
    expect(flowSource).toContain(
      'let savedDesignContract: DesignContract | undefined = context.designContract'
    )
  })

  it('starts through the dedicated job UI without a style-switch dialog', () => {
    const styleViewSource = fs.readFileSync(
      path.resolve('src/renderer/src/components/session-detail/style/StyleView.tsx'),
      'utf8'
    )
    const jobBarSource = fs.readFileSync(
      path.resolve('src/renderer/src/components/session-detail/style/StyleSwitchJobBar.tsx'),
      'utf8'
    )
    const cancelHookSource = fs.readFileSync(
      path.resolve('src/renderer/src/components/session-detail/hooks/useCancelStyleSwitch.ts'),
      'utf8'
    )

    expect(styleViewSource).toContain('startStyleSwitch')
    expect(styleViewSource).toContain('ipc.startStyleSwitch')
    expect(styleViewSource).not.toContain('AlertDialog')
    expect(styleViewSource).not.toContain('setSwitchTarget')
    expect(jobBarSource).toContain('useCancelStyleSwitch')
    expect(cancelHookSource).toContain('ipc.cancelStyleSwitch')
    expect(cancelHookSource).toContain('if (!result.success)')
    expect(cancelHookSource).toContain('ipc.getStyleSwitchState(sessionId)')
    expect(jobBarSource).toContain('ipc.retryFailedStyleSwitchPages')
    expect(jobBarSource).toContain("if (!job || job.status === 'completed') return null")
  })

  it('retries only failed pages through the dedicated style-switch service', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-service.ts'),
      'utf8'
    )

    expect(serviceSource).toContain('async retryPage(')
    expect(serviceSource).toContain("page.page_id === pageId && page.status === 'failed'")
    expect(serviceSource).toContain('async retryFailed(')
    expect(serviceSource).toContain(".filter((page) => page.status === 'failed')")
    expect(serviceSource).toContain("ipcMain.handle('style-switch:retryPage'")
    expect(serviceSource).toContain("ipcMain.handle('style-switch:retryFailed'")
  })

  it('uses the session style snapshot when the global style has been disabled', () => {
    const handlerSource = fs.readFileSync(path.resolve('src/main/styles/handlers.ts'), 'utf8')

    expect(handlerSource).toContain('await db.getSessionStyleSnapshot(sessionId)')
    expect(handlerSource).toContain('items.unshift({')
    expect(handlerSource).toContain('id: snapshot.styleId')
  })

  it('retries normal deck edits through the deck job with their original request', () => {
    const handlerSource = fs.readFileSync(path.resolve('src/main/generation/handlers.ts'), 'utf8')
    const retryHandler = handlerSource.slice(
      handlerSource.indexOf("ipcMain.handle('generate:retryDeckEdit'"),
      handlerSource.indexOf("ipcMain.handle('generate:startTemplate'")
    )

    const deckJobSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/deck-edit-job-service.ts'),
      'utf8'
    )

    expect(retryHandler).toContain('return deckEditJobs.retry(event, payload)')
    expect(deckJobSource).toContain('getFailedPagesForRun(sessionId, failedRunId)')
    expect(deckJobSource).toContain('userMessage,')
    expect(deckJobSource).toContain('selectPageIds: failedPageIds')
    expect(deckJobSource).toContain('persistUserMessage: false')
    expect(deckJobSource).toContain('const result = await this.start(event')
    expect(deckJobSource).not.toContain('executeRetryFailedPages')
  })

  it('keeps internal style-switch prompts out of the visible chat history', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-service.ts'),
      'utf8'
    )
    const editFlowSource = fs.readFileSync(path.resolve('src/main/generation/edit-flow.ts'), 'utf8')

    expect(serviceSource).toContain('persistUserMessage: false')
    expect(editFlowSource).toContain('if (input.persistUserMessage)')
  })

  it('writes a page history commit before publishing it as editable', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-service.ts'),
      'utf8'
    )
    const historySource = fs.readFileSync(
      path.resolve('src/main/history/git-history-service.ts'),
      'utf8'
    )
    const commitPageSource = serviceSource.slice(
      serviceSource.indexOf('private async commitPage'),
      serviceSource.indexOf('private emitPageProgress')
    )

    expect(commitPageSource).toContain("scope: 'page'")
    expect(commitPageSource).toContain('prompt: `切换风格 · 第 ${page.pageNumber} 页`')
    expect(commitPageSource).toContain('styleName: job.context.styleName || null')
    expect(commitPageSource).toContain('allowedPaths: [relativePath]')
    expect(commitPageSource).toContain('if (!operation?.after_commit)')
    expect(commitPageSource).toContain("status: 'completed'")
    expect(commitPageSource.indexOf('recordOperation({')).toBeLessThan(
      commitPageSource.indexOf("type: 'page_updated'")
    )
    expect(commitPageSource.indexOf('recordOperation({')).toBeLessThan(
      commitPageSource.indexOf('await this.ctx.db.upsertSessionPage({')
    )
    expect(commitPageSource.indexOf('recordOperation({')).toBeLessThan(
      commitPageSource.indexOf('await this.ctx.db.upsertGenerationPage({')
    )
    expect(commitPageSource.indexOf('if (!operation?.after_commit)')).toBeLessThan(
      commitPageSource.indexOf("type: 'page_updated'")
    )
    expect(historySource).toContain('allowedPaths?: string[]')
    expect(historySource).toContain('stageControlledChanges(projectDir, args.allowedPaths)')
    expect(historySource).toContain('git.resetIndex({ fs, dir: projectDir, filepath })')
    expect(historySource).toContain('rollbackCommittedOperation')
    expect(historySource).toContain("if (metadata.jobType === 'style-switch')")
    expect(historySource).toContain('`切换风格 · 第 ${styleSwitchPageNumber} 页`')
    expect(commitPageSource).toContain('history.rollbackCommittedOperation')
  })

  it('does not commit queued pages after cancellation or roll back a durable commit on notify failure', () => {
    const serviceSource = fs.readFileSync(
      path.resolve('src/main/edit-jobs/style-switch-job-service.ts'),
      'utf8'
    )
    const commitPageSource = serviceSource.slice(
      serviceSource.indexOf('private async commitPage'),
      serviceSource.indexOf('private emitPageProgress')
    )

    expect(commitPageSource).toContain('this.assertCommitNotCancelled(job)')
    expect(commitPageSource.indexOf('this.assertCommitNotCancelled(job)')).toBeLessThan(
      commitPageSource.indexOf('recordOperation({')
    )
    expect(commitPageSource).toContain(
      "log.warn('[style-switch:job] page commit notification failed'"
    )
    expect(commitPageSource.indexOf('if (!operation?.after_commit)')).toBeLessThan(
      commitPageSource.indexOf("log.warn('[style-switch:job] page commit notification failed'")
    )
    expect(commitPageSource).toContain('retryCount: page.retryCount')
  })
})
