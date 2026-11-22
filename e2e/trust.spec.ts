import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * v0.9.2 审批摩擦阶梯与 `a` 信任集（agent-design）：
 * 放宽沿"击键成本"轴——low 档空 Ctrl+Enter 即批准（生产机除外）、
 * mid 档可用 `a` 授予该动词免问；不沿"人在环"轴——low 档绝不自动执行。
 * 附带风险分级补洞的回归：mkfs.* 族提 high、docker 只读子命令不误伤。
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

async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
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

test('low 档空 Ctrl+Enter 即批准；docker 只读子命令补洞后仍留在 low', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-lowrisk')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'low')
  await expect(page.getByTestId('approval-keys')).toContainText('Ctrl+Enter 直接批准')

  // 空草稿 + Ctrl+Enter = 批准（Ctrl+Enter 本身已是显式动作）
  await page.getByTestId('composer-input').press('Control+Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('mkdir -p /tmp/lab')
  await expect(card).toHaveCount(0)

  // 白名单只认老式 `docker images`，`image ls` 走审批——但档位不该被动词级提级误伤
  await askAgent(page, 'propose-docker-imagels')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'low')
  await page.getByTestId('composer-input').press('Control+Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('docker image ls')
})

test('生产机 low 不空过：仍需 y（避免 [零动作|打别名] 断崖）', async () => {
  const launched = await launchApp(
    [makeHost(ssh.port, { name: 'prod-t', envLevel: 'production' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-lowrisk')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  // 生产机只做 mid→high 位移，low 档不提级（只读诊断不该打别名）
  await expect(card).toHaveAttribute('data-risk', 'low')
  await expect(page.getByTestId('approval-keys')).toContainText('y 批准')

  await page.getByTestId('composer-input').press('Control+Enter')
  await expect(page.getByTestId('approval-error')).toContainText('空输入不做操作')
  await expect(card).toBeVisible()
  expect(await activeTerminalText(page)).not.toContain('mkdir -p /tmp/lab')

  await submitApproval(page, 'y')
  await expect.poll(() => activeTerminalText(page)).toContain('mkdir -p /tmp/lab')
})

test('`a` 免问：同动词后续零审批直接执行，审计如实标 trusted，LLM 全程无感知', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-apt')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await expect(page.getByTestId('approval-keys')).toContainText('a 批准且本机免问')

  await submitApproval(page, 'a')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y nginx')
  await expect(page.getByTestId('agent-trust-badge')).toBeVisible()

  // 同动词第二条：不再进审批台，直接写入用户终端执行
  await askAgent(page, 'propose-apt2')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y redis')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'executed')

  // 放宽审批 ≠ 放宽审计：免问执行照记，且与白名单自动执行区分得开
  await expect
    .poll(() => auditLines(launched.userDataDir).some((l) => l.trusted === 'apt-get'))
    .toBe(true)
  const trustedEntry = auditLines(launched.userDataDir).find(
    (l) => l.kind === 'auto-exec' && l.trusted === 'apt-get'
  )
  expect(trustedEntry?.command).toBe('apt-get install -y redis')

  // 零注入：信任集不进 system prompt（否则模型会挑免问路径绕路）
  const system = llm.lastSystem() ?? ''
  expect(system).not.toContain('免问')
  expect(system).not.toContain('apt-get')

  // 徽章可点开收回
  await page.getByTestId('agent-trust-badge').click()
  await expect(page.getByTestId('agent-trust-panel')).toContainText('apt-get')
  await page.getByTestId('agent-trust-clear').click()
  await expect(page.getByTestId('agent-trust-badge')).toHaveCount(0)
})

test('终端忙时免问退回审批台：已信任的命令也不会被喂给前台进程', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-apt')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(page, 'a')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y nginx')

  // 进 TUI：批准路径靠 UI 禁用把关，免问路径没有 UI——只能靠 composer 模式上报
  await page.getByTestId('composer-input').fill('tui')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'tui')

  await askAgent(page, 'propose-apt2')
  const card = page.getByTestId('approval-card')
  // TUI 期间 composer 整体让位，卡片在 DOM 里但不可见——关键是它退回了审批台
  await expect(card).toBeAttached()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  expect(await activeTerminalText(page)).not.toContain('apt-get install -y redis')

  // 退出 TUI 后提案照常可决策（免问的信任仍在，只是这一条已经进了审批台）
  await page.getByTestId('terminal-view').click()
  await page.keyboard.press('q')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(card).toBeVisible()
  await submitApproval(page, 'y')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y redis')
})

test('补洞：mkfs.ext4 由规则提到 high（LLM 自报 low 无效），`a` 对 high 档无效', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-mkfs')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  // 现表 mkswap 在而 mkfs 不在——带后缀族要前缀匹配，这条是补洞的回归守卫
  await expect(card).toHaveAttribute('data-risk', 'high')

  // high 档永不进信任集：按 a 落到确认词校验，不会静默免问
  await submitApproval(page, 'a')
  await expect(page.getByTestId('approval-error')).toContainText('mkfs.ext4')
  await expect(page.getByTestId('agent-trust-badge')).toHaveCount(0)

  await submitApproval(page, 'mkfs.ext4')
  await expect.poll(() => activeTerminalText(page)).toContain('mkfs.ext4 /dev/sdb')
})

test('跨机动词永不可免问：ssh 提案不给 `a`（实验属性不传递给它能触达的资源）', async () => {
  const launched = await launchApp(
    [makeHost(ssh.port, { name: 'lab-x', envLevel: 'experiment' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-ssh-remote')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await expect(page.getByTestId('approval-keys')).not.toContainText('a 批准')

  await submitApproval(page, 'a')
  await expect(page.getByTestId('approval-error')).toContainText('不支持免问')
  await expect(page.getByTestId('agent-trust-badge')).toHaveCount(0)
})

test('实验机 = 信任记忆的作用域：重启后 `a` 仍生效（普通机则会话即失）', async () => {
  const host = makeHost(ssh.port, { name: 'lab-mem', envLevel: 'experiment' })
  const launched = await launchApp([host], undefined, { llmProfiles: [anthropicProfile()] })
  app = launched.app
  await connectAndWaitPrompt(launched.page)

  await askAgent(launched.page, 'propose-apt')
  await expect(launched.page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(launched.page, 'a')
  await expect.poll(() => activeTerminalText(launched.page)).toContain('apt-get install -y nginx')

  await app.close()
  app = undefined

  const again = await launchApp([], launched.userDataDir, { llmProfiles: [anthropicProfile()] })
  app = again.app
  const page = again.page
  await connectAndWaitPrompt(page)

  // 持久信任随主机记回来（trust.json 按 hostId）
  await expect(page.getByTestId('agent-trust-badge')).toBeVisible()
  await askAgent(page, 'propose-apt2')
  await expect.poll(() => activeTerminalText(page)).toContain('apt-get install -y redis')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)

  expect(JSON.parse(readFileSync(join(launched.userDataDir, 'trust.json'), 'utf-8'))).toEqual({
    [host.id]: ['apt-get']
  })
})
