import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

let server: FakeSshServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  server = await startFakeSshServer({
    files: {
      '/home/test': [
        { name: 'www', type: 'dir' },
        { name: 'app.log', type: 'file', size: 128 },
        { name: 'config.yaml', type: 'file', size: 64 },
        { name: 'config.local.yaml', type: 'file', size: 64 }
      ],
      '/home/test/www': [{ name: 'index.html', type: 'file', size: 64 }]
    }
  })
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

test('唯一候选直接回填：文件加空格、目录带斜杠不加', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  const input = page.getByTestId('composer-input')

  // 文件唯一候选 → 回填 + 尾随空格
  await page.keyboard.type('cat ap')
  await page.keyboard.press('Tab')
  await expect(input).toHaveValue('cat app.log ')

  // 目录唯一候选 → 尾 /，不加空格（可继续补下一级）
  await input.fill('')
  await page.keyboard.type('cd w')
  await page.keyboard.press('Tab')
  await expect(input).toHaveValue('cd www/')

  // 继续 Tab 补下一级目录内容
  await page.keyboard.press('Tab')
  await expect(input).toHaveValue('cd www/index.html ')
})

test('多候选：先补公共前缀，面板选择回填', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  const input = page.getByTestId('composer-input')

  // config.yaml / config.local.yaml → 公共前缀 config. 先补上，面板列出两项
  await page.keyboard.type('cat co')
  await page.keyboard.press('Tab')
  await expect(input).toHaveValue('cat config.')
  await expect(page.getByTestId('completion-item')).toHaveCount(2)

  // ↓ 选第二项（字母序：config.local.yaml, config.yaml）Enter 确认
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('cat config.yaml ')
  await expect(page.getByTestId('completion-panel')).toHaveCount(0)

  // Esc 关面板：草稿保持公共前缀
  await input.fill('')
  await page.keyboard.type('cat co')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('completion-item')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('completion-panel')).toHaveCount(0)
  await expect(input).toHaveValue('cat config.')
  await expect(input).toBeFocused()
})

test('补全跟随 cwd：cd 后 Tab 用新目录', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  const input = page.getByTestId('composer-input')

  await page.keyboard.type('cd www')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('www')
  await expect(input).toBeFocused()

  await page.keyboard.type('cat in')
  await page.keyboard.press('Tab')
  await expect(input).toHaveValue('cat index.html ')
})
