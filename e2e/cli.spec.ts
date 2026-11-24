import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { powershellHosts, psQuote, runPowerShell } from './fixtures/powershell'
import {
  activeTerminalText,
  launchApp,
  makeHost,
  openSettings,
  type SeedLlmProfile,
  type TestHost
} from './fixtures/launch'

/**
 * CLI 通道（cli-bridge-design）：只读基座、审批路径与右栏 CLI 栏。
 *
 * 回归点：`executeTool` 是内置 Agent 与 CLI 的**共同**下游（闸门/审批/脱敏/审计一份）、
 * 句柄寻址与粘性隔离、建联包是 collectPromptInputs 的第二渲染器、退出码互不相同、
 * 审批路径（批准回流真实退出码 / 拒绝带留言 102 / 超时主动撤回 125 / --async+job）、
 * pty 路口互斥 105、CLI 栏逐条留卡，以及安装面的"手工改过不静默覆盖"。
 */

// 保持文件内串行：这里每条除 Electron 外还会频繁拉 CLI Node 子进程；v0.13.7 实测
// 单文件并行虽让本文件变快，却因进程争用让 daily 与 full 的整套墙钟时间都变慢。

let ssh: FakeSshServer
let llm: FakeLlmServer
let app: ElectronApplication | undefined

const CLI_SCRIPT = resolve(__dirname, '..', 'out', 'cli', 'tsubasa-ssh.js')

const HOST_KNOWLEDGE = '本机专属：日志在 /data/logs-cli-mark'
const GLOBAL_KNOWLEDGE = '全公司通用：支付网关就是 pay-gw-cli-mark'
const EXP_SUMMARY = '磁盘满 → core dump 堆积 cli-exp-mark'
const EXP_BODY = 'core dump 落在 /var/log/app cli-exp-body-mark'

let pipeSeq = 0

interface Bench {
  page: Page
  userDataDir: string
  cliHome: string
  pipe: string
}

function nextPipe(): string {
  pipeSeq += 1
  return `\\\\.\\pipe\\tsubasaterminal-e2e-${process.pid}-${pipeSeq}`
}

function seedExperience(hostId: string): Record<string, string> {
  const meta = {
    id: 'cliexp01',
    scope: 'host',
    hostId,
    summary: EXP_SUMMARY,
    pinned: false,
    createdAt: 1700000000000,
    lastReadAt: null,
    readCount: 0,
    bytes: 40
  }
  return {
    'experience/index.jsonl': JSON.stringify(meta) + '\n',
    'experience/cliexp01.md': `## 真因\n${EXP_BODY}\n`
  }
}

interface BenchOptions {
  /** 复用已有 userData / cliHome（"重启后不覆盖手工改动"用例） */
  reuse?: { userDataDir: string; cliHome: string; pipe: string }
  host?: Partial<TestHost>
  /** 追加主机（v0.12.2 多机用例） */
  extraHosts?: TestHost[]
  settings?: Record<string, unknown>
  /** 预置模型服务（内置 Agent 互斥用例要让 Agent 真跑起来） */
  llmProfiles?: SeedLlmProfile[]
  /** 启动前往沙盒 home 预置文件（v0.13.17 skill 旧落点迁移用例） */
  seedCliHome?: (cliHome: string) => void
}

async function launchBench(options: BenchOptions = {}): Promise<Bench> {
  const cliHome = options.reuse?.cliHome ?? mkdtempSync(join(tmpdir(), 'tsubasaterminal-cli-'))
  options.seedCliHome?.(cliHome)
  const pipe = options.reuse?.pipe ?? nextPipe()
  const host = makeHost(ssh.port, {
    id: 'cli-host',
    name: 'web1-fake',
    knowledge: HOST_KNOWLEDGE,
    ...options.host
  })
  const launched = await launchApp([host, ...(options.extraHosts ?? [])], options.reuse?.userDataDir, {
    llmProfiles: options.llmProfiles,
    settings: {
      cliBridgeEnabled: true,
      cliSkillClaude: true,
      globalKnowledge: GLOBAL_KNOWLEDGE,
      ...options.settings
    },
    env: {
      TSUBASA_SSH_PIPE: pipe,
      // 落点全改到沙盒，且绝不去动开发机真实的 HKCU\Environment
      TSUBASATERMINAL_CLI_HOME: cliHome,
      TSUBASATERMINAL_CLI_SKIP_PATH: '1',
      // 审批挂起的桌面通知在测试机上会弹真 toast，压掉（flashFrame 无害不压）
      TSUBASATERMINAL_SUPPRESS_NOTIFY: '1'
    },
    seedFiles: options.reuse ? undefined : seedExperience(host.id)
  })
  app = launched.app
  return { page: launched.page, userDataDir: launched.userDataDir, cliHome, pipe }
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

interface CliRun {
  child: ChildProcessWithoutNullStreams
  result: Promise<CliResult>
}

/** 留住子进程句柄的形态：只有"请求方中途断连"的用例需要它，其余走 runCli */
function startCli(
  bench: Pick<Bench, 'userDataDir' | 'pipe'>,
  args: string[],
  opts: { client?: string; userDataDir?: string } = {}
): CliRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TSUBASA_SSH_PIPE: bench.pipe,
    TSUBASA_SSH_USERDATA: opts.userDataDir ?? bench.userDataDir,
    // 开发机上跑测试时真实的 WT_SESSION 会盖掉 TSUBASA_CLIENT 之外的默认值，
    // 显式清空保证 clientId 完全由用例决定
    WT_SESSION: '',
    TSUBASA_CLIENT: opts.client ?? 'e2e-client-a'
  }
  // VS Code 的 JS 自动附加（debug.javascript.autoAttachFilter=smart）靠
  // `NODE_OPTIONS=--require <bootloader>` 注入，子进程继承后 Node 会自己往
  // **stderr 第一行**打 "Debugger attached."——而"stderr 首行是会话回显"正是本通道
  // 3.4 那道纵深的断言点（`# session <句柄> · <别名>`）。在 VS Code 里跑因此会红两条，
  // 命令行里跑不会：这种只在某个 IDE 下失败的用例最费人。剥掉，别让 e2e 的确定性
  // 取决于开发者的编辑器设置
  delete env.NODE_OPTIONS
  delete env.VSCODE_INSPECTOR_OPTIONS
  const child = spawn(process.execPath, [CLI_SCRIPT, ...args], { env, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')))
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')))
  const result = new Promise<CliResult>((done) => {
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }))
  })
  return { child, result }
}

function runCli(
  bench: Pick<Bench, 'userDataDir' | 'pipe'>,
  args: string[],
  opts: { client?: string; userDataDir?: string } = {}
): Promise<CliResult> {
  return startCli(bench, args, opts).result
}

