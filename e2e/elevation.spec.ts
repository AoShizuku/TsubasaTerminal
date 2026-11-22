import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  startFakeSshServer,
  type FakeFsEntry,
  type FakeSshServer,
  type FakeSudoConfig
} from './fixtures/fake-ssh-server'
import { startFakeLlmServer, type FakeLlmServer } from './fixtures/fake-llm-server'
import { activeTerminalText, launchApp, makeHost, type SeedLlmProfile, type TestHost } from './fixtures/launch'

/**
 * 登录后以 root 运行（identity-design）。主线是"登录时定死"：连接握手阶段
 * pty `sudo -i` + exec 探活，全过才装载 SI；任一步失败整会话退回登录用户 + 徽章带
 * 原因——**无静默、无身份分裂**。同版捆绑的闸门收紧（路径敏感度 always-on、root
 * 风险位移、trust.json 冻结）也在这里守。
 *
 * fake server 的 sudo 剧本按用例逐个起（探测点通/不通是服务器属性，不共享实例）。
 */

let llm: FakeLlmServer
let ssh: FakeSshServer | undefined
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  llm = await startFakeLlmServer()
})

test.afterAll(async () => {
  await llm.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  await ssh?.close()
  ssh = undefined
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

async function startServer(
  sudo: FakeSudoConfig,
  extra: { files?: Record<string, FakeFsEntry[]>; deniedDirs?: string[] } = {}
): Promise<FakeSshServer> {
  ssh = await startFakeSshServer({
    files: extra.files ?? {
      '/home/test': [{ name: 'www', type: 'dir' }],
      '/root': []
    },
    deniedDirs: extra.deniedDirs,
    sudo
  })
  return ssh
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 15000
  })
}

async function askAgent(page: Page, text: string): Promise<void> {
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
}

async function submitApproval(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('composer-input').press('Control+Enter')
}

/** composer 整行发送（等 prompt 态再发）；顺带让转录单元把当前 cwd 记实 */
async function runInTerminal(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await page.getByTestId('composer-input').fill(command)
  await page.getByTestId('composer-input').press('Enter')
}

/** 跑一条 echo 让 latestCwd 落到当前目录（cwd 取自已闭合单元，不是实时 OSC） */
async function settleCwd(page: Page): Promise<void> {
  await runInTerminal(page, 'echo cwd-probe')
  await expect.poll(async () => /^cwd-probe$/m.test(await activeTerminalText(page))).toBe(true)
}

function elevatedHost(port: number, overrides: Partial<TestHost> = {}): TestHost {
  return makeHost(port, { elevate: 'sudo', ...overrides })
}

