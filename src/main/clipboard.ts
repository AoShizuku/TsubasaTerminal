import { clipboard, ipcMain } from 'electron'

/**
 * 剪贴板读通道。
 *
 * 写走渲染进程的 `navigator.clipboard.writeText`（复制路径一直如此，用户手势天然
 * 具备），读却不能同样办：`readText()` 要 clipboard-read 权限 + 用户手势，
 * Electron 下会被默认权限处理器拒掉，右键菜单里点"粘贴"这种非直接手势更不稳。
 * 主进程的 Electron clipboard 模块没有这层门槛，读一律从这里走。
 *
 * 无机密面：剪贴板本就是用户自己刚复制的内容，不涉及主进程自持的凭据。
 */
export function registerClipboardHandlers(): void {
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
}
