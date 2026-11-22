import { expect, test, type ElectronApplication } from '@playwright/test'
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

test('连接后注入 shell integration source 行', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  // 注入命令可见（坦诚展示）：. /tmp/.tsubasaterminal-si-xxx.sh
  await expect.poll(() => activeTerminalText(page)).toContain('.tsubasaterminal-si-')
})

test('cd 跟随：终端切目录后文件栏自动导航', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByRole('tab', { name: '文件' }).click()
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'app.log' })).toBeVisible()

  // 终端里 cd，面板应自动跟到 www
  await page.locator('[data-testid="terminal-view"]:visible').click()
  await page.keyboard.type('cd www')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'index.html' })).toBeVisible()
  await expect(page.getByTestId('breadcrumb')).toContainText('www')
})

test('手动导航暂停跟随，磁铁恢复并跳回 cwd', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByRole('tab', { name: '文件' }).click()
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'app.log' })).toBeVisible()
  await expect(page.getByTestId('follow-toggle')).toHaveAttribute('data-active', 'on')

  // 终端 cd 到 www
  await page.locator('[data-testid="terminal-view"]:visible').click()
  await page.keyboard.type('cd www')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'index.html' })).toBeVisible()

  // 面板里点面包屑回上级 → 跟随自动暂停
  await page.getByTestId('crumb').filter({ hasText: 'test' }).click()
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'app.log' })).toBeVisible()
  await expect(page.getByTestId('follow-toggle')).toHaveAttribute('data-active', 'off')

  // 点磁铁恢复跟随 → 跳回 shell 当前目录 www
  await page.getByTestId('follow-toggle').click()
  await expect(page.getByTestId('follow-toggle')).toHaveAttribute('data-active', 'on')
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'index.html' })).toBeVisible()
})
