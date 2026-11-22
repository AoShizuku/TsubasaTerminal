import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { FAKE_EXP_DRAFT, startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import {
  activeTerminalText,
  launchApp,
  makeHost,
  type SeedLlmProfile
} from './fixtures/launch'

/**
 * 排障经验（knowledge-design 第四节）：索引常驻 system + 正文按需、
 * read_experience/save_experience 两工具、防盲批 + 可编辑后再批、
 * 20/10 上限 pinned + createdAt 截断、提炼补录与来源回跳。
 * 铁律回归点：**指令通道只能人写**——save_experience 永不自动落盘，
 * 且当前对话的 system 快照不因新经验而变（缓存经济）。
 */

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

const HOST_EXP_MARK = '磁盘满 → core dump 堆积 exp-host-mark'
const GLOBAL_EXP_MARK = 'nginx 502 → upstream 连接池满 exp-global-mark'
const EXP_BODY_MARK = 'core dump 堆积在 /var/log/app exp-body-mark'

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

function anthropicProfile(id = 'prof-anthropic', name = 'Fake Claude'): SeedLlmProfile {
  return {
    id,
    name,
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

/** 发一轮并等这一轮的回复落地（数量断言防被上一轮同款文本骗过） */
async function askAgent(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('agent-assistant-msg').count()
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('agent-assistant-msg')).toHaveCount(before + 1)
}

async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
}

function readExperienceIndex(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'experience', 'index.jsonl'), 'utf-8')
  } catch {
    return ''
  }
}

/** 种子索引行（ExperienceMeta 形状） */
function seedEntry(over: Record<string, unknown>): string {
  return (
    JSON.stringify({
      id: 'seed0000',
      scope: 'host',
      hostId: 'exp-host',
      summary: '（占位）',
      pinned: false,
      createdAt: 1700000000000,
      lastReadAt: null,
      readCount: 0,
      bytes: 10,
      ...over
    }) + '\n'
  )
}

test('索引进 system（主机档案之后 + 召回纪律），read_experience 取回正文并记 readCount', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: {
      'experience/index.jsonl':
        seedEntry({ id: 'expseed01', summary: HOST_EXP_MARK }) +
        seedEntry({ id: 'expseed02', scope: 'global', hostId: undefined, summary: GLOBAL_EXP_MARK }),
      'experience/expseed01.md': `## 真因\n${EXP_BODY_MARK}\n`
    }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  const system = llm.lastSystem() ?? ''
  // 索引常驻：本机与全局条目都在，id 可供 read_experience 引用
  expect(system).toContain('## 排障经验索引')
  expect(system).toContain(`[expseed01] ${HOST_EXP_MARK}`)
  expect(system).toContain(`[expseed02] ${GLOBAL_EXP_MARK}`)
  // 召回纪律（4.2）：先读再侦察 + "你侦察不出来"——告诉模型这类信息不可替代
  expect(system).toContain('先 read_experience 读正文再动手侦察')
  expect(system).toContain('侦察不出来')
  // 第六节殿后：主机档案（探测）之后
  expect(system.indexOf('## 排障经验索引')).toBeGreaterThan(system.indexOf('## 主机档案'))

  // 正文按需：read_experience 免审批取回，内容是指令侧（不包 terminal-data）
  await askAgent(page, 'read-exp')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('"status":"ok"')
  await expect(reply).toContainText(EXP_BODY_MARK)
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  // 读取记 readCount/lastReadAt（治理参考，不参与淘汰）
  await expect.poll(() => readExperienceIndex(launched.userDataDir)).toContain('"readCount":1')

  // 陌生 id：not_found，引导回索引
  await askAgent(page, 'read-exp-missing')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('not_found')
})

