import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import {
  activeTerminalText,
  hostFormTab,
  launchApp,
  makeHost,
  openSettings,
  readHostsFile,
  type SeedLlmProfile
} from './fixtures/launch'

/**
 * v0.13.4 固定输入栏 / 原生终端可切换（composer-design v0.13.4 节）：
 * - native：键直达 pty，命令输入行不渲染，审批用独立决策输入（Ctrl+Shift+Y 借焦）；
 * - write-safe fail-closed：native 半行 dirty 挡住批准/免问/伪造 IPC，合法 133;A 解锁；
 * - none 只能经用户显式「已回到空提示符」解锁；
 * - 直通粘贴含换行先确认；
 * - 偏好切换按 pending 表执行，零丢字。
 */

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ssh = await startFakeSshServer()
  llm = await startFakeLlmServer()
})

test.afterAll(async () => {
  await ssh.close()
  await llm.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

function anthropicProfile(): SeedLlmProfile {
  return {
    id: 'prof-anthropic',
    name: 'Fake Claude',
    provider: 'anthropic',
    baseURL: llm.anthropicBaseURL,
    model: 'fake-model',
    apiKey: 'sk-test'
  }
}

async function connectAndWaitPrompt(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function askAgent(page: Page, text: string): Promise<void> {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
}

function auditLines(userDataDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(userDataDir, 'audit.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/**
 * 系统剪贴板整机共享，并行 worker 各自 writeText 会互相覆盖（--repeat-each 实测把
 * 别的用例内容粘了进来）。这里只替换主进程 `clipboard.readText` 的返回值：渲染 →
 * IPC → 主进程 handler 的真实读链不变，只是不再经过系统剪贴板。
 */
async function seedClipboard(a: ElectronApplication, text: string): Promise<void> {
  await a.evaluate(({ clipboard }, value) => {
    clipboard.readText = () => value
  }, text)
}

test('native：命令输入行不渲染，按键与 Enter 直达远端 shell', { tag: ['@headed', '@daily'] }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 固定输入栏整个不在 DOM 里；状态行说明原生输入
  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await expect(page.getByTestId('composer-hint')).toContainText('原生输入')

  // 键直达 pty：行回显 shell 原样执行
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('echo native-works')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^native-works$/m.test(await activeTerminalText(page))).toBe(true)
})

test('native 半行 dirty：按钮禁用、伪造 approve IPC 被主进程挡、提交半行后 A 解锁、决策框批准', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-decision-input')).toBeVisible()

  // 用户在原生 shell 行敲了半行——写 pty 之前就置 dirty
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('kubect')
  await expect(page.getByTestId('approval-approve')).toBeDisabled()
  await expect(page.getByTestId('approval-busy-hint')).toContainText('输入行非空')

  // 绕开 UI 直接伪造 approve IPC：主进程复核 write-safe，提案原地保留
  await expect.poll(() => auditLines(launched.userDataDir).some((l) => l.kind === 'proposal')).toBe(
    true
  )
  const proposalId = auditLines(launched.userDataDir).find((l) => l.kind === 'proposal')
    ?.proposalId as string
  const forged = await page.evaluate(async (pid) => {
    const w = window as unknown as {
      __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
      api: {
        agent: {
          approve: (sid: string, pid: string) => Promise<{ ok: boolean; error?: string }>
        }
      }
    }
    return await w.api.agent.approve(w.__tsubasaterminal.getSessions()[0].id, pid)
  }, proposalId)
  expect(forged.ok).toBe(false)
  expect(forged.error).toContain('终端不可写')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  expect(await activeTerminalText(page)).not.toContain('systemctl restart nginx')

  // 半行提交（或 Ctrl+C）→ 下一个合法 133;A 复位 dirty
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('approval-approve')).toBeEnabled()

  // Ctrl+Shift+Y 借焦给决策框，y + Ctrl+Enter 批准；Enter 从未参与审批
  await page.keyboard.press('Control+Shift+KeyY')
  await expect(page.getByTestId('approval-decision-input')).toBeFocused()
  await page.keyboard.type('y')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  await expect(page.getByTestId('approval-decision-input')).toHaveCount(0)
})

test('native 信任免问也认 dirty：已授信动词在半行现场退回审批台', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 建立信任：a 批准 apt-get
  await askAgent(page, 'propose-apt')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.getByTestId('terminal-view').click()
  await page.keyboard.press('Control+Shift+KeyY')
  await page.keyboard.type('a')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y nginx')
  // 等这条跑完回到 prompt（工具结果回流后 Agent 面板出回复）
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('approved', {
    timeout: 15000
  })

  // 半行现场：同动词不免问，退回审批台
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('tail -f /var/lo')
  await askAgent(page, 'propose-apt2')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-command')).toContainText('apt-get install -y redis')
  expect(await activeTerminalText(page)).not.toContain('apt-get install -y redis')
  // 审计里这条只有 proposal，没有 auto-exec
  expect(
    auditLines(launched.userDataDir).some(
      (l) => l.kind === 'auto-exec' && String(l.command).includes('redis')
    )
  ).toBe(false)
})

