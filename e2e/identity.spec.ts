import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * 身份平面一致性——存量兜底（identity-design）。
 * 运维 `sudo su` 之后 pty / 独立 exec / SFTP 是三个身份平面，后两者由 sshd 直接
 * fork、协议层面无法继承切换后的身份。这部分是结构不是 bug；本组用例守的是"系统不再把
 * 差异藏起来"：身份上报、错位不借 cwd、cd 失败翻译、自动重载、cwd 变更通知、
 * errno 分流、审计不再把 root 命令记成登录用户。
 *
 * fake server：pty OSC 7 上报 root-fake（与独立探测的 id -un 一致——默认三平面
 * 无错位）；`elevate` 直达 root 态（root@/root）；`sudo su` 复现断链现场等自动重载；
 * deniedDirs=['/root'] 让 SFTP 与独立 exec 的 cd 都在 /root 上撞 Permission denied。
 */

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ssh = await startFakeSshServer({
    files: {
      '/home/test': [
        { name: 'www', type: 'dir' },
        { name: 'app.log', type: 'file', size: 12, content: 'log-content\n' }
      ],
      '/home/test/www': [{ name: 'index.html', type: 'file', size: 64 }],
      '/root': []
    },
    deniedDirs: ['/root']
  })
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

/** composer 整行发送（等 prompt 态再发，避免落进上一条命令的 stdin） */
async function runInTerminal(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.getByTestId('composer-input').fill(command)
  await page.getByTestId('composer-input').press('Enter')
}

async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
}

/** 等主机档案探测落地（构成面板触发的独立 exec 回来后 execCommands 基线才稳定） */
async function waitContextReady(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.getByTestId('agent-token-ring').getAttribute('data-used')))
    .toBeGreaterThan(0)
}

function readAudit(userDataDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(userDataDir, 'audit.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

test('pty 身份上报进审计：切到 root 后批准的命令记 root，不再冒用登录用户', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 直达 root 态：下一个 prompt 起 OSC 7 上报 root@/root
  await runInTerminal(page, 'elevate')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/root#')

  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(page, 'y')
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')

  // decision 条目带 pty 有效身份 root（v0.11.0 之前这里只有登录用户，审计在撒谎）
  await expect
    .poll(() =>
      readAudit(launched.userDataDir).some(
        (l) => l.kind === 'decision' && l.command === 'systemctl restart nginx' && l.ptyUser === 'root'
      )
    )
    .toBe(true)
  // result 补记用单元自带的执行时刻身份
  await expect
    .poll(() =>
      readAudit(launched.userDataDir).some(
        (l) => l.kind === 'result' && l.command === 'systemctl restart nginx' && l.ptyUser === 'root'
      )
    )
    .toBe(true)
})

test('身份错位：白名单 exec 不借 pty cwd，meta 回错位说明', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)

  await runInTerminal(page, 'elevate')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/root#')
  // 再跑一条命令让转录单元携带 /root（latestCwd 取自单元，不是实时 OSC）
  await runInTerminal(page, 'echo cwd-probe')
  await expect.poll(async () => /^cwd-probe$/m.test(await activeTerminalText(page))).toBe(true)

  const before = ssh.execCommands().length
  await askAgent(page, 'run-whoami')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'executed')
  // meta 里有结构化错位说明（fake LLM 把工具结果 echo 成文本）
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('identityMismatch')
  await expect(reply).toContainText('root-fake')
  // 关键行为：pty 在 /root（错位），exec 命令**没有**带 cd 前缀——不借靠不住的跨平面状态
  const whoami = ssh.execCommands().slice(before).find((c) => c.includes('whoami'))
  expect(whoami).toBeTruthy()
  expect(whoami).not.toContain('cd -- ')
})