/** 管道在 createWindow 之后异步起，首个调用前等它就位 */
async function waitForPipe(bench: Bench): Promise<void> {
  await expect
    .poll(async () => (await runCli(bench, ['sessions'])).code, { timeout: 15000 })
    .not.toBe(106)
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

/** 多主机场景：按别名双击连接（host-item 有多个，靠文本过滤） */
async function connectHost(page: Page, name: string): Promise<void> {
  await page.getByTestId('host-item').filter({ hasText: name }).dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function runInTerminal(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

/** stdout 第一行之外的会话回显都在 stderr，句柄从那里取 */
function handleOf(result: CliResult): string {
  const m = /# session ([0-9a-f]{8})/.exec(result.stderr)
  expect(m, `stderr 里没有会话回显：${result.stderr}`).not.toBeNull()
  return m![1]
}

interface AuditLine {
  kind?: string
  actor?: string
  command?: string
  decision?: string
}

function readAudit(userDataDir: string): AuditLine[] {
  try {
    return readFileSync(join(userDataDir, 'audit.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditLine)
  } catch {
    return []
  }
}

/** 按命令文本定位审计条目——同一个用例里两个 client 各跑一条，得分开断言 actor */
function actorOf(userDataDir: string, command: string): string | undefined {
  return readAudit(userDataDir).find((l) => l.command === command)?.actor
}

test.beforeAll(async () => {
  ssh = await startFakeSshServer()
  llm = await startFakeLlmServer()
})

test.afterAll(async () => {
  await ssh.close()
  await llm.close()
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

/** 审批提交：composer 输入 + Ctrl+Enter（决策面即 composer 本体） */
async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
}

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('hosts：一台没连也能列（配置面标记 + 知识✓ + 全局知识）、详情不连接就读本机知识、同名 104、未命中 103', { tag: '@daily' }, async () => {
  const bench = await launchBench({
    extraHosts: [
      makeHost(ssh.port, {
        id: 'cli-host-prod',
        name: 'prod-fake',
        envLevel: 'production',
        tmuxKeepalive: true,
        elevate: 'sudo'
      }),
      makeHost(ssh.port, { id: 'cli-host-dup1', name: 'dup-fake' }),
      makeHost(ssh.port, { id: 'cli-host-dup2', name: 'dup-fake' })
    ]
  })
  await waitForPipe(bench)

  // 配置面 / 运行时面的分工：一个会话都没开时 sessions 退 103，hosts 照常回答
  expect((await runCli(bench, ['sessions'])).code).toBe(103)

  const list = await runCli(bench, ['hosts'])
  expect(list.code).toBe(0)
  expect(list.stdout).toContain('web1-fake')
  expect(list.stdout).toContain('test@127.0.0.1')
  // 标记按主机配置算，三个同时出现；知识✓只跟着真有 knowledge 的那台
  expect(list.stdout).toContain('production root tmux')
  expect(list.stdout).toContain('未连接')
  expect(list.stdout).toMatch(/web1-fake.*知识✓/)
  expect(list.stdout).not.toMatch(/prod-fake.*知识✓/)
  expect(list.stdout).toContain(GLOBAL_KNOWLEDGE)

  // 详情：读到本机知识，且**一个标签页都没开**——这正是它相对 use 的全部价值
  const detail = await runCli(bench, ['hosts', 'WEB1-FAKE'])
  expect(detail.code).toBe(0)
  expect(detail.stdout).toContain(HOST_KNOWLEDGE)
  expect(detail.stdout).toContain('未连接')
  await expect(bench.page.getByTestId('session-tab')).toHaveCount(0)

  const prod = await runCli(bench, ['hosts', 'prod-fake'])
  expect(prod.stdout).toContain('⚠ production')
  expect(prod.stdout).toContain('⚠ root')
  expect(prod.stdout).toContain('这台没有本机知识')

  // 主机列表里同名多台：不挑不猜，104 列候选（与"同主机多会话"同款纪律）
  const dup = await runCli(bench, ['hosts', 'dup-fake'])
  expect(dup.code).toBe(104)
  expect(dup.stderr).toContain('匹配到 2 台')

  const missing = await runCli(bench, ['hosts', 'no-such-host'])
  expect(missing.code).toBe(103)
  expect(missing.stderr).toContain('跑 tsubasa-ssh hosts')

  // 连上之后同一张表长出句柄，当前绑定打星（sessions 的 * 是同一套视觉语言）
  const used = await runCli(bench, ['use', 'web1-fake'])
  const handle = handleOf(used)
  const after = await runCli(bench, ['hosts'])
  expect(after.stdout).toContain(handle)
  expect(after.stdout).toMatch(new RegExp(`\\* +web1-fake`))
})

test('hosts：连接后改配置的会话标(旧配置)不冒充新地址；漏引号的多余位置参数退 124', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)

  const used = await runCli(bench, ['use', 'web1-fake'])
  const handle = handleOf(used)
  expect((await runCli(bench, ['hosts'])).stdout).toMatch(
    new RegExp(`web1-fake.*${handle}`)
  )

  // 会话开着时改这台的地址与环境等级（SessionMeta 是连接那一刻的快照，不会跟着变）
  const hostsFile = join(bench.userDataDir, 'hosts.json')
  const patch = (edit: (h: Record<string, unknown>) => void): void => {
    const stored = JSON.parse(readFileSync(hostsFile, 'utf-8')) as Record<string, unknown>[]
    edit(stored.find((h) => h.id === 'cli-host')!)
    writeFileSync(hostsFile, JSON.stringify(stored, null, 2), 'utf-8')
  }
  patch((h) => {
    h.host = '10.0.0.9'
    h.envLevel = 'production'
  })

  // 表格：左边是新配置，旧句柄**不能**被当成"新地址已连接"
  const list = await runCli(bench, ['hosts'])
  expect(list.stdout).toContain('10.0.0.9')
  expect(list.stdout).toMatch(new RegExp(`未连接 · ⚠${handle}\\(旧配置\\)`))
  expect(list.stdout).toContain('(旧配置) 的句柄')

  // 详情：旧会话连的到底是哪台要写明；别名没改 → use 仍会命中它，必须说出来
  const detail = await runCli(bench, ['hosts', 'web1-fake'])
  expect(detail.stdout).toContain('10.0.0.9')
  expect(detail.stdout).toContain(`⚠ 另有会话 ${handle}`)
  expect(detail.stdout).toContain(`127.0.0.1:${ssh.port}`)
  expect(detail.stdout).toContain(`use web1-fake 会命中它们`)

  // 连别名也改了 → 寻址走快照，新别名不会命中旧会话；这两句话相反，不能混着说
  patch((h) => (h.name = 'web1-renamed'))
  const renamed = await runCli(bench, ['hosts', 'web1-renamed'])
  expect(renamed.stdout).toContain(`⚠ 另有会话 ${handle}`)
  expect(renamed.stdout).toContain('不会命中它们')

  // 别名允许带空格（表单只 trim）：漏引号时静默取另一台是最坏形态，响亮退 124
  const sloppy = await runCli(bench, ['hosts', 'prod', 'east'])
  expect(sloppy.code).toBe(124)
  expect(sloppy.stderr).toContain('整体加引号')
  const sloppyUse = await runCli(bench, ['use', 'prod', 'east'])
  expect(sloppyUse.code).toBe(124)
  expect(sloppyUse.stderr).toContain('整体加引号')
})

test('寻址与建联包：无会话 103、use 返回档案/知识/经验、粘性按 clientId 隔离、-s 逐条覆盖', { tag: '@daily' }, async () => {
  const bench = await launchBench()
  await waitForPipe(bench)

  // 无会话：103 的补救是"去开会话"，与 106"去启动应用"分开
  const empty = await runCli(bench, ['sessions'])
  expect(empty.code).toBe(103)
  expect(empty.stderr).toContain('无已连接会话')

  await connect(bench.page)

  const list = await runCli(bench, ['sessions'])
  expect(list.code).toBe(0)
  expect(list.stdout).toContain('web1-fake')
  expect(list.stdout).toContain('test@127.0.0.1')

  const used = await runCli(bench, ['use', 'web1-fake'])
  expect(used.code).toBe(0)
  const handle = handleOf(used)
  // 建联包 = collectPromptInputs 的第二渲染器：探测档案 + 人写两级知识 + 经验索引
  expect(used.stdout).toContain('[主机档案]')
  expect(used.stdout).toContain('Ubuntu 22.04 Fake LTS')
  expect(used.stdout).toContain(HOST_KNOWLEDGE)
  expect(used.stdout).toContain(GLOBAL_KNOWLEDGE)
  expect(used.stdout).toContain('cliexp01')
  expect(used.stdout).toContain(EXP_SUMMARY)
  // unit id 与句柄自洽（log 的输出直接可用于寻址）
  expect(used.stdout).toContain(`${handle}:<n>`)

  // 绑定在 clientId 上：另一个 client 没绑就是响亮 103，不会静默用别人的会话
  const other = await runCli(bench, ['exec', 'whoami'], { client: 'e2e-client-b' })
  expect(other.code).toBe(103)
  expect(other.stderr).toContain('未绑定会话')

  // -s 逐条覆盖：解析完即用，不读不写粘性
  const forced = await runCli(bench, ['-s', handle, 'exec', 'whoami'], { client: 'e2e-client-b' })
  expect(forced.code).toBe(0)
  expect(forced.stdout).toContain('agent-saw-test-user')
  expect((await runCli(bench, ['exec', 'whoami'], { client: 'e2e-client-b' })).code).toBe(103)

  // 每条命令 stderr 首行回显作用的会话（隔离失手第一行就暴露）
  const echoed = await runCli(bench, ['exec', 'whoami'])
  expect(echoed.stderr.split('\n')[0]).toContain(`# session ${handle} · web1-fake`)
})

test('exec：白名单直执行透传退出码 + --save 转存；结构性拒绝退 101 不弹提案卡；--agent 逐条生效不继承', { tag: '@daily' }, async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  // use 上带 --agent：绑定 + 署名一步完成（名字只在本条生效）
  const used = await runCli(bench, ['use', 'web1-fake', '--agent', 'e2e-agent'])
  expect(used.stderr).toContain('agent e2e-agent')

  const ok = await runCli(bench, ['exec', '--agent', 'e2e-agent', 'whoami'])
  expect(ok.code).toBe(0)
  expect(ok.stdout.trim()).toBe('agent-saw-test-user')
  // 本条声明的身份回显在首行
  expect(ok.stderr).toContain('agent e2e-agent')

  // 转存：全量落远端，只回规模 + 前 30 行预览
  const saved = await runCli(bench, ['exec', '--save', 'kubectl logs deploy/app --tail=2000'])
  expect(saved.code).toBe(0)
  expect(saved.stderr).toContain('输出已全量落远端')
  expect(saved.stderr).toContain('1500 行')
  expect(saved.stdout).toContain('req=xyz-777')

  // 结构性拒绝（&& 拼接）→ 101 且**不弹提案卡**（解析即拒绝，审批台无事可审）；
  // 给的是可操作的修复方向。非白名单命令自 v0.12.1 走审批路径，见后面的用例
  const compound = await runCli(bench, ['exec', 'cat a.txt && cat b.txt'])
  expect(compound.code).toBe(101)
  expect(compound.stderr).toContain('硬解析')
  // 拒绝理由走 raw 纯文本回 stderr，不把喂 LLM 的 JSON 形态漏出去
  expect(compound.stderr).not.toContain('"status"')

  // 引号已被 shell 拆掉的多段参数无法无损还原——响亮 124，不静默拼成另一条命令
  const lossy = await runCli(bench, ['exec', 'grep', 'a b', 'file.log'])
  expect(lossy.code).toBe(124)
  expect(lossy.stderr).toContain('整体加引号')

  await bench.page.waitForTimeout(300)
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)

  // 逐条生效：这条没带 --agent，不继承上一条的名字——记成匿名并在 stderr 提醒
  const anon = await runCli(bench, ['exec', 'uptime'])
  expect(anon.code).toBe(0)
  expect(anon.stderr).not.toContain('agent e2e-agent')
  expect(anon.stderr).toContain('匿名')

  // 名字洗成空串不静默变匿名，响亮打回
  const badName = await runCli(bench, ['exec', '--agent', '！！！', 'whoami'])
  expect(badName.code).toBe(124)
  expect(badName.stderr).toContain('--agent')

  // 审计合流：actor 分得清是谁按的，且不互相冒名
  expect(readAudit(bench.userDataDir).some((l) => l.kind === 'auto-exec')).toBe(true)
  expect(actorOf(bench.userDataDir, 'whoami')).toBe('cli:e2e-agent')
  expect(actorOf(bench.userDataDir, 'uptime')).toBe('cli')
})

test('审批路径：批准回流真实退出码；拒绝带留言 102；超时主动撤回 125；--bg 一律审批；执行中指示按命令收口；CLI 栏逐条留卡', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  await runCli(bench, ['use', 'web1-fake'])

  // 右栏 CLI 栏（cli-bridge-design 七）：白名单命令走旁路 channel 终端完全不可见，
  // 每条 exec 在发起会话的 CLI 栏留一张卡；审批路径的结局一并列入
  await bench.page.getByTestId('cli-tab').click()
  const cards = bench.page.getByTestId('cli-activity-card')
  const auto = await runCli(bench, ['exec', '--agent', 'cc', '--intent', '看看当前身份', 'whoami'])
  expect(auto.code).toBe(0)
  await expect(cards).toHaveCount(1)
  await expect(cards.last()).toHaveAttribute('data-status', 'executed')
  await expect(cards.last()).toContainText('cc · exec')
  await expect(cards.last()).toContainText('whoami')
  await expect(cards.last()).toContainText('看看当前身份')
  // CLI 活动只落右栏，不占输入栏状态行
  await expect(bench.page.getByTestId('composer')).not.toContainText('执行了 whoami')

  // 批准：提案卡带署名与 --intent 意图（reason 槽位复用），y 后命令写入用户终端，
  // 真实退出码与输出回流 CLI——审批权唯一归属 Tsubasa Terminal，CLI 只是等结果
  const approvedRun = runCli(bench, [
    'exec', '--agent', 'cc', '--intent', '复现一次失败看输出', 'failcmd'
  ])
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  await expect(bench.page.getByTestId('approval-command')).toHaveText('failcmd')
  await expect(bench.page.getByTestId('approval-card')).toContainText('cli:cc')
  await expect(bench.page.getByTestId('approval-card')).toContainText('复现一次失败看输出')
  await expect(cards.last()).toHaveAttribute('data-status', 'proposed')
  await submitApproval(bench.page, 'y')
  const approved = await approvedRun
  expect(approved.code).toBe(1)
  expect(approved.stdout).toContain('boom: simulated failure')
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)
  // CLI 没有内置 Agent 的 tool-end/turn-end：命令收场后主进程要单独发 cli-exec-end，
  // 否则 composer 的"已批准 · 执行中"再没人清，永久卡住
  await expect(bench.page.getByTestId('approval-executing')).toHaveCount(0)
  await expect(cards).toHaveCount(2)
  await expect(cards.last()).toHaveAttribute('data-status', 'approved')
  await expect(cards.last()).toContainText('exit 1')

  // 拒绝 + 留言：102（与 101"别重试同样写法"补救不同），留言原文回 stderr
  const deniedRun = runCli(bench, ['exec', '--agent', 'cc', 'failcmd'])
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(bench.page, '先别动，换只读方案')
  const denied = await deniedRun
  expect(denied.code).toBe(102)
  expect(denied.stderr).toContain('先别动，换只读方案')
  await expect(cards.last()).toHaveAttribute('data-status', 'denied')
  await expect(cards.last()).toContainText('先别动，换只读方案')

  // 超时：无人决策 → 主进程**主动撤回**退 125、卡片消失——幽灵提案（用户批准一条
  // 早已被放弃的命令）的正解就是提案不许比调用方的注意力活得久
  const timedRun = runCli(bench, ['exec', '--agent', 'cc', '--timeout', '2', 'failcmd'])
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  const timed = await timedRun
  expect(timed.code).toBe(125)
  expect(timed.stderr).toContain('撤回')
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)
  await expect(cards.last()).toHaveAttribute('data-status', 'withdrawn')

  // --bg：主进程代拼 nohup 包装（& 与重定向 LLM/CLI 手里都没有），一律审批；
  // 批准后 stderr 说清"提交成功 ≠ 运行正常"
  const bgRun = runCli(bench, ['exec', '--bg', '--agent', 'cc', 'failcmd'])
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  await expect(bench.page.getByTestId('approval-command')).toContainText('nohup failcmd')
  await submitApproval(bench.page, 'y')
  const bg = await bgRun
  expect(bg.stderr).toContain('已后台启动')
  expect(bg.stderr).toContain('/tmp/tsubasaterminal-')
  await expect(bench.page.getByTestId('approval-executing')).toHaveCount(0)

  // --bg 与 --save 互斥是用法错误（124），不占 101 的语义
  expect((await runCli(bench, ['exec', '--bg', '--save', 'x'])).code).toBe(124)

  // 请求方中途断连（外部 agent 的超时窗口比等待窗口短，是日常路径而非边角）：
  // 命令已写进 pty 但结果没捕获到，主进程照样要发 cli-exec-end——这条路径漏发的话
  // 徽章此后永远没人清。`ask` 会停在交互提示上，转录单元不闭合，正好造出这个窗口
  const abortRun = startCli(bench, ['exec', '--agent', 'cc', 'ask'])
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  await submitApproval(bench.page, 'y')
  await expect(bench.page.getByTestId('approval-executing')).toBeVisible()
  abortRun.child.kill()
  await abortRun.result
  await expect(bench.page.getByTestId('approval-executing')).toHaveCount(0)

  // 审计：提案/决策都带 CLI 侧 actor；超时撤回如实记 withdrawn
  const audit = readAudit(bench.userDataDir)
  expect(audit.some((l) => l.kind === 'proposal' && l.actor === 'cli:cc')).toBe(true)
  expect(audit.some((l) => l.kind === 'decision' && l.decision === 'approved' && l.actor === 'cli:cc')).toBe(true)
  expect(audit.some((l) => l.kind === 'decision' && l.decision === 'withdrawn')).toBe(true)
})

