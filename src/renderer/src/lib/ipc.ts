/** 渲染进程 IPC 门面：按域拆分到 lib/ipc/，此处合并导出，保持既有导入路径不变。 */
export * from './ipc/types'

import { sessionDocIpc } from './ipc/sessions'
import { generationIpc } from './ipc/generation'
import { workspaceIpc } from './ipc/workspace'
import { settingsIpc } from './ipc/settings'
import { stylesIpc } from './ipc/styles'
import { systemIpc } from './ipc/system'

export const ipc = {
  ...sessionDocIpc,
  ...generationIpc,
  ...workspaceIpc,
  ...settingsIpc,
  ...stylesIpc,
  ...systemIpc
}
