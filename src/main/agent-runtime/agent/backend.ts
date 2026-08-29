import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import {
  CompositeBackend,
  FilesystemBackend,
  GENERAL_PURPOSE_SUBAGENT,
  type EditResult,
  type WriteResult
} from 'deepagents'
import { createProductSkillsMiddlewareSet } from '../skills/backend'
import type { RequiredProductSkillName } from '../../product-skills'
import type { SessionDeckGenerationContext } from './types'

export class GuardedFilesystemBackend extends FilesystemBackend {
  constructor(
    options: { rootDir?: string; virtualMode?: boolean; maxFileSizeMb?: number } & {
      disableEditFile?: boolean
      disableWriteFile?: boolean
      editBlockedReason?: string
      writeBlockedReason?: string
      validateEditedFile?: (filePath: string) => Promise<void>
    }
  ) {
    super(options)
    this.disableEditFile = Boolean(options.disableEditFile)
    this.disableWriteFile = Boolean(options.disableWriteFile)
    this.editBlockedReason =
      options.editBlockedReason ||
      '当前任务禁止调用 edit_file。请使用 update_single_page_file(pageId, content) 或 update_page_file(pageId, content)。'
    this.writeBlockedReason =
      options.writeBlockedReason || '当前任务禁止调用 write_file。请使用受控的页面写入工具。'
    this.validateEditedFile = options.validateEditedFile
  }

  private readonly disableEditFile: boolean
  private readonly disableWriteFile: boolean
  private readonly editBlockedReason: string
  private readonly writeBlockedReason: string
  private readonly validateEditedFile?: (filePath: string) => Promise<void>

  async write(filePath: string, content: string): Promise<WriteResult> {
    if (this.disableWriteFile) return { error: this.writeBlockedReason }
    return super.write(filePath, content)
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean
  ): Promise<EditResult> {
    if (this.disableEditFile) return { error: this.editBlockedReason }
    const before = await super.readRaw(filePath)
    if (before.error || !before.data || typeof before.data.content !== 'string') {
      return super.edit(filePath, oldString, newString, replaceAll)
    }
    const result = await super.edit(filePath, oldString, newString, replaceAll)
    if (result.error || !this.validateEditedFile) return result

    try {
      await this.validateEditedFile(filePath)
      return result
    } catch (error) {
      const after = await super.readRaw(filePath)
      if (after.data && typeof after.data.content === 'string') {
        const rollback = await super.edit(filePath, after.data.content, before.data.content, false)
        if (rollback.error) {
          return {
            error: `${error instanceof Error ? error.message : String(error)}\n回滚失败: ${rollback.error}`
          }
        }
      }
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function shouldEnableGeneralPurposeSubagent(
  context: Pick<
    SessionDeckGenerationContext,
    'mode' | 'selectedPageId' | 'selectPageIds' | 'allowedPageIds' | 'outlineTitles'
  >
): boolean {
  if (context.mode === 'edit') return true
  return !(
    Boolean(context.selectedPageId) ||
    context.selectPageIds?.length === 1 ||
    context.allowedPageIds?.length === 1 ||
    context.outlineTitles.length === 1
  )
}

export function createProductGeneralPurposeSubagent(args: {
  model: BaseLanguageModel
  tools: unknown[]
  backend: FilesystemBackend | CompositeBackend
  skillSource: string
  requiredSkillNames: readonly RequiredProductSkillName[]
  enabled?: boolean
}): any[] {
  if (args.enabled === false) return []
  if (!(args.backend instanceof CompositeBackend)) return []
  return [
    {
      ...GENERAL_PURPOSE_SUBAGENT,
      model: args.model as any,
      tools: args.tools as any,
      middleware: createProductSkillsMiddlewareSet(
        args.backend,
        args.skillSource,
        'general-purpose',
        args.requiredSkillNames
      )
    }
  ]
}
