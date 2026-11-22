import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { MIDDLE_MIN_WIDTH, PANE_DEFAULT_WIDTH } from '../src/shared/layout'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

let server: FakeSshServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  server = await startFakeSshServer()
})

test.afterAll(async () => {
  await server.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

/** 取整：DPI 缩放下 boundingBox 带 1e-5 级浮点尾巴，按整数 px 断言 */
async function width(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())!.width)
}

/**
 * 拖把手：按住热区中心横向拖 dx。Playwright 的 mouse 在 Chromium 里会
 * 合成 pointer 事件，pointer capture 照常生效；分 steps 走是为了产生多次 pointermove
 * ——"一次拖拽只换一次 SIGWINCH"的断言就靠中间这些帧确实发生过。
 */
async function dragSash(page: Page, side: 'left' | 'right', dx: number): Promise<void> {
  const hit = page.getByTestId(`sash-${side}`).locator('.sash-hit')
  const box = (await hit.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 12 })
  await page.mouse.up()
}

function settingsOf(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
}

/** xterm 渲染网格必须完整落在终端容器内，否则底行/右缘被裁（vim 状态栏被吞的根因） */
async function expectGridInsideContainer(page: Page): Promise<void> {
  const container = await page.locator('[data-testid="terminal-view"]:visible').boundingBox()
  const screen = await page.locator('.xterm-screen:visible').boundingBox()
  expect(container).not.toBeNull()
  expect(screen).not.toBeNull()
  expect(screen!.y + screen!.height).toBeLessThanOrEqual(container!.y + container!.height + 0.5)
  expect(screen!.x + screen!.width).toBeLessThanOrEqual(container!.x + container!.width + 0.5)
}

test('composer 输入行 autosize：默认单行、多行长高、6 行封顶、清空回落', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')

  const input = page.getByTestId('composer-input')
  const height = async (): Promise<number> => (await input.boundingBox())!.height

  // ideal 形态回归：默认单行（v0.8.1 曾写死 h-16 三行）
  const oneLine = await height()
  expect(oneLine).toBeLessThan(40)

  // 多行草稿长高（mirror 驱动，占位挤终端不覆盖）
  await input.fill('line-1\nline-2\nline-3')
  await expect.poll(height).toBeGreaterThan(oneLine * 2)

  // 超 6 行封顶，textarea 内部滚动
  await input.fill(Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n'))
  await expect.poll(height).toBeLessThanOrEqual(121)

  // 长高状态下网格仍不溢出容器（refit 让位）
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)

  // 清空回落单行
  await input.fill('')
  await expect.poll(height).toBe(oneLine)
})

test('终端网格不溢出容器：普通模式与 TUI 全屏', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expectGridInsideContainer(page)

  // 进 TUI：composer 让位、终端拿满高度并 refit——网格仍须在容器内
  await page.keyboard.type('tui')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toBeHidden()
  await expect.poll(() => activeTerminalText(page)).toContain('[FAKE-TUI]')
  // 等 refit 稳定（resize 触发的 pty/网格更新是异步的）
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)

  // 退出 TUI 回到普通布局，同样不得溢出
  await page.keyboard.press('q')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)
})

test('侧栏折叠：两栏收起后终端拿满宽度且网格不溢出，Ctrl+Shift+A 自动请回右栏', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')

  const termWidth = async (): Promise<number> =>
    (await page.locator('[data-testid="terminal-view"]:visible').boundingBox())!.width
  const threeColumn = await termWidth()

  // 收左栏：主机列表整体退出布局（display:none，不是宽度归零），中栏随即变宽
  await page.getByTestId('toggle-left-pane').click()
  await expect(page.getByTestId('host-item')).toBeHidden()
  await expect.poll(termWidth).toBeGreaterThan(threeColumn)
  const oneCollapsed = await termWidth()

  // 收右栏：Agent / 文件 tab 一并退出
  await page.getByTestId('toggle-right-pane').click()
  await expect(page.getByRole('tab', { name: '文件' })).toBeHidden()
  await expect.poll(termWidth).toBeGreaterThan(oneCollapsed)

  // 折叠后 refit 到位：网格仍完整落在容器内（底行/右缘不被裁）
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)

  // 折叠态下终端照常可用——resize 之后 pty 没被打断
  await page.keyboard.type('echo collapsed')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('echo collapsed')

  // Ctrl+Shift+A：右栏藏着也要能跳 Agent——先请回来再落焦，
  // 焦点落在 display:none 子树里会静默失败，这条断言就是那个坑的守卫
  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByRole('tab', { name: '文件' })).toBeVisible()
  await expect(page.getByTestId('agent-input')).toBeFocused()

  // 键盘路径放回左栏（Ctrl+Shift+B；Ctrl+B 归 tmux，不能占）
  await page.keyboard.press('Control+Shift+B')
  await expect(page.getByTestId('host-item')).toBeVisible()
  await expect.poll(termWidth).toBeLessThanOrEqual(threeColumn)
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)
})