test('save_experience：起草校验 → 防盲批 → 可编辑后批准落盘；当前对话 system 不变、下一对话带上', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 结论导向的梗概（无 →）被工具校验打回，不进审批台——模板约束不指望自觉
  await askAgent(page, 'save-exp-badsummary')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('rejected')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('症状 → 结论')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)

  // 合格起草 → 进审批台（中性卡：无风险徽章——审的是上下文污染，不是机器安全）
  await page.getByTestId('agent-input').fill('save-exp')
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-kind', 'save_experience')
  await expect(page.getByTestId('approval-command')).toContainText('磁盘满 →')
  await expect(page.getByTestId('approval-risk')).toHaveCount(0)

  // 防盲批：未查看不能批
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toContainText('先查看经验内容')
  await expect(page.getByTestId('exp-viewer')).toBeHidden()

  // 展开查看器（可编辑）：改梗概后批准——落盘的是人确认的版本
  await page.getByTestId('exp-viewer-toggle').click()
  await expect(page.getByTestId('exp-viewer')).toBeVisible()
  await expect(page.getByTestId('exp-viewer-detail')).toHaveValue(/core dump 堆积/)
  await page.getByTestId('exp-viewer-summary').fill('磁盘满 → 编辑后的结论 edited-mark')
  await submitApproval(page, 'y')

  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('approved_and_saved')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'approved')

  // 落盘：索引含编辑后梗概与来源对话；正文文件在
  await expect.poll(() => readExperienceIndex(launched.userDataDir)).toContain('edited-mark')
  const indexLine = JSON.parse(readExperienceIndex(launched.userDataDir).trim().split('\n')[0])
  expect(indexLine.scope).toBe('host')
  expect(indexLine.hostId).toBe('exp-host')
  expect(typeof indexLine.sourceConvId).toBe('string')
  const files = readdirSync(join(launched.userDataDir, 'experience'))
  const body = files.find((f) => f.endsWith('.md'))
  expect(body).toBeTruthy()
  expect(readFileSync(join(launched.userDataDir, 'experience', body!), 'utf-8')).toContain('## 症状')
  // 审批走了审计（提案 + 决策）
  const audit = readFileSync(join(launched.userDataDir, 'audit.jsonl'), 'utf-8')
  expect(audit).toContain('save_experience')
  expect(audit).toContain('"decision":"approved"')

  // 快照纪律（4.3）：同一对话再问，system 仍是开始时的快照——新经验不在里面
  await askAgent(page, 'hello-agent')
  expect(llm.lastSystem() ?? '').not.toContain('edited-mark')

  // 新建对话（清场）：下一个对话自然带上新索引，零额外成本
  await page.getByTestId('agent-new-conversation').click()
  await askAgent(page, 'hello-agent')
  expect(llm.lastSystem() ?? '').toContain('## 排障经验索引')
  expect(llm.lastSystem() ?? '').toContain('edited-mark')
})

test('超限截断：pinned 固定注入，其余按创建时间新者优先；UI 明示"另有 N 条未注入"', async () => {
  // 22 条本机经验：exp-mark-01 最老但 pinned；上限 20 → 挤出最老的两条非 pinned（02、03）
  let indexLines = ''
  for (let i = 1; i <= 22; i++) {
    const nn = String(i).padStart(2, '0')
    indexLines += seedEntry({
      id: `exp000-${nn}`,
      summary: `症状${nn} → 结论 exp-mark-${nn}`,
      pinned: i === 1,
      createdAt: 1700000000000 + i * 1000
    })
  }
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: { 'experience/index.jsonl': indexLines }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  const system = llm.lastSystem() ?? ''
  expect(system).toContain('exp-mark-01') // pinned：最老也不被挤出
  expect(system).toContain('exp-mark-04') // 非 pinned 的新 19 条（04..22）都在
  expect(system).toContain('exp-mark-22')
  expect(system).not.toContain('exp-mark-02') // 最老的两条非 pinned 被截断
  expect(system).not.toContain('exp-mark-03')

  // 淘汰 = 不注入不是删除：管理面板全量可见，未注入的明示
  await page.getByTestId('agent-exp-toggle').click()
  await expect(page.getByTestId('agent-exp-panel')).toBeVisible()
  await expect(page.getByTestId('agent-exp-item')).toHaveCount(22)
  await expect(page.locator('[data-testid="agent-exp-item"][data-injected="false"]')).toHaveCount(2)
  await expect(page.getByTestId('agent-exp-omitted')).toContainText('另有 2 条未注入')
})

test('提炼为经验（补录）：Agent 起草可编辑，保存后索引含 sourceConvId', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 先有一段对话（第一轮结束即落盘，提炼原料从 events.jsonl 来）
  await askAgent(page, 'hello-agent')

  // 历史 → 回溯 → 提炼：Agent 草稿回填（fake server 按"排障经验提炼引擎"标记路由）
  await page.getByTestId('agent-history-toggle').click()
  await page.getByTestId('agent-history-item').first().click()
  await expect(page.getByTestId('agent-review-bar')).toBeVisible()
  await page.getByTestId('agent-review-extract').click()
  await expect(page.getByTestId('agent-extract-panel')).toBeVisible()
  await expect(page.getByTestId('agent-extract-summary')).toHaveValue(FAKE_EXP_DRAFT.summary)
  await expect(page.getByTestId('agent-extract-detail')).toHaveValue(/连接池耗尽/)

  await page.getByTestId('agent-extract-save').click()
  await expect(page.getByTestId('agent-extract-panel')).toBeHidden()
  await expect(page.getByTestId('agent-export-note')).toContainText('已存为经验')

  // 落盘：人写路径不经审批台，索引含来源对话（回跳的依据）
  await expect.poll(() => readExperienceIndex(launched.userDataDir)).toContain(
    FAKE_EXP_DRAFT.summary
  )
  const line = JSON.parse(readExperienceIndex(launched.userDataDir).trim().split('\n')[0])
  expect(line.hostId).toBe('exp-host')
  expect(typeof line.sourceConvId).toBe('string')
  expect(line.sourceConvId.length).toBeGreaterThan(0)

  // 经验管理列表能看到，且带来源回跳入口
  await page.getByTestId('agent-review-close').click()
  await page.getByTestId('agent-exp-toggle').click()
  await expect(page.getByTestId('agent-exp-item')).toHaveCount(1)
  await expect(page.getByTestId('agent-exp-source')).toHaveCount(1)
})