test('失败翻译：借来的 cwd cd 被拒 → 结构化 cd-denied，不让 Agent 从退出码猜', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)

  // 身份未错位（pty 仍是 root-fake），但 pty 走进了独立 exec 进不去的目录——
  // 借 cwd 合法，cd 撞 Permission denied（fake server 按 deniedDirs 复现）
  await runInTerminal(page, 'cd /root')
  await runInTerminal(page, 'echo cwd-probe')
  await expect.poll(async () => /^cwd-probe$/m.test(await activeTerminalText(page))).toBe(true)

  await askAgent(page, 'run-whoami')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'error')
  await expect(card).toContainText('命令未执行')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('cd-denied')
  await expect(reply).toContainText('未执行')
  await expect(reply).toContainText('审批台')
})

test('自动重载：sudo su 后无需点击，下一个 prompt 自动 source 恢复三件事', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await runInTerminal(page, 'sudo su')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/home/test#')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')

  // 不点任何按钮：检测器（命令文本 + 静默 + 光标行像 prompt）自动写入 source 行，
  // 新 shell 重挂 OSC 时序，composer 回 prompt
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15000
  })
  // source 行出现了第二次（第一次是连接时的正常注入）
  const text = await activeTerminalText(page)
  expect((text.match(/\/tmp\/\.tsubasaterminal-si-/g) ?? []).length).toBeGreaterThanOrEqual(2)
  // 全程没走到 v0.9.5 的手动断链提示（10s 阈值远晚于自动恢复）
  await expect(page.getByTestId('stall-reinject')).toHaveCount(0)
})

test('自动重载在 native 下同样生效：pty 里直接敲 sudo su，靠 133;C 进入运行中', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalInputMode: 'native' }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 检测器以 running 为前提：v0.13.15 之前 native 直接回车不进 running，武装当场撤销
  await page.getByTestId('terminal-view').click()
  await page.keyboard.type('sudo su')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/home/test#')

  // source 行必须落在 root 提示符之后（新 shell 里），只数出现次数挡不住缺陷
  await expect
    .poll(() => activeTerminalText(page), { timeout: 15000 })
    .toMatch(/root@fake:\/home\/test# \. \/tmp\/\.tsubasaterminal-si-/)
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('stall-reinject')).toHaveCount(0)
})

test('cwd 变更通知：目录变了才提一句，不变不重复', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  // 首轮以"对话开始时目录"为基线，不该有变更通知
  expect(llm.lastMessages()).not.toContain('工作目录变更')

  await runInTerminal(page, 'cd www')
  await runInTerminal(page, 'echo cwd-marker')
  await expect.poll(async () => /^cwd-marker$/m.test(await activeTerminalText(page))).toBe(true)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-user-msg')).toHaveCount(2)
  await expect.poll(() => llm.lastMessages()).toContain('终端当前目录已变为 /home/test/www')

  // 目录没再变：第三轮不重复告知（说过一次就推进基线）
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-user-msg')).toHaveCount(3)
  await expect
    .poll(() => (llm.lastMessages().match(/工作目录变更/g) ?? []).length)
    .toBe(1)
})

test('文件栏 EACCES 分流：说身份不足，不再误诊成"嵌套够不着"', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // pty cd 进 /root（fake shell 放行），文件栏跟随后 SFTP 以登录用户被拒
  await runInTerminal(page, 'cd /root')
  await page.getByRole('tab', { name: '文件' }).click()
  const error = page.getByTestId('file-error')
  await expect(error).toBeVisible({ timeout: 10000 })
  await expect(error).toContainText('权限不足')
  await expect(error).toContainText('登录用户')
  await expect(error).not.toContainText('嵌套')
})

test('桥下载错误 errno 分流：EACCES 说身份不足，ENOENT 才提嵌套', async () => {
  const saveDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-iddl-'))
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    env: { TSUBASATERMINAL_E2E_SAVE_DIR: saveDir }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await runInTerminal(page, 'sz /root/x.txt')
  await expect.poll(() => activeTerminalText(page)).toContain('✗ x.txt')
  let text = await activeTerminalText(page)
  expect(text).toContain('权限不足')
  expect(text).not.toContain('目标不存在')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')

  await runInTerminal(page, 'sz /nope.txt')
  await expect.poll(() => activeTerminalText(page)).toContain('✗ nope.txt')
  text = await activeTerminalText(page)
  expect(text).toContain('目标不存在')
})
