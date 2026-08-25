/**
 * 生成插件注册表：导入此文件即注册全部内置插件。
 * 新增插件 = 新建文件导出注册函数 + 在此调用。
 */
export type GenerationPlugin = {
  name: string
  /** 注册函数，返回取消注册句柄。 */
  register: () => () => void
}

const registered: Array<{ name: string; dispose: () => void }> = []

export function registerGenerationPlugin(plugin: GenerationPlugin): void {
  if (registered.some((p) => p.name === plugin.name)) return
  const dispose = plugin.register()
  registered.push({ name: plugin.name, dispose })
}

export function listRegisteredPlugins(): string[] {
  return registered.map((p) => p.name)
}

export function disposeAllGenerationPlugins(): void {
  for (const { dispose } of registered) dispose()
  registered.length = 0
}
