import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

/**
 * v0.9 会话可靠性：非干净关闭（网络断开——主进程未见 shell 退出状态）自动重连；
 * exit/logout 是用户意图，照旧收场不重连。
 */

let ssh: FakeSshServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ssh = await startFakeSshServer()
})

test.afterAll(async () => {
  await ssh.close()
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

test('非干净断开：自动重连并恢复可用', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // drop = 服务端不发 exit-status 直接关连接（模拟网络断开）
  await page.getByTestId('composer-input').fill('drop')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('自动重连')
  await expect.poll(() => activeTerminalText(page), { timeout: 20_000 }).toContain('[已重连]')

  // 重连后新 shell 就绪，composer 回 prompt，命令照常可用
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15_000
  })
  await page.getByTestId('composer-input').fill('echo back-alive')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^back-alive$/m.test(await activeTerminalText(page))).toBe(true)
})

test('exit 干净退出：不触发自动重连', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('composer-input').fill('exit')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('[连接已关闭]')
  expect(await activeTerminalText(page)).not.toContain('自动重连')
})