/** 种一条可编辑的经验（索引 + 正文），返回 launch 用的 seedFiles */
function seedEditable(): Record<string, string> {
  return {
    'experience/index.jsonl': seedEntry({
      id: 'expedit1',
      summary: '磁盘满 → core dump 堆积 exp-old-mark',
      pinned: true,
      createdAt: 1700000000000,
      readCount: 3,
      sourceConvId: 'conv-old',
      bytes: 24
    }),
    'experience/expedit1.md': '## 症状\n旧正文 exp-old-body\n'
  }
}

function readExperienceBody(userDataDir: string, id: string): string {
  try {
    return readFileSync(join(userDataDir, 'experience', `${id}.md`), 'utf-8')
  } catch {
    return ''
  }
}

test('编辑已存经验：打开即可改，id/创建时间/pin/被读次数/来源全部留住', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: seedEditable()
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // "打开"自 v0.13.1 起是读写一体（此前是中栏只读查看器）
  await page.getByTestId('agent-exp-toggle').click()
  await page.getByTestId('agent-exp-summary').first().click()
  await expect(page.getByTestId('agent-extract-panel')).toHaveAttribute('data-mode', 'edit')
  await expect(page.getByTestId('agent-extract-summary')).toHaveValue(/exp-old-mark/)
  await expect(page.getByTestId('agent-extract-detail')).toHaveValue(/exp-old-body/)

  await page.getByTestId('agent-extract-summary').fill('磁盘满 → 改过的结论 exp-new-mark')
  await page.getByTestId('agent-extract-detail').fill('## 症状\n新正文 exp-new-body\n')
  await page.getByTestId('agent-extract-save').click()
  await expect(page.getByTestId('agent-extract-panel')).toBeHidden()
  await expect(page.getByTestId('agent-export-note')).toContainText('已保存修改')

  // 原地更新而不是删了重存：换 id 就等于把 Agent 的引用钩子扯断
  await expect.poll(() => readExperienceIndex(launched.userDataDir)).toContain('exp-new-mark')
  const lines = readExperienceIndex(launched.userDataDir).trim().split('\n')
  expect(lines).toHaveLength(1)
  const line = JSON.parse(lines[0])
  expect(line.id).toBe('expedit1')
  expect(line.createdAt).toBe(1700000000000) // 注入按 createdAt 排序，编辑不改优先级
  expect(line.pinned).toBe(true)
  expect(line.readCount).toBe(3)
  expect(line.sourceConvId).toBe('conv-old')
  expect(line.hostId).toBe('exp-host') // 补丁语义：没传 hostId 也不会写成孤儿
  expect(typeof line.updatedAt).toBe('number')
  expect(readExperienceBody(launched.userDataDir, 'expedit1')).toContain('exp-new-body')

  // 列表标出"改过"；梗概进下一个对话的 system 索引
  await page.getByTestId('agent-exp-toggle').click()
  await expect(page.getByTestId('agent-exp-edited')).toHaveCount(1)
  await page.getByTestId('agent-exp-toggle').click()
  await askAgent(page, 'hello-agent')
  const system = llm.lastSystem() ?? ''
  expect(system).toContain('exp-new-mark')
  expect(system).not.toContain('exp-old-mark')
})

test('删除经验走应用内确认框：取消保留，确认后索引与正文一起删', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: seedEditable()
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('agent-exp-toggle').click()
  await page.getByTestId('agent-exp-delete').click()
  await expect(page.getByTestId('confirm-message')).toContainText('exp-old-mark')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await page.getByTestId('confirm-cancel').click()
  await expect(page.getByTestId('confirm-dialog')).toBeHidden()
  // 确认框不会顺手关掉经验浮层，条目原样还在
  await expect(page.getByTestId('agent-exp-item')).toHaveCount(1)
  expect(readExperienceIndex(launched.userDataDir)).toContain('exp-old-mark')

  await page.getByTestId('agent-exp-delete').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-exp-item')).toHaveCount(0)
  await expect.poll(() => readExperienceIndex(launched.userDataDir)).not.toContain('exp-old-mark')
  await expect.poll(() => readExperienceBody(launched.userDataDir, 'expedit1')).toBe('')
})