test('--async 返回 proposalId、job 轮询到终态可重复读；白名单命令 --async 退化为同步', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  await runCli(bench, ['use', 'web1-fake'])

  const started = await runCli(bench, [
    'exec', '--async', '--agent', 'cc', '--intent', '长任务演练', 'failcmd'
  ])
  expect(started.code).toBe(0)
  const proposalId = started.stdout.trim()
  expect(proposalId).toMatch(/^[0-9a-f-]{36}$/)
  expect(started.stderr).toContain(`job ${proposalId}`)

  // 未决态：108 = 继续轮询（补救动作与 105"稍后重试这条命令"不同，不合并）
  const pending = await runCli(bench, ['job', proposalId])
  expect(pending.code).toBe(108)
  expect(pending.stderr).toContain('等待用户决策')
  // sessions 状态列如实报"提案待决"
  expect((await runCli(bench, ['sessions'])).stdout).toContain('提案待决')

  await submitApproval(bench.page, 'y')
  await expect
    .poll(async () => (await runCli(bench, ['job', proposalId])).code, { timeout: 15000 })
    .toBe(1)
  // 终态结果可重复读（管道抖动重查不该丢结果）
  const done = await runCli(bench, ['job', proposalId])
  expect(done.code).toBe(1)
  expect(done.stdout).toContain('boom: simulated failure')

  // 未知 / 过期 id 归用法错误
  expect((await runCli(bench, ['job', 'no-such-proposal'])).code).toBe(124)

  // 白名单命令没有提案可挂：--async 退化为同步直执行并明说
  const sync = await runCli(bench, ['exec', '--async', '--agent', 'cc', 'whoami'])
  expect(sync.code).toBe(0)
  expect(sync.stdout.trim()).toBe('agent-saw-test-user')
  expect(sync.stderr).toContain('--async 未生效')
})

