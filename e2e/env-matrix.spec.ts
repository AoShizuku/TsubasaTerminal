import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * v0.9 主机等级 × 操作风险矩阵（agent-design）+ 环境标识视觉层：
 * 生产机非对称位移——只读白名单照常自动、中风险位移到高危仪式、
 * 高危确认词改主机显示别名（GitHub 删库模式）、write_file 同规则；
 * 表单侧强制生产机起短别名；环境色与风险色双通道。
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

test('生产机：中风险位移到高危仪式，确认词=主机别名（y 不放行）', { tag: '@daily' }, async () => {
  const launched = await launchApp(
    [makeHost(ssh.port, { name: 'prod-1', envLevel: 'production' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 普通机上 systemctl restart 是中风险 y/N；生产机位移到高危仪式
  await askAgent(page, 'propose-restart')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'high')
  await expect(page.getByTestId('approval-risk')).toHaveText('高风险')
  // 环境徽章与风险徽章并列（双通道：环境说在哪台机器，风险说这动作多危险）
  await expect(page.getByTestId('approval-env-badge')).toHaveText('生产')
  // 确认词是主机显示别名，不是真动词
  await expect(card).toContainText('「prod-1」')

  // y 肌肉记忆不放行——主进程硬校验确认词
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toContainText('prod-1')
  await expect(card).toBeVisible()

  // 输别名放行执行
  await submitApproval(page, 'prod-1')
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'approved'
  )
  // 审计里的档位是位移后的 high
  const readAudit = (): string => {
    try {
      return readFileSync(join(launched.userDataDir, 'audit.jsonl'), 'utf-8')
    } catch {
      return ''
    }
  }
  await expect.poll(readAudit).toContain('"kind":"proposal"')
  const proposalLine = readAudit()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.kind === 'proposal')
  expect(proposalLine.risk).toBe('high')
})

test('生产机：只读白名单照常自动；write_file 同规则位移且确认词=别名；system prompt 带生产标记', async () => {
  const launched = await launchApp(
    [makeHost(ssh.port, { name: 'prod-2', envLevel: 'production' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 只读白名单不提级：诊断生产靠读，拦 df -h 纯属狼来了
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  // 生产标记进主机档案 system prompt（源头引导）
  expect(llm.lastSystem() ?? '').toContain('生产环境')

  // write_file：普通机 /home 路径是 mid，生产机位移 high，确认词=别名
  await askAgent(page, 'propose-write')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'high')
  await expect(card).toContainText('「prod-2」')
  // 防盲批：先展开查看器再批
  await page.getByTestId('write-viewer-toggle').click()
  await submitApproval(page, 'prod-2')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('approved_and_written')
  expect(ssh.writtenFiles()['/home/test/notes.txt']).toContain('hello-from-agent')
})

test('实验机：审批语义不变（中风险仍 y/N），仅标识', async () => {
  const launched = await launchApp(
    [makeHost(ssh.port, { name: 'lab-1', envLevel: 'experiment' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await expect(page.getByTestId('tab-env-badge')).toHaveText(/实验/)
  await askAgent(page, 'propose-restart')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await submitApproval(page, 'y')
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')
})

test('生产机环境标识视觉层：tab 徽章 + 终端顶缘光条（TUI 不消失），四边环/左缘条/底栏徽章已删', async () => {
  const launched = await launchApp([
    makeHost(ssh.port, { name: 'prod-3', envLevel: 'production' })
  ])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 保留的两个落点
  await expect(page.getByTestId('tab-env-badge')).toHaveText(/生产/)
  const rail = page.getByTestId('env-rail')
  await expect(rail).toBeVisible()
  // 满不透明的生产橙——不再是 /45 合成出的 #773b13 棕。v0.14.3 起色值走 --env-prod
  // 令牌（暗色仍是 orange-500 的 #f97316），解析成不带 alpha 的 rgb() 即满不透明
  await expect(rail).toHaveClass(/bg-env-prod/)
  await expect(rail).toHaveCSS('background-color', 'rgb(249, 115, 22)')

  // 删掉的三个落点
  await expect(page.getByTestId('terminal-area')).not.toHaveClass(/ring-env-prod/)
  await expect(page.getByTestId('composer-env-edge')).toHaveCount(0)
  await expect(page.getByTestId('env-statusbar')).toHaveCount(0)

  // 进入 TUI：composer 让位，顶缘条在终端区上，常驻不消失
  await page.getByTestId('composer-input').fill('tui')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'tui')
  await expect(rail).toBeVisible()
})

test('实验机不画顶缘光条（环境色是氛围，只有生产需要常驻提示）', async () => {
  const launched = await launchApp([
    makeHost(ssh.port, { name: 'lab-2', envLevel: 'experiment' })
  ])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await expect(page.getByTestId('tab-env-badge')).toHaveText(/实验/)
  await expect(page.getByTestId('env-rail')).toHaveCount(0)
})
