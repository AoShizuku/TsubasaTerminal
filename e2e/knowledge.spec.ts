import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import {
  activeTerminalText,
  hostFormTab,
  launchApp,
  makeHost,
  openSettings,
  readHostsFile,
  readSettingsFile,
  type SeedLlmProfile
} from './fixtures/launch'

/**
 * 主机知识 + system prompt 分段可视（knowledge-design 第三/五节）。
 * 要点有三：知识落在闸门规则之后、探测档案之前；它是**指令通道**故不包定界符；
 * 改动只在下一个对话生效（在 cache 最前缀，中途换等于后续每轮全 miss）。
 */

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

const HOST_MARK = '本机专属：日志在 /data/logs-knowledge-mark'
const GLOBAL_MARK = '全公司通用：支付网关就是 pay-gw-global-mark'

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

/**
 * 多轮用例必须等**这一轮**的回复落地：只断言"最后一条含固定回复"会被上一轮的
 * 同款文本骗过，随后读到的 lastSystem 还是上一轮的（并行跑时必现）。
 */
async function askAgent(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('agent-assistant-msg').count()
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('agent-assistant-msg')).toHaveCount(before + 1)
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('echo:hello-agent-reply')
}

test('人写知识进 system prompt：闸门规则之后、探测档案之前，且不包定界符', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port, { knowledge: HOST_MARK })], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { globalKnowledge: GLOBAL_MARK }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  const system = llm.lastSystem() ?? ''
  expect(system).toContain(HOST_MARK)
  expect(system).toContain(GLOBAL_MARK)

  // 分节顺序（knowledge-design 第五节，按改动频率排）：
  // 闸门规则（代码）→ 全局知识 → 本机知识（人写）→ 主机档案（探测）
  const gate = system.indexOf('exec 闸门规则')
  const global = system.indexOf(GLOBAL_MARK)
  const host = system.indexOf(HOST_MARK)
  const probe = system.indexOf('## 主机档案')
  expect(gate).toBeGreaterThan(-1)
  expect(global).toBeGreaterThan(gate)
  expect(host).toBeGreaterThan(global)
  expect(probe).toBeGreaterThan(host)

  // 来源必须分节标注：将来出错要能分清是探测过期还是人写错了
  expect(system).toContain('## 全局知识（来源：用户手写')
  expect(system).toContain('## 本机知识（来源：用户手写')
  expect(system).toContain('## 主机档案（来源：主机配置 + 连接时自动探测')
  // 探测值仍在（分节重构没把 v0.8.3 的主机档案弄丢）
  expect(system).toContain('Ubuntu 22.04 Fake LTS')

  // 知识是指令通道，不包 <terminal-data>——包成数据反而语义错乱
  expect(system).not.toContain('</terminal-data>')
})

