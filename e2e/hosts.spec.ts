import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchApp, makeHost, readHostsFile } from './fixtures/launch'

let app: ElectronApplication | undefined

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('新增主机在重启应用后仍然存在', { tag: '@daily' }, async () => {
  const launched = await launchApp([])
  app = launched.app
  const page = launched.page

  await page.getByTestId('add-host').click()
  await page.getByTestId('form-name').fill('e2e-added-host')
  await page.getByTestId('form-host').fill('127.0.0.1')
  await page.getByTestId('form-port').fill('2222')
  await page.getByTestId('form-username').fill('test')
  await page.getByTestId('form-password').fill('pw')
  await page.getByTestId('form-save').click()

  await expect(page.getByTestId('host-item')).toHaveCount(1)
  await expect(page.getByTestId('host-item')).toContainText('e2e-added-host')
  // 等待落盘再重启，避免 close 与异步保存竞争
  await expect.poll(() => readHostsFile(launched.userDataDir)).toContain('e2e-added-host')

  await app.close()
  const relaunched = await launchApp([], launched.userDataDir)
  app = relaunched.app
  await expect(relaunched.page.getByTestId('host-item')).toHaveCount(1)
  await expect(relaunched.page.getByTestId('host-item')).toContainText('e2e-added-host')
})

test('删除主机后持久化生效', async () => {
  const launched = await launchApp([makeHost(2222, { name: 'host-to-delete' })])
  app = launched.app
  const page = launched.page

  await expect(page.getByTestId('host-item')).toHaveCount(1)
  // 删主机自 v0.13.1 二次返工起要确认（会级联删该主机的排障经验），
  // v0.13.13 起是应用内确认框：危险操作默认落焦「取消」，Esc 取消
  await page.getByTestId('delete-host').click()
  await expect(page.getByTestId('confirm-message')).toContainText('删除主机「host-to-delete」？')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-dialog')).toBeHidden()
  await expect(page.getByTestId('host-item')).toHaveCount(1)

  await page.getByTestId('delete-host').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('host-item')).toHaveCount(0)
  await expect.poll(() => readHostsFile(launched.userDataDir)).not.toContain('host-to-delete')

  await app.close()
  const relaunched = await launchApp([], launched.userDataDir)
  app = relaunched.app
  await expect(relaunched.page.getByTestId('host-item')).toHaveCount(0)
  await expect(relaunched.page.getByText('暂无主机')).toBeVisible()
})
