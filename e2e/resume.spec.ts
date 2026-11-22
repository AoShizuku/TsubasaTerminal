import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { FAKE_TITLE, startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * v0.10.2 接续与迁移（knowledge-design 2.2/2.3/2.4/2.7）：
 * - 前置：单元 id 带会话前缀（全局唯一），陌生前缀/裸数字直接 rejected——
 *   防"新会话恰好也有 id 7"读到另一台机器输出的静默错读；
 * - 接续：provider 原生消息回灌（thinking signature 原样回传）、恢复前展示重算成本；
 * - 迁移：换主机一律重建 system prompt（本机知识/主机档案换新）、user 前缀声明
 *   迁移事件与转录引用失效、hostIds 追加；
 * - 排他：活动对话不可被捞出（UI 无按钮 + 主进程硬校验）。
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

async function connectHost(page: Page, hostName?: string): Promise<void> {
  const item = hostName
    ? page.getByTestId('host-item').filter({ hasText: hostName })
    : page.getByTestId('host-item')
  await item.dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function askAgent(page: Page, text: string): Promise<void> {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
}

function readIndex(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
  } catch {
    return ''
  }
}

test('unit id 带会话前缀：带前缀引用正常读、裸数字（存量格式）被 rejected', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectHost(page)

  // 先跑一条命令产生转录单元
  await page.getByTestId('composer-input').fill('echo unit-mark-001')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^unit-mark-001$/m.test(await activeTerminalText(page))).toBe(true)

  // 正常通路：list_transcript 给出带前缀 id → 剧本抽出该 id 调 read_output → 读到正文
  await askAgent(page, 'read-first-unit')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'ok')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('tool-result:command=')
  await expect(reply).toContainText('unit-mark-001')
  // 概要里的 id 是 "前缀:序号" 形态（8 位十六进制会话前缀）
  expect(llm.lastMessages()).toMatch(/\\"id\\":\\"[0-9a-f]{8}:\d+\\"/)

  // 陌生前缀防线：裸数字 id（v0.10.1 存量/恢复前的旧引用）直接 rejected
  await askAgent(page, 'read-stale-unit')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'rejected'
  )
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('失效')
})

test('跨重启接续：原生消息回灌（signature 原样回传）+ 成本展示 + 恢复声明', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectHost(page)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  // 落盘齐了（索引 turnCount + 标题）再重启——app.quit 不等挂起的写
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"turnCount":1')
  await expect.poll(() => readIndex(launched.userDataDir)).toContain(FAKE_TITLE)

  await launched.app.close()
  app = undefined
  const second = await launchApp([], launched.userDataDir, {})
  app = second.app
  const page2 = second.page
  await connectHost(page2)

  // 回溯 → 继续按钮如实标注重算成本（FAKE_USAGE：输入 3000+缓存 1000+输出 200 = 4.2K）
  await page2.getByTestId('agent-history-toggle').click()
  await page2.getByTestId('agent-history-item').click()
  const resumeBtn = page2.getByTestId('agent-review-resume')
  await expect(resumeBtn).toBeVisible()
  await expect(resumeBtn).toContainText('约重算 4.2K')

  // 继续：回溯态退出、旧消息灌回实时流、接缝 notice 在场
  await resumeBtn.click()
  await expect(page2.getByTestId('agent-review-bar')).toHaveCount(0)
  await expect(page2.getByTestId('agent-input')).toBeVisible()
  await expect(page2.getByTestId('agent-user-msg').first()).toContainText('hello-agent')
  await expect(page2.getByTestId('agent-assistant-msg').first()).toContainText(
    'echo:hello-agent-reply'
  )
  await expect(page2.getByText('对话已在新会话中恢复')).toBeVisible()
  // 恢复后圆环显示旧对话的上下文体积（下一轮官方 usage 会刷新）
  await expect(page2.getByTestId('agent-token-ring')).toHaveAttribute('data-used', '4200')

  // 接着聊：provider 收到的 messages 含原样回灌的 thinking signature 与旧轮文本，
  // 新一轮 user 前缀声明"已恢复 + 旧 unit id 失效"（fake server 复刻 tool 配对校验，
  // 能正常回复本身就说明回灌历史被 provider 接受）
  const requestCount = llm.requests()
  const replyCount = await page2.getByTestId('agent-assistant-msg').count()
  await askAgent(page2, 'hello-agent')
  // 旧回复的文本与新回复相同，单看 `.last()` 会在新请求尚未抵达 fake provider 时误通过。
  await expect.poll(() => llm.requests()).toBe(requestCount + 1)
  await expect(page2.getByTestId('agent-assistant-msg')).toHaveCount(replyCount + 1)
  await expect(page2.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  const messages = llm.lastMessages()
  expect(messages).toContain('fake-signature')
  expect(messages).toContain('【对话恢复】')
  expect(messages).toContain('已失效')
  // 索引继续累计轮数（同一对话，不是新对话）
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"turnCount":2')
})

