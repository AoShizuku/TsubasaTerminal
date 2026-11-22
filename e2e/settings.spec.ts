import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost, openSettings } from './fixtures/launch'

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
}

async function runCommand(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function outputs(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const w = window as unknown as {
      __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
      api: { transcript: { get: (id: string) => Promise<Array<{ output: string }>> } }
    }
    const sessionId = w.__tsubasaterminal.getSessions()[0]?.id
    if (!sessionId) return []
    return (await w.api.transcript.get(sessionId)).map((u) => u.output)
  })
}

async function setRedaction(page: Page, enabled: boolean): Promise<void> {
  await openSettings(page, 'security')
  const toggle = page.getByTestId('settings-redaction-toggle')
  if ((await toggle.isChecked()) !== enabled) await toggle.click()
  await expect(toggle).toBeChecked({ checked: enabled })
  await page.getByTestId('settings-close').click()
}

test('凭据脱敏开关：关闭放行原文，重新开启即恢复脱敏', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page

  await connectAndWaitPrompt(page)

  // 关闭 → 明文进转录
  await setRedaction(page, false)
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await runCommand(page, 'echo AKIAIOSFODNN7EXAMPLE off-marker')
  await expect
    .poll(async () => (await outputs(page)).some((o) => o.includes('off-marker')))
    .toBe(true)
  expect(
    (await outputs(page)).find((o) => o.includes('off-marker'))
  ).toContain('AKIAIOSFODNN7EXAMPLE')

  // 重新开启 → 新单元恢复脱敏
  await setRedaction(page, true)
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await runCommand(page, 'echo AKIAIOSFODNN7EXAMPLE on-marker')
  await expect
    .poll(async () => (await outputs(page)).some((o) => o.includes('on-marker')))
    .toBe(true)
  const onOutput = (await outputs(page)).find((o) => o.includes('on-marker'))!
  expect(onOutput).toContain('«REDACTED:aws-access-key:')
  expect(onOutput).not.toContain('AKIAIOSFODNN7EXAMPLE')
})

test('脱敏开关跨重启持久化', async () => {
  const first = await launchApp([makeHost(server.port)])
  app = first.app
  await setRedaction(first.page, false)
  await first.app.close()
  app = undefined

  const second = await launchApp([], first.userDataDir)
  app = second.app
  const page = second.page

  await connectAndWaitPrompt(page)
  await runCommand(page, 'echo AKIAIOSFODNN7EXAMPLE persist-marker')
  await expect
    .poll(async () => (await outputs(page)).some((o) => o.includes('persist-marker')))
    .toBe(true)
  expect(
    (await outputs(page)).find((o) => o.includes('persist-marker'))
  ).toContain('AKIAIOSFODNN7EXAMPLE')

  // 设置面板里也应显示关闭态
  await openSettings(page, 'security')
  await expect(page.getByTestId('settings-redaction-toggle')).toBeChecked({ checked: false })
})
