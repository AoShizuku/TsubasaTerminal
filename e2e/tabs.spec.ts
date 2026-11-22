import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost, openSettings } from './fixtures/launch'

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

test('多标签会话互不串数据', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  // 第一个会话：写入标记
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await page.locator('[data-testid="terminal-view"]:visible').click()
  await page.keyboard.type('echo tab-one-marker')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^tab-one-marker$/m.test(await activeTerminalText(page))).toBe(true)

  // 第二个会话（再次点击主机开新标签）：不应看到第一个会话的数据
  await page.getByTestId('host-item').dblclick()
  await expect(page.getByTestId('session-tab')).toHaveCount(2)
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  expect(await activeTerminalText(page)).not.toContain('tab-one-marker')

  await page.locator('[data-testid="terminal-view"]:visible').click()
  await page.keyboard.type('echo tab-two-marker')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^tab-two-marker$/m.test(await activeTerminalText(page))).toBe(true)

  // 切回第一个标签：数据仍在，且没有第二个会话的数据
  await page.getByTestId('session-tab').first().click()
  await expect.poll(() => activeTerminalText(page)).toContain('tab-one-marker')
  expect(await activeTerminalText(page)).not.toContain('tab-two-marker')
})

test('关闭标签会断开 SSH 连接', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect.poll(() => server.activeConnections()).toBe(1)

  await page.getByTestId('close-tab').click()
  // 空闲（prompt）会话直接关，不弹确认
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect(page.getByTestId('session-tab')).toHaveCount(0)
  await expect.poll(() => server.activeConnections()).toBe(0)
})

/** 开一个会话并等到 shell integration 就绪（prompt 态），返回后焦点在 composer */
async function openReadySession(page: Page, count: number): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect(page.getByTestId('session-tab')).toHaveCount(count)
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()
}

async function clickCloseActiveTab(page: Page): Promise<void> {
  const tab = page.locator('[data-testid="session-tab"]').last()
  await tab.hover()
  await tab.getByTestId('close-tab').click()
}

test('终端忙时关闭标签先确认：取消保留连接，确认才断开', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  const dialog = page.getByTestId('confirm-dialog')

  // 命令运行中：sleepy 无输出、不回 prompt
  await openReadySession(page, 1)
  await page.keyboard.type('sleepy')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')

  await clickCloseActiveTab(page)
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('confirm-message')).toContainText('有命令正在运行')
  // 危险操作：默认焦点在取消，手滑回车不会误关
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await page.getByTestId('confirm-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('session-tab')).toHaveCount(1)
  expect(server.activeConnections()).toBe(1)
  // 取消后焦点回家：running 态的家是 xterm，不停在关闭按钮上
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[data-testid="terminal-view"]'))
    )
    .toBe(true)

  await clickCloseActiveTab(page)
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('session-tab')).toHaveCount(0)
  await expect.poll(() => server.activeConnections()).toBe(0)

  // 全屏应用中：同样要确认
  await openReadySession(page, 1)
  await page.keyboard.type('tui')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('[FAKE-TUI]')
  await expect(page.getByTestId('composer')).toBeHidden()

  await clickCloseActiveTab(page)
  await expect(page.getByTestId('confirm-message')).toContainText('全屏应用')
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('session-tab')).toHaveCount(0)
  await expect.poll(() => server.activeConnections()).toBe(0)
})

test('关闭忙碌会话前确认可在设置里关掉', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await openSettings(page, 'appearance')
  const sw = page.getByTestId('settings-confirm-close-busy')
  await expect(sw).toBeChecked()
  await sw.click()
  await expect(sw).not.toBeChecked()
  await page.getByTestId('settings-close').click()
  await expect(sw).toHaveCount(0)

  await openReadySession(page, 1)
  await page.keyboard.type('sleepy')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')

  await clickCloseActiveTab(page)
  await expect(page.getByTestId('session-tab')).toHaveCount(0)
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect.poll(() => server.activeConnections()).toBe(0)
})
