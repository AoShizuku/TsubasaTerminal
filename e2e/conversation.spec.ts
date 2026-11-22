import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { FAKE_TITLE, startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile } from './fixtures/launch'

/**
 * v0.10.1 对话持久化与回溯：双份落盘（messages.json + events.jsonl + index.jsonl）、
 * 跨重启列出与回溯渲染、新建清场、标题自动生成/手改/降级、删除与导出。
 * 本版只读——回溯不可续聊（接续与迁移归 v0.10.2）。
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

function readIndex(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
  } catch {
    return ''
  }
}

/** conversations/ 下唯一日期目录里的文件名列表 */
function convFiles(userDataDir: string): string[] {
  try {
    const root = join(userDataDir, 'conversations')
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    return dirs.flatMap((d) => readdirSync(join(root, d.name)).map((f) => join(d.name, f)))
  } catch {
    return []
  }
}

test('双份落盘 + 跨重启列出与回溯渲染（thinking/文本/工具卡都复原）', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 两轮对话：流式文本 + 工具执行（回溯要能复原这两类条目）
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-test-user')

  // 双份落盘：messages.json（provider 原生，含 thinking signature——v0.10.2 接续的命根）
  // 与 events.jsonl（回溯渲染）。落盘异步且按轮全量覆盖，等的条件必须是"第二轮已落"：
  // 光等文件出现第一轮就满足了，读到的快照里没有 tool_result。索引的 turnCount 蕴含它
  // ——persistConversationTurn 同一 job 内先写 messages.json 再写索引。
  // 这同时是重启前的等待：app.quit 不等挂起的写
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"turnCount":2')
  const files = convFiles(launched.userDataDir)
  const messagesFile = files.find((f) => f.endsWith('.messages.json'))
  const eventsFile = files.find((f) => f.endsWith('.events.jsonl'))
  expect(messagesFile).toBeTruthy()
  expect(eventsFile).toBeTruthy()
  const snapshot = JSON.parse(
    readFileSync(join(launched.userDataDir, 'conversations', messagesFile!), 'utf-8')
  )
  expect(snapshot.provider).toBe('anthropic')
  expect(snapshot.model).toBe('fake-model')
  expect(typeof snapshot.system).toBe('string')
  const flat = JSON.stringify(snapshot.messages)
  expect(flat).toContain('fake-signature') // thinking 块连 signature 原样落盘
  expect(flat).toContain('tool_result') // 工具配对完整
  // 标题：第一轮结束后 oneShotText 生成（fake server 固定应答），异步落索引
  await expect.poll(() => readIndex(launched.userDataDir)).toContain(FAKE_TITLE)
  expect(readIndex(launched.userDataDir)).toContain('"titleSource":"llm"')

  // 重启复用 userData：对话必须还在
  await launched.app.close()
  app = undefined
  const second = await launchApp([], launched.userDataDir, {})
  app = second.app
  const page2 = second.page

  await page2.getByTestId('agent-history-toggle').click()
  const item = page2.getByTestId('agent-history-item')
  await expect(item).toHaveCount(1)
  await expect(page2.getByTestId('agent-history-title')).toContainText(FAKE_TITLE)
  await expect(item).toContainText('2 轮')

  // 回溯：主体区切只读视图，条目与当时一致
  await item.click()
  await expect(page2.getByTestId('agent-review-bar')).toBeVisible()
  await expect(page2.getByTestId('agent-review-title')).toContainText(FAKE_TITLE)
  await expect(page2.getByTestId('agent-user-msg').first()).toContainText('hello-agent')
  await expect(page2.getByTestId('agent-assistant-msg').first()).toContainText(
    'echo:hello-agent-reply'
  )
  // thinking 折叠区与工具卡状态都从 events.jsonl 复原
  await expect(page2.getByText('思考过程').first()).toBeVisible()
  const card = page2.getByTestId('agent-tool-card').first()
  await expect(card).toHaveAttribute('data-status', 'executed')
  await expect(card).toContainText('whoami')
  // 只读：输入区在回溯态藏起
  await expect(page2.getByTestId('agent-input')).toBeHidden()
  // 返回当前对话：输入区回来，回溯栏退场
  await page2.getByTestId('agent-review-close').click()
  await expect(page2.getByTestId('agent-review-bar')).toHaveCount(0)
  await expect(page2.getByTestId('agent-input')).toBeVisible()
})

test('新建对话清场：一键开新对话，旧对话自动存盘可回看', { tag: '@daily' }, async () => {
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

  // 历史浮层开着时新建：浮层要自己收起（留在屏上的话"当前"徽标还指着刚摘下的那条）
  await page.getByTestId('agent-history-toggle').click()
  await expect(page.getByTestId('agent-history-panel')).toBeVisible()

  // 新建：消息流清空、回到空态（上下文构成铺开）、历史浮层关闭
  await page.getByTestId('agent-new-conversation').click()
  await expect(page.getByTestId('agent-history-panel')).toBeHidden()
  await expect(page.getByTestId('agent-user-msg')).toHaveCount(0)
  await expect(page.getByTestId('agent-empty-context')).toBeVisible()

  // 新对话是另一个 convId：再聊一轮后磁盘上是两对文件
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-test-user')
  await expect.poll(() => convFiles(launched.userDataDir).length).toBe(4)

  // 历史列表两条；活动对话标"当前"且不出删除按钮
  await page.getByTestId('agent-history-toggle').click()
  await expect(page.getByTestId('agent-history-item')).toHaveCount(2)
  const activeRow = page.getByTestId('agent-history-item').filter({ hasText: '当前' })
  await expect(activeRow).toHaveCount(1)
  await expect(activeRow.getByTestId('agent-history-delete')).toHaveCount(0)
})

