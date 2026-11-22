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

async function connectAndWaitPrompt(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()
}

test('L1 ghost text：历史前缀灰字提示，→ 接受', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.keyboard.type('echo ghost-mark-once')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^ghost-mark-once$/m.test(await activeTerminalText(page))).toBe(
    true
  )

  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type('echo g')
  await expect(page.getByTestId('ghost-text')).toHaveText('host-mark-once')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo ghost-mark-once')
  await expect(page.getByTestId('ghost-text')).toHaveText('')
})

test('L2 预取缓存：命令表与 SFTP 路径补全零实查', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  const beforeConnect = server.execCounts()
  await connectAndWaitPrompt(page)
  // 等命令表预取完成（连接后唯一一次 exec）
  await expect.poll(() => server.execCounts()).toBe(beforeConnect + 1)

  // 首词命令补全吃预取缓存
  await page.keyboard.type('ec')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo ')
  expect(server.execCounts()).toBe(beforeConnect + 1)

  // 路径补全吃 SFTP 目录缓存（cd 跟随实时维护）
  await page.getByTestId('composer-input').fill('')
  await page.keyboard.type('cat ap')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('composer-input')).toHaveValue('cat app.log ')
  expect(server.execCounts()).toBe(beforeConnect + 1)
})

test('L2 上下文候选：systemctl 补 unit、docker 补容器名', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.keyboard.type('systemctl restart ngi')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('composer-input')).toHaveValue('systemctl restart nginx.service ')

  await page.getByTestId('composer-input').fill('')
  await page.keyboard.type('docker logs web')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('composer-input')).toHaveValue('docker logs web-app ')
})

test('OSC 合理性校验：运行中伪造 133;A 不能把 composer 骗回 prompt', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.keyboard.type('trap')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('input?')
  // 伪 A 已随输出到达——composer 必须仍在运行态直通
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  await expect(page.getByTestId('composer-input')).toBeDisabled()

  // 键盘直通应答，命令正常结束后真 prompt 恢复
  await page.keyboard.type('okay')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('answer: okay')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()
})
