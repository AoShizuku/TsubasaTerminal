import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * v0.13.14 模型按会话绑定：
 * - 同主机多 tab 各用各的模型；切 tab 选择器跟随该会话，活动对话锁定在自己的 profile 上，
 *   发送永远用绑定的模型（此前选择器全局一份，切 tab 后会拿别处选的模型发出去，
 *   主进程再静默开一个没有上下文的新对话）；
 * - 主进程硬拒：绕过 UI 用另一个 profile 发到已绑定的会话，拒绝且对话不分叉；
 * - 活动对话中换模型 = 确认后新建对话；没有活动对话时的选择记为最后一次选择，新会话跟随；
 * - 恢复：只锁本会话，不改最后一次选择；存档 model 与 profile 现值不同、或原 profile
 *   已删改用同模型替身，都先确认再接续。
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

function profile(id: string, name: string, model: string): SeedLlmProfile {
  return {
    id,
    name,
    provider: 'anthropic',
    baseURL: llm.anthropicBaseURL,
    model,
    apiKey: 'sk-test'
  }
}

async function openSession(page: Page, expectedTabs: number): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect(page.getByTestId('session-tab')).toHaveCount(expectedTabs)
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

/** 问一句并等这一轮真的打到 fake provider、回复落屏 */
async function askAgent(page: Page, text: string): Promise<void> {
  const requestCount = llm.requests()
  const replies = await page.getByTestId('agent-assistant-msg').count()
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
  await expect.poll(() => llm.requests()).toBeGreaterThan(requestCount)
  await expect(page.getByTestId('agent-assistant-msg')).toHaveCount(replies + 1)
}

function readIndex(userDataDir: string): Array<{ convId: string; profileId: string; model?: string; turnCount: number }> {
  try {
    return readFileSync(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function activeSessionId(page: Page): Promise<string> {
  return (await page.locator('[data-testid="terminal-view"]:visible').getAttribute('data-session-id')) ?? ''
}

test('同主机两个 tab 各用各的模型：切 tab 选择器跟随，发送用绑定模型，主进程拒绝绕过 UI 换模型', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [profile('pa', 'Pricey', 'fake-model-a'), profile('pb', 'Cheap', 'fake-model-b')]
  })
  app = launched.app
  const page = launched.page
  const select = page.getByTestId('agent-profile-select')

  // tab1：默认（最后一次选择 = pa）开对话
  await openSession(page, 1)
  const tab1 = await activeSessionId(page)
  await expect(select).toHaveValue('pa')
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-a')
  await expect(select).toHaveAttribute('data-locked', 'true')

  // tab2：同主机新会话，选低价模型开对话（无活动对话，不弹确认）
  await openSession(page, 2)
  await expect(select).toHaveValue('pa')
  await select.selectOption('pb')
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-b')

  // 切回 tab1：选择器跟随该会话的对话（此前停在 pb），发送仍是 A 且接着原对话
  await page.getByTestId('session-tab').first().click()
  await expect(select).toHaveValue('pa')
  await expect(select).toHaveAttribute('data-locked', 'true')
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-a')
  // 旧轮次在请求里：是接续，不是静默开的新对话
  expect(llm.lastMessages()).toContain('hello-agent-reply')

  // 切到 tab2 同理
  await page.getByTestId('session-tab').nth(1).click()
  await expect(select).toHaveValue('pb')

  await expect
    .poll(() =>
      readIndex(launched.userDataDir)
        .map((m) => `${m.profileId}:${m.model}:${m.turnCount}`)
        .sort()
    )
    .toEqual(['pa:fake-model-a:2', 'pb:fake-model-b:1'])

  // 主进程硬拒：绕过渲染层，用 pb 发到绑定了 pa 的 tab1——拒绝、带回绑定，不分叉
  const requests = llm.requests()
  const result = await page.evaluate(async (sessionId) => {
    const api = (
      window as unknown as {
        api: {
          agent: {
            send(
              sessionId: string,
              text: string,
              opts: { profileId: string; attachUnitIds: number[]; hostLabel: string }
            ): Promise<{ ok: boolean; error?: string; boundProfileId?: string }>
          }
        }
      }
    ).api
    return await api.agent.send(sessionId, 'hello-agent', {
      profileId: 'pb',
      attachUnitIds: [],
      hostLabel: 'x'
    })
  }, tab1)
  expect(result).toMatchObject({ ok: false, boundProfileId: 'pa' })
  expect(result.error ?? '').toContain('新建对话')
  expect(llm.requests()).toBe(requests)
  expect(readIndex(launched.userDataDir)).toHaveLength(2)
})

