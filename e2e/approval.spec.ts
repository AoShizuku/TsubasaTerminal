import { readFileSync } from 'fs'
import { join } from 'path'
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
 * v0.8.1 审批台（与 composer 同体 + 阻塞语义）：
 * 提案行长在 composer 内（占位不覆盖终端），Enter 归终端、Ctrl+Enter 归审批；
 * 批准的 exec 阻塞等到执行结果直接回流工具结果；write_file 走只读查看器 + SFTP；
 * 轮数熔断复用同一决策面（y 零注入续跑 / N 走工具结果暂停）。
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

/** 审批提交：composer 输入 + Ctrl+Enter（决策面即 composer 本体） */
async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
}

function readAudit(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'audit.jsonl'), 'utf-8')
  } catch {
    return ''
  }
}

/** 读活动会话结构化转录的命令列表（断言单元命令文本没被 stdin 应答行顶掉） */
async function transcriptCommands(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const w = window as unknown as {
      __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
      api: { transcript: { get: (id: string) => Promise<Array<{ command: string }>> } }
    }
    const sessionId = w.__tsubasaterminal.getSessions()[0]?.id
    if (!sessionId) return []
    return (await w.api.transcript.get(sessionId)).map((u) => u.command)
  })
}

test('批准：y + Ctrl+Enter，命令写入终端且执行结果直接回流工具结果', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-command')).toHaveText('systemctl restart nginx')
  await expect(page.getByTestId('approval-risk')).toHaveText('中风险')
  // 提案产生即审计
  await expect.poll(() => readAudit(launched.userDataDir)).toContain('"kind":"proposal"')

  await submitApproval(page, 'y')
  // 主进程写入用户可见终端执行
  await expect.poll(() => activeTerminalText(page)).toContain('systemctl restart nginx')
  // 阻塞语义的核心：执行结果（退出码+输出）直接随工具结果回流，
  // 不需要 Agent 再用 list_transcript 捞——fake LLM 把工具结果 echo 成文本
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('approved')
  await expect(reply).toContainText('"exitCode":127')
  await expect(reply).toContainText('command not found')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'approved'
  )
  // 提案消费完毕，composer 回到普通 compose 态
  await expect(page.getByTestId('approval-card')).toHaveCount(0)

  const audit = (): string => readAudit(launched.userDataDir)
  await expect.poll(audit).toContain('"decision":"approved"')
  await expect.poll(audit).toContain('"kind":"result"')
  const resultLine = audit()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.kind === 'result')
  expect(resultLine.command).toBe('systemctl restart nginx')
  expect(resultLine.exitCode).toBe(127)
  expect(resultLine.host).toBe(`test@127.0.0.1:${ssh.port}`)
})

test('Enter 归终端：提案挂着时正常命令照发，空输入 Ctrl+Enter 无操作，n 拒绝', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  // 两个决策按钮同一字号（v0.14.2 首轮验收：执行按钮的 text-meta 经 cn() 与颜色类
  // 合并时被吞，退回继承的 13px，比拒绝按钮大一号）
  await expect(page.getByTestId('approval-approve')).toHaveCSS('font-size', '11px')
  await expect(page.getByTestId('approval-deny')).toHaveCSS('font-size', '11px')

  // 提案不阻塞会话：Enter 的肌肉记忆语义不变
  await page.getByTestId('composer-input').fill('echo still-works')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^still-works$/m.test(await activeTerminalText(page))).toBe(true)
  await expect(page.getByTestId('approval-card')).toBeVisible()

  // 安全默认双向显式：空输入 Ctrl+Enter 不做任何事
  await page.getByTestId('composer-input').press('Control+Enter')
  await expect(page.getByTestId('approval-error')).toContainText('空输入不做操作')
  await expect(page.getByTestId('approval-card')).toBeVisible()

  await submitApproval(page, 'n')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'denied')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('denied')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  expect(await activeTerminalText(page)).not.toContain('systemctl restart nginx')
  await expect.poll(() => readAudit(launched.userDataDir)).toContain('"decision":"denied"')
})

test('comment 回流：留言拒绝直接成为工具结果，Agent 收到修订依据', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(page, '先备份配置再执行')

  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'denied')
  await expect(card).toContainText('先备份配置再执行')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('先备份配置再执行')
  expect(await activeTerminalText(page)).not.toContain('systemctl restart nginx')
  await expect.poll(() => readAudit(launched.userDataDir)).toContain('先备份配置再执行')
})

test('高危加重交互：y 无效，须输入命令首词确认', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-highrisk')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'high')
  await expect(page.getByTestId('approval-risk')).toHaveText('高风险')

  // y 不生效——防肌肉记忆
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toContainText('rm')
  await expect(card).toBeVisible()
  expect(await activeTerminalText(page)).not.toContain('rm -rf /data/cache')

  // 输入真动词才放行
  await submitApproval(page, 'rm')
  await expect.poll(() => activeTerminalText(page)).toContain('rm -rf /data/cache')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'approved'
  )
  await expect.poll(() => readAudit(launched.userDataDir)).toContain('"decision":"approved"')
})

