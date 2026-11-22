import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

let server: FakeSshServer
let app: ElectronApplication | undefined

// 密码兼作"自持凭据精确匹配"的测试载荷（长度 ≥4 才纳入匹配）
const HOST_PASSWORD = 'sup3r-secret-pw'

test.beforeAll(async () => {
  server = await startFakeSshServer({ password: HOST_PASSWORD })
})

test.afterAll(async () => {
  await server.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

interface UnitView {
  command: string
  output: string
  exitCode: number | null
  cwd: string | null
  redactions: number
  hasEsc: boolean
  hasZwsp: boolean
}

/** 读活动会话的结构化转录（走机器消费者出口，已净化脱敏） */
async function getTranscript(page: Page): Promise<UnitView[]> {
  return await page.evaluate(async () => {
    const w = window as unknown as {
      __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
      api: {
        transcript: {
          get: (id: string) => Promise<
            Array<{
              command: string
              output: string
              exitCode: number | null
              cwd: string | null
              redactions: number
            }>
          >
        }
      }
    }
    const sessionId = w.__tsubasaterminal.getSessions()[0]?.id
    if (!sessionId) return []
    const units = await w.api.transcript.get(sessionId)
    return units.map((u) => ({
      command: u.command,
      output: u.output,
      exitCode: u.exitCode,
      cwd: u.cwd,
      redactions: u.redactions,
      hasEsc: [...u.output].some((c) => c.charCodeAt(0) === 0x1b),
      hasZwsp: [...u.output].some((c) => c.charCodeAt(0) === 0x200b)
    }))
  })
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

test('结构化转录：命令-输出-退出码-cwd 单元', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port, { password: HOST_PASSWORD })])
  app = launched.app
  const page = launched.page

  await connectAndRun(page, ['echo transcript-probe'])
  await expect
    .poll(async () =>
      (await getTranscript(page)).some(
        (u) =>
          u.command === 'echo transcript-probe' &&
          u.output.includes('transcript-probe') &&
          u.exitCode === 0 &&
          u.cwd === '/home/test'
      )
    )
    .toBe(true)
})

test('zsh 直打：命令取屏幕终态、输出不带 PROMPT_SP 尾巴、不进主机历史', { tag: '@daily' }, async () => {
  const host = makeHost(server.port, { password: HOST_PASSWORD })
  const launched = await launchApp([host], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.getByTestId('terminal-view').click()

  // 打开 zle 式回显：每键整行重画、回车整行重显、prompt 前 PROMPT_SP
  await page.keyboard.type('zleon')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.keyboard.type('echo zle-probe')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^zle-probe$/m.test(await activeTerminalText(page))).toBe(true)

  // 回显近似在这里会是 `eecechech…` 的拼接；屏幕终态才是命令。
  // zleon 本身无输出：它之后的 prompt 已带 PROMPT_SP，剥净后输出为空
  // （fake shell 把连接时的 SI source 行也记成一条单元，故按子集断言）
  await expect
    .poll(async () => (await getTranscript(page)).map((u) => [u.command, u.output]))
    .toEqual(
      expect.arrayContaining([
        ['zleon', ''],
        ['echo zle-probe', 'zle-probe\n']
      ])
    )
  // 原生直打的命令历史归远端 shell（composer-design），屏幕读数不改这条
  const history = await page.evaluate(
    async (hostId) =>
      await (
        window as unknown as { api: { history: { list: (id: string) => Promise<string[]> } } }
      ).api.history.list(hostId),
    host.id
  )
  expect(history).not.toContain('echo zle-probe')
})

test('脱敏闸门：AWS 密钥换稳定指纹占位符，命令与输出同脱，角标与明细可见', async () => {
  const launched = await launchApp([makeHost(server.port, { password: HOST_PASSWORD })])
  app = launched.app
  const page = launched.page

  await connectAndRun(page, [
    'echo AKIAIOSFODNN7EXAMPLE',
    'echo AKIAIOSFODNN7EXAMPLE again'
  ])

  await expect
    .poll(async () =>
      (await getTranscript(page)).filter((u) => u.output.includes('«REDACTED:aws-access-key:'))
        .length
    )
    .toBe(2)

  const units = (await getTranscript(page)).filter((u) =>
    u.output.includes('«REDACTED:aws-access-key:')
  )
  // 明文不出闸门：输出与命令文本都被替换
  for (const unit of units) {
    expect(unit.output).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(unit.command).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(unit.command).toContain('«REDACTED:aws-access-key:')
  }
  // 同一密钥指纹稳定：两个单元的占位符一致
  const fp = (text: string): string | undefined =>
    /«REDACTED:aws-access-key:([0-9a-f]{4})»/.exec(text)?.[1]
  expect(fp(units[0].output)).toBeDefined()
  expect(fp(units[0].output)).toBe(fp(units[1].output))

  // 角标与审查明细
  await expect(page.getByTestId('redaction-badge')).toContainText('已脱敏')
  await page.getByTestId('redaction-badge').click()
  await expect(page.getByTestId('redaction-entry').first()).toContainText('aws-access-key')
})

test('自持凭据精确匹配：主机密码出现在输出中被脱敏', async () => {
  const launched = await launchApp([makeHost(server.port, { password: HOST_PASSWORD })])
  app = launched.app
  const page = launched.page

  await connectAndRun(page, [`echo leaked ${HOST_PASSWORD} end`])
  await expect
    .poll(async () =>
      (await getTranscript(page)).find((u) => u.output.includes('«REDACTED:self-credential:'))
    )
    .toBeTruthy()
  const unit = (await getTranscript(page)).find((u) =>
    u.output.includes('«REDACTED:self-credential:')
  )!
  expect(unit.output).not.toContain(HOST_PASSWORD)
  expect(unit.command).not.toContain(HOST_PASSWORD)
})
