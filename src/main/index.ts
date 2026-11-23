import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../build/icon.png?asset'
import { isWebUrl } from '../shared/url'
import { registerHostHandlers } from './hosts'
import { registerHostKeyHandlers } from './hostkeys'
import { registerSshConfigHandlers } from './sshconfig'
import { registerSftpHandlers } from './sftp'
import { registerSshHandlers, disposeAllSessions } from './ssh'
import { registerTransferHandlers } from './transfer'
import { registerTranscriptHandlers } from './transcript'
import { getSettingsSync, loadSettings, registerSettingsHandlers } from './settings'
import { registerAuditHandlers } from './audit'
import { registerClipboardHandlers } from './clipboard'
import { registerLlmProfileHandlers } from './llm/profiles'
import { registerAgentHandlers, disposeAllAgents } from './llm/loop'
import { registerConversationHandlers } from './llm/conversations'
import { registerExperienceHandlers } from './llm/experience'
import { registerSuggestHandlers } from './llm/suggest'
import { bootCliBridge, disposeCliBridge, registerCliHandlers } from './cli'
import { initialWindowChrome, registerWindowChromeHandlers } from './windowChrome'
import { initialWindowPlacement, loadWindowState, trackWindowState } from './windowState'
import { parseSizeSpec } from './windowPlacement'
import { TITLE_BAR_HEIGHT } from '../shared/types'
import { APP_DATA_DIR_NAME } from '../shared/cli'
import { WINDOW_MIN_SIZE } from '../shared/layout'

// e2e 测试通过该环境变量隔离 userData，避免污染真实配置；
// 否则固定为 %APPDATA%/TsubasaTerminal，不随显示名（含空格）变化
const userDataOverride = process.env['TSUBASATERMINAL_USER_DATA']
app.setPath('userData', userDataOverride || join(app.getPath('appData'), APP_DATA_DIR_NAME))

function createWindow(): void {
  // 后台 e2e 车道：移出屏幕 + 全透明 + 不占任务栏，但仍真实渲染
  // （`show: false` 会让 Chromium 把文档判成 hidden 并节流 rAF / timer）。
  // **锁在开发态**：装机版若从父进程或系统环境继承到这个变量，用户看到的是
  // "双击图标没反应"——进程在跑、窗口停在 (-10000, -10000) 且全透明，
  // 是排查成本最高的一类故障，而守卫的代价只有这半行。
  const backgroundE2e = is.dev && process.env['TSUBASATERMINAL_E2E_HIDDEN'] === '1'
  // 原生配色按已存方案派生：settings 在建窗前已读热
  const chrome = initialWindowChrome(getSettingsSync().terminalTheme)
  // 首次启动按主屏比例取尺寸会随机器变化；e2e 用它锁定基线，同样锁在开发态
  const e2eDefaultSize = is.dev
    ? parseSizeSpec(process.env['TSUBASATERMINAL_E2E_WINDOW_SIZE'])
    : undefined
  const placement = initialWindowPlacement(e2eDefaultSize)
  const mainWindow = new BrowserWindow({
    width: placement.width,
    height: placement.height,
    x: backgroundE2e ? -10000 : placement.x,
    y: backgroundE2e ? -10000 : placement.y,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    opacity: backgroundE2e ? 0 : 1,
    skipTaskbar: backgroundE2e,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { ...chrome.titleBarOverlay, height: TITLE_BAR_HEIGHT } }
      : {}),
    title: 'Tsubasa Terminal',
    // 打包版窗口图标来自 exe（electron-builder 由 build/icon.png 生成 ico），
    // 这里显式指定是为了 dev 窗口与打包版一致
    icon: appIcon,
    backgroundColor: chrome.backgroundColor,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 最小化不把页面判 hidden：默认会丢弃已合成的画面、把渲染进程降到 Idle，
      // 挂机久了恢复时内容区要等渲染进程重出首帧，1~3s 只见主题底色和原生 overlay 按钮。
      // 最小化的窗口 Chromium 本就不出帧，关掉节流实测空闲开销与默认持平
      backgroundThrottling: false
    }
  })

  // 混合缩放多屏：建窗与 setBounds 都按窗口**当前**所在屏的缩放换算尺寸，
  // 落到缩放不同的屏上会差一个缩放比。窗口已到目标屏后再设一次才准
  const requested = {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height
  }
  if (!backgroundE2e) mainWindow.setBounds(requested)
  trackWindowState(mainWindow, requested)

  mainWindow.on('ready-to-show', () => {
    // 后台车道不恢复最大化：最大化会把窗口从屏幕外拉回桌面
    if (backgroundE2e) mainWindow.showInactive()
    else {
      // 先按还原态尺寸建窗再最大化：取消最大化时回到记住的尺寸，而不是建窗默认值
      if (placement.maximized) mainWindow.maximize()
      mainWindow.show()
    }
  })

  // 外开只放行 http / https：渲染进程的确认框不是唯一的闸，
  // 其他协议可能拉起本机程序
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isWebUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Agent 面板渲染 markdown 链接：页面内导航一律拦死（点击走 window.open →
  // 上面的 handler → 外部浏览器），防被注入的 md 链接把应用整页带走
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.tsubasaterminal.app')

  // 终端应用不能让默认菜单加速键截胡 shell 命根子按键：
  // Ctrl+W（默认关窗口）、Ctrl+R（默认重载，composer 用作历史搜索）必须到达渲染进程。
  // 开发模式 F12 开 DevTools 由 optimizer.watchWindowShortcuts 提供，不受影响。
  Menu.setApplicationMenu(null)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerHostHandlers()
  registerWindowChromeHandlers()
  registerHostKeyHandlers()
  registerSshConfigHandlers()
  registerSshHandlers()
  registerSftpHandlers()
  registerTransferHandlers()
  registerTranscriptHandlers()
  registerSettingsHandlers()
  registerAuditHandlers()
  registerClipboardHandlers()
  registerLlmProfileHandlers()
  registerAgentHandlers()
  registerConversationHandlers()
  registerExperienceHandlers()
  registerSuggestHandlers()
  registerCliHandlers()
  // 建窗前把 settings 读热：渲染进程首帧前用 settings:get-sync 同步取
  // 布局与外观，缓存必须在 preload 跑起来之前就位；窗口落位记录同理在建窗前读。
  // 两个小 JSON 并行读取，不拖首屏
  await Promise.all([loadSettings(), loadWindowState()])
  createWindow()
  // CLI 通道装配放在建窗之后：起管道 / 自愈 shim / skill 版本戳重渲染都不该拖慢首屏，
  // 且总开关默认关时这里几乎零成本
  void bootCliBridge()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disposeAllAgents()
  disposeAllSessions()
  void disposeCliBridge()
  if (process.platform !== 'darwin') app.quit()
})
