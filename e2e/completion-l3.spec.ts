import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import {
  activeTerminalText,
  launchApp,
  makeHost,
  type SeedLlmProfile
} from './fixtures/launch'

/**
 * 补全 L3（completion-design）：LLM 只在停顿时刻进场——
 * 命令结束预测下一条（ghost text，→ 接受）、非零退出码给修复建议。
 * 默认关闭（每条命令一次 LLM 调用），设置开启后生效。
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

async function runCommand(page: Page, command: string): Promise<void> {
  await page.getByTestId('composer-input').fill(command)
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

test('L3 预测下一条：命令结束 ghost 呈现，→ 接受', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { completionLlmEnabled: true }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await runCommand(page, 'echo suggest-probe')
  // 停顿时刻返回的预测以 ghost text 呈现（draft 为空时整条展示）
  await expect(page.getByTestId('ghost-text')).toHaveText('echo predicted-next')
  await expect(page.getByTestId('suggest-explanation')).toContainText('预测的下一条命令')

  // → 接受进草稿
  await page.getByTestId('composer-input').press('ArrowRight')
  await expect(page.getByTestId('composer-input')).toHaveValue('echo predicted-next')
  // 接受即消费，ghost 归于历史逻辑（无前缀匹配则为空）
  await expect(page.getByTestId('suggest-explanation')).toHaveCount(0)
})

test('L3 修复建议：非零退出码触发 fix 与解释', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { completionLlmEnabled: true }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await runCommand(page, 'failcmd')
  await expect.poll(() => activeTerminalText(page)).toContain('boom: simulated failure')
  await expect(page.getByTestId('ghost-text')).toHaveText('echo fixed-it')
  await expect(page.getByTestId('suggest-explanation')).toContainText('修复 boom 报错')
})

test('L3 默认关闭：命令结束不触发任何 LLM 调用', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  const baseline = llm.requests()

  await runCommand(page, 'echo suggest-probe')
  // 给足触发窗口后确认零调用（烧 key 的功能必须显式开启）
  await page.waitForTimeout(1200)
  expect(llm.requests()).toBe(baseline)
  await expect(page.getByTestId('ghost-text')).toHaveText('')
})
