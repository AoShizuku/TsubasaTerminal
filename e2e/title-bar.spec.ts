import { expect, test, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'
import { deriveShell } from '../src/shared/shellPalette'
import { themeById } from '../src/shared/terminalThemes'
import { TITLE_BAR_HEIGHT, type TitleBarTheme } from '../src/shared/types'

let app: ElectronApplication | undefined
let ssh: FakeSshServer
test.beforeAll(async () => { ssh = await startFakeSshServer() })
test.afterAll(async () => { await ssh.close() })
test.afterEach(async () => { await app?.close(); app = undefined })

test('标题栏设置：最小窗口、左栏折叠与键盘激活，关闭回终端', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 600))
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.keyboard.press('Control+Shift+B')
  await expect(page.getByTestId('host-item')).toBeHidden()
  const settings = page.getByTestId('open-settings')
  await expect(settings).toBeVisible()
  await settings.click()
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // 有活动终端时，兜底键路由也必须让位给标题栏按钮的 Enter / Space。
  for (const key of ['Enter', 'Space']) {
    await settings.focus()
    await page.keyboard.press(key)
    await expect(page.getByTestId('settings-theme')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composer-input')).toBeFocused()
  }
  await page.keyboard.type('echo titlebar-ok')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('titlebar-ok')

  const layout = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="title-bar"]')!.getBoundingClientRect()
    const body = document.querySelector('[data-testid="window-body"]')!.getBoundingClientRect()
    const grid = document.querySelector('.xterm-screen')!.getBoundingClientRect()
    return { top: bar.top, height: bar.height, bodyTop: body.top, bottom: body.bottom,
      viewport: innerHeight, gridBottom: grid.bottom, scrollWidth: document.body.scrollWidth,
      viewportWidth: innerWidth }
  })
  expect(layout.top).toBe(0)
  expect(layout.height).toBe(TITLE_BAR_HEIGHT)
  expect(layout.bodyTop).toBe(TITLE_BAR_HEIGHT)
  expect(layout.bottom).toBe(layout.viewport)
  expect(layout.gridBottom).toBeLessThanOrEqual(layout.viewport)
  expect(layout.scrollWidth).toBe(layout.viewportWidth)
})

test('主题通过 preload 更新原生 overlay，按钮安全区随窗口大小变化', { tag: '@daily' }, async () => {
  test.skip(process.platform === 'darwin', 'macOS 使用系统交通灯，不提供 overlay 配色')
  const launched = await launchApp([])
  app = launched.app
  const page = launched.page
  // 包装真实原生方法以观察参数；仍调用原方法，不 mock 成功。
  // 建窗时就按已存方案（默认 tsubasaterminal）派生，不再是写死的 #0c0d10
  expect(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()
  )).toBe(deriveShell(themeById('tsubasaterminal').theme).background)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const original = win.setTitleBarOverlay.bind(win)
    win.setTitleBarOverlay = (options) => {
      original(options)
      ;(globalThis as typeof globalThis & { titleBarApplied?: unknown }).titleBarApplied = options
    }
  })
  for (const id of ['dracula', 'pitch-black', 'nord']) {
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-theme').selectOption(id)
    await page.getByTestId('settings-close').click()
    const palette = deriveShell(themeById(id).theme)
    await expect.poll(() => app!.evaluate(() =>
      (globalThis as typeof globalThis & { titleBarApplied?: unknown }).titleBarApplied
    )).toEqual({ color: palette.subtle, symbolColor: palette.foreground2, height: TITLE_BAR_HEIGHT })
    // 原生窗口底色跟着方案走（页面未画出时露出的那块）
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()
    )).toBe(palette.background)
    const rgb = palette.subtle.match(/\w{2}/g)!.map((part) => parseInt(part, 16)).join(', ')
    await expect(page.getByTestId('title-bar')).toHaveCSS('background-color', `rgb(${rgb})`)
  }
  // 标题栏标识是正式应用图标（v0.14.2 首轮验收：不换成姊妹项目的占位渐变方块）
  const icon = page.locator('[data-testid="title-bar"] img')
  // Vite 把小 svg 内联成 data URI；认 >_ 那两笔（polyline 72,86 起笔）就是 build/icon.svg
  await expect(icon).toHaveAttribute('src', /^data:image\/svg\+xml,.*polyline%20points='72,86/)
  await expect(icon).toHaveCSS('width', '16px')
  for (const width of [960, 1280]) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 600), width)
    await expect.poll(() => page.evaluate(() => {
      const overlay = (navigator as Navigator & {
        windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): DOMRect }
      }).windowControlsOverlay
      const safe = overlay.getTitlebarAreaRect()
      const button = document.querySelector('[data-testid="open-settings"]')!.getBoundingClientRect()
      return overlay.visible && safe.width < innerWidth && safe.width > 0 &&
        // 分数 DPI（例如 175%）的布局会有浮点舍入；容忍半个 CSS 像素。
        button.left >= safe.left - 0.5 && button.right <= safe.right + 0.5 && button.bottom <= safe.bottom + 0.5
    })).toBe(true)
  }
  // 校验失败通过真实 IPC 返回 reject，不能静默成功。
  expect(await page.evaluate(async () => {
    try {
      await window.api.window.setTitleBarTheme({ color: 'red', symbolColor: '#ffffff', background: '#000000' } as TitleBarTheme)
      return 'accepted'
    } catch { return 'rejected' }
  })).toBe('rejected')
})