test('pty 路口互斥退 105（内置 Agent 运行中 / 终端非空闲），只读白名单不受影响', async () => {
  const bench = await launchBench({ llmProfiles: [anthropicProfile()] })
  await waitForPipe(bench)
  await connect(bench.page)
  await runCli(bench, ['use', 'web1-fake'])

  // 内置 Agent 正在跑（阻塞在自己的提案上）：审批路径 105，别让两个大脑抢一只手；
  // 只读白名单走旁路 channel 照常并行
  await bench.page.getByTestId('agent-input').fill('propose-restart')
  await bench.page.getByTestId('agent-input').press('Enter')
  await expect(bench.page.getByTestId('approval-card')).toBeVisible()
  const busyAgent = await runCli(bench, ['exec', '--agent', 'cc', 'failcmd'])
  expect(busyAgent.code).toBe(105)
  expect(busyAgent.stderr).toContain('内置 Agent')
  expect((await runCli(bench, ['exec', 'whoami'])).code).toBe(0)
  expect((await runCli(bench, ['sessions'])).stdout).toContain('内置 Agent 运行中')
  await submitApproval(bench.page, 'n')
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)
  // 等 Agent 这轮完全结束（turn-end），否则下一段的 105 理由会飘
  await expect
    .poll(async () => (await runCli(bench, ['sessions'])).stdout, { timeout: 15000 })
    .toContain('就绪')

  // 终端不可写（交互命令等输入）：此刻写 pty 就是喂给前台进程，105。
  // v0.13.4 忙因文案同源化：带具体原因「命令运行中」
  await expect(bench.page.getByTestId('composer-input')).toBeFocused()
  await bench.page.keyboard.type('ask')
  await bench.page.keyboard.press('Enter')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  const busyTerm = await runCli(bench, ['exec', '--agent', 'cc', 'failcmd'])
  expect(busyTerm.code).toBe(105)
  expect(busyTerm.stderr).toContain('终端不可写')
  expect(busyTerm.stderr).toContain('命令运行中')
  await bench.page.keyboard.type('done')
  await bench.page.keyboard.press('Enter')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
})

test('log / screen / exp / rules：转录寻址严格认句柄前缀，裸数字打回', { tag: '@daily' }, async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  await runInTerminal(bench.page, 'echo cli-transcript-probe')
  const used = await runCli(bench, ['use', 'web1-fake'])
  const handle = handleOf(used)

  await expect
    .poll(async () => (await runCli(bench, ['log'])).stdout, { timeout: 10000 })
    .toContain('echo cli-transcript-probe')
  const list = await runCli(bench, ['log'])
  expect(list.code).toBe(0)
  expect(list.stdout).toContain(`${handle}:`)

  // 取 probe 那一行的 id：清单第一行是连接时的 SI 装载命令，不是我们要的那条
  const probeLine = list.stdout
    .split('\n')
    .find((line) => line.includes('cli-transcript-probe'))!
  const unitId = /(\w{8}:\d+)/.exec(probeLine)![1]
  const body = await runCli(bench, ['log', unitId])
  expect(body.code).toBe(0)
  expect(body.stdout).toContain('cli-transcript-probe')

  // 裸数字不认（换会话后会静默读错别人的输出，宁可响亮失败）——参数写错归 124，不占 101
  const bare = await runCli(bench, ['log', '1'])
  expect(bare.code).toBe(124)
  expect(bare.stderr).toContain('不是当前会话的有效引用')

  const screen = await runCli(bench, ['screen'])
  expect(screen.code).toBe(0)
  expect(screen.stderr).toContain('bufferType=normal')
  expect(screen.stdout).toContain('cli-transcript-probe')

  const exp = await runCli(bench, ['exp', 'cliexp01'])
  expect(exp.code).toBe(0)
  expect(exp.stdout).toContain(EXP_BODY)
  expect(exp.stderr).toContain('可能已过期')

  const missing = await runCli(bench, ['exp', 'nope0000'])
  expect(missing.code).toBe(107)

  // rules 与 skill 同源：白名单取自 gate.ts，不抄
  const rules = await runCli(bench, ['rules'])
  expect(rules.code).toBe(0)
  expect(rules.stdout).toContain('systemctl')
  expect(rules.stdout).toContain('101')
  expect(rules.stdout).toContain('别重试同样写法')
})

