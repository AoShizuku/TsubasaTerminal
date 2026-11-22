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

test('文件页平铺视图：预取 home 并可点击目录导航', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByRole('tab', { name: '文件' }).click()
  // 连接时已预取，无需再等 SFTP 初始化
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'app.log' })).toBeVisible()
  await expect(page.getByTestId('breadcrumb')).toContainText('test')

  // 点击目录 → 导航进入
  await page.getByTestId('flat-entry').filter({ hasText: 'www' }).click()
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'index.html' })).toBeVisible()
})

test('树视图可展开，tab 切换后状态保留', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByRole('tab', { name: '文件' }).click()
  await page.getByTestId('view-toggle').click()
  await expect(page.getByTestId('file-node').filter({ hasText: 'www' })).toBeVisible()

  await page.getByTestId('file-node').filter({ hasText: 'www' }).click()
  await expect(page.getByTestId('file-node').filter({ hasText: 'index.html' })).toBeVisible()

  // 切到 Agent 再切回：树视图与展开状态保留（forceMount + store 缓存）
  await page.getByRole('tab', { name: 'Agent' }).click()
  await page.getByRole('tab', { name: '文件' }).click()
  await expect(page.getByTestId('file-node').filter({ hasText: 'index.html' })).toBeVisible()
})
