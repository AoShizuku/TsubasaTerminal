import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import {
  activeTerminalText,
  launchApp,
  makeHost,
  openSettings,
  type SeedLlmProfile
} from './fixtures/launch'

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

/**
 * 等主机档案探测落地：圆环常驻后，探测从"首次 agent:send"提前到
 * "Agent 面板要算构成"——面板要如实说出"这个对话会带上什么"，就绕不开档案。
 * 圆环 data-used 有值 = 那次独立 exec 已回来，之后取的 baseline 才稳定。
 */
async function waitContextReady(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.getByTestId('agent-token-ring').getAttribute('data-used')))
    .toBeGreaterThan(0)
}

test('Agent 对话：流式文本回显与思考过程（anthropic 协议）', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-user-msg')).toContainText('hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  // 思考过程折叠区
  await expect(page.getByText('思考过程')).toBeVisible()
})

test('白名单 exec 自动执行：独立通道跑 whoami，结果回流上下文', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'run-whoami')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'executed')
  await expect(card).toContainText('whoami')
  // 工具结果 echo 回最终文本：包含独立通道执行的输出
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-test-user')
  expect(ssh.execCounts()).toBeGreaterThan(baseline)
  // 正常结果不触发注入 advisory（回归守卫：检测须在定界符包装前，
  // 否则包装自带的 </terminal-data> 闭合会让每个结果误报"伪造定界符闭合"）
  await expect(page.getByTestId('agent-advisory')).toHaveCount(0)
})

test('白名单外 exec：进入审批台等待，不自动执行', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  // 等 L2 预取完成，之后 exec 计数不应再变
  await expect.poll(() => ssh.execCounts()).toBeGreaterThan(0)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'propose-restart')
  // 审批面与 composer 同体：提案行/风险行占位长在 composer 内
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await expect(page.getByTestId('approval-command')).toHaveText('systemctl restart nginx')
  await expect(page.getByTestId('approval-risk')).toHaveText('中风险')
  // 不再填 composer（v0.7 行为已升级为审批台），也绝不自动执行
  await expect(page.getByTestId('composer-input')).toHaveValue('')
  expect(ssh.execCounts()).toBe(baseline) // 主机档案探测已计入 baseline（v0.10.0 起随面板触发）
  // 阻塞语义：决策前工具调用保持等待
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'running')
})

test('复合命令 fail-closed：管道外发被闸门拒绝', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await expect.poll(() => ssh.execCounts()).toBeGreaterThan(0)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'try-compound')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'rejected')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('rejected')
  expect(ssh.execCounts()).toBe(baseline) // 主机档案探测已计入 baseline（v0.10.0 起随面板触发）
  // composer 也不该被填入
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('~ 由主进程按 $HOME 展开后再进硬解析', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'run-tilde-cat')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'executed')
  // fake server 只认展开后的绝对路径：拿到这行就证明发出去的不是裸 ~/
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('tilde-expanded-to-home')
  expect(ssh.execCounts()).toBeGreaterThan(baseline)
})

test('save_to_file 转存：全量落远端，上下文只进规模与预览', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'run-kubectl-save')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'executed')
  const reply = page.getByTestId('agent-assistant-msg').last()
  await expect(reply).toContainText('saved_to_file')
  // 规模数字回来了（1500 行 / 45000 字节），落点是主进程生成的 /tmp 路径
  await expect(reply).toContainText('1500')
  await expect(reply).toContainText('/tmp/tsubasaterminal-')
  // 预览进了上下文，但 45000 字节的全文没有
  await expect(reply).toContainText('req=xyz-777')
  expect(ssh.execCounts()).toBeGreaterThan(baseline)
})