function readAudit(userDataDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(userDataDir, 'audit.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

test('NOPASSWD 全过：pty 到 root、徽章安静 root、exec 走 sudo -D 包装且以 root 执行', { tag: '@daily' }, async () => {
  const server = await startServer({ pty: 'nopasswd', chdir: 'ok' })
  const launched = await launchApp([elevatedHost(server.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  // pty 已是 root（握手在 SI 装载前完成，转录从第一条命令起就是 root 的）
  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/root#')
  // 徽章：安静 root，无警示
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  // exec 平面跟随：白名单命令包装成 `sudo -n -D '<cwd>' -- <cmd>`，结果是 root 视角
  await settleCwd(page)
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
    'data-status',
    'executed'
  )
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-root')
  const whoami = server.execCommands().find((c) => c.includes('-- whoami'))
  expect(whoami).toBeTruthy()
  expect(whoami).toMatch(/^sudo -n -D '\/root' -- whoami$/)

  // 审计条目带 elevated 与 exec 平面有效身份
  await expect
    .poll(() =>
      readAudit(launched.userDataDir).some(
        (l) => l.kind === 'auto-exec' && l.command === 'whoami' && l.elevated === true && l.execUser === 'root'
      )
    )
    .toBe(true)
})

test('-S 模式：探活定死每 channel 自认证，密码不进屏幕/转录/审计', async () => {
  const server = await startServer({
    pty: 'password',
    password: 'sudopw',
    execN: false,
    execS: true,
    chdir: 'ok'
  })
  const launched = await launchApp(
    [elevatedHost(server.port, { sudoPassword: 'sudopw' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connect(page)

  await expect.poll(() => activeTerminalText(page)).toContain('root@fake:/root#')
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  await settleCwd(page)
  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-root')
  const whoami = server.execCommands().find((c) => c.includes('-- whoami'))
  expect(whoami).toMatch(/^sudo -S -p '' -D '\/root' -- whoami$/)

  // 密码只在 exec channel 的 stdin（加密信道内）：屏幕与审计里一个字节都不能有
  expect(await activeTerminalText(page)).not.toContain('sudopw')
  const audit = readFileSync(join(launched.userDataDir, 'audit.jsonl'), 'utf-8')
  expect(audit).not.toContain('sudopw')
})

test('降级 requiretty：exec 探活不通时整会话退回登录用户，徽章显示原因', async () => {
  const server = await startServer({
    pty: 'nopasswd',
    password: 'sudopw',
    execN: false,
    execS: false
  })
  const launched = await launchApp(
    [elevatedHost(server.port, { sudoPassword: 'sudopw' })],
    undefined,
    { llmProfiles: [anthropicProfile()] }
  )
  app = launched.app
  const page = launched.page
  await connect(page)

  // 具体失败原因由无 Electron 集成测试铺开；这里只守主进程通知到真实 UI 的接线，
  // 以及 all-or-nothing 降级后 exec 不再套 sudo。
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'degraded')
  expect(await activeTerminalText(page)).toContain('以 root 运行未生效')

  await askAgent(page, 'run-whoami')
  await expect(page.getByTestId('agent-assistant-msg').last()).toContainText('agent-saw-test-user')
  const whoami = server.execCommands().find((command) => command.includes('whoami'))
  expect(whoami).toBeTruthy()
  expect(whoami!.startsWith('sudo')).toBe(false)
})

test('路径敏感度 always-on：普通会话里白名单 cat 读 /etc/shadow 也转投审批台', async () => {
  const server = await startServer({})
  const launched = await launchApp([makeHost(server.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  await askAgent(page, 'run-cat-shadow')
  // 没有敏感度维度的话这条会自动执行（cat 白名单 + 自报 low）——必须停在审批台
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await expect(card).toContainText('敏感路径')
  // 免问通道同收：不可信任（无 `a`）、mid 档无空批
  await expect(page.getByTestId('approval-keys')).not.toContainText('a 批准')
  await expect(page.getByTestId('approval-keys')).toContainText('y 批准')

  await submitApproval(page, 'n')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'denied')
})

test('root 会话免问收紧：low 位移到 mid（空批消失），实验机 `a` 只记会话、不写 trust.json', async () => {
  const server = await startServer({ pty: 'nopasswd', chdir: 'ok' })
  const host = elevatedHost(server.port, { name: 'lab-root', envLevel: 'experiment' })
  const launched = await launchApp([host], undefined, { llmProfiles: [anthropicProfile()] })
  app = launched.app
  const page = launched.page
  await connect(page)
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  // mkdir 规则 low → root 位移 mid：卡片档位如实、空 Ctrl+Enter 资格消失
  await askAgent(page, 'propose-lowrisk')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-risk', 'mid')
  await expect(page.getByTestId('approval-keys')).toContainText('y 批准')
  await expect(page.getByTestId('approval-keys')).not.toContainText('直接批准')

  // 会话级 `a` 照常（授予时用户知道对象是 root）……
  await submitApproval(page, 'a')
  await expect.poll(() => activeTerminalText(page)).toContain('mkdir -p /tmp/lab')
  await expect(page.getByTestId('agent-trust-badge')).toBeVisible()

  // ……但 root 会话不写 trust.json——普通会话授予的信任与 root 免问必须隔离
  let persisted = ''
  try {
    persisted = readFileSync(join(launched.userDataDir, 'trust.json'), 'utf-8')
  } catch {
    // 文件不存在 = 从未写过，正确
  }
  expect(persisted).not.toContain(host.id)
})

// ============================================================================
// v0.11.2 — root 版 SFTP：三消费者随 getSftp 自动对齐
// ============================================================================

/**
 * 对照组是 identity.spec.ts 的 v0.11.0 用例：**同样的 deniedDirs=['/root'] 配置**，
 * 那边断言文件栏吐"权限不足"红字，这边断言真读到了内容。差别只有主机配置勾了
 * elevate='sudo'——`getSftp` 是全应用唯一的 SFTP 入口，换掉它返回的实例，
 * 文件栏一行不改地跟着切。
 */
test('root 版 SFTP：文件栏读到登录用户读不了的 /root（消费者一行不改）', async () => {
  const server = await startServer(
    { pty: 'nopasswd' },
    {
      files: {
        '/home/test': [{ name: 'www', type: 'dir' }],
        '/root': [{ name: 'secret.conf', type: 'file', size: 42 }]
      },
      deniedDirs: ['/root']
    }
  )
  const launched = await launchApp([elevatedHost(server.port)])
  app = launched.app
  const page = launched.page
  await connect(page)
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  await runInTerminal(page, 'cd /root')
  await page.getByRole('tab', { name: '文件' }).click()
  await expect(page.getByTestId('flat-entry').filter({ hasText: 'secret.conf' })).toBeVisible({
    timeout: 10000
  })
  await expect(page.getByTestId('file-error')).toHaveCount(0)
})

/**
 * `-S` 模式的单 channel 认证：接管 subsystem→exec、拦 `_init`、等 stderr 哨兵、
 * 写密码（不 EOF）、补发 INIT。fake server 按 Ubuntu 真机观察到的行为模拟 sudo——
 * 尤其"只吃到换行为止、剩余字节转交 sftp-server"这条，客户端"写密码后立即发
 * INIT"正是靠它成立。
 */
test('-S 模式 root 版 SFTP：哨兵→密码→INIT 跑通，rz/sz 桥白拿 root', async () => {
  const saveDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-elev-sftp-'))
  const server = await startServer(
    { pty: 'password', password: 'sudopw', execN: false, execS: true },
    {
      files: {
        '/home/test': [{ name: 'www', type: 'dir' }],
        '/root': [{ name: 'secret.conf', type: 'file', content: 'root-only-payload\n' }]
      },
      deniedDirs: ['/root']
    }
  )
  const launched = await launchApp([elevatedHost(server.port, { sudoPassword: 'sudopw' })], undefined, {
    env: { TSUBASATERMINAL_E2E_SAVE_DIR: saveDir }
  })
  app = launched.app
  const page = launched.page
  await connect(page)
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  // 桥调的就是 getSftp——运维的 sz 因此是白拿的（同路径在登录用户会话里是 EACCES）
  await runInTerminal(page, 'sz /root/secret.conf')
  await expect.poll(() => activeTerminalText(page)).toContain('✓ secret.conf')
  expect(readdirSync(saveDir)).toContain('secret.conf')
  expect(readFileSync(join(saveDir, 'secret.conf'), 'utf-8')).toContain('root-only-payload')

  // 密码走 channel stdin（加密信道内），屏幕上一个字节都不能有
  expect(await activeTerminalText(page)).not.toContain('sudopw')
})

/**
 * 闸门与身份变化同版捆绑的第二处（identity-design 捆绑表）：`write_file` 这一版
 * 才真正以 root 落盘，故 `gateWriteFile` 的分档在 root 会话整体上抬 mid→high。
 * 普通会话里 /home/test/notes.txt 是 mid（y 即可批），root 会话里要走确认词仪式。
 */
test('write_file 闸门随 SFTP 切 root 上抬：普通会话 mid 的写入在 root 会话要确认词', async () => {
  const server = await startServer({ pty: 'nopasswd' })
  const launched = await launchApp([elevatedHost(server.port)], undefined, {
    llmProfiles: [anthropicProfile()]
  })
  app = launched.app
  const page = launched.page
  await connect(page)
  await expect(page.getByTestId('tab-root-badge')).toHaveAttribute('data-phase', 'active')

  await askAgent(page, 'propose-write')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  // 同一条提案在普通会话是 mid（见 approval.spec.ts），这里被 root 位移到 high
  await expect(card).toHaveAttribute('data-risk', 'high')

  await page.getByTestId('write-viewer-toggle').click()
  await expect(page.getByTestId('write-viewer-content')).toContainText('hello-from-agent')

  // y 不再够用：确认词是目标文件名
  await submitApproval(page, 'y')
  await expect(page.getByTestId('approval-error')).toBeVisible()
  expect(server.writtenFiles()['/home/test/notes.txt']).toBeUndefined()

  await submitApproval(page, 'notes.txt')
  await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute('data-status', 'approved')
  await expect.poll(() => server.writtenFiles()['/home/test/notes.txt']).toContain('hello-from-agent')
})
