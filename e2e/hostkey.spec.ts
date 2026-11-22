import { expect, test, type ElectronApplication } from '@playwright/test'
import { startFakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost, readHostsFile } from './fixtures/launch'
import { readFileSync } from 'fs'
import { join } from 'path'

let app: ElectronApplication | undefined

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('主机密钥变化时拒绝连接（TOFU）', { tag: '@daily' }, async () => {
  const server1 = await startFakeSshServer()
  const launched = await launchApp([makeHost(server1.port)])
  app = launched.app
  const page = launched.page

  // 首次连接：TOFU 记录指纹
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  const knownHosts = readFileSync(join(launched.userDataDir, 'known_hosts.json'), 'utf-8')
  expect(knownHosts).toContain(`127.0.0.1:${server1.port}`)

  // 关闭会话与旧服务器，在同端口起一个新 host key 的服务器
  await page.getByTestId('close-tab').click()
  await server1.close()
  const server2 = await startFakeSshServer({ port: server1.port })

  try {
    await page.getByTestId('host-item').dblclick()
    await expect
      .poll(() => activeTerminalText(page), { timeout: 15_000 })
      .toContain('主机密钥已改变')
  } finally {
    await server2.close()
  }
})

test('凭据加密存储，hosts.json 不含明文密码字段', async () => {
  const server = await startFakeSshServer()
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  // 触发一次读取（启动时 hosts:list 已迁移明文 fixture → 加密存储）
  await expect(page.getByTestId('host-item')).toHaveCount(1)
  await expect.poll(() => readHostsFile(launched.userDataDir)).toContain('passwordEnc')
  expect(readHostsFile(launched.userDataDir)).not.toContain('"password":')

  // 迁移后的加密凭据仍可用于连接
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await server.close()
})
