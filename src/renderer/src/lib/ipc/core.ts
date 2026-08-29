/** 渲染进程 IPC 入口：preload 暴露的 ipcRenderer 获取与缺失诊断。 */
type IpcRendererLike = Window['electron']['ipcRenderer']

export function getIpc(): IpcRendererLike {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) {
    const electronKeys = window.electron ? Object.keys(window.electron).join(', ') : 'none'
    throw new Error(`Electron preload IPC is unavailable. window.electron keys: ${electronKeys}`)
  }
  return ipc
}