test('迁移到另一台主机：system prompt 重建（新主机知识）+ 迁移声明 + hostIds 追加', async () => {
  const hostA = makeHost(ssh.port, { knowledge: '拓扑约定：KNOW-A-MARK' })
  const hostB = makeHost(ssh.port, { knowledge: '拓扑约定：KNOW-B-MARK' })
  const launched = await launchApp([hostA, hostB], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page

  // 主机 A：聊一轮（system 是 A 的知识），等落盘
  await connectHost(page, hostA.name)
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  expect(llm.lastSystem() ?? '').toContain('KNOW-A-MARK')
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"turnCount":1')

  // 关掉 A 的会话（对话失去活动绑定，才可被捞出）；关闭按钮 hover 才显形
  await page.getByTestId('session-tab').hover()
  await page.getByTestId('close-tab').click()

  // 主机 B：回溯 A 的对话，"继续" = 迁移
  await connectHost(page, hostB.name)
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').click()
  await page.getByTestId('agent-review-resume').click()
  await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
  await expect(page.getByText('对话已迁移到')).toBeVisible()

  // 迁移一律重建 system：B 的本机知识在、A 的不残留（跨机残留是这条规则要防的事故）
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  const system = llm.lastSystem() ?? ''
  expect(system).toContain('KNOW-B-MARK')
  expect(system).not.toContain('KNOW-A-MARK')
  // user 前缀只声明迁移事件与转录引用失效
  const messages = llm.lastMessages()
  expect(messages).toContain('【对话迁移】')
  expect(messages).toContain('已全部失效')
  // 迁移历史（thinking signature）依旧原样回传
  expect(messages).toContain('fake-signature')
  // hostIds 按时间线追加：一眼看出这次排障跨了哪几台机
  await expect
    .poll(() => readIndex(launched.userDataDir))
    .toContain(`"hostIds":["${hostA.id}","${hostB.id}"]`)
})

test('活动对话不可被捞出：回溯无继续按钮，主进程拒绝并说明', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectHost(page)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )

  // 回溯自己的活动对话（标"当前"）：没有继续按钮
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').click()
  await expect(page.getByTestId('agent-review-bar')).toBeVisible()
  await expect(page.getByTestId('agent-review-resume')).toHaveCount(0)

  // 主进程硬校验：UI 之外的调用同样拒绝——两个 loop 并发写同一份 messages.json 是数据损坏
  const result = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: {
          conversations: { list(): Promise<Array<{ convId: string; active?: boolean }>> }
          agent: {
            resumeConversation(
              sessionId: string,
              convId: string,
              opts: { hostLabel: string }
            ): Promise<{ ok: boolean; error?: string }>
          }
        }
      }
    ).api
    const list = await api.conversations.list()
    const active = list.find((m) => m.active)
    if (!active) return { ok: true, error: 'no-active-conversation' }
    return await api.agent.resumeConversation('another-session-id', active.convId, {
      hostLabel: 'x@y'
    })
  })
  expect(result.ok).toBe(false)
  expect(result.error ?? '').toContain('其他会话')
})
