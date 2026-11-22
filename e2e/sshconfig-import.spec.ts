import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { launchApp } from './fixtures/launch'

/** v0.9：~/.ssh/config 一键导入（TSUBASATERMINAL_SSH_CONFIG 指向 fixture，隔离真实文件） */

const CONFIG_TEXT = `# 全局默认
Host *
  ServerAliveInterval 60

Host us1
  HostName 10.0.0.1
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_us1

Host us2 lax*
  HostName 10.0.0.2
`

let app: ElectronApplication | undefined

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('解析并导入：通配符跳过、字段齐备、落盘为私钥认证主机', { tag: '@daily' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsubasa-sshconfig-'))
  const configPath = join(dir, 'config')
  writeFileSync(configPath, CONFIG_TEXT, 'utf-8')

  const launched = await launchApp([], undefined, {
    env: { TSUBASATERMINAL_SSH_CONFIG: configPath }
  })
  app = launched.app
  const page = launched.page

  await page.getByTestId('import-ssh-config').click()
  // * 与 lax* 跳过：只有 us1、us2 两条
  await expect(page.getByTestId('import-entry')).toHaveCount(2)
  await expect(page.getByTestId('import-entry').first()).toContainText('us1')
  await expect(page.getByTestId('import-entry').first()).toContainText('deploy@10.0.0.1:2222')

  await page.getByTestId('import-confirm').click()
  await expect(page.getByTestId('import-result')).toContainText('已导入 2')
  await expect(page.getByTestId('host-item')).toHaveCount(2)

  const hosts = JSON.parse(readFileSync(join(launched.userDataDir, 'hosts.json'), 'utf-8'))
  const us1 = hosts.find((h: { name: string }) => h.name === 'us1')
  expect(us1.host).toBe('10.0.0.1')
  expect(us1.port).toBe(2222)
  expect(us1.username).toBe('deploy')
  expect(us1.authType).toBe('privateKey')
  expect(us1.privateKeyPath).toBe('~/.ssh/id_us1')
})

test('已存在的主机默认不勾选、标注已存在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsubasa-sshconfig-'))
  const configPath = join(dir, 'config')
  writeFileSync(configPath, CONFIG_TEXT, 'utf-8')

  const launched = await launchApp(
    [
      {
        id: 'existing-1',
        name: 'us1-already',
        host: '10.0.0.1',
        port: 2222,
        username: 'deploy',
        authType: 'privateKey'
      }
    ],
    undefined,
    { env: { TSUBASATERMINAL_SSH_CONFIG: configPath } }
  )
  app = launched.app
  const page = launched.page

  await page.getByTestId('import-ssh-config').click()
  const first = page.getByTestId('import-entry').first()
  await expect(first).toContainText('已存在')
  // v0.13.0：勾选块自绘后，行本身担任 role=checkbox（原生 input 已不在里面）
  await expect(first).not.toBeChecked()
})