test('write_file：查看器占位审阅 + 防盲批拦截 + SFTP 落盘 + 审计', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-write')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-kind', 'write_file')
  await expect(page.getByTestId('approval-command')).toContainText('write_file /home/test/notes.txt')
  await expect(page.getByTestId('approval-command')).toContainText('新建')
  await expect(page.getByTestId('write-viewer-toggle')).toContainText('notes.txt 文件写入待审批')
  // 工具卡摘要只报路径与规模：content 是整个文件，塞进卡片会连带字面 \n 又被拦腰截断
  const writeCard = page.getByTestId('agent-tool-card').last()
  await expect(writeCard).toContainText('/home/test/notes.txt（29 字节） — 记录巡检笔记')
  await expect(writeCard).not.toContainText('hello-from-agent')
  // 到达时收起：不重排用户正在看的终端
  await expect(page.getByTestId('write-viewer')).toHaveCount(0)

  // 防盲批：没看过内容不能批
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toContainText('先查看写入内容')
  expect(ssh.writtenFiles()['/home/test/notes.txt']).toBeUndefined()

  // 展开只读查看器：行号 + 全文；占位不覆盖终端（几何断言）；
  // 焦点回程：展开即回家，看完直接 y+Ctrl+Enter 零多余点击
  await page.getByTestId('write-viewer-toggle').click()
  const viewer = page.getByTestId('write-viewer')
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByTestId('write-viewer-content')).toContainText('hello-from-agent')
  await expect(page.getByTestId('write-viewer-content')).toContainText('second-line')
  expect((await page.getByTestId('write-viewer-gutter').innerText()).split('\n')).toContain('3')
  // 占位不覆盖：终端 refit 让位后，xterm 网格底边不越过查看器顶边
  await expect
    .poll(async () => {
      const viewerBox = await viewer.boundingBox()
      const termBox = await page.locator('.xterm').first().boundingBox()
      if (!viewerBox || !termBox) return false
      return termBox.y + termBox.height <= viewerBox.y + 1
    })
    .toBe(true)

  // X 收起 → 焦点回家；Esc 也能收起（先再展开一次验证）
  await page.getByTestId('write-viewer-close').click()
  await expect(viewer).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.getByTestId('write-viewer-toggle').click()
  await expect(viewer).toBeVisible()
  await page.getByTestId('composer-input').press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toBeFocused()

  // 已看过即可批（viewed 不因收起而失效），批准不要求查看器开着
  await submitApproval(page, 'y')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'approved'
  )
  // SFTP 真正落盘的是主进程自存的原始内容
  await expect
    .poll(() => ssh.writtenFiles()['/home/test/notes.txt'])
    .toBe('hello-from-agent\nsecond-line\n')
  // 工具结果回流 approved_and_written（v0.8.3：status 带足"已审批"语义）+ previous（新建）
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('approved_and_written')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('"existed":false')
  await expect(page.getByTestId('write-viewer')).toHaveCount(0)
  const audit = readAudit(launched.userDataDir)
  expect(audit).toContain('write_file /home/test/notes.txt')
  expect(audit).toContain('"bytes":29')
})

test('中栏只读位独占：write_file 与 TUI 都把上下文查看器顶掉', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 先摊开一段 system prompt 原文占住中栏只读位
  const empty = page.getByTestId('agent-empty-context')
  await empty.locator('[data-key="builtin"]').click()
  await expect(page.getByTestId('context-viewer')).toBeVisible()

  // TUI 要整屏：藏起来，退出后原样回来（v0.13.1 二次返工改）。它不是让位链上
  // 一档而是"整个中栏区暂时归全屏应用"——composer 也是同样地整体隐藏后恢复
  await page.getByTestId('composer-input').click()
  await page.keyboard.type('tui')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toBeHidden()
  await expect(page.getByTestId('context-viewer')).toBeHidden()
  await page.keyboard.press('q')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(page.getByTestId('context-viewer')).toBeVisible()

  // 待审批的 write_file 要逐行审阅：**这才是真关掉**（退出审批后不自己冒回来），
  // 且审批期间连打开都不打开
  await askAgent(page, 'propose-write')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('context-viewer')).toBeHidden()
  await page.getByTestId('agent-token-ring').click()
  await page.getByTestId('agent-prompt-panel').locator('[data-key="builtin"]').click()
  await expect(page.getByTestId('context-viewer')).toBeHidden()
})

test('write_file 高危：系统路径须输入文件名确认', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-write-etc')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'high')

  await page.getByTestId('write-viewer-toggle').click()
  await expect(page.getByTestId('write-viewer-content')).toContainText('net.ipv4.ip_forward')

  // y 无效，确认词 = 目标文件名
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toContainText('99-k8s.conf')
  await submitApproval(page, '99-k8s.conf')
  await expect
    .poll(() => ssh.writtenFiles()['/etc/sysctl.d/99-k8s.conf'])
    .toBe('net.ipv4.ip_forward = 1\n')
})