test('活动对话中换模型：取消不变，确认则新建对话并记为最后一次选择', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [profile('pa', 'Pricey', 'fake-model-a'), profile('pb', 'Cheap', 'fake-model-b')]
  })
  app = launched.app
  const page = launched.page
  const select = page.getByTestId('agent-profile-select')

  await openSession(page, 1)
  await askAgent(page, 'hello-agent')

  // 取消：选择器拨回，对话原样
  await select.selectOption('pb')
  await expect(page.getByTestId('confirm-message')).toContainText('将新建对话')
  await page.getByTestId('confirm-cancel').click()
  await expect(select).toHaveValue('pa')
  await expect(select).toHaveAttribute('data-locked', 'true')
  await expect(page.getByTestId('agent-user-msg')).toHaveCount(1)

  // 确认：新建对话（清场、解锁），下一轮用 B 开新对话
  await select.selectOption('pb')
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-user-msg')).toHaveCount(0)
  await expect(select).toHaveValue('pb')
  await expect(select).toHaveAttribute('data-locked', 'false')
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-b')
  expect(llm.lastMessages()).not.toContain('hello-agent-reply')
  await expect.poll(() => readIndex(launched.userDataDir).length).toBe(2)

  // 新开的会话跟随最后一次选择
  await openSession(page, 2)
  await expect(select).toHaveValue('pb')
})

/** 首次启动用 pa 聊一轮并落盘，返回 userData 供改 profile 后重启 */
async function seedConversationWithA(): Promise<string> {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [profile('pa', 'Pricey', 'fake-model-a'), profile('pb', 'Cheap', 'fake-model-b')]
  })
  app = launched.app
  await openSession(launched.page, 1)
  await askAgent(launched.page, 'hello-agent')
  await expect.poll(() => readIndex(launched.userDataDir)[0]?.turnCount).toBe(1)
  await launched.app.close()
  app = undefined
  return launched.userDataDir
}

async function openFirstReview(page: Page): Promise<void> {
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').click()
  await expect(page.getByTestId('agent-review-resume')).toBeVisible()
}

test('恢复只锁本会话：选择器回到原对话的模型，最后一次选择不被带走', async () => {
  const userDataDir = await seedConversationWithA()
  const second = await launchApp([], userDataDir, {})
  app = second.app
  const page = second.page
  const select = page.getByTestId('agent-profile-select')

  await openSession(page, 1)
  // 恢复前先把本会话（与最后一次选择）切到低价模型
  await select.selectOption('pb')
  // 历史条目与回溯页脚标出对话实际用的模型
  await page.getByTestId('agent-history-toggle').click()
  await expect(page.getByTestId('agent-history-model')).toHaveText('fake-model-a')
  await page.getByTestId('agent-history-toggle').click()
  await openFirstReview(page)
  await expect(page.getByTestId('agent-review-footer')).toContainText('fake-model-a')
  await page.getByTestId('agent-review-resume').click()
  // 模型没变：不弹确认，直接接续并锁回 A
  await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect(select).toHaveValue('pa')
  await expect(select).toHaveAttribute('data-locked', 'true')
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-a')

  // 另开会话：仍跟随最后一次选择（B），没有被恢复带走
  await openSession(page, 2)
  await expect(select).toHaveValue('pb')
})

test('恢复时 profile 已改过模型：先确认，取消不接续，确认后按新模型接续', async () => {
  const userDataDir = await seedConversationWithA()
  // 同一个 profile id，模型被改了
  const second = await launchApp([], userDataDir, {
    llmProfiles: [profile('pa', 'Pricey', 'fake-model-a2'), profile('pb', 'Cheap', 'fake-model-b')]
  })
  app = second.app
  const page = second.page

  await openSession(page, 1)
  await openFirstReview(page)
  await page.getByTestId('agent-review-resume').click()
  const message = page.getByTestId('confirm-message')
  await expect(message).toContainText('fake-model-a')
  await expect(message).toContainText('fake-model-a2')
  await page.getByTestId('confirm-cancel').click()
  await expect(page.getByTestId('agent-review-bar')).toBeVisible()

  await page.getByTestId('agent-review-resume').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-a2')
  expect(llm.lastMessages()).toContain('fake-signature')
  await expect.poll(() => readIndex(userDataDir)[0]?.model).toBe('fake-model-a2')
})

test('恢复时原 profile 已删：用同模型替身，确认后接续并改记替身', async () => {
  const userDataDir = await seedConversationWithA()
  const second = await launchApp([], userDataDir, {
    llmProfiles: [profile('pb', 'Cheap', 'fake-model-b'), profile('pc', 'Relay A', 'fake-model-a')]
  })
  app = second.app
  const page = second.page

  await openSession(page, 1)
  await openFirstReview(page)
  await page.getByTestId('agent-review-resume').click()
  await expect(page.getByTestId('confirm-message')).toContainText('已删除')
  await expect(page.getByTestId('confirm-message')).toContainText('Relay A')
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
  await expect(page.getByTestId('agent-profile-select')).toHaveValue('pc')
  await askAgent(page, 'hello-agent')
  expect(llm.lastBody().model).toBe('fake-model-a')
  await expect.poll(() => readIndex(userDataDir)[0]?.profileId).toBe('pc')
})
