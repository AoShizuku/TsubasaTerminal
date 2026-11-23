import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

/**
 * shell integration 断链。`sudo su` 起的新 shell 是全新进程，
 * PS1/PS0/PROMPT_COMMAND 都不是 exported，OSC 133 时序就此断掉——running 的唯一
 * 出口是 133;A，composer 会永久卡死（真机现场：阿里云 ECS，运维反馈"不下去了"）。
 * fake server 的 fakesu 精确复现这个现场：C 发出后 D/A 永不再来。
 */
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
  await expect(page.getByTestId('composer-input')).toBeFocused()
}

interface TsubasaTerminalStallHook {
  setStallThresholdMs: (thresholdMs: number, pollMs?: number) => void
  getStallScanCount: () => number
}

/** 静默阈值调到 300ms、巡检调到 50ms，生产仍使用 10s / 2s。 */
async function shortenStallThreshold(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __tsubasaterminal: TsubasaTerminalStallHook }).__tsubasaterminal.setStallThresholdMs(
      300,
      50
    )
  })
}

async function stallScanCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __tsubasaterminal: TsubasaTerminalStallHook }).__tsubasaterminal.getStallScanCount()
  )
}

/** 进入假 root shell，等断链提示浮出 */
async function enterStalledSuShell(page: Page): Promise<void> {
  await shortenStallThreshold(page)
  await page.keyboard.type('fakesu')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/home/test#')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  await expect(page.getByTestId('stall-reinject')).toBeVisible({ timeout: 15000 })
}

test('SI 断链：sudo su 后卡在 running，重新装载原地恢复就绪', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await enterStalledSuShell(page)

  await expect(page.getByTestId('composer-hint')).toContainText('Shell 集成已断开')
  await expect(page.getByTestId('stall-passthrough')).toBeVisible()

  // 重载是真修复：新 shell 重新挂上 OSC 133，用户不必退出 root 丢现场
  await page.getByTestId('stall-reinject').click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15000
  })
  await expect(page.getByTestId('stall-reinject')).toHaveCount(0)
  await expect(page.getByTestId('composer-hint')).toContainText('就绪')
})

test('SI 断链：切回直通是保底出口，模式降级到 none', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await enterStalledSuShell(page)

  await page.getByTestId('stall-passthrough').click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'none')
  await expect(page.getByTestId('composer-hint')).toContainText('直通模式')
  await expect(page.getByTestId('stall-reinject')).toHaveCount(0)

  // 直通态的输入框本就禁用（没有 SI 就无从判断何时是 prompt），按键归终端；
  // 降级真正解开的是 Agent 侧的"终端正忙"锁定，终端本身照常可用
  await expect(page.getByTestId('composer-input')).toBeDisabled()
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('echo after-passthrough')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => activeTerminalText(page))
    .toContain('echo after-passthrough: fake su shell')
})

test('native 直接回车：133;C 进入运行中，换 shell 照样提示断链', async () => {
  const launched = await launchApp([makeHost(server.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await shortenStallThreshold(page)

  // 人在 pty 里直接提交，不经 composer 整行发送：运行态只能来自 shell 发出的 133;C
  // （v0.13.15 之前 mode 停在 prompt，状态行一直写着「原生输入」，断链提示永不出现）
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('fakesu')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/home/test#')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  await expect(page.getByTestId('composer-hint')).not.toContainText('原生输入')
  await expect(page.getByTestId('stall-reinject')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('stall-reinject').click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15000
  })
  await expect(page.getByTestId('composer-hint')).toContainText('原生输入')
})

test('提示符框架的 ❯ 结尾也认：嵌套 zsh 换掉 SI 后照样提示断链', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await shortenStallThreshold(page)

  // v0.13.15 之前判定只认 `$ # > %` 结尾，starship 的 `❯` 下永远等不到这行提示
  await page.keyboard.type('zsh')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toMatch(/^❯\s*$/m)
  await expect(page.getByTestId('stall-reinject')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('stall-reinject').click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15000
  })
})

test('静默长命令不误报：光标不在 prompt 行上就不提示断链', async () => {
  const launched = await launchApp([makeHost(server.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await shortenStallThreshold(page)

  // sleepy 无输出、光标停在空行——与 sudo su 的区别全在这一条
  await page.keyboard.type('sleepy')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')

  // 等 8 次巡检（约 400ms，已越过 300ms 静默阈值），证明反例确实经过判定，
  // 而不是在第一轮定时器触发前做一个会立即通过的「不存在」断言。
  const scanCount = await stallScanCount(page)
  await expect
    .poll(() => stallScanCount(page), {
      timeout: 2_000,
      intervals: [20]
    })
    .toBeGreaterThanOrEqual(scanCount + 8)
  await expect(page.getByTestId('stall-reinject')).toHaveCount(0)
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
})