test('别名歧义退 104 并列候选；应用关闭后退 106；token 不符退 100', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  // 同主机第二个标签页：不禁止，但不许替用户挑
  await bench.page.getByTestId('host-item').dblclick()
  await expect.poll(async () => (await runCli(bench, ['sessions'])).stdout.split('\n').length)
    .toBeGreaterThan(2)

  const ambiguous = await runCli(bench, ['use', 'web1-fake'])
  expect(ambiguous.code).toBe(104)
  expect(ambiguous.stderr).toContain('匹配到 2 个会话')

  // token 对不上 = 可能连到了别的实例，与"应用没开"分开报
  const fakeUserData = mkdtempSync(join(tmpdir(), 'tsubasaterminal-cli-token-'))
  writeFileSync(join(fakeUserData, 'cli-token'), 'deadbeef', 'utf-8')
  const badToken = await runCli(bench, ['sessions'], { userDataDir: fakeUserData })
  expect(badToken.code).toBe(100)
  expect(badToken.stderr).toContain('握手 token 不匹配')

  await app?.close()
  app = undefined
  const down = await runCli(bench, ['sessions'])
  expect(down.code).toBe(106)
  expect(down.stderr).toContain('不要自己去拉起应用')
})

test('PowerShell shim：真实会话、exec 输出与闸门拒绝', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  const shim = join(bench.cliHome, 'bin', 'tsubasa-ssh.ps1')
  for (const host of powershellHosts) {
    const run = (args: string[]) => runPowerShell(host,
      `& ${psQuote(shim)} ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`,
      { TSUBASA_SSH_PIPE: bench.pipe, TSUBASA_CLIENT: 'shim-real-bridge', WT_SESSION: '' })
    const sessions = await run(['sessions'])
    expect(sessions.code, sessions.stderr).toBe(0)
    expect(sessions.stdout).toContain('web1-fake')
    const success = await run(['exec', '-s', 'web1-fake', '--agent', 'shim-e2e', 'whoami'])
    expect(success.code, success.stderr).toBe(0)
    expect(success.stdout).toBe('agent-saw-test-user\r\n')
    expect(success.stderr).toContain('# session ')
    const rejected = await run(['exec', '-s', 'web1-fake', '--agent', 'shim-e2e', 'whoami && pwd'])
    expect(rejected.code).toBe(101)
    expect(rejected.stdout).toBe('')
    expect(rejected.stderr).toContain('硬解析')
  }
})

test('安装面：shim 三件套 + skill 双目录，手工改过的 skill 重启也不覆盖', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)

  // 三件套齐全，sh 版是 CC 的 Git Bash 唯一认得的那个
  // 宿主进程行为由上面的真实桥用例及 cli-shim.spec.ts 覆盖，这里只检查安装清单。
  const shims = ['tsubasa-ssh.cmd', 'tsubasa-ssh', 'tsubasa-ssh.ps1']
  for (const name of shims) {
    const file = join(bench.cliHome, 'bin', name)
    expect(existsSync(file), `${name} 未生成`).toBe(true)
  }

  const claudeSkill = join(bench.cliHome, '.claude', 'skills', 'tsubasa-ssh', 'SKILL.md')
  expect(existsSync(claudeSkill)).toBe(true)
  const skillText = readFileSync(claudeSkill, 'utf-8')
  expect(skillText).toContain('name: tsubasa-ssh')
  expect(skillText).toContain('systemctl') // 闸门白名单与 rules 同源
  expect(skillText).toContain('不要自己用 start')
  // Codex 落通用目录 ~/.agents/skills
  const codexSkill = join(bench.cliHome, '.agents', 'skills', 'tsubasa-ssh', 'SKILL.md')
  expect(existsSync(codexSkill)).toBe(false)

  // 设置弹窗：勾上 Codex 一栏即落盘
  await openSettings(bench.page, 'cli')
  await expect(bench.page.getByTestId('settings-cli-section')).toBeVisible()
  await bench.page.getByTestId('settings-cli-skill-codex').click()
  await expect
    .poll(() => existsSync(codexSkill), { timeout: 10000 })
    .toBe(true)
  expect(readFileSync(codexSkill, 'utf-8')).toBe(skillText) // 两家逐字节同文件
  expect(existsSync(join(bench.cliHome, '.codex'))).toBe(false) // 旧落点不再写
  await bench.page.getByTestId('settings-close').click()

  // 人手工改过 → 状态如实标注，且重启后**不静默覆盖**
  const handEdited = skillText + '\n<!-- 我自己加的一行 -->\n'
  writeFileSync(claudeSkill, handEdited, 'utf-8')
  await openSettings(bench.page, 'cli')
  await expect(bench.page.getByTestId('settings-cli-skill-state-claude')).toContainText(
    '已被手工修改'
  )
  await expect(bench.page.getByTestId('settings-cli-skill-claude')).toBeDisabled()
  await bench.page.getByTestId('settings-close').click()

  await app?.close()
  app = undefined
  const again = await launchBench({
    reuse: { userDataDir: bench.userDataDir, cliHome: bench.cliHome, pipe: bench.pipe }
  })
  await waitForPipe(again)
  expect(readFileSync(claudeSkill, 'utf-8')).toBe(handEdited)
})

test('CLI 栏跟随设置里的 CLI 通道总开关出现与收起；收起时停在 CLI 栏的退回 Agent', async () => {
  const bench = await launchBench({ settings: { cliBridgeEnabled: false } })
  const page = bench.page
  await expect(page.getByTestId('cli-tab')).toHaveCount(0)

  // 打开总开关：主进程起管道、写设置，渲染侧共享设置缓存跟上，栏随之出现
  await openSettings(page, 'cli')
  await page.getByTestId('settings-cli-bridge').click()
  await expect(page.getByTestId('settings-cli-state')).not.toHaveText('未启用')
  await page.getByTestId('settings-close').click()
  await waitForPipe(bench)
  await page.getByTestId('cli-tab').click()
  await expect(page.getByTestId('cli-tab')).toHaveAttribute('data-state', 'active')
  await expect(page.getByTestId('cli-panel-empty')).toBeVisible()

  // 关掉总开关：栏收起，右栏退回 Agent
  await openSettings(page, 'cli')
  await page.getByTestId('settings-cli-bridge').click()
  await expect(page.getByTestId('settings-cli-state')).toHaveText('未启用')
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('cli-tab')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('data-state', 'active')
})