test('native 直通粘贴：含换行先确认（取消零写入），单行不问', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await page.getByTestId('terminal-view').click()

  // 取消：pty 零字节。v0.13.13 起是应用内确认框：行数与内容预览可见，默认落焦「粘贴」
  const dialog = page.getByTestId('confirm-dialog')
  await seedClipboard(launched.app, 'echo ml-line1\necho ml-line2\n')
  await page.keyboard.press('Control+KeyV')
  await expect(page.getByTestId('confirm-message')).toContainText('2 行')
  await expect(page.getByTestId('confirm-detail')).toHaveText('echo ml-line1\necho ml-line2')
  await expect(page.getByTestId('confirm-ok')).toBeFocused()
  // 确认框开着时再按 Ctrl+V：不接管、不排第二次粘贴（原生框冻住线程天然挡住，异步后要自己挡）
  await page.keyboard.press('Control+KeyV')
  await page.getByTestId('confirm-cancel').click()
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(500)
  expect(await activeTerminalText(page)).not.toContain('ml-line1')
  // 第二次 Ctrl+V 没有排队：取消后不会再冒出一个
  await expect(dialog).toBeHidden()

  // 确认：回车落在默认焦点「粘贴」上，照常执行且只执行一次
  await page.keyboard.press('Control+KeyV')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Control+KeyV')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^ml-line2$/m.test(await activeTerminalText(page))).toBe(true)
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(300)
  expect((await activeTerminalText(page)).match(/^ml-line1$/gm)).toHaveLength(1)

  // 单行粘贴不该弹确认
  await seedClipboard(launched.app, 'echo single-ok')
  await installConfirmProbe(page)
  await page.keyboard.press('Control+KeyV')
  // 粘贴要经主进程读剪贴板（异步），紧跟的 Enter 会抢先到 pty——先等回显再回车
  await expect.poll(() => activeTerminalText(page)).toContain('echo single-ok')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^single-ok$/m.test(await activeTerminalText(page))).toBe(true)
  expect(await confirmHit(page)).toBeUndefined()
})

/** 确认框探针：确认框一旦挂进 DOM 就记标记（出现过又关掉也记得住） */
async function installConfirmProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __confirmHit?: boolean; __confirmProbe?: MutationObserver }
    w.__confirmHit = undefined
    w.__confirmProbe?.disconnect()
    w.__confirmProbe = new MutationObserver(() => {
      if (document.querySelector('[data-testid="confirm-dialog"]')) w.__confirmHit = true
    })
    w.__confirmProbe.observe(document.body, { childList: true, subtree: true })
  })
}

async function confirmHit(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as { __confirmHit?: boolean }).__confirmHit)
}

test('多行粘贴确认可在设置里关掉：关后直通不问、照常执行', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 经设置面板关（覆盖 面板 → 主进程白名单落盘 → 渲染 store → 粘贴判定 整条链）
  await openSettings(page)
  const toggle = page.getByTestId('settings-confirm-multiline-paste')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked({ checked: false })
  await page.getByTestId('settings-close').click()

  await page.getByTestId('terminal-view').click()
  await seedClipboard(launched.app, 'echo off-line1\necho off-line2\n')
  await installConfirmProbe(page)
  await page.keyboard.press('Control+KeyV')
  // 远端没开 bracketed paste：换行即回车，两条都立即执行——这正是开关关掉的代价
  await expect.poll(async () => /^off-line2$/m.test(await activeTerminalText(page))).toBe(true)
  expect(/^off-line1$/m.test(await activeTerminalText(page))).toBe(true)
  expect(await confirmHit(page)).toBeUndefined()
})

test('远端开启 bracketed paste 时多行粘贴不问：整块进行缓冲，回车才执行', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await page.getByTestId('terminal-view').click()

  // fake shell 从下一个 prompt 起发 CSI ?2004h（bash 5.1+ / zsh 默认行为）
  await page.keyboard.type('bpon')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => /\$ bpon\n[^\n]*test@fake:~\$/.test(await activeTerminalText(page)))
    .toBe(true)

  await seedClipboard(launched.app, 'echo bp-line1\necho bp-line2\n')
  await installConfirmProbe(page)
  await page.keyboard.press('Control+KeyV')
  // 块已进行缓冲（续行提示回显），但还没执行
  await expect.poll(async () => await activeTerminalText(page)).toContain('> echo bp-line2')
  await page.waitForTimeout(300)
  expect(/^bp-line1$/m.test(await activeTerminalText(page))).toBe(false)
  expect(await confirmHit(page)).toBeUndefined()

  // 人按回车：整块执行
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^bp-line2$/m.test(await activeTerminalText(page))).toBe(true)
  expect(/^bp-line1$/m.test(await activeTerminalText(page))).toBe(true)
})

