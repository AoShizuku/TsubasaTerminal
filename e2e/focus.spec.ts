import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
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

/** 连接并等到 composer 进入 prompt 态（shell integration 激活） */
async function connectAndWaitPrompt(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

/** 通过 composer 跑一条命令并等待其输出独占一行 */
async function runCommand(page: Page, command: string, expected: RegExp): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect.poll(async () => expected.test(await activeTerminalText(page))).toBe(true)
}

test('连接后焦点自动落在 composer', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('composer 组稿整行发送，↑/↓ 召回历史', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo focus-marker', /^focus-marker$/m)

  // 发送后清空，↑ 召回，↓ 回到空草稿
  const input = page.getByTestId('composer-input')
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(input).toHaveValue('echo focus-marker')
  await page.keyboard.press('ArrowDown')
  await expect(input).toHaveValue('')
})

test('Ctrl+Shift+A 跳 Agent 输入框，Enter 发送留守、Esc 放弃并回家', { tag: ['@headed', '@daily'] }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)

  // 去：Ctrl+Shift+A（自动切到 Agent tab 并聚焦输入框）
  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByTestId('agent-input')).toBeFocused()

  // v0.7 起 Agent 是持续对话：Enter 发送后焦点留守输入框（未配 profile 时给出提示）
  await page.keyboard.type('看看负载')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('agent-send-error')).toContainText('配置模型服务')
  await expect(page.getByTestId('agent-input')).toBeFocused()

  // 回程票：Esc 放弃并回家（草稿保留）
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('点文件栏条目与点空白后焦点回家', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)

  // 文件栏是纯鼠标表面：点 tab、点目录条目，焦点都立即回家
  await page.getByRole('tab', { name: '文件' }).click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.getByTestId('flat-entry').filter({ hasText: 'www' }).click()
  await expect(page.getByTestId('breadcrumb')).toContainText('www')
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // 点侧栏空白（非交互表面）→ 回家
  await page.getByText('主机列表').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('TUI 场景：composer 让位直通，退出后复位回家', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // 进入备用屏幕 → composer 整体让位
  await page.keyboard.type('tui')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toBeHidden()
  await expect.poll(() => activeTerminalText(page)).toContain('[FAKE-TUI]')

  // 焦点已自动在终端上，q 直通 pty 退出 TUI
  await page.keyboard.press('q')
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('运行态按键直通 pty：交互式命令的应答', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // ask 命令挂起等输入 → composer 置灰，键盘直达 pty
  await page.keyboard.type('ask')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('input?')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  await expect(page.getByTestId('composer-input')).toBeDisabled()

  await page.keyboard.type('yes')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('answer: yes')

  // 命令结束 → composer 复位并拿回焦点
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('Ctrl+R 历史搜索回填草稿', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo aaa-one', /^aaa-one$/m)
  await runCommand(page, 'echo bbb-two', /^bbb-two$/m)

  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.press('Control+r')
  await expect(page.getByTestId('history-search-input')).toBeFocused()
  await page.keyboard.type('aaa')
  await expect(page.getByTestId('history-search-item')).toHaveText('echo aaa-one')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo aaa-one')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('Ctrl+数字切换会话且焦点回家', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo first-tab-mark', /^first-tab-mark$/m)

  // 开第二个会话
  await page.getByTestId('host-item').dblclick()
  await expect(page.getByTestId('session-tab')).toHaveCount(2)
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  expect(await activeTerminalText(page)).not.toContain('first-tab-mark')

  // Ctrl+1 回第一个会话，焦点在 composer
  await page.keyboard.press('Control+Digit1')
  await expect.poll(() => activeTerminalText(page)).toContain('first-tab-mark')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})