test('安装面：Codex skill 迁到 ~/.agents，旧 ~/.codex 只清托管且未改的文件', async () => {
  const marker = '.tsubasa-ssh-install.json'
  const sha = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex')
  const seedManaged = (dir: string, body: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8')
    writeFileSync(
      join(dir, marker),
      JSON.stringify({ version: '0.0.1-seed', files: { 'SKILL.md': sha(body) } }, null, 2),
      'utf-8'
    )
  }
  let agentsDir = ''
  let legacyDir = ''
  let systemSkill = ''
  let otherSkill = ''
  // 复刻真实机器的现状：旧版装在 ~/.codex，用户又手工复制了一份到 ~/.agents（含 manifest）
  const bench = await launchBench({
    settings: { cliSkillCodex: true },
    seedCliHome: (home) => {
      agentsDir = join(home, '.agents', 'skills', 'tsubasa-ssh')
      legacyDir = join(home, '.codex', 'skills', 'tsubasa-ssh')
      systemSkill = join(home, '.codex', 'skills', '.system', 'skill-creator', 'SKILL.md')
      otherSkill = join(home, '.codex', 'skills', 'tsubasa-mysql', 'SKILL.md')
      seedManaged(agentsDir, 'old skill body\n')
      seedManaged(legacyDir, 'old skill body\n')
      mkdirSync(join(systemSkill, '..'), { recursive: true })
      mkdirSync(join(otherSkill, '..'), { recursive: true })
      writeFileSync(systemSkill, 'system skill', 'utf-8')
      writeFileSync(otherSkill, 'mysql skill', 'utf-8')
    }
  })
  await waitForPipe(bench)

  // 启动自愈：接管 ~/.agents 的副本并重渲染，旧落点按 manifest 清掉
  const claudeSkill = join(bench.cliHome, '.claude', 'skills', 'tsubasa-ssh', 'SKILL.md')
  await expect
    .poll(() => existsSync(legacyDir), { timeout: 10000 })
    .toBe(false)
  const skillText = readFileSync(claudeSkill, 'utf-8')
  expect(readFileSync(join(agentsDir, 'SKILL.md'), 'utf-8')).toBe(skillText)
  const claudeMarker = JSON.parse(readFileSync(join(claudeSkill, '..', marker), 'utf-8'))
  const codexMarker = JSON.parse(readFileSync(join(agentsDir, marker), 'utf-8'))
  expect(codexMarker).toEqual(claudeMarker)
  expect(codexMarker.version).not.toBe('0.0.1-seed')
  expect(existsSync(join(bench.cliHome, '.codex', 'skills'))).toBe(true)
  expect(readFileSync(systemSkill, 'utf-8')).toBe('system skill')
  expect(readFileSync(otherSkill, 'utf-8')).toBe('mysql skill')

  await openSettings(bench.page, 'cli')
  await expect(bench.page.getByTestId('settings-cli-skill-state-codex')).toContainText('已安装')
  await expect(bench.page.getByTestId('settings-cli-section')).toContainText(agentsDir)
  await expect(bench.page.getByTestId('settings-cli-skill-legacy-codex')).toHaveCount(0)
  await bench.page.getByTestId('settings-close').click()

  // 旧落点又出现一份手工改过的副本：卸载时新落点删掉，旧落点原样保留并在状态行提示
  seedManaged(legacyDir, 'old skill body\n')
  const handEdited = 'old skill body\n<!-- 我自己加的一行 -->\n'
  writeFileSync(join(legacyDir, 'SKILL.md'), handEdited, 'utf-8')
  await openSettings(bench.page, 'cli')
  await expect(bench.page.getByTestId('settings-cli-skill-legacy-codex')).toContainText(legacyDir)
  await bench.page.getByTestId('settings-cli-skill-codex').click()
  await expect
    .poll(() => existsSync(agentsDir), { timeout: 10000 })
    .toBe(false)
  await expect(bench.page.getByTestId('settings-cli-skill-state-codex')).toContainText('未安装')
  await expect(bench.page.getByTestId('settings-cli-skill-legacy-codex')).toContainText('已原样保留')
  expect(readFileSync(join(legacyDir, 'SKILL.md'), 'utf-8')).toBe(handEdited)
  expect(existsSync(join(legacyDir, marker))).toBe(true)
  expect(readFileSync(systemSkill, 'utf-8')).toBe('system skill')
  expect(readFileSync(otherSkill, 'utf-8')).toBe('mysql skill')
})

// ---------- v0.12.2 多机并行 + use 自动开会话 ----------

const HOST2 = 'web2-fake'

function secondHost(): TestHost {
  return makeHost(ssh.port, { id: 'cli-host-2', name: HOST2 })
}

interface MultiJson {
  command: string
  batchId?: string
  decision?: string
  comment?: string
  results: Array<{
    handle: string
    host: string
    code: number
    exitCode: number | null
    stdout: string
    notes: string[]
  }>
}

function parseJsonOut(result: CliResult): MultiJson {
  try {
    return JSON.parse(result.stdout) as MultiJson
  } catch {
    throw new Error(`stdout 不是 JSON：${result.stdout}`)
  }
}

test('--hosts 白名单并行：JSON 聚合 + 审计 batchId；目标解析 fail-closed；单机 --json 同构', async () => {
  const bench = await launchBench({ extraHosts: [secondHost()] })
  await waitForPipe(bench)
  await connectHost(bench.page, 'web1-fake')
  await connectHost(bench.page, HOST2)

  // 白名单逐台旁路并行直执行（不弹卡），stdout 切结构化 JSON
  const par = await runCli(bench, ['exec', '--hosts', `web1-fake,${HOST2}`, '--agent', 'cc', 'whoami'])
  expect(par.code).toBe(0)
  const json = parseJsonOut(par)
  expect(json.decision).toBe('executed')
  expect(json.results).toHaveLength(2)
  for (const r of json.results) {
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('agent-saw-test-user')
  }
  // stderr 首行列出全部目标句柄（隔离失手第一行暴露）
  const first = par.stderr.split('\n')[0]
  for (const r of json.results) expect(first).toContain(r.handle)
  await bench.page.waitForTimeout(200)
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveCount(0)

  // CLI 栏：批次逐台各留一张卡并标出总台数（当前停在后连上的第二台）；
  // 下面几条在解析目标阶段就整批打回，不开卡
  await bench.page.getByTestId('cli-tab').click()
  const cliCards = bench.page.getByTestId('cli-activity-card')
  await expect(cliCards).toHaveCount(1)
  await expect(cliCards).toContainText('cc · exec · 2 台')
  await expect(cliCards).toHaveAttribute('data-status', 'executed')

  // 审计：两台各一条 auto-exec，batchId 相同（同一次批量靠它串起来）
  const batchLines = readAudit(bench.userDataDir).filter(
    (l) => l.kind === 'auto-exec' && l.command === 'whoami'
  ) as Array<AuditLine & { batchId?: string }>
  expect(batchLines).toHaveLength(2)
  expect(batchLines[0].batchId).toBeTruthy()
  expect(batchLines[1].batchId).toBe(batchLines[0].batchId)

  // fail-closed：任一未命中整批 103；台数/组合的用法错误 124
  const missing = await runCli(bench, ['exec', '--hosts', 'web1-fake,nope', 'whoami'])
  expect(missing.code).toBe(103)
  expect(missing.stderr).toContain('整批未执行')
  expect((await runCli(bench, ['exec', '--hosts', 'web1-fake', 'whoami'])).code).toBe(124)
  expect(
    (await runCli(bench, ['-s', 'web1-fake', 'exec', '--hosts', `web1-fake,${HOST2}`, 'whoami'])).code
  ).toBe(124)
  const eight = Array.from({ length: 8 }, (_v, i) => `h${i}`).join(',')
  const over = await runCli(bench, ['exec', '--hosts', eight, 'whoami'])
  expect(over.code).toBe(124)
  expect(over.stderr).toContain('上限 7 台')
  await expect(cliCards).toHaveCount(1)

  // 单机 --json：与多机聚合同构（results 单元素），退出码语义不变
  await runCli(bench, ['use', 'web1-fake'])
  const single = await runCli(bench, ['exec', '--json', '--agent', 'cc', 'whoami'])
  expect(single.code).toBe(0)
  const singleJson = parseJsonOut(single)
  expect(singleJson.results).toHaveLength(1)
  expect(singleJson.results[0].stdout).toContain('agent-saw-test-user')
})