test('侧栏拖拽调宽：实时动栏、松手只换一次 SIGWINCH、上限夹在中栏下限、双击复位', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  // 连接后的首次 fit 已经结清，之后再数
  await page.waitForTimeout(300)

  const TERM = '[data-testid="terminal-view"]:visible'
  const leftBefore = await width(page, '[data-testid="left-pane"]')
  const termBefore = await width(page, TERM)
  expect(leftBefore).toBe(PANE_DEFAULT_WIDTH.left)

  // 往右拖 80px：左栏变宽、终端等量变窄。12 步 pointermove 里 cols 变了十几次，
  // 但 pty 只能收到松手那一次 window-change——这是穿过 SSH 边界的断言，DOM 看不出来
  const resizesBefore = server.windowChanges()
  await dragSash(page, 'left', 80)
  await expect.poll(() => width(page, '[data-testid="left-pane"]')).toBe(leftBefore + 80)
  await expect.poll(() => width(page, TERM)).toBe(termBefore - 80)
  await page.waitForTimeout(300)
  expect(server.windowChanges() - resizesBefore).toBe(1)
  await expectGridInsideContainer(page)
  await expect.poll(() => settingsOf(launched.userDataDir).leftPaneWidth).toBe(leftBefore + 80)

  // 拖到头：上限 = 容器宽 − 右栏有效宽 − 中栏下限，中栏被夹在 MIDDLE_MIN_WIDTH。
  // 指针停在窗口内（右栏里），位移已远超上限
  const body = await width(page, '[data-testid="window-body"]')
  const right = await width(page, '[data-testid="right-pane"]')
  await dragSash(page, 'left', body - PANE_DEFAULT_WIDTH.left - 100)
  const cap = Math.floor(body - right - MIDDLE_MIN_WIDTH)
  await expect.poll(() => width(page, '[data-testid="left-pane"]')).toBe(cap)
  await expect.poll(() => width(page, '[data-testid="terminal-view"]:visible')).toBe(
    MIDDLE_MIN_WIDTH
  )
  await page.waitForTimeout(300)
  await expectGridInsideContainer(page)

  // 折叠态下终端照常可用——resize 没打断 pty
  await page.keyboard.type('echo resized')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('echo resized')

  // 双击把手回默认宽并写盘
  await page.getByTestId('sash-left').locator('.sash-hit').dblclick()
  await expect.poll(() => width(page, '[data-testid="left-pane"]')).toBe(PANE_DEFAULT_WIDTH.left)
  await expect.poll(() => settingsOf(launched.userDataDir).leftPaneWidth).toBe(
    PANE_DEFAULT_WIDTH.left
  )

  // 右栏方向相反：往左拖 = 变宽
  const rightBefore = await width(page, '[data-testid="right-pane"]')
  await dragSash(page, 'right', -60)
  await expect.poll(() => width(page, '[data-testid="right-pane"]')).toBe(rightBefore + 60)
  await expect.poll(() => settingsOf(launched.userDataDir).rightPaneWidth).toBe(rightBefore + 60)
})

test('布局记忆：折叠、宽度与右栏 tab 跨重启保持，首帧不按默认布局回填', async () => {
  const first = await launchApp([makeHost(server.port)])
  app = first.app
  const page = first.page

  await page.getByTestId('toggle-left-pane').click()
  await expect(page.getByTestId('host-item')).toBeHidden()
  await page.getByRole('tab', { name: '文件' }).click()
  const rightBefore = await width(page, '[data-testid="right-pane"]')
  await dragSash(page, 'right', -100)
  await expect.poll(() => width(page, '[data-testid="right-pane"]')).toBe(rightBefore + 100)
  await expect.poll(() => settingsOf(first.userDataDir)).toMatchObject({
    leftPaneOpen: false,
    rightPaneOpen: true,
    rightPaneWidth: rightBefore + 100,
    rightPanelTab: 'files'
  })
  await first.app.close()

  // 同一 userData 二次启动：就绪即已是记住的布局（launchApp 的就绪判据不依赖左栏可见）
  const second = await launchApp([], first.userDataDir)
  app = second.app
  const page2 = second.page
  await expect(page2.getByTestId('left-pane')).toBeHidden()
  await expect(page2.getByRole('tab', { name: '文件' })).toHaveAttribute('data-state', 'active')
  expect(await width(page2, '[data-testid="right-pane"]')).toBe(rightBefore + 100)

  // 折叠着启动仍能开会话、网格不溢出；Ctrl+Shift+B 放回左栏也走同一条持久化
  await page2.keyboard.press('Control+Shift+B')
  await expect(page2.getByTestId('host-item')).toBeVisible()
  await page2.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page2)).toContain('test@fake:~$')
  await page2.waitForTimeout(300)
  await expectGridInsideContainer(page2)
  await expect.poll(() => settingsOf(second.userDataDir).leftPaneOpen).toBe(true)
})

test('拖把手不动焦点：Agent 输入框持焦时调宽右栏，焦点仍在输入框', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByTestId('agent-input')).toBeFocused()

  // pointerdown 被 preventDefault（不让 mousedown 把焦点踢到 body），收尾 click 落在
  // data-keep-focus 区（App 的回家逻辑不接管）——两半缺一，焦点都会跑
  await dragSash(page, 'right', -40)
  await expect(page.getByTestId('agent-input')).toBeFocused()
  await expect.poll(() => width(page, '[data-testid="right-pane"]')).toBe(
    PANE_DEFAULT_WIDTH.right + 40
  )
})