test('偏好切换 pending：fixed 草稿非空不切、发送后兑现为 native', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 固定模式先攒半条草稿
  await page.getByTestId('composer-input').fill('echo pending-hold')

  await openSettings(page)
  await page.getByTestId('settings-input-mode').selectOption('native')
  await page.getByTestId('settings-close').click()

  // 草稿非空：不立即切，输入行还在、草稿一字不丢，状态行说明 pending
  await expect(page.getByTestId('composer-input')).toHaveValue('echo pending-hold')
  await expect(page.getByTestId('input-pending-hint')).toContainText('原生')

  // 发送草稿 = pending 条件解除，切换兑现
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^pending-hold$/m.test(await activeTerminalText(page))).toBe(true)
  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await expect(page.getByTestId('input-pending-hint')).toHaveCount(0)

  // 切过去之后键直达 shell
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('echo now-native')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^now-native$/m.test(await activeTerminalText(page))).toBe(true)
})

/**
 * v0.13.19 本机输入方式：主机覆盖全局；编辑主机后已开标签立即切换，且同样走 pending 表。
 * 覆盖 表单 → 主进程白名单落盘 → 主机列表 → app store 下发 → composer pending 表 → 落焦
 * 整条链。
 */
test('本机输入方式覆盖全局：开标签按本机起步，编辑主机立即切换且守 pending', { tag: ['@headed', '@daily'] }, async () => {
  // 全局保持默认 composer，只有这台主机指定 native
  const launched = await launchApp([makeHost(ssh.port, { inputMode: 'native' })])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await expect(page.getByTestId('composer-hint')).toContainText('原生输入 · 本机设置')
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('echo host-native')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^host-native$/m.test(await activeTerminalText(page))).toBe(true)

  // 改回「跟随全局」：已开标签立即切到固定输入栏，焦点回家落在输入栏
  await page.getByTestId('host-item').click()
  await page.getByTestId('info-edit').click()
  await hostFormTab(page, 'session')
  await expect(page.getByTestId('form-input-mode')).toHaveValue('native')
  await page.getByTestId('form-input-mode').selectOption('global')
  await page.getByTestId('form-save').click()
  await expect.poll(() => readHostsFile(launched.userDataDir)).not.toContain('"inputMode"')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByTestId('composer-hint')).not.toContainText('本机设置')

  // 再指定 native，但固定栏里有半条草稿：不切、草稿一字不丢，发送后兑现
  await page.getByTestId('composer-input').fill('echo host-pending')
  await page.getByTestId('info-edit').click()
  await hostFormTab(page, 'session')
  await page.getByTestId('form-input-mode').selectOption('native')
  await page.getByTestId('form-save').click()
  await expect.poll(() => readHostsFile(launched.userDataDir)).toContain('"inputMode": "native"')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo host-pending')
  await expect(page.getByTestId('input-pending-hint')).toContainText('原生')

  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^host-pending$/m.test(await activeTerminalText(page))).toBe(true)
  await expect(page.getByTestId('composer-input')).toHaveCount(0)
  await expect(page.getByTestId('input-pending-hint')).toHaveCount(0)
  await expect(page.getByTestId('composer-hint')).toContainText('本机设置')
  // 切到 native 后焦点在 xterm：直接敲就进远端 shell
  await page.keyboard.type('echo focus-native')
  await page.keyboard.press('Enter')
  await expect.poll(async () => /^focus-native$/m.test(await activeTerminalText(page))).toBe(true)
})

test('none fail-closed：切回直通后批准被挡，「已回到空提示符」显式声明才解锁', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 进假 root shell（SI 全断）→ 切回直通降级到 none
  await page.evaluate(() => {
    ;(
      window as unknown as { __tsubasaterminal: { setStallThresholdMs: (ms: number) => void } }
    ).__tsubasaterminal.setStallThresholdMs(300)
  })
  await page.keyboard.type('fakesu')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/home/test#')
  await expect(page.getByTestId('stall-passthrough')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('stall-passthrough').click()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'none')

  // fail-closed：降级不等于解锁——恢复动作可见，批准被挡
  await expect(page.getByTestId('none-declare-clean')).toBeVisible()
  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-approve')).toBeDisabled()
  await expect(page.getByTestId('approval-busy-hint')).toContainText('已回到空提示符')
  expect(await activeTerminalText(page)).not.toContain('systemctl restart nginx')

  // 人的现场声明是唯一解锁路径
  await page.getByTestId('none-declare-clean').click()
  await expect(page.getByTestId('none-declare-clean')).toHaveCount(0)
  await expect(page.getByTestId('approval-approve')).toBeEnabled()
  await page.getByTestId('approval-approve').click()
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')
})