test('--hosts 一卡罩 N 台：composer Ctrl+Enter 拦截、浮层不动终端网格、批准回流、109 混合码', async () => {
  const bench = await launchBench({ extraHosts: [secondHost()] })
  await waitForPipe(bench)
  await connectHost(bench.page, 'web1-fake')
  await connectHost(bench.page, HOST2)

  const gridBefore = await bench.page.locator('.xterm-screen >> visible=true').first().boundingBox()

  // flipflop 非白名单 → 整批一张卡；退出码全服务器交替 0/1，两台必然拿到不同码
  const run = runCli(bench, [
    'exec', '--hosts', `web1-fake,${HOST2}`, '--agent', 'cc', '--intent', '多机演练', 'flipflop'
  ])
  await expect(bench.page.getByTestId('multi-approval-card')).toBeVisible()
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveAttribute('data-phase', 'pending')
  await expect(bench.page.getByTestId('multi-approval-target')).toHaveCount(2)
  await expect(bench.page.getByTestId('multi-approval-command')).toHaveText('flipflop')
  await expect(bench.page.getByTestId('multi-approval-card')).toContainText('多机演练')
  // 单机审批卡不出现：一个决策一张卡，不是 N 张卡轰炸
  await expect(bench.page.getByTestId('approval-card')).toHaveCount(0)
  // 目标 tab 呼吸徽章（波及范围可视化）
  await expect(bench.page.getByTestId('tab-multi-badge')).toHaveCount(2)
  // 浮层 absolute 不进布局：终端网格几何不变（FitAddon 老坑的守卫）
  const gridAfter = await bench.page.locator('.xterm-screen >> visible=true').first().boundingBox()
  expect(gridAfter).toEqual(gridBefore)

  // composer 的 Ctrl+Enter 一律拦下（防"以为批 1 台实际批 7 台"），路标提示前往浮层
  await bench.page.getByTestId('composer-input').fill('y')
  await bench.page.getByTestId('composer-input').press('Control+Enter')
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveAttribute('data-phase', 'pending')
  await expect(bench.page.getByTestId('multi-approval-signpost')).toContainText('已拦下')
  await bench.page.getByTestId('composer-input').fill('')

  // 浮层输入才是真决策面：空输入不批准，y + Ctrl+Enter 批整批
  await bench.page.getByTestId('multi-approval-input').press('Control+Enter')
  await expect(bench.page.getByTestId('multi-approval-error')).toContainText('不支持空输入')
  await bench.page.getByTestId('multi-approval-input').fill('y')
  await bench.page.getByTestId('multi-approval-input').press('Control+Enter')

  const done = await run
  expect(done.code).toBe(109)
  expect(done.stderr).toContain('逐台结果不一致')
  const json = parseJsonOut(done)
  expect(json.decision).toBe('approved')
  expect(json.results.map((r) => r.code).sort()).toEqual([0, 1])
  expect(json.results.every((r) => r.stdout.includes('flip'))).toBe(true)

  // 浮层跨三阶段：终态停留到用户关掉；执行中指示已按台收口
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveAttribute('data-phase', 'final')
  await expect(bench.page.getByTestId('approval-executing')).toHaveCount(0)
  await bench.page.getByTestId('multi-approval-close').click()
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveCount(0)

  // 审计：逐台 proposal + approved 决策各两条，batchId 一致
  const audit = readAudit(bench.userDataDir) as Array<AuditLine & { batchId?: string }>
  const proposals = audit.filter((l) => l.kind === 'proposal' && l.command === 'flipflop')
  const approvals = audit.filter(
    (l) => l.kind === 'decision' && l.decision === 'approved' && l.command === 'flipflop'
  )
  expect(proposals).toHaveLength(2)
  expect(approvals).toHaveLength(2)
  expect(approvals[0].batchId).toBeTruthy()
  expect(approvals[1].batchId).toBe(approvals[0].batchId)
})

test('--hosts 拒绝留言 102 / 超时撤回 125 / 目标忙 105；多机挂起期间单机 CLI 提案也 105', async () => {
  const bench = await launchBench({ extraHosts: [secondHost()] })
  await waitForPipe(bench)
  await connectHost(bench.page, 'web1-fake')
  await connectHost(bench.page, HOST2)
  await runCli(bench, ['use', 'web1-fake'])

  // 挂起期间：审批输入语义全局唯一——其他 CLI 提案（哪怕别的会话）一律 105
  const denyRun = runCli(bench, ['exec', '--hosts', `web1-fake,${HOST2}`, '--agent', 'cc', 'failcmd'])
  await expect(bench.page.getByTestId('multi-approval-card')).toBeVisible()
  const blocked = await runCli(bench, ['exec', '--agent', 'cc', 'failcmd'])
  expect(blocked.code).toBe(105)
  expect(blocked.stderr).toContain('多机')
  // 拒绝 + 留言：整批同命运，留言原文穿透 stderr
  await bench.page.getByTestId('multi-approval-input').fill('先别动，分开跑')
  await bench.page.getByTestId('multi-approval-input').press('Control+Enter')
  const denied = await denyRun
  expect(denied.code).toBe(102)
  expect(denied.stderr).toContain('先别动，分开跑')
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveCount(0)

  // 超时：整批主动撤回退 125，浮层消失
  const timedRun = runCli(bench, [
    'exec', '--hosts', `web1-fake,${HOST2}`, '--agent', 'cc', '--timeout', '2', 'failcmd'
  ])
  await expect(bench.page.getByTestId('multi-approval-card')).toBeVisible()
  const timed = await timedRun
  expect(timed.code).toBe(125)
  expect(timed.stderr).toContain('撤回')
  await expect(bench.page.getByTestId('multi-approval-card')).toHaveCount(0)

  // 任一目标终端忙 → 整批 105（活动会话是 web2-fake，让它跑交互命令占住）
  await bench.page.getByTestId('composer-input').click()
  await bench.page.keyboard.type('ask')
  await bench.page.keyboard.press('Enter')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')
  const busy = await runCli(bench, ['exec', '--hosts', `web1-fake,${HOST2}`, '--agent', 'cc', 'failcmd'])
  expect(busy.code).toBe(105)
  expect(busy.stderr).toContain('整批未执行')
  await bench.page.keyboard.type('done')
  await bench.page.keyboard.press('Enter')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
})

test('use 自动开会话：无会话时开标签页连接并返回建联包；主机列表也没有则 103', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)

  // 不手动连接：use 直接触发自动开会话（右边自己长出 tab）
  await expect(bench.page.getByTestId('cli-tab')).toHaveAttribute('data-state', 'inactive')
  const used = await runCli(bench, ['use', 'web1-fake', '--agent', 'cc'])
  expect(used.code).toBe(0)
  expect(used.stderr).toContain('自动打开标签页')
  expect(used.stdout).toContain('[主机档案]')
  expect(used.stdout).toContain('Ubuntu 22.04 Fake LTS')
  await expect(bench.page.getByTestId('session-tab')).toHaveCount(1)
  // 外部 agent 开的标签页落在 CLI 栏
  await expect(bench.page.getByTestId('cli-tab')).toHaveAttribute('data-state', 'active')

  // 绑定已建立：直接 exec 可用
  const ok = await runCli(bench, ['exec', '--agent', 'cc', 'whoami'])
  expect(ok.code).toBe(0)
  expect(ok.stdout).toContain('agent-saw-test-user')

  // 主机列表里也没有的别名：103 响亮失败，不开任何标签页
  const missing = await runCli(bench, ['use', 'no-such-host'])
  expect(missing.code).toBe(103)
  expect(missing.stderr).toContain('主机列表里也没有')
  await expect(bench.page.getByTestId('session-tab')).toHaveCount(1)
})

// ---------- push（cli-bridge-design 第十一节）----------