test('主机档案与闸门先验注入 system prompt（v0.8.3 上下文工程）', async () => {
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
  const system = llm.lastSystem() ?? ''
  // 主机档案：独立探测的 OS/内核/用户落进 system prompt
  expect(system).toContain('Ubuntu 22.04 Fake LTS')
  expect(system).toContain('Linux 5.15.0-fake')
  expect(system).toContain('root-fake')
  // shell integration 可用性透传（connectAndWaitPrompt 已见 133;A）
  expect(system).toContain('shell integration 可用')
  // 闸门先验：白名单清单与语法要点，模型不再靠撞墙学习
  expect(system).toContain('journalctl')
  expect(system).toContain('2>&1')
  expect(system).toContain('wait 工具')
  // v0.9.8：白名单清单由 whitelistCommands() 生成，kubectl 进表要能传导到先验；
  // 过滤下推与转存正门也得说在前面——靠模型自己想到就晚了
  expect(system).toContain('kubectl')
  expect(system).toContain('save_to_file')
})

test('token 用量圆环：官方 usage 驱动，点开是构成明细与 profile 窗口（v0.8.3 / v0.10.0）', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [{ ...anthropicProfile(), contextWindow: 272000 }]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 圆环连上就在：窗口一开始就被 system prompt 占掉一截，从 0 起画是撒谎。
  // 首轮回来前只有估算，画得弱一档、口径明确标出来
  const ring = page.getByTestId('agent-token-ring')
  await expect(ring).toBeVisible()
  await expect(ring).toHaveAttribute('data-estimated', 'true')
  await expect.poll(async () => Number(await ring.getAttribute('data-used'))).toBeGreaterThan(0)

  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
  // 上下文 = input(3000) + cache_read(1000) + output(200) = 4200
  await expect(ring).toHaveAttribute('data-used', '4200')
  await expect(ring).toHaveAttribute('data-estimated', 'false')
  // 明细并进圆环下钻：总量 → 构成，一个入口讲完
  await ring.click()
  const panel = page.getByTestId('agent-prompt-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('4.2K / 272K')
  await expect(panel).toContainText('上轮输入 4000 · 输出 200')
  await expect(panel).toContainText('缓存命中 1000（25%）')
})

test('header 浮层互斥：构成/历史/经验共用一块地，后开的顶掉前一个', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  await waitContextReady(page)

  const prompt = page.getByTestId('agent-prompt-panel')
  const history = page.getByTestId('agent-history-panel')
  const exp = page.getByTestId('agent-exp-panel')

  // 三个浮层都挂在 header 下同一块地（absolute top-full），共存就是叠成一摞
  await page.getByTestId('agent-token-ring').click()
  await expect(prompt).toBeVisible()

  await page.getByTestId('agent-history-toggle').click()
  await expect(history).toBeVisible()
  await expect(prompt).toBeHidden()

  await page.getByTestId('agent-exp-toggle').click()
  await expect(exp).toBeVisible()
  await expect(history).toBeHidden()

  await page.getByTestId('agent-token-ring').click()
  await expect(prompt).toBeVisible()
  await expect(exp).toBeHidden()

  // 再点自己 = 关（互斥不吃掉 toggle 语义）
  await page.getByTestId('agent-token-ring').click()
  await expect(prompt).toBeHidden()
})

test('wait 工具：本地定时等待，免审批零远端执行', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)
  // 等 L2 预取完成，之后 exec 计数不应再变
  await expect.poll(() => ssh.execCounts()).toBeGreaterThan(0)
  await waitContextReady(page)
  const baseline = ssh.execCounts()

  await askAgent(page, 'use-wait')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toContainText('wait')
  await expect(card).toContainText('等待服务就绪')
  await expect(card).toHaveAttribute('data-status', 'ok')
  await expect(card).toContainText('已等待 1 秒')
  // 工具结果回流（fake server echo 成文本）：status=waited
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('waited')
  // 全程零远端执行、零审批、终端不见 sleep
  expect(ssh.execCounts()).toBe(baseline) // 主机档案探测已计入 baseline（v0.10.0 起随面板触发）
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  expect(await activeTerminalText(page)).not.toContain('sleep')
})