test('清空历史对话走应用内确认框：取消不动，确认后只留活动对话', async () => {
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
  await page.getByTestId('agent-new-conversation').click()
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-test-user')
  await expect.poll(() => convFiles(launched.userDataDir).length).toBe(4)

  await page.getByTestId('agent-history-toggle').click()
  await expect(page.getByTestId('agent-history-item')).toHaveCount(2)
  await page.getByTestId('agent-history-clear').click()
  await expect(page.getByTestId('confirm-message')).toContainText('清空所有历史对话')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await page.getByTestId('confirm-cancel').click()
  await expect(page.getByTestId('confirm-dialog')).toBeHidden()
  await expect(page.getByTestId('agent-history-item')).toHaveCount(2)
  expect(convFiles(launched.userDataDir)).toHaveLength(4)

  await page.getByTestId('agent-history-clear').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-history-item')).toHaveCount(1)
  await expect(page.getByTestId('agent-history-item')).toContainText('当前')
  await expect.poll(() => convFiles(launched.userDataDir).length).toBe(2)
})

test('标题手改后不被自动覆盖；删除单条连文件一起清', async () => {
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
  await expect.poll(() => readIndex(launched.userDataDir)).toContain(FAKE_TITLE)

  // 新建把它变成非活动对话，才能验证删除
  await page.getByTestId('agent-new-conversation').click()

  // 回溯里改标题 → titleSource=manual
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').click()
  await page.getByTestId('agent-review-rename').click()
  await page.getByTestId('agent-review-title-input').fill('0812 支付超时工单')
  await page.getByTestId('agent-review-title-save').click()
  await expect(page.getByTestId('agent-review-title')).toContainText('0812 支付超时工单')
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"titleSource":"manual"')
  expect(readIndex(launched.userDataDir)).toContain('0812 支付超时工单')

  // 删除：列表消失、双份文件清掉、回溯视图关闭
  await page.getByTestId('agent-review-close').click()
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').hover()
  await page.getByTestId('agent-history-delete').click()
  await expect(page.getByTestId('agent-history-item')).toHaveCount(0)
  await expect.poll(() => convFiles(launched.userDataDir).length).toBe(0)
  await expect.poll(() => readIndex(launched.userDataDir)).not.toContain('0812 支付超时工单')
})

test('markdown 导出：标题/用户消息/回复/工具卡进文件', async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-export-'))
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()],
    env: { TSUBASATERMINAL_E2E_EXPORT_DIR: exportDir }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect.poll(() => readIndex(launched.userDataDir)).toContain(FAKE_TITLE)

  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').click()
  await page.getByTestId('agent-review-export').click()
  await expect(page.getByTestId('agent-export-note')).toContainText('已导出')

  const files = readdirSync(exportDir)
  expect(files.length).toBe(1)
  const md = readFileSync(join(exportDir, files[0]), 'utf-8')
  expect(files[0]).toContain(FAKE_TITLE)
  expect(md).toContain(`# ${FAKE_TITLE}`)
  expect(md).toContain('## 用户')
  expect(md).toContain('run-whoami')
  expect(md).toContain('## Agent')
  expect(md).toContain('**exec** whoami')
  expect(md).toContain('已执行')
  // 角色归属：工具行自身不带角色，只能从上一个 ## 标题继承。run-whoami 剧本正是
  // "调工具前不吐文本"的形态（OpenAI responses 的纯 function_call 轮同理），
  // ## Agent 必须由导出侧补出来，否则整串工具调用挂到用户名下
  expect(md.indexOf('## Agent')).toBeGreaterThan(md.indexOf('## 用户'))
  expect(md.indexOf('## Agent')).toBeLessThan(md.indexOf('> 🔧'))
  // 一个回合只开一次 Agent 段：工具行与其后的回复不该各顶一个标题
  expect(md.split('## Agent').length - 1).toBe(1)
})

test('标题生成失败降级首句截断（永远有个能看的标题）', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // fake server 对含 title-fail 的标题请求回空文本 → 应用侧不覆盖 fallback
  await askAgent(page, 'title-fail-probe 请帮我看看')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('ok')
  await expect.poll(() => readIndex(launched.userDataDir)).toContain('"titleSource":"fallback"')
  // 标题请求已发出并返回空；索引里保留的是首句截断（20 字内）
  await page.waitForTimeout(500)
  const index = readIndex(launched.userDataDir)
  expect(index).toContain('"titleSource":"fallback"')
  expect(index).toContain('title-fail-probe')
  expect(index).not.toContain(FAKE_TITLE)
})
