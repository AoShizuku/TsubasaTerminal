import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import type { ThinkingLevel } from '../../src/shared/types'

export interface TestHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  envLevel?: 'none' | 'production' | 'experiment'
  tmuxKeepalive?: boolean
  /** 本机输入方式；缺省跟随全局 */
  inputMode?: 'composer' | 'native'
  /** 登录后以 root 运行；sudoPassword 走明文字段，主进程读取时自动迁移加密 */
  elevate?: 'none' | 'sudo'
  sudoPassword?: string
  /** 本机知识：人写、直插 system prompt 最前 */
  knowledge?: string
}

const appRoot = resolve(__dirname, '..', '..')
let hostSeq = 0

export function makeHost(port: number, overrides: Partial<TestHost> = {}): TestHost {
  hostSeq += 1
  return {
    id: `e2e-host-${hostSeq}`,
    name: `fake-${hostSeq}`,
    host: '127.0.0.1',
    port,
    username: 'test',
    authType: 'password',
    password: 'pw',
    ...overrides
  }
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

export interface SeedLlmProfile {
  id: string
  name: string
  provider: 'anthropic' | 'openai-compatible'
  wireFormat?: 'chat.completions' | 'responses'
  baseURL: string
  model: string
  /**
   * 思考档位。联合里的对象形态是 v0.10.3 及更早的落盘格式，
   * 只为迁移用例保留——正常用例传档位字符串
   */
  thinking?: ThinkingLevel | { enabled: boolean; budgetTokens?: number }
  /** token 圆环分母（缺省 UI 按 200k 显示） */
  contextWindow?: number
  apiKey: string
}

export interface LaunchOptions {
  /** 安装产物验收：传入实际安装目录里的 exe，应用参数不再使用开发态的 '.'。 */
  executablePath?: string
  /** 预置 LLM profile（apiKey 走 plain: 降级格式，主进程解密路径兼容）并设首个为活动 */
  llmProfiles?: SeedLlmProfile[]
  /** 额外 settings.json 字段（如 completionLlmEnabled），与 llmProfiles 预置合并 */
  settings?: Record<string, unknown>
  /** 额外环境变量（如 TSUBASATERMINAL_SUPPRESS_NOTIFY 压掉审批挂起的桌面通知） */
  env?: Record<string, string>
  /** 预置 userData 下的任意文件（相对路径 → 内容），如 experience/index.jsonl */
  seedFiles?: Record<string, string>
}

/**
 * 启动应用。默认新建隔离的 userData 目录并预置 hosts.json；
 * 传入 existingUserDataDir 时复用该目录（用于"重启后持久化"断言）。
 */
export async function launchApp(
  hosts: TestHost[],
  existingUserDataDir?: string,
  options?: LaunchOptions
): Promise<LaunchedApp> {
  const userDataDir = existingUserDataDir ?? mkdtempSync(join(tmpdir(), 'tsubasaterminal-e2e-'))
  if (!existingUserDataDir) {
    writeFileSync(join(userDataDir, 'hosts.json'), JSON.stringify(hosts, null, 2), 'utf-8')
  }
  if (options?.llmProfiles?.length || options?.settings) {
    const seededSettings: Record<string, unknown> = {
      redactionEnabled: true,
      ...(options?.settings ?? {})
    }
    if (options?.llmProfiles?.length) {
      const stored = options.llmProfiles.map(({ apiKey, ...rest }) => ({
        ...rest,
        apiKeyEnc: 'plain:' + Buffer.from(apiKey, 'utf-8').toString('base64')
      }))
      writeFileSync(join(userDataDir, 'llm-profiles.json'), JSON.stringify(stored, null, 2), 'utf-8')
      seededSettings.activeLlmProfileId ??= stored[0].id
    }
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seededSettings, null, 2), 'utf-8')
  }
  for (const [rel, content] of Object.entries(options?.seedFiles ?? {})) {
    const target = join(userDataDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf-8')
  }
  const app = await _electron.launch({
    executablePath: options?.executablePath,
    // 并行跑 e2e 时多个窗口互相遮挡，Chromium 会给被遮挡窗口降级渲染并节流定时器，
    // :hover 之类的样式重算跟着延后（token 圆环 tooltip 用例在 4 worker 下踩过）
    args: [
      ...(options?.executablePath ? [] : ['.']),
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ],
    cwd: appRoot,
    env: {
      ...(process.env as Record<string, string>),
      TSUBASATERMINAL_USER_DATA: userDataDir,
      ...(options?.env ?? {})
    }
  })
  const page = await app.firstWindow()
  // 就绪判据（v0.13.11 起）：等标签栏的折叠把手而不是左栏标题——布局记忆让"左栏折叠着
  // 启动"成为合法状态，左栏文案此时不可见，按它等会超时。把手两态常驻、永远在中栏
  await page.getByTestId('toggle-left-pane').waitFor()
  return { app, page, userDataDir }
}

/**
 * 打开设置并落到指定分节。弹窗从单列滚动流改成左导航 + 右内容之后，
 * "打开设置"不再等于"看得见任何一项"——分节以外的控件根本不在 DOM 里。
 * 第一节（外观）是默认落点，不必传。
 */
export async function openSettings(
  page: Page,
  section?: 'appearance' | 'knowledge' | 'models' | 'security' | 'cli' | 'about'
): Promise<void> {
  await page.getByTestId('open-settings').click()
  if (section && section !== 'appearance') {
    await page.getByTestId(`settings-nav-${section}`).click()
  }
}

/** 主机表单的分页同理：常规是默认落点，其余要先点 tab */
export async function hostFormTab(
  page: Page,
  tab: 'general' | 'session' | 'knowledge'
): Promise<void> {
  await page.getByTestId(`form-tab-${tab}`).click()
}

export function readHostsFile(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'hosts.json'), 'utf-8')
  } catch {
    return ''
  }
}

export function readSettingsFile(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'settings.json'), 'utf-8')
  } catch {
    return ''
  }
}

/** 读当前激活会话的终端屏幕文本（走渲染进程的 window.__tsubasaterminal 钩子） */
export async function activeTerminalText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hook = (
      window as unknown as {
        __tsubasaterminal?: { getActiveTerminalText: () => string | null }
      }
    ).__tsubasaterminal
    return hook?.getActiveTerminalText() ?? ''
  })
}