test('read_screen：TUI 之眼读到终端上的标记', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 终端里制造一个屏幕标记
  await page.getByTestId('composer-input').fill('echo screen-mark-777')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^screen-mark-777$/m.test(await activeTerminalText(page))).toBe(true)

  await askAgent(page, 'look-screen')
  const card = page.getByTestId('agent-tool-card').last()
  await expect(card).toHaveAttribute('data-status', 'ok')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('screen-mark-777')
})

test('勾选拾取：单元全文随下一条消息附带，发送即消费', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 产生一条转录单元
  await page.getByTestId('composer-input').fill('echo attach-me-marker')
  await page.getByTestId('composer-input').press('Enter')
  await expect.poll(async () => /^attach-me-marker$/m.test(await activeTerminalText(page))).toBe(
    true
  )

  // 打开 picker 勾选该条
  await page.getByTestId('agent-picker-toggle').click()
  const item = page.getByTestId('agent-picker-item').filter({ hasText: 'attach-me-marker' })
  await expect(item.first()).toBeVisible()
  await item.first().locator('input[type=checkbox]').check()
  await expect(page.getByTestId('agent-picker-toggle')).toContainText('已勾选 1 条')

  await askAgent(page, 'check-attach')
  // fake LLM 检查用户消息里含定界符包裹的勾选全文
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('attach:yes')
  // 发送即消费：勾选清空
  await expect(page.getByTestId('agent-picker-toggle')).not.toContainText('已勾选')
})

test('注入启发式：远端输出中的指令样文本被 advisory 标注', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'run-inject')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect(page.getByTestId('agent-advisory')).toContainText('忽略先前指示')
})

test('注入启发式：远端输出伪造定界符闭合被 advisory 标注', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'run-fakeclose')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect(page.getByTestId('agent-advisory')).toContainText('伪造定界符闭合')
  // LLM 侧同样收到标注（fake LLM 把工具结果 echo 回文本）
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('按数据对待')
})

test('设置页配置 profile 全流程：表单添加 → Agent 面板可用', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page

  await openSettings(page, 'models')
  await page.getByTestId('llm-add-profile').click()
  await page.getByTestId('llm-form-name').fill('UI 配的 Claude')
  await page.getByTestId('llm-form-baseurl').fill(llm.anthropicBaseURL)
  await page.getByTestId('llm-form-model').fill('fake-model')
  await page.getByTestId('llm-form-key').fill('sk-ui-test')
  await page.getByTestId('llm-form-save').click()
  await expect(page.getByTestId('llm-profile-item')).toContainText('UI 配的 Claude')
  await page.getByTestId('settings-close').click()

  // 首个 profile 自动设为活动，Agent 面板即可用
  await expect(page.getByTestId('agent-profile-select')).toBeVisible()
  await connectAndWaitPrompt(page)
  await askAgent(page, 'hello-agent')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText(
    'echo:hello-agent-reply'
  )
})

