import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * 复制路径。三条路各自可用：
 * 终端鼠标（选中即复制）、终端键盘（Ctrl+Shift+C）、只读文本原生选区（Ctrl+C）。
 * 焦点纪律不得吃掉选区——"点空白回家"曾在拖选收尾时把选区清空。
 */

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ssh = await startFakeSshServer()
  llm = await startFakeLlmServer()
})

test.afterAll(async () => {
  await ssh.close()
  await llm.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

async function connectAndWaitPrompt(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function runCommand(page: Page, command: string, expected: RegExp): Promise<void> {
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect.poll(async () => expected.test(await activeTerminalText(page))).toBe(true)
}

/** 在元素上拖出一个真实选区（mousedown → move → mouseup） */
async function dragSelect(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('目标不可见，无法拖选')
  await page.mouse.move(box.x + 3, box.y + 3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3, { steps: 12 })
  await page.mouse.up()
}

/** DOM 文本容器可能比字形宽很多；沿 Range 的首末行拖，避免鼠标落在两端空白上。 */
async function dragSelectText(page: Page, locator: Locator): Promise<void> {
  const points = await locator.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 1 && rect.height > 1)
    const first = rects[0]
    const last = rects.at(-1)
    if (!first || !last) return null
    return {
      from: { x: first.left + 1, y: first.top + first.height / 2 },
      to: { x: last.right - 1, y: last.top + last.height / 2 }
    }
  })
  if (!points) throw new Error('目标没有可拖选的文本')
  await page.mouse.move(points.from.x, points.from.y)
  await page.mouse.down()
  await page.mouse.move(points.to.x, points.to.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => domSelection(page)).not.toBe('')
}

function clipboard(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ clipboard: cb }) => cb.readText())
}

function seedClipboard(electronApp: ElectronApplication, text: string): Promise<void> {
  return electronApp.evaluate(({ clipboard: cb }, value) => cb.writeText(value), text)
}

function domSelection(page: Page): Promise<string> {
  return page.evaluate(() => (window.getSelection()?.toString() ?? '').trim())
}

/** 终端要拖 xterm 的渲染层：terminal-view 外层带 padding（FitAddon 的行数算法要求），
 *  按在 padding 上 xterm 收不到 mousedown，选不出东西 */
function terminalScreen(page: Page): Locator {
  return page.getByTestId('terminal-view').locator('.xterm-screen')
}

test('终端选中即复制：拖选直接进剪贴板，尾部空行不带出去', { tag: ['@headed', '@daily'] }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo copy-on-select-mark', /^copy-on-select-mark$/m)

  await seedClipboard(launched.app, 'SENTINEL')
  await dragSelect(page, terminalScreen(page))

  // 写剪贴板是异步的（提示也挂在兑现之后），断言一律轮询，不赌单次时序
  await expect.poll(() => clipboard(launched.app)).toContain('copy-on-select-mark')
  // 拖到屏幕底部会带上整屏空行，尾部空白从来不是用户要的那部分
  expect(await clipboard(launched.app)).not.toMatch(/\s$/)
  // 复制不抢焦点：家还是 composer
  await expect(page.getByTestId('composer-input')).toBeFocused()
  // 显性反馈（隐形动作必须有信号）
  await expect(page.getByTestId('copy-toast')).toContainText('已复制')
})

test('选中即复制可关：关掉后拖选不动剪贴板，Ctrl+Shift+C 仍能复制（焦点在 Agent 框也能）', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalCopyOnSelect: false }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo keyboard-path-mark', /^keyboard-path-mark$/m)

  await seedClipboard(launched.app, 'SENTINEL')
  await dragSelect(page, terminalScreen(page))
  // 没复制的证据取"提示始终不出现"——比读剪贴板可靠，异步写入不会偷偷赶在断言之后
  await expect(page.getByTestId('copy-toast')).toHaveCount(0)
  expect(await clipboard(launched.app)).toBe('SENTINEL')

  // 键盘路径：焦点跑到 Agent 输入框（composer 的 Ctrl+C 够不着的地方）也能复制终端选区
  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByTestId('agent-input')).toBeFocused()
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(() => clipboard(launched.app)).toContain('keyboard-path-mark')

  // 设置项在弹窗里如实反映关闭状态
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-copy-on-select')).not.toBeChecked()
})

test('Agent 面板：拖选保住选区可原生复制，复制按钮给的是 markdown 原文', { tag: '@headed' }, async () => {
  const profile: SeedLlmProfile = {
    id: 'prof-anthropic',
    name: 'Fake Claude',
    provider: 'anthropic',
    baseURL: llm.anthropicBaseURL,
    model: 'fake-model',
    apiKey: 'sk-test'
  }
  const launched = await launchApp([makeHost(ssh.port)], undefined, { llmProfiles: [profile] })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('agent-input').fill('show-markdown')
  await page.getByTestId('agent-input').press('Enter')
  const md = page.getByTestId('agent-md').last()
  await expect(md.locator('h1')).toHaveText('诊断结论')

  // 拖选：焦点纪律不得在收尾 click 上把选区清掉（曾经清了，复制彻底不可能）
  await seedClipboard(launched.app, 'SENTINEL')
  await dragSelectText(page, md.locator('h1'))
  expect(await domSelection(page)).toContain('诊断结论')
  await page.keyboard.press('Control+c')
  await expect.poll(() => clipboard(launched.app)).toContain('诊断结论')

  // Ctrl+Shift+C 不分表面：终端没选区时复制页面选区
  await seedClipboard(launched.app, 'SENTINEL')
  await dragSelectText(page, md.locator('h1'))
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(() => clipboard(launched.app)).toContain('诊断结论')

  // 复制按钮：原文而非渲染结果——markdown 标记必须还在
  await seedClipboard(launched.app, 'SENTINEL')
  const copyBtn = page.getByTestId('agent-msg-copy').last()
  await copyBtn.click()
  await expect(copyBtn).toHaveText('已复制')
  await expect.poll(() => clipboard(launched.app)).toContain('# 诊断结论')
  const raw = await clipboard(launched.app)
  expect(raw).toContain('**磁盘已满**')
  expect(raw).toContain('[排查文档](https://example.com/docs)')
  // 回程票：点完按钮焦点回家，不停在按钮上吃掉后续按键
  await expect(page.getByTestId('composer-input')).toBeFocused()
})

test('拖选只读文本后直接打字不丢键：字符回流 composer 并回家', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  const hint = page.locator('p').filter({ hasText: '然后在这里提问' }).first()
  await dragSelectText(page, hint)
  // 选区还在（不回家），焦点没落进任何输入框——落进去选区当场就被收走了
  expect(await domSelection(page)).not.toBe('')
  expect(
    await page.evaluate(() => {
      const el = document.activeElement
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    })
  ).toBe(false)

  await page.keyboard.type('uptime')
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByTestId('composer-input')).toHaveValue('uptime')

  // 单纯点击（无选区）照旧回家——选区守卫没有把"点空白回家"破坏掉
  await page.getByText('主机列表').click()
  await expect(page.getByTestId('composer-input')).toBeFocused()
})