test('write_file 非规范化路径：/../ 闸门直接拒绝，不进审批台', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'try-write-traversal')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'rejected')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('规范化')
  // 闸门层拒绝：审批卡片从未出现，SFTP 什么都没写
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  expect(ssh.writtenFiles()['/tmp/../etc/cron.d/backdoor']).toBeUndefined()
  expect(ssh.writtenFiles()['/etc/cron.d/backdoor']).toBeUndefined()
})

test('批准 exec 运行中应答 stdin：composer 进入运行态，命令文本不被顶掉，结果照常回流', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'propose-ask')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-command')).toHaveText('ask')
  await submitApproval(page, 'y')

  // 批准的 exec 由主进程写 pty：composer 应同步进入运行态——v0.8.5 的坑正是
  // 执行期间仍停在 prompt 态"就绪"，用户把 stdin 应答敲进了 composer 顶掉命令文本
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  await expect(page.getByTestId('composer-input')).toBeDisabled()
  await expect.poll(() => activeTerminalText(page)).toContain('input?')

  // 真实场景：apt/dpkg 交互提示，用户键入 N 回车应答 stdin（运行态按键直达终端）
  await page.keyboard.type('N')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('answer: N')

  // v0.8.5 真机踩坑回归：stdin 行曾顶掉 pendingCommand，waitForUnit 匹配落空卡满
  // 15 分钟等待窗口——现在执行结果（退出码+输出）照常回流工具结果
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('approved')
  await expect(reply).toContainText('"exitCode":0')
  await expect(reply).toContainText('answer: N')
  // 转录单元的命令文本是命令真身，不是 stdin 应答行
  await expect.poll(() => transcriptCommands(page)).toContain('ask')
  expect(await transcriptCommands(page)).not.toContain('N')
})

test('停止后继续对话：中止路径补齐 tool_result，下一条消息不被 API 打回', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 提案挂起（assistant 的 tool_use 已入对话历史）时直接停止
  await askAgent(page, 'propose-restart')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.getByTestId('agent-stop').click()
  await expect(page.getByTestId('agent-notice').last()).toContainText('已停止')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)

  // v0.8.5 真机踩坑回归：中止曾留下悬空 tool_use，下一次请求被 400 打回
  // （fake server 已复刻真实 API 的配对校验）——现在补了占位 tool_result，对话可续
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  const notices = await page.getByTestId('agent-notice').allInnerTexts()
  expect(notices.some((t) => t.includes('出错'))).toBe(false)
})

test('轮数熔断续跑：15 轮后同一决策面问 y/N，y 零注入续跑、N 走工具结果暂停', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'loop-forever')
  // 第 15 轮工具执行完、第 16 批调用到达前：续跑确认出现
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card).toHaveAttribute('data-kind', 'continue')
  await expect(page.getByTestId('approval-command')).toContainText('15 轮')
  expect(await page.getByTestId('agent-tool-card').count()).toBe(15)

  // y 续跑：LLM 上下文零注入，工具卡继续增长
  await page.getByTestId('approval-approve').click()
  await expect.poll(() => page.getByTestId('agent-tool-card').count(), { timeout: 30000 }).toBe(30)

  // 30 轮再问，N 暂停：这批未执行的调用回"用户显式暂停"
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('approval-command')).toContainText('30 轮')
  await page.getByTestId('approval-deny').click()
  await expect(page.getByTestId('agent-notice').last()).toContainText('暂停')
  expect(await page.getByTestId('agent-tool-card').count()).toBe(30)
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
})

test('background：主进程代拼 nohup + 日志重定向，展示的即执行的', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'run-bg-service')
  await expect(page.getByTestId('approval-card')).toBeVisible()
  // 用户批准的文本 = 写进 pty 的文本：& 与重定向由主进程拼，LLM 手里没有这些字符；
  // </dev/null 不能省——后台进程读 stdin 会收 SIGTTIN 停住
  const shown = (await page.getByTestId('approval-command').textContent())?.trim()
  expect(shown).toMatch(
    /^nohup python3 server\.py <\/dev\/null >\/tmp\/tsubasaterminal-[0-9a-f]{8}-1\.log 2>&1 &$/
  )

  await submitApproval(page, 'y')
  await expect.poll(() => activeTerminalText(page)).toContain('nohup python3 server.py')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('logPath')
  await expect(reply).toContainText('/tmp/tsubasaterminal-')
  // 退出码语义的免责说明：不点破的话 LLM 会把 exit 0 读成"服务已正常启动"
  await expect(reply).toContainText('提交成功')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
})

test('background 不给快车道：白名单只读命令也强制过审批台', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  // 主机档案探测（v0.10.0 起随 Agent 面板触发）先落地，baseline 才稳定
  await expect
    .poll(async () => Number(await page.getByTestId('agent-token-ring').getAttribute('data-used')))
    .toBeGreaterThan(0)
  const baseline = ssh.execCounts()

  await askAgent(page, 'run-bg-readonly')
  // whoami 本可独立通道自动执行；后台化把输出从用户眼前拿走，"用户可见"这个
  // 监督兜底失效 → auto 与信任免问两条快车道都不给
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-command')).toContainText('nohup whoami </dev/null')
  expect(ssh.execCounts()).toBe(baseline) // whoami 没走独立通道（探测已计入 baseline）
})
