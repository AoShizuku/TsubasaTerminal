import { expect, test, type ElectronApplication } from '@playwright/test'
import {
  startFakeSshServer,
  startSilentTcpServer,
  type FakeSshServer
} from './fixtures/fake-ssh-server'
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

test('连接成功后显示远端 prompt', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app

  await launched.page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(launched.page)).toContain('test@fake:~$')
})

test('密码错误时终端显示连接失败', async () => {
  const launched = await launchApp([makeHost(server.port, { password: 'wrong-password' })])
  app = launched.app

  await launched.page.getByTestId('host-item').dblclick()
  await expect
    .poll(() => activeTerminalText(launched.page), { timeout: 15_000 })
    .toContain('[连接失败]')
})

test('服务器无响应时报握手超时', async () => {
  const silent = await startSilentTcpServer()
  try {
    const launched = await launchApp([makeHost(silent.port)], undefined, {
      env: { TSUBASATERMINAL_E2E_READY_TIMEOUT_MS: '400' }
    })
    app = launched.app

    await launched.page.getByTestId('host-item').dblclick()
    // 生产默认仍是 15s；这里只用测试专用变量压短无响应 socket 的握手时钟
    await expect
      .poll(() => activeTerminalText(launched.page), { timeout: 5_000, intervals: [100] })
      .toContain('[连接失败]')
    expect(await activeTerminalText(launched.page)).toContain('Timed out')
  } finally {
    await silent.close()
  }
})

test('输入命令得到回显输出', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.locator('[data-testid="terminal-view"]:visible').click()
  await page.keyboard.type('echo hello-e2e-marker')
  await page.keyboard.press('Enter')

  // 输出应独占一行（区别于命令本身的回显行 "test@fake:~$ echo ..."）
  await expect
    .poll(async () => /^hello-e2e-marker$/m.test(await activeTerminalText(page)))
    .toBe(true)
})
