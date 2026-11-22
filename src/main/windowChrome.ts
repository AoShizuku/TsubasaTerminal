import { BrowserWindow, ipcMain } from 'electron'
import { TITLE_BAR_HEIGHT, type TitleBarTheme } from '../shared/types'
import { deriveShell, type ShellPalette } from '../shared/shellPalette'
import { themeById } from '../shared/terminalThemes'

/**
 * 建窗时的原生配色：与渲染层同一套派生（shared/shellPalette），
 * 按已存的配色方案给窗口底色与标题栏按钮区上色。此前写死暗色 `#0c0d10`，
 * 亮色用户每次启动都先见一块暗底和暗色按钮区，等渲染层 IPC 到了才变过来。
 */
export function initialWindowChrome(terminalTheme: string | undefined): {
  backgroundColor: string
  titleBarOverlay: { color: string; symbolColor: string }
} {
  const palette: ShellPalette = deriveShell(themeById(terminalTheme).theme)
  return {
    backgroundColor: palette.background,
    titleBarOverlay: { color: palette.subtle, symbolColor: palette.foreground2 }
  }
}

/** 只允许改调用窗口的外观；颜色在 renderer 复用现有主题派生，无窗口控制通用入口。 */
export function registerWindowChromeHandlers(): void {
  ipcMain.handle('window:title-bar-theme', (event, theme: TitleBarTheme) => {
    const hex = /^#[0-9a-f]{6}$/i
    if (
      !theme ||
      typeof theme.color !== 'string' ||
      !hex.test(theme.color) ||
      typeof theme.symbolColor !== 'string' ||
      !hex.test(theme.symbolColor) ||
      typeof theme.background !== 'string' ||
      !hex.test(theme.background)
    ) {
      throw new Error('标题栏颜色无效')
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) throw new Error('窗口已关闭')
    // 窗口底色各平台都有：切方案后最小化恢复、拖大窗口时露出的那块也要跟着变
    win.setBackgroundColor(theme.background)
    // macOS 的交通灯由系统绘制，没有 Windows/Linux 的 overlay 配色接口。
    if (process.platform !== 'darwin') {
      win.setTitleBarOverlay({
        color: theme.color,
        symbolColor: theme.symbolColor,
        height: TITLE_BAR_HEIGHT
      })
    }
  })
}