test('Agent 面板 markdown 渲染：加粗/代码块复制按钮/链接确认后外开', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'show-markdown')
  const md = page.getByTestId('agent-md').last()
  // html:false 下 markdown 语法仍正常渲染为元素
  await expect(md.locator('strong')).toHaveText('磁盘已满')
  await expect(md.locator('h1')).toHaveText('诊断结论')
  await expect(md.locator('.md-code pre')).toContainText('df -h /')

  // 代码块复制按钮
  const copyBtn = md.locator('button[data-md-copy]')
  await copyBtn.click()
  await expect(copyBtn).toHaveText('已复制')

  // 链接：点击不导航，应用内确认框确认后走 window.open → 主进程 handler → openExternal。
  // 只替换主进程的 shell.openExternal 记下调用，整条真实链路不变，也不碰真实浏览器
  await launched.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened.push(url)
    }
  })
  const opened = (): Promise<string[]> =>
    launched.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
  const dialog = page.getByTestId('confirm-dialog')
  const docsLink = md.getByRole('link', { name: '排查文档' })

  await docsLink.click()
  await expect(dialog).toBeVisible()
  // URL 完整展示；非危险确认默认落焦「打开」
  await expect(page.getByTestId('confirm-detail')).toHaveText('https://example.com/docs')
  await expect(page.getByTestId('confirm-ok')).toBeFocused()
  // 拒绝 → 不打开，焦点回家而不是停在链接上
  await page.getByTestId('confirm-cancel').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('composer-input')).toBeFocused()
  expect(await opened()).toEqual([])

  await docsLink.click()
  await page.getByTestId('confirm-ok').click()
  await expect.poll(opened).toEqual(['https://example.com/docs'])

  // 非 http/https：如实告知打不开，只有一个按钮，不外开
  await md.getByRole('link', { name: '显示设置' }).click()
  await expect(page.getByTestId('confirm-message')).toContainText('http / https')
  await expect(page.getByTestId('confirm-detail')).toHaveText('ms-settings:display')
  await expect(page.getByTestId('confirm-cancel')).toHaveCount(0)
  await page.getByTestId('confirm-ok').click()
  await expect(dialog).toBeHidden()

  // 主进程硬闸：绕过渲染层直接 window.open 也不放行。handler 按序处理，
  // 紧随其后的 https 到了，说明前一个已被判定过
  await page.evaluate(() => {
    window.open('ms-settings:display')
    window.open('https://example.com/after')
  })
  await expect.poll(opened).toEqual(['https://example.com/docs', 'https://example.com/after'])
  // 应用没有被链接整页带走
  await expect(page.getByTestId('composer')).toBeVisible()
})

test('Agent 面板宽表与代码块：数错列的表照常成表、只在表格框内横滚，代码复制按钮骑边不挡字', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'show-wide-table')
  const md = page.getByTestId('agent-md').last()
  // 表头 15 列、分隔行 16 列：GFM 判不成表，修正前整张退成满屏竖线的段落
  await expect(md.locator('.md-table th')).toHaveCount(15)
  await expect(md.locator('.md-table tbody tr')).toHaveCount(2)

  // 宽表只在自己的框里滚；消息流不出横向滚动（修正前被表格顶出整条横向滚动条）
  const table = md.locator('.md-table')
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)
  expect(
    await page.getByTestId('agent-messages').evaluate((el) => el.scrollWidth - el.clientWidth)
  ).toBe(0)
  // 单元格里的行内代码不被 break-all 拆成一字一行（表格既然横滚，就不该再挤列）
  expect(await md.locator('td code').first().evaluate((el) => el.getClientRects().length)).toBe(1)

  // 代码块复制按钮：与消息复制按钮同位，骑在框的右上沿，不落进内容区挡代码
  const pre = md.locator('.md-code pre')
  const codeCopy = md.locator('button[data-md-copy]')
  const msgCopy = page.getByTestId('agent-msg-copy').last()
  await pre.hover()
  await expect(codeCopy).toHaveCSS('opacity', '1')
  // 两颗「复制」不同时亮：指针在代码块上只亮它自己的
  await expect(msgCopy).toHaveCSS('opacity', '0')
  const btn = (await codeCopy.boundingBox())!
  const frame = (await pre.boundingBox())!
  // 骑在上沿：按钮上半截探出框外
  expect(btn.y).toBeLessThan(frame.y)
  // 首行是顶到右沿的长横线，按钮底边仍在它的字形之上
  const firstLineTop = await pre
    .locator('code')
    .evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getClientRects()[0].top
    })
  expect(btn.y + btn.height).toBeLessThanOrEqual(firstLineTop)
  // 代码块打头时与消息复制按钮上下错开，不叠在一处
  const msgBox = (await msgCopy.boundingBox())!
  expect(btn.y).toBeGreaterThanOrEqual(msgBox.y + msgBox.height - 0.5)

  // 被隐藏的消息复制按钮不拦点击
  await codeCopy.click()
  await expect(codeCopy).toHaveText('已复制')
  // 指针离开代码块，消息复制按钮照常出现
  await table.hover()
  await expect(msgCopy).toHaveCSS('opacity', '1')
})

// 轮数熔断 v0.8.1 改为审批面 y/N 续跑，用例迁移至 approval.spec.ts