test('push：二进制批准落盘、--mode 八进制、覆盖接原 mode 走 backup-rename、拒绝/超时/坏参数各归各码', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  await runCli(bench, ['use', 'web1-fake', '--agent', 'cc'])

  const localDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-push-'))
  const binFile = join(localDir, 'app.bin')
  const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x0a, 0x0d, 0x00, 0x7f])
  writeFileSync(binFile, payload)

  // 本地文件缺失：CLI 侧快速失败 124（不连审批台，卡不该出现）
  const missing = await runCli(bench, [
    'push',
    join(localDir, 'nope.bin'),
    '/home/test/x',
    '--agent',
    'cc'
  ])
  expect(missing.code).toBe(124)
  expect(missing.stderr).toContain('本地文件不存在')

  // 远端相对路径：闸门 101（gateRemotePath 的路径纪律）
  const rel = await runCli(bench, ['push', binFile, 'relative/path', '--agent', 'cc'])
  expect(rel.code).toBe(101)

  // --mode 非八进制字符即拒（789 的 8/9 不是八进制位——Number 风格会静默吃掉它）
  const badMode = await runCli(bench, ['push', binFile, '/home/test/x', '--mode', '789'])
  expect(badMode.code).toBe(124)

  // 主流程：--mode 755 批准 → 二进制原样落盘、sha256 上 stdout、mode 生效
  const target = '/home/test/deploy/app.bin'
  const run1 = startCli(bench, [
    'push',
    binFile,
    target,
    '--mode',
    '755',
    '--agent',
    'cc',
    '--intent',
    '部署测试产物'
  ])
  const card = bench.page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'transfer')
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await expect(bench.page.getByTestId('approval-command')).toContainText('app.bin')
  await expect(bench.page.getByTestId('approval-command')).toContainText('mode 755')
  await expect(bench.page.getByTestId('approval-command')).toContainText('新建')
  await submitApproval(bench.page, 'y')
  const done1 = await run1.result
  expect(done1.code).toBe(0)
  expect(done1.stdout).toContain(createHash('sha256').update(payload).digest('hex'))
  const buf1 = ssh.writtenBuffers()[target]
  expect(buf1).toBeDefined()
  expect(Buffer.compare(buf1, payload)).toBe(0)
  expect(ssh.writtenModes()[target]).toBe(0o755)
  // CLI 栏：push 同样留卡，写明本地 → 远端与 mode
  await bench.page.getByTestId('cli-tab').click()
  const pushCard = bench.page.getByTestId('cli-activity-card').last()
  await expect(pushCard).toHaveAttribute('data-status', 'approved')
  await expect(pushCard).toContainText('cc · push')
  await expect(pushCard).toContainText(`${binFile} → ${target} · mode 755`)
  await expect(pushCard).toContainText('部署测试产物')

  // 覆盖：未显式 --mode 接原 mode（rename 换 inode，不接就变 umask 默认）；
  // fixture 不宣告 posix-rename，v3 RENAME 目标存在即失败 → backup-rename 三步是主路径
  const payload2 = Buffer.from('new-version-bytes\x00\x01', 'latin1')
  writeFileSync(binFile, payload2)
  const run2 = startCli(bench, ['push', binFile, target, '--agent', 'cc', '--intent', '覆盖部署'])
  await expect(card).toHaveAttribute('data-kind', 'transfer')
  await expect(bench.page.getByTestId('approval-command')).toContainText('覆盖')
  await submitApproval(bench.page, 'y')
  const done2 = await run2.result
  expect(done2.code).toBe(0)
  expect(Buffer.compare(ssh.writtenBuffers()[target], payload2)).toBe(0)
  expect(ssh.writtenModes()[target]).toBe(0o755)
  // 残骸清净：backup 三步走完不留 .part / .bak
  expect(
    Object.keys(ssh.writtenBuffers()).filter((k) => /\.tsubasa-[^/]*\.(part|bak)$/.test(k))
  ).toEqual([])

  // 拒绝：102，留言穿透 stderr
  const run3 = startCli(bench, ['push', binFile, target, '--agent', 'cc'])
  await expect(card).toHaveAttribute('data-kind', 'transfer')
  await submitApproval(bench.page, '先别发')
  const done3 = await run3.result
  expect(done3.code).toBe(102)
  expect(done3.stderr).toContain('先别发')

  // 超时撤回：125，卡自动消失（文件未上传）
  const run4 = startCli(bench, ['push', binFile, target, '--timeout', '1', '--agent', 'cc'])
  const done4 = await run4.result
  expect(done4.code).toBe(125)
  await expect(card).toHaveCount(0)

  // 敏感路径升 high——authorized_keys 恰是复审揪出的"初稿分类器漏掉"的路径；
  // high 档确认词 = 目标文件名
  const run5 = startCli(bench, [
    'push',
    binFile,
    '/home/test/.ssh/authorized_keys',
    '--agent',
    'cc',
    '--intent',
    '下发公钥'
  ])
  await expect(card).toHaveAttribute('data-risk', 'high')
  await submitApproval(bench.page, 'authorized_keys')
  const done5 = await run5.result
  expect(done5.code).toBe(0)

  // 审计：transfer 条目 actor 归位、sha256 是实传字节的 hash
  const transfers = readAudit(bench.userDataDir).filter((l) => l.kind === 'transfer')
  expect(transfers.length).toBeGreaterThanOrEqual(3)
  expect(transfers.every((l) => l.actor === 'cli:cc')).toBe(true)
  expect((transfers[0] as { sha256?: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
})

test('push：终端非空闲不挡审批（TUI 中建案）、exec 对照 105、--async + job 轮询到终态', async () => {
  const bench = await launchBench()
  await waitForPipe(bench)
  await connect(bench.page)
  await runCli(bench, ['use', 'web1-fake', '--agent', 'cc'])

  const localDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-push-'))
  const confFile = join(localDir, 'conf.txt')
  writeFileSync(confFile, 'tui-async-push\n')

  // 进 TUI：终端非空闲
  await bench.page.getByTestId('composer-input').fill('tui')
  await bench.page.getByTestId('composer-input').press('Enter')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'tui')

  // 对照组先行：exec 审批路径被"终端不可写（TUI）"挡（105，v0.13.4 忙因带原因）
  const execBusy = await runCli(bench, ['exec', '--agent', 'cc', 'apt-get install -y sl'])
  expect(execBusy.code).toBe(105)
  expect(execBusy.stderr).toContain('终端不可写')
  expect(execBusy.stderr).toContain('TUI')

  // push 走 SFTP 不碰 pty：同一时刻照常建案（忙检查只挡审批三因）
  const asyncRun = await runCli(bench, [
    'push',
    confFile,
    '/home/test/tui-conf.txt',
    '--async',
    '--agent',
    'cc',
    '--intent',
    'TUI 期间上传配置'
  ])
  expect(asyncRun.code).toBe(0)
  const proposalId = asyncRun.stdout.trim()
  expect(proposalId).toMatch(/^[0-9a-f-]{36}$/)
  const pending = await runCli(bench, ['job', proposalId])
  expect(pending.code).toBe(108)

  // 退出 TUI：卡还在（TUI 期间只是让位不是丢弃），批准后 job 轮询到终态
  await bench.page.keyboard.press('q')
  await expect(bench.page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await expect(bench.page.getByTestId('approval-card')).toHaveAttribute('data-kind', 'transfer')
  await submitApproval(bench.page, 'y')
  await expect.poll(async () => (await runCli(bench, ['job', proposalId])).code).toBe(0)
  const final = await runCli(bench, ['job', proposalId])
  expect(final.code).toBe(0)
  expect(final.stdout).toContain('已上传 /home/test/tui-conf.txt')
  expect(ssh.writtenFiles()['/home/test/tui-conf.txt']).toBe('tui-async-push\n')
})