test('Windows 原生命中区域正确，最大化与还原后设置保持可用', { tag: '@headed' }, async () => {
  const launched = await launchApp([])
  app = launched.app
  const page = launched.page
  if (process.platform === 'win32') {
    const handle = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString()
    )
    const points = await page.evaluate(() => {
      const overlay = (navigator as Navigator & {
        windowControlsOverlay: { getTitlebarAreaRect(): DOMRect }
      }).windowControlsOverlay
      const safe = overlay.getTitlebarAreaRect()
      const settings = document.querySelector('[data-testid="open-settings"]')!.getBoundingClientRect()
      const width = (innerWidth - safe.right) / 3
      return [
        { name: 'drag', x: 300, y: 20 },
        { name: 'settings', x: settings.x + settings.width / 2, y: 20 },
        { name: 'minimize', x: safe.right + width / 2, y: 20 },
        { name: 'maximize', x: safe.right + width * 1.5, y: 20 },
        { name: 'close', x: safe.right + width * 2.5, y: 20 }
      ].map((p) => ({ ...p, x: Math.round(p.x * devicePixelRatio), y: Math.round(p.y * devicePixelRatio) }))
    })
    const pointsPath = join(launched.userDataDir, 'titlebar-hit-points.json')
    writeFileSync(pointsPath, JSON.stringify(points))
    const result = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve('e2e/fixtures/window-hit-test.ps1'), '-WindowHandle', handle, '-PointsPath', pointsPath
    ], { timeout: 20_000, windowsHide: true })
    expect(result.stderr).toBe('')
    // WM_NCHITTEST: HTCAPTION / HTCLIENT / HTMINBUTTON / HTMAXBUTTON / HTCLOSE。
    // 不移动系统鼠标，可与其他桌面车道用例并行。
    expect(JSON.parse(result.stdout)).toEqual([
      { name: 'drag', hit: 2 }, { name: 'settings', hit: 1 },
      { name: 'minimize', hit: 8 }, { name: 'maximize', hit: 9 }, { name: 'close', hit: 20 }
    ])
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false)
  await expect(page.getByTestId('title-bar')).toHaveCSS('height', `${TITLE_BAR_HEIGHT}px`)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await page.keyboard.press('Escape')

  // 最小化不节流：Playwright 接管的页面最小化后本就保持 visible，
  // 这里只能守住配置真到了 webContents；隐藏态差异由版本详情里的直启实测覆盖
  expect(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling())).toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-theme')).toBeVisible()
})

test('弹窗遮罩覆盖整条标题栏：原生按钮区与网页区同色，关闭恢复', { tag: '@headed' }, async () => {
  test.skip(process.platform !== 'win32', '真实 Windows 原生窗口截图边界')
  const launched = await launchApp([])
  app = launched.app
  const page = launched.page

  // capturePage / DOM 截图不含原生窗口按钮，必须截取真实原生窗口。
  const colors = async (): Promise<{ web: number[]; native: number[] }> => {
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    return app!.evaluate(async ({ BrowserWindow, desktopCapturer }, viewport) => {
      const win = BrowserWindow.getAllWindows()[0]
      const sources = await desktopCapturer.getSources({
        types: ['window'], thumbnailSize: { width: 3840, height: 2160 }
      })
      const source = sources.find((s) => s.id === win.getMediaSourceId())
      if (!source || source.thumbnail.isEmpty()) throw new Error('未捕获到目标窗口')
      const image = source.thumbnail
      const bitmap = image.toBitmap()
      const imageSize = image.getSize()
      const sample = (x: number): number[] => {
        // 离开按钮图标、边框和圆角，取标题栏底色。
        const pixelX = Math.floor(x * imageSize.width / viewport.width)
        const pixelY = Math.floor(30 * imageSize.height / viewport.height)
        const index = (pixelY * imageSize.width + pixelX) * 4
        return [bitmap[index + 2], bitmap[index + 1], bitmap[index]]
      }
      return { web: sample(300), native: sample(viewport.width - 20) }
    }, size)
  }
  const expectMatchingColors = async (): Promise<void> => {
    await expect.poll(async () => {
      const sample = await colors()
      return Math.max(...sample.web.map((channel, i) => Math.abs(channel - sample.native[i])))
    }).toBeLessThanOrEqual(1)
  }

  await expectMatchingColors()
  const initial = await colors()
  for (const trigger of ['open-settings', 'add-host', 'import-ssh-config']) {
    await page.getByTestId(trigger).click()
    await expect(page.locator('.scrim')).toBeVisible()
    await expectMatchingColors()
    await expect.poll(async () => (await colors()).native[0]).toBeLessThan(initial.native[0])
    await page.keyboard.press('Escape')
    await expect(page.locator('.scrim')).toHaveCount(0)
    await expectMatchingColors()
    await expect.poll(async () => (await colors()).native).toEqual(initial.native)
  }
  // 弹窗内部切换主题时仍保持遮罩合成，不能把原生按钮恢复成未遮罩色。
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-theme').selectOption('dracula')
  await expectMatchingColors()
  await page.getByTestId('settings-close').click()
  await expectMatchingColors()
})
