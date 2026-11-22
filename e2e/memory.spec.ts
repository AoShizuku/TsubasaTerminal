import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost, type TestHost } from './fixtures/launch'

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

function historyFile(userDataDir: string, host: TestHost): string {
  return join(userDataDir, 'history', `${host.id}.jsonl`)
}

function readHistory(userDataDir: string, host: TestHost): string {
  try {
    return readFileSync(historyFile(userDataDir, host), 'utf-8')
  } catch {
    return ''
  }
}

async function connectAndRun(page: Page, commands: string[]): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  for (const command of commands) {
    await expect(page.getByTestId('composer-input')).toBeFocused()
    await page.keyboard.type(command)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  }
}

test('主机记忆：命令历史跨重启持久化，↑ 与 Ctrl+R 可用', async () => {
  const host = makeHost(server.port)
  const first = await launchApp([host])
  app = first.app

  await connectAndRun(first.page, ['echo memory-probe-one'])
  // 历史入库是异步落盘，poll 文件
  await expect
    .poll(() => readHistory(first.userDataDir, host))
    .toContain('echo memory-probe-one')

  await first.app.close()
  app = undefined

  // 复用 userData 重启：主机与历史都应还在
  const second = await launchApp([], first.userDataDir)
  app = second.app
  const page = second.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // Ctrl+R 跨会话可搜索——搜索结果是响应式的，同时充当"预载完成"的等待屏障
  await page.keyboard.press('Control+r')
  await page.keyboard.type('memory-probe')
  await expect(page.getByTestId('history-search-item').first()).toContainText(
    'echo memory-probe-one'
  )
  await page.keyboard.press('Escape')

  // ↑ 召回上一次运行的命令（主机记忆预载）
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo memory-probe-one')
})

test('主机记忆脱敏后入库：命令行密码不落盘', { tag: '@daily' }, async () => {
  const host = makeHost(server.port)
  const launched = await launchApp([host])
  app = launched.app

  await connectAndRun(launched.page, ['deploy --password=Sup3rSecret99 --target prod'])
  await expect.poll(() => readHistory(launched.userDataDir, host)).toContain('«REDACTED:')
  const content = readHistory(launched.userDataDir, host)
  expect(content).not.toContain('Sup3rSecret99')
  expect(content).toContain('deploy')
})