test('未保存关闭叠放确认框：Esc 只关确认框且焦点回编辑器，放弃后回家', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: seedEditable()
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('agent-exp-toggle').click()
  await page.getByTestId('agent-exp-summary').first().click()
  const detail = page.getByTestId('agent-extract-detail')
  await detail.fill('## 症状\n还没保存 exp-unsaved\n')

  // 编辑器里按 Esc：编辑器不关，确认框叠上来，危险确认默认落焦「继续编辑」
  await detail.press('Escape')
  await expect(page.getByTestId('confirm-message')).toHaveText('放弃未保存的修改？')
  await expect(page.getByTestId('confirm-cancel')).toHaveText('继续编辑')
  await expect(page.getByTestId('confirm-cancel')).toBeFocused()
  await expect(page.getByTestId('agent-extract-panel')).toBeVisible()

  // 再按 Esc 只关最上层；焦点回到编辑器里原来的输入框，而不是被送回终端
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('confirm-dialog')).toBeHidden()
  await expect(page.getByTestId('agent-extract-panel')).toBeVisible()
  await expect(detail).toBeFocused()
  await expect(detail).toHaveValue(/exp-unsaved/)

  // ✕ → 放弃：点得到确认框的按钮（压在编辑器之上），关闭后焦点回家，磁盘不变
  await page.getByTestId('agent-extract-close').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-extract-panel')).toBeHidden()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  expect(readExperienceBody(launched.userDataDir, 'expedit1')).toContain('exp-old-body')
})

test('编辑器是弹窗、退出让位链（v0.13.1 二次返工）：中栏忙时照开，查看器不让位', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()],
    seedFiles: seedEditable()
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 中栏先被 save_experience 的审批查看器占住（提案阻塞，assistant 消息不会 +1，
  // 故不能用 askAgent）
  await page.getByTestId('agent-input').fill('save-exp')
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.getByTestId('exp-viewer-toggle').click()
  await expect(page.getByTestId('exp-viewer')).toBeVisible()

  // 中栏那版在这里被 centerBusy 挡下、只给一句"中栏正忙"；弹窗不占中栏，照开
  await page.getByTestId('agent-exp-toggle').click()
  await page.getByTestId('agent-exp-summary').first().click()
  await expect(page.getByTestId('agent-extract-panel')).toHaveAttribute('data-mode', 'edit')
  // 中栏那份**不让位**："藏起来"那档语义连同它带来的防盲批漏洞（查看器没渲染
  // 却记成"已查看"，于是能批准从未显示过的内容）一起没了
  await expect(page.getByTestId('exp-viewer')).toBeVisible()

  // 关掉弹窗（没改内容，不问放弃），提案原样可决策
  await page.getByTestId('agent-extract-close').click()
  await expect(page.getByTestId('agent-extract-panel')).toBeHidden()
  await expect(page.getByTestId('exp-viewer')).toBeVisible()
  await submitApproval(page, 'n')
  await expect(page.getByTestId('approval-card')).toBeHidden()
})

test('TUI 不是让位链上一档（v0.13.1 二次返工）：查看器整体让位，退出后原样回来', async () => {
  const launched = await launchApp([makeHost(ssh.port, { id: 'exp-host' })], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('agent-input').fill('save-exp')
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.getByTestId('exp-viewer-toggle').click()
  await expect(page.getByTestId('exp-viewer')).toBeVisible()

  // 提案挂着时 Enter 仍归终端：起个全屏应用。此前 write/exp 两个查看器都不查 tui，
  // 于是 vim 起来了它们还挂着——而 TUI 态 composer 整体隐藏、y/n 根本打不了，
  // 那份批不动的查看器纯粹在挤终端高度
  await page.getByTestId('composer-input').click()
  await page.keyboard.type('tui')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toBeHidden()
  await expect(page.getByTestId('exp-viewer')).toBeHidden()

  // 藏起来不是真关掉：TUI 只是"整个中栏区暂时归全屏应用"，退出后提案与
  // 展开状态原样都在（同 composer 自己的隐藏/恢复）
  await page.keyboard.press('q')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('exp-viewer')).toBeVisible()
  await submitApproval(page, 'n')
})