test('知识改动下一个对话才生效：当前对话的 system 快照不动', async () => {
  const launched = await launchApp([makeHost(ssh.port, { knowledge: HOST_MARK })], undefined, {
    llmProfiles: [anthropicProfile('prof-a', '模型甲'), anthropicProfile('prof-b', '模型乙')]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await askAgent(page, 'hello-agent')
  expect(llm.lastSystem() ?? '').toContain(HOST_MARK)

  // 对话进行中改全局知识
  await openSettings(page, 'knowledge')
  await page.getByTestId('settings-global-knowledge').fill(GLOBAL_MARK)
  await page.getByTestId('settings-close').click()
  await expect.poll(() => readSettingsFile(launched.userDataDir)).toContain(GLOBAL_MARK)

  // 同一个对话再问：system 是开始时的快照，新知识不该混进来
  await askAgent(page, 'hello-agent')
  expect(llm.lastSystem() ?? '').not.toContain(GLOBAL_MARK)

  // 切 profile = 开新对话（v0.13.14 起须确认）：这一刻才带上新知识
  await page.getByTestId('agent-profile-select').selectOption('prof-b')
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('agent-profile-select')).toHaveValue('prof-b')
  await askAgent(page, 'hello-agent')
  expect(llm.lastSystem() ?? '').toContain(GLOBAL_MARK)
  expect(llm.lastSystem() ?? '').toContain(HOST_MARK)
})

test('上下文构成：空态直接铺开，四行三来源，原文去中栏查看器', async () => {
  const launched = await launchApp([makeHost(ssh.port, { knowledge: HOST_MARK })], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { globalKnowledge: GLOBAL_MARK }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 尚无对话：空态那块地放的是"下一个对话会带上什么"，不用先发现圆环可以点
  const empty = page.getByTestId('agent-empty-context')
  await expect(empty).toBeVisible()
  await expect(empty.getByTestId('context-breakdown-live')).toContainText('下一个对话')
  await expect(empty.getByTestId('context-breakdown-total')).toContainText('约')

  // 五行：代码两节合并成一行（用户既改不了也不区分），人写两节分开（作用域与编辑落点不同），
  // 排障经验索引独立一行（v0.10.3——本次注入了哪些经验必须一眼可见）
  const rows = empty.getByTestId('context-row')
  await expect(rows).toHaveCount(5)
  await expect(empty.locator('[data-key="builtin"][data-source="code"]')).toHaveCount(1)
  await expect(empty.locator('[data-key="global-knowledge"][data-source="human"]')).toHaveCount(1)
  await expect(empty.locator('[data-key="host-knowledge"][data-source="human"]')).toHaveCount(1)
  await expect(empty.locator('[data-key="host-profile"][data-source="probe"]')).toHaveCount(1)
  await expect(empty.locator('[data-key="experience-index"][data-source="human"]')).toHaveCount(1)

  // 原文归中栏只读查看器——弹层里套原文块就是两条滚动条并排
  await empty.locator('[data-key="host-knowledge"]').click()
  const viewer = page.getByTestId('context-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.getByTestId('context-viewer-content')).toContainText(HOST_MARK)
  await page.getByTestId('context-viewer-close').click()
  await expect(viewer).toBeHidden()

  // 有对话后：空态让位给消息流，构成改从圆环下钻，口径变成"这个对话带着"
  await askAgent(page, 'hello-agent')
  await expect(empty).toBeHidden()
  await page.getByTestId('agent-token-ring').click()
  const panel = page.getByTestId('agent-prompt-panel')
  await expect(panel.getByTestId('context-breakdown-live')).toContainText('这个对话')
  await expect(panel.getByTestId('context-row')).toHaveCount(5)
})

test('空的人写节：弱化成待办并直达编辑，改完提示待生效', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // 没写过知识的两节标"未填写"——它们是用户唯一能动的，不该和满节一样重
  const empty = page.getByTestId('agent-empty-context')
  await expect(empty.locator('[data-key="global-knowledge"]')).toContainText('未填写')
  await expect(empty.locator('[data-key="host-knowledge"]')).toContainText('未填写')

  // 点空的全局知识行 = 直达设置里那个框（不定位就得自己在设置里找）
  await empty.locator('[data-key="global-knowledge"]').click()
  const box = page.getByTestId('settings-global-knowledge')
  await expect(box).toBeVisible()
  await expect(box).toBeFocused()
  await box.fill(GLOBAL_MARK)
  await page.getByTestId('settings-close').click()
  // 关掉设置就重取一次：写完的知识立刻反映在构成里
  await expect(empty.locator('[data-key="global-knowledge"]')).not.toContainText('未填写')

  // 对话开始后再改知识，才提示"下一个对话才生效"——常驻着就只是每次都要略过的一段字
  await askAgent(page, 'hello-agent')
  await page.getByTestId('agent-token-ring').click()
  await expect(page.getByTestId('agent-prompt-panel')).toBeVisible()
  await expect(page.getByTestId('context-pending-knowledge')).toBeHidden()
  // 面板开着不动，改完知识关掉设置即重取——提示这时才该出现
  await openSettings(page, 'knowledge')
  await page.getByTestId('settings-global-knowledge').fill(`${GLOBAL_MARK} 改过了`)
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('context-pending-knowledge')).toBeVisible()
})

test('主机表单写本机知识：落盘 + 信息面板可见', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').click()
  await expect(page.getByTestId('info-knowledge')).toContainText('未写')
  await page.getByTestId('info-edit').click()
  await hostFormTab(page, 'knowledge')
  await page.getByTestId('form-knowledge').fill(HOST_MARK)
  await expect(page.getByTestId('form-knowledge-count')).toContainText(`${HOST_MARK.length}/4000`)
  await page.getByTestId('form-save').click()

  await expect.poll(() => readHostsFile(launched.userDataDir)).toContain('logs-knowledge-mark')
  await expect(page.getByTestId('info-knowledge')).toContainText(`已写 ${HOST_MARK.length} 字`)

  // 重启后仍在（人写的东西丢一次就再也不会有人写第二次）
  await app.close()
  const relaunched = await launchApp([], launched.userDataDir)
  app = relaunched.app
  await relaunched.page.getByTestId('host-item').click()
  await expect(relaunched.page.getByTestId('info-knowledge')).toContainText('已写')
})

test('L3 建议顺带吃知识', async () => {
  const launched = await launchApp([makeHost(ssh.port, { knowledge: HOST_MARK })], undefined, {
    llmProfiles: [anthropicProfile()],
    settings: { completionLlmEnabled: true, globalKnowledge: GLOBAL_MARK }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.getByTestId('composer-input').fill('echo suggest-probe')
  await page.getByTestId('composer-input').press('Enter')
  await expect(page.getByTestId('ghost-text')).toHaveText('echo predicted-next')
  // 判官式最小上下文里也带上了人写约定（截头部控成本，标记在最前所以必在）
  const system = llm.lastSystem() ?? ''
  expect(system).toContain(HOST_MARK)
  expect(system).toContain(GLOBAL_MARK)
})
