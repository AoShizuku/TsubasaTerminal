import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import type {
  ElevationInfo,
  HostEnvLevel,
  HostKeyInfo,
  SshConnectResult,
  SshExecResult,
  TerminalSize
} from '../shared/types'
import { getHostForConnect, type ConnectableHost } from './hosts'
import { checkHostKey } from './hostkeys'
import { auditLog } from './audit'
import { TransferPipeline } from './transfer'
import { runElevation, type ElevationIo, type ElevationState } from './elevation'
// terminalState 无任何反向依赖（纯状态 Map），不构成 ssh ↔ llm 新环
import { noteHumanPtyInput } from './llm/terminalState'
import {
  ElevatedSftpError,
  openElevatedSftp,
  SFTP_SUDO_SENTINEL,
  type ElevatedSftpOptions
} from './elevatedSftp'
import { shellQuote } from '../shared/shell'

/** 会话身份元信息（审计日志的"谁/哪台机器"，主进程自持，不信渲染进程回传） */
export interface SessionMeta {
  hostId: string
  host: string
  port: number
  username: string
  name: string
  /** 环境等级（v0.9 审批矩阵）：连接时从主机配置固化，闸门/审批/system prompt 只信这里 */
  envLevel: HostEnvLevel
  /** 身份切换已生效：握手 + 探活全过才 true；免问收紧/审计/位移只信这里 */
  elevated: boolean
}

/** 会话的身份切换状态：settled 收口前的调用必须先 await 它 */
interface SessionElevation {
  settled: Promise<ElevationState>
  /** 收口后的结果；null = 握手进行中 */
  state: ElevationState | null
  /** sudo 密码明文只停在主进程这份会话内存里，`-S` 模式喂 exec channel stdin 用 */
  password: string | null
}

interface Session {
  conn: Client
  stream: ClientChannel
  meta: SessionMeta
  /**
   * 建立本会话的窗口（v0.12.0 CLI 通道）：CLI 复用它当 `ToolContext.sender`——
   * CLI 发起的读屏请求走同一个渲染进程，将来的提案卡也弹在同一个右栏。
   * 左右两个窗口因此不是割裂的，是同一件事的两个视角。
   */
  sender: WebContents
  /** 传输管线：trzsz 过滤 + ZMODEM 拦截桥，输入输出都必须经它 */
  transfer: TransferPipeline
  /** 本会话的 shell integration 脚本远端路径（v0.9.5 重载用；未启用 SI 时为空） */
  siPath?: string
  /** 普通槽位：登录用户身份的 SFTP（连接即预热；SI 脚本落盘显式用它） */
  sftpPromise?: Promise<SFTPWrapper>
  /** 身份切换：仅 elevate='sudo' 的主机有 */
  elevation?: SessionElevation
  /**
   * root 槽位：探 3 成功的那条 channel 直接留作实例，**不懒建**——
   * 懒建与 all-or-nothing 矛盾（懒到中途才发现起不来时已来不及整会话退回）。
   */
  elevatedSftp?: SFTPWrapper
  /** 运行中断开后的重建（唯一可能中途降级的地方），并发调用共享同一次尝试 */
  elevatedSftpPromise?: Promise<SFTPWrapper>
  /** 推送身份切换徽章：中途降级也要能改 */
  notifyElevation?: (info: ElevationInfo) => void
}

const sessions = new Map<string, Session>()

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId)
}

export function getSessionMeta(sessionId: string): SessionMeta | null {
  return sessions.get(sessionId)?.meta ?? null
}

/** 会话的窗口：CLI 通道拿它当 sender，命令照样落在用户看得见的那个窗口 */
export function getSessionSender(sessionId: string): WebContents | null {
  return sessions.get(sessionId)?.sender ?? null
}

/**
 * shell integration 是否已装载（v0.12.0 建联包用）：主进程侧只知道"脚本写下去了"，
 * 渲染进程那份 integrationSeen（见过 133;A）主进程拿不到——故以脚本落盘为准，
 * 有转录单元则是更硬的证据。宁可乐观一点：说"可用"而实际没有，Agent 一次
 * list_transcript 空结果就自明；说"不可用"而实际可用，则会白白劝退它去读屏。
 */
export function sessionIntegrationLoaded(sessionId: string): boolean {
  return Boolean(sessions.get(sessionId)?.siPath)
}

/** 已连接会话清单（v0.12.0 CLI `sessions` / `use` 寻址）；顺序即 Map 插入序 */
export function listSessions(): Array<{ sessionId: string; meta: SessionMeta }> {
  return [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, meta: session.meta }))
}

/** 身份切换状态的渲染/系统提示视图；会话不存在为 null */
export function getElevationInfo(sessionId: string): ElevationInfo | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  if (!session.elevation) return { requested: false, active: false }
  const state = session.elevation.state
  if (!state) return { requested: true, active: false } // 握手进行中
  return { requested: true, active: state.active, reason: state.reason }
}

/**
 * 等身份切换收口（未启用立即回 null；降级回 state.active=false）。
 * Agent exec 包装与主机档案探测都必须先等这里——握手期间以登录用户抢跑，
 * 跑出来的就是本设计要消灭的身份分裂。
 */
export async function awaitElevation(sessionId: string): Promise<ElevationState | null> {
  const session = sessions.get(sessionId)
  if (!session?.elevation) return null
  return await session.elevation.settled
}

/** 登录用户身份的 SFTP（普通槽位）；连接建立后即被预热调用 */
function getPlainSftp(sessionId: string): Promise<SFTPWrapper> {
  const session = sessions.get(sessionId)
  if (!session) return Promise.reject(new Error('会话不存在或已断开'))
  if (!session.sftpPromise) {
    session.sftpPromise = new Promise((resolve, reject) => {
      session.conn.sftp((err, sftp) => {
        if (err) {
          session.sftpPromise = undefined
          reject(err)
          return
        }
        sftp.on('close', () => {
          const current = sessions.get(sessionId)
          if (current) current.sftpPromise = undefined
        })
        resolve(sftp)
      })
    })
  }
  return session.sftpPromise
}

/**
 * root 版 SFTP 的 sudo 命令（主进程模板拼装，不经 LLM——与 wrapBackground 同性质）。
 * password 传 null 即 `-n` 模式：两种模式不混，`-n` 下密码一个字节不发
 * （NOPASSWD 时 sudo 不读 stdin，写进去的字节会被 sftp-server 当协议流读走）。
 */
function buildElevatedSftpOptions(serverPath: string, password: string | null): ElevatedSftpOptions {
  const auth = password === null ? '-n' : `-S -p ${shellQuote(SFTP_SUDO_SENTINEL)}`
  return {
    serverCmd: `sudo ${auth} -- ${shellQuote(serverPath)}`,
    password,
    sentinel: SFTP_SUDO_SENTINEL,
    timeoutMs: 15000
  }
}

/** 接管成功的实例入 root 槽位；channel 断开时清空，下次 getSftp 走重建 */
function adoptElevatedSftp(sessionId: string, session: Session, sftp: SFTPWrapper): void {
  session.elevatedSftp = sftp
  sftp.on('close', () => {
    const current = sessions.get(sessionId)
    if (current !== session) return
    current.elevatedSftp = undefined
    current.elevatedSftpPromise = undefined
  })
}

/**
 * 运行中 channel 断开后的重建（罕见）。**这是全设计唯一可能出现中途降级的地方**——
 * 握手期的 all-or-nothing 已在结构上消灭了身份分裂，这里失败则如实反映在徽章上，
 * 不假装还是 root。
 */
function rebuildElevatedSftp(
  sessionId: string,
  session: Session,
  state: ElevationState
): Promise<SFTPWrapper> {
  if (!session.elevatedSftpPromise) {
    session.elevatedSftpPromise = openElevatedSftp(
      session.conn,
      buildElevatedSftpOptions(
        state.sftpServerPath ?? '',
        state.authMode === 'password' ? (session.elevation?.password ?? null) : null
      )
    )
      .then((sftp) => {
        adoptElevatedSftp(sessionId, session, sftp)
        return sftp
      })
      .catch((err: unknown) => {
        session.elevatedSftpPromise = undefined
        if (session.elevation?.state?.active) {
          const reason =
            err instanceof ElevatedSftpError && err.kind === 'api' ? 'error' : 'sftp-init'
          session.elevation.state = { ...session.elevation.state, active: false, reason }
          session.meta.elevated = false
          session.notifyElevation?.({ requested: true, active: false, reason })
        }
        throw err
      })
  }
  return session.elevatedSftpPromise
}

/**
 * 获取会话的 SFTP 通道。**root 会话返回以 root 运行的实例**——`getSftp`
 * 是全应用唯一的 SFTP 入口，换掉它返回的实例，三个消费者（文件栏 / ZMODEM 桥的
 * `rz`·`sz` / Agent `write_file`）一行不改地跟着切。
 *
 * `warmupSession` 是唯一显式留在普通槽位的调用方：SI 脚本写 /tmp 登录用户就够，
 * 不必要地用 root 写反而会让 sweepStaleSiScripts 误删同机其他用户的脚本。
 */
export async function getSftp(sessionId: string): Promise<SFTPWrapper> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('会话不存在或已断开')
  if (!session.elevation) return await getPlainSftp(sessionId)
  // 握手未收口就抢跑，跑出来的正是本设计要消灭的身份分裂
  const state = await session.elevation.settled
  if (!state.active) return await getPlainSftp(sessionId)
  if (session.elevatedSftp) return session.elevatedSftp
  return await rebuildElevatedSftp(sessionId, session, state)
}

/**
 * Shell integration 装载脚本：完整 OSC 133 时序（VS Code 语义）——
 * D;退出码 → OSC 7 cwd（file://user@host/path，userinfo 位携带 id -un 上报 pty
 * 身份，v0.11.0）→ A（prompt 开始）→ [prompt 文本] → B（prompt 结束/输入开始）
 * → [用户输入回显] → C（命令被接受、输出开始）→ [输出] → 回到 D。
 * B/C 供结构化转录切"命令-输出-退出码"单元。
 * bash：B 挂 PS1 末尾、C 挂 PS0（bash ≥ 4.4）；zsh：B 挂 PROMPT 末尾、C 挂 preexec。
 * 仅 bash/zsh 生效，其余 shell 静默无操作。
 */
const SHELL_INTEGRATION_SCRIPT = `# Tsubasa Terminal shell integration
if [ -z "$__TSUBASATERMINAL_SI_DONE" ]; then
__TSUBASATERMINAL_SI_DONE=1
# pty 身份：uid 在同一 shell 进程内不会变，source 时算一次即可；
# sudo su / su - 换 shell 后重载会在新进程里重算，正好拿到新身份
__TSUBASATERMINAL_USER=$(id -un 2>/dev/null)
# OSC 出口统一走此函数：tmux 内包 DCS passthrough（tmux 会吞裸 OSC；需 allow-passthrough，
# 3.3 前默认放行），包裹时内嵌 ESC 按协议加倍。$1 = OSC 正文（不含 ESC ] 前缀与 BEL）
__tsubasaterminal_seq() {
  if [ -n "$TMUX" ]; then
    printf '\\033Ptmux;\\033\\033]%s\\007\\033\\\\' "$1"
  else
    printf '\\033]%s\\007' "$1"
  fi
}
__tsubasaterminal_report() {
  local __st=$?
  __tsubasaterminal_seq "133;D;$__st"
  __tsubasaterminal_seq "7;file://\${__TSUBASATERMINAL_USER:+\${__TSUBASATERMINAL_USER}@}\${HOSTNAME:-localhost}$PWD"
  __tsubasaterminal_seq "133;A"
}
if [ -n "$ZSH_VERSION" ]; then
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(__tsubasaterminal_report)
  __tsubasaterminal_preexec() { __tsubasaterminal_seq '133;C'; }
  preexec_functions+=(__tsubasaterminal_preexec)
  PS1="\${PS1}%{$(printf '\\033]133;B\\007')%}"
elif [ -n "$BASH_VERSION" ]; then
  PROMPT_COMMAND="__tsubasaterminal_report\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
  # B/C 用 \\$() 延迟求值：每个 prompt 现算，进出 tmux 都能选对包裹形态
  PS1="\${PS1}\\[\\$(__tsubasaterminal_seq '133;B')\\]"
  PS0="\${PS0}\\$(__tsubasaterminal_seq '133;C')"
fi
fi
`

/**
 * tmux 会话池 bootstrap（v0.9 断线保活）：优先 attach 池中无人连着的 tsubasaterminal-N 会话
 * （断线重连回到原 shell 现场），没有空闲则新建入池；新建时开 allow-passthrough
 * 并把 shell integration source 进内层 shell（attach 旧会话不注入——可能正在 TUI 里）。
 * 无 tmux / 已在 tmux 内则直接降级为普通 source。
 */
function buildTmuxBootstrap(bootPath: string, siPath: string | null): string {
  // source 后不删：sudo su 等换 shell 会甩掉 OSC 133，脚本留着才能重载
  const sourceLine = siPath ? `. ${siPath}` : ''
  return `# Tsubasa Terminal tmux bootstrap
rm -f ${bootPath}
if command -v tmux >/dev/null 2>&1 && [ -z "$TMUX" ]; then
  __ss_pick=$(tmux list-sessions -F '#S #{session_attached}' 2>/dev/null | awk '$1 ~ /^tsubasaterminal-/ && $2 == 0 { print $1; exit }')
  if [ -z "$__ss_pick" ]; then
    __ss_i=1
    while tmux has-session -t "=tsubasaterminal-$__ss_i" 2>/dev/null; do __ss_i=$((__ss_i+1)); done
    __ss_pick="tsubasaterminal-$__ss_i"
    # send-keys 用 pane_id 精确定位：\`=name\` 精确匹配在 tmux 3.2a 的 target-pane
    # 上不生效（can't find pane，Ubuntu 真机踩坑），pane_id（%N）才是全版本精确形态
    __ss_pane=$(tmux new-session -d -s "$__ss_pick" -P -F '#{pane_id}')
    tmux set-option -g allow-passthrough on 2>/dev/null
    # 禁掉 tmux client 的 alternate screen（smcup/rmcup）：attach 若切备用屏，
    # composer 会把整个 tmux 会话判成 TUI 让位（Ubuntu 真机踩坑）。副作用（server 级
    # option）：本机其他终端 attach 的 tmux 画面也会留在 scrollback，属可接受偏好
    tmux set-option -g terminal-overrides '*:smcup@:rmcup@' 2>/dev/null
    ${siPath ? `tmux send-keys -t "$__ss_pane" '${sourceLine}' Enter` : ':'}
  else
    __ss_pane=$(tmux list-panes -a -F '#{session_name} #{pane_id}' 2>/dev/null | awk -v s="$__ss_pick" '$1 == s { print $2; exit }')
    case "$(tmux display-message -p -t "$__ss_pane" '#{pane_current_command}' 2>/dev/null)" in
      bash|-bash|zsh|-zsh|sh|-sh) : ;;
      *) __ss_pane='' ;;
    esac
  fi
  # attach 后踢一个空回车触发新 prompt：OSC passthrough 只发给已连接的 client，
  # attach 前发出的 133 序列已丢、tmux 重绘也不重放 OSC——不踢这一脚 composer 会停在
  # none 直到用户自己按回车。复用路径仅当 pane 正处于 shell 时才踢（正在 TUI 不打扰）
  [ -n "$__ss_pane" ] && { (sleep 1; tmux send-keys -t "$__ss_pane" Enter) >/dev/null 2>&1 & }
  exec tmux attach-session -t "=$__ss_pick"
fi
${sourceLine || ':'}
`
}

/**
 * 陈旧 SI 脚本回收：source 后不再自删（换 shell 要能重载），改为每次连接
 * 扫一遍 /tmp 收掉一天前的遗留——那是断线没走到 disconnect 的场景。按 mtime 卡一天，
 * 同机其他活跃会话的脚本不会被误伤。走 SFTP 而非 exec：独立 exec channel 的调用
 * 次数是补全预取用例的守卫断言，不该被清理动作打乱。
 */
function sweepStaleSiScripts(sftp: SFTPWrapper): void {
  const cutoffSeconds = Date.now() / 1000 - 86400
  sftp.readdir('/tmp', (err, entries) => {
    if (err || !entries) return
    for (const entry of entries) {
      if (!/^\.tsubasaterminal-si-.+\.sh$/.test(entry.filename)) continue
      if ((entry.attrs?.mtime ?? Infinity) > cutoffSeconds) continue
      sftp.unlink(`/tmp/${entry.filename}`, () => {
        /* 别人留下的同名文件删不掉是正常的 */
      })
    }
  })
}

/** 预热 SFTP 通道；按配置写入 shell integration / tmux bootstrap 脚本并 source（失败静默降级） */
async function warmupSession(
  sessionId: string,
  shellIntegration: boolean,
  tmuxKeepalive: boolean
): Promise<void> {
  try {
    // 显式走普通槽位：SI 脚本落 /tmp 登录用户就能写，不需要 root；
    // 用 root 写反而会让 sweepStaleSiScripts 有权删掉同机其他用户的遗留脚本
    const sftp = await getPlainSftp(sessionId)
    if (!shellIntegration && !tmuxKeepalive) return
    const session = sessions.get(sessionId)
    if (!session) return
    const writeRemote = (path: string, content: string, mode: number): Promise<void> =>
      new Promise((resolve, reject) =>
        sftp.writeFile(path, content, { mode }, (err) => (err ? reject(err) : resolve()))
      )
    // 文件名带 sessionId 随机段是安全必需：/tmp 人人可创建文件，固定名会被同机其他
    // 用户预先占坑，我们 source 它就是任意代码执行。0644 是为 `su - deploy` 这类
    // 切到另一个普通用户的重载场景（root 本就无视权限位，sudo su 不靠这一条）
    // ——脚本内容只有 OSC 序列，无机密
    const siPath = shellIntegration ? `/tmp/.tsubasaterminal-si-${sessionId.slice(0, 8)}.sh` : null
    if (siPath) {
      await writeRemote(siPath, SHELL_INTEGRATION_SCRIPT, 0o644)
      session.siPath = siPath
      sweepStaleSiScripts(sftp)
    }
    if (tmuxKeepalive) {
      const bootPath = `/tmp/.tsubasaterminal-boot-${sessionId.slice(0, 8)}.sh`
      // boot 脚本是一次性的（自身首行 rm -f），0600 即可
      await writeRemote(bootPath, buildTmuxBootstrap(bootPath, siPath), 0o600)
      session.transfer.writeInput(`. ${bootPath}\r`)
    } else if (siPath) {
      session.transfer.writeInput(`. ${siPath}\r`)
    }
  } catch {
    // SFTP 不可用或写入失败：降级为无 shell integration 的基础体验
  }
}

function expandHome(filePath: string): string {
  return filePath.startsWith('~') ? join(homedir(), filePath.slice(1)) : filePath
}

async function findDefaultKey(): Promise<string | null> {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const keyPath = join(homedir(), '.ssh', name)
    try {
      await fs.access(keyPath)
      return keyPath
    } catch {
      // 继续找下一个
    }
  }
  return null
}

async function buildConnectConfig(config: ConnectableHost): Promise<ConnectConfig> {
  // 仅供 e2e 把「服务端接受 TCP 后永不发 SSH 握手」压到亚秒级。与 index.ts 的后台
  // 车道一样锁在开发态：打包产物里这个分支根本不存在，慢链路不可能被测试时钟误伤。
  const readyTimeoutOverride = is.dev
    ? Number(process.env['TSUBASATERMINAL_E2E_READY_TIMEOUT_MS'])
    : Number.NaN
  const readyTimeout =
    Number.isFinite(readyTimeoutOverride) && readyTimeoutOverride >= 100
      ? readyTimeoutOverride
      : 15000
  const base: ConnectConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    readyTimeout,
    keepaliveInterval: 15000,
    // 主机密钥以 sha256 哈希传给 hostVerifier
    hostHash: 'sha256'
  }
  if (config.authType === 'privateKey') {
    const keyPath = config.privateKeyPath?.trim()
      ? expandHome(config.privateKeyPath.trim())
      : await findDefaultKey()
    if (!keyPath) throw new Error('未找到私钥文件，请在主机配置中指定私钥路径')
    base.privateKey = await fs.readFile(keyPath)
    if (config.passphrase) base.passphrase = config.passphrase
  } else {
    base.password = config.password ?? ''
    // 部分服务器只开 keyboard-interactive，不接受 password 认证
    base.tryKeyboard = true
  }
  return base
}

/**
 * Agent 独立执行：与 ssh:exec 同为一次性 exec channel（无 pty），
 * 独立超时（Agent 诊断命令比补全查询更耗时）+ 64KB 截断标注 + abort 联动
 * （用户 stop 时 close 在跑的 channel）。命令必须先过 gate.ts 白名单闸门。
 *
 * opts（v0.11.1 身份切换）：
 * - stdin：打开 channel 即写入并 EOF（探活套件自带认证载荷）；
 * - sudoAuth：root 会话 `-S` 模式自动喂 sudo 密码 + 立刻 EOF——exec 命令不消费
 *   stdin，EOF 保证万一密码错时 sudo 二次读到 EOF 直接失败而不是挂到超时；
 *   `-n` 模式此选项是空操作（两种模式不混，密码一个字节不发）。
 */
export function execOnSession(
  sessionId: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  opts?: { stdin?: string; sudoAuth?: boolean }
): Promise<SshExecResult & { truncated?: boolean }> {
  const session = sessions.get(sessionId)
  if (!session) return Promise.resolve({ ok: false, error: '会话不存在或已断开' })
  let stdin = opts?.stdin
  if (opts?.sudoAuth) {
    const elevation = session.elevation
    if (elevation?.state?.active && elevation.state.authMode === 'password' && elevation.password) {
      stdin = `${elevation.password}\n`
    }
  }
  return new Promise((resolve) => {
    session.conn.exec(command, (err, stream) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      if (stdin !== undefined) {
        stream.write(stdin)
        stream.end()
      }
      let out = ''
      let truncated = false
      const finish = (result: SshExecResult & { truncated?: boolean }): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        stream.close()
        finish({ ok: false, error: '已被用户中止' })
      }
      const timer = setTimeout(() => {
        stream.close()
        finish({ ok: false, error: `执行超时（${Math.round(timeoutMs / 1000)}s）` })
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      const collect = (data: Buffer): void => {
        if (out.length < 65536) out += data.toString('utf-8')
        else truncated = true
      }
      stream.on('data', collect)
      stream.stderr.on('data', collect)
      stream.on('close', (code: number | null) => {
        finish({ ok: true, stdout: out.slice(0, 65536), exitCode: code ?? undefined, truncated })
      })
    })
  })
}

export function registerSshHandlers(): void {
  ipcMain.handle(
    'ssh:connect',
    async (event, sessionId: string, hostId: string, size: TerminalSize): Promise<SshConnectResult> => {
      if (sessions.has(sessionId)) return { ok: true }

      const config = await getHostForConnect(hostId)
      if (!config) return { ok: false, error: '主机配置不存在，请刷新主机列表' }

      const sender = event.sender
      const conn = new Client()
      let hostKeyInfo: HostKeyInfo | undefined
      try {
        const connectConfig = await buildConnectConfig(config)
        connectConfig.hostVerifier = ((hashHex: string, verify: (valid: boolean) => void): void => {
          const fingerprint =
            'SHA256:' + Buffer.from(hashHex, 'hex').toString('base64').replace(/=+$/, '')
          void checkHostKey(config.host, config.port, fingerprint).then((info) => {
            hostKeyInfo = info
            verify(info.status !== 'mismatch')
          })
        }) as unknown as ConnectConfig['hostVerifier']

        if (config.authType !== 'privateKey') {
          conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
            finish(prompts.map(() => config.password ?? ''))
          })
        }
        const stream = await new Promise<ClientChannel>((resolve, reject) => {
          conn
            .on('ready', () => {
              conn.shell(
                { term: 'xterm-256color', cols: size.cols || 80, rows: size.rows || 24 },
                (err, shellStream) => (err ? reject(err) : resolve(shellStream))
              )
            })
            .on('error', reject)
            .connect(connectConfig)
        })

        const sendData = (data: Buffer): void => {
          if (!sender.isDestroyed()) sender.send('ssh:data', sessionId, data)
        }
        // 传输管线：ssh2 stream 与 IPC 之间的唯一数据出口（trzsz + ZMODEM 桥，
        // 传输数据在此消费即对下游转录/Agent 通道天然不可见——transfer-design.md）
        const transfer = new TransferPipeline({
          transientEnabled: config.shellIntegration !== false,
          terminalColumns: size.cols || 80,
          getWindow: () => (sender.isDestroyed() ? null : BrowserWindow.fromWebContents(sender)),
          sendOutput: sendData,
          sendTransient: (data) => {
            if (!sender.isDestroyed()) sender.send('ssh:data:transient', sessionId, data)
          },
          onZmodem: (kind) => {
            if (!sender.isDestroyed()) sender.send('ssh:zmodem', sessionId, kind)
            void auditLog(sessionId, {
              kind: 'transfer',
              command: `(zmodem-detected) 已中止 ZMODEM，转 SFTP 桥`,
              via: 'bridge',
              direction: kind
            })
          },
          onTrzszEnd: (info) =>
            void auditLog(sessionId, {
              kind: 'transfer',
              command: `(trzsz) ${info.direction === 'download' ? 'tsz 下载' : 'trz 上传'}`,
              via: 'trzsz',
              direction: info.direction,
              files: info.sentFiles,
              savedTo: info.saveDir,
              durationMs: info.durationMs
            }),
          writeToStream: (data) => stream.write(data)
        })

        const session: Session = {
          conn,
          stream,
          transfer,
          sender,
          meta: {
            hostId: config.id,
            host: config.host,
            port: config.port,
            username: config.username,
            name: config.name,
            envLevel: config.envLevel ?? 'none',
            elevated: false
          }
        }
        sessions.set(sessionId, session)
        // 三件套之一：连接即预热 SFTP 通道；顺带按配置装载 shell integration / tmux 保活
        const doWarmup = (): void =>
          void warmupSession(sessionId, config.shellIntegration !== false, config.tmuxKeepalive === true)
        if (config.elevate === 'sudo') {
          // 身份切换握手：先切 root + 探活，**全过才装载 SI**——转录从
          // 第一条命令起就是确定身份的（手动 sudo su 结构上拿不到的时序）。握手窗口
          // 无 SI、无 OSC 133，输入输出天然不进转录/审计/主机记忆，密码不靠 redaction 兜底。
          const io: ElevationIo = {
            writeInput: (data) => transfer.writeInput(data),
            onOutput: (cb) => {
              const listener = (data: Buffer): void => cb(data.toString('utf-8'))
              stream.on('data', listener)
              return () => {
                stream.removeListener('data', listener)
              }
            },
            exec: (command, timeoutMs, stdin) =>
              execOnSession(sessionId, command, timeoutMs, undefined, { stdin }),
            password: config.sudoPassword ?? null,
            sftpServerPath: config.sftpServerPath ?? null,
            // 探 3：完整起一次 root 版 SFTP，成功的 channel 直接留作
            // 会话实例（不懒建）。authMode 由探 1 定死后传进来，不在这里重算
            openSftp: async (serverPath, authMode) => {
              try {
                const sftp = await openElevatedSftp(
                  conn,
                  buildElevatedSftpOptions(
                    serverPath,
                    authMode === 'password' ? (config.sudoPassword ?? null) : null
                  )
                )
                adoptElevatedSftp(sessionId, session, sftp)
                return null
              } catch (err) {
                // 内部 API 不匹配（ssh2 升级碎了）与 sudo/sftp-server 起不来分开报，
                // 徽章原因才有信息量
                return err instanceof ElevatedSftpError && err.kind === 'api' ? 'error' : 'sftp-init'
              }
            }
          }
          session.notifyElevation = (info: ElevationInfo): void => {
            if (!sender.isDestroyed()) sender.send('ssh:elevation', sessionId, info)
          }
          const settled = runElevation(io).catch(
            (): ElevationState => ({ active: false, reason: 'error', authMode: 'none', cwdMode: 'chdir' })
          )
          session.elevation = { settled, state: null, password: config.sudoPassword ?? null }
          void settled.then((state) => {
            const current = sessions.get(sessionId)
            if (!current || current !== session) return // 握手期间已断开/重连
            session.elevation!.state = state
            session.meta.elevated = state.active
            session.notifyElevation?.({
              requested: true,
              active: state.active,
              reason: state.reason
            })
            doWarmup()
          })
        } else {
          doWarmup()
        }

        stream.on('data', (data: Buffer) => transfer.feedServerOutput(data))
        // pty 下 stderr 几乎不用；不过传输过滤，直通
        stream.stderr.on('data', sendData)

        // 干净退出（exit/logout → 远端 shell 报了退出状态）与网络断开的区分：
        // 只有非干净关闭才是渲染进程自动重连的触发条件
        let cleanExit = false
        stream.on('exit', () => {
          cleanExit = true
        })
        const finish = (): void => {
          // stream close 与 conn close 都会触发，用 map 删除结果去重
          if (sessions.delete(sessionId)) {
            transfer.dispose()
            conn.end()
            if (!sender.isDestroyed()) sender.send('ssh:exit', sessionId, cleanExit)
          }
        }
        stream.on('close', finish)
        conn.on('close', finish)
        conn.on('error', (err) => {
          if (!sender.isDestroyed()) sender.send('ssh:error', sessionId, err.message)
        })

        return { ok: true, hostKey: hostKeyInfo }
      } catch (err) {
        conn.end()
        let message = err instanceof Error ? err.message : String(err)
        if (hostKeyInfo?.status === 'mismatch') {
          message =
            `主机密钥已改变！已存指纹 ${hostKeyInfo.storedFingerprint}，本次收到 ${hostKeyInfo.fingerprint}。` +
            '可能存在中间人攻击；若确认是主机重装等正常变更，请在左栏主机信息面板中重置指纹后重试。'
        }
        return { ok: false, error: message, hostKey: hostKeyInfo }
      }
    }
  )

  ipcMain.on('ssh:input', (_event, sessionId: string, data: string) => {
    // 人的输入先标记会话不可写再转发：渲染层的状态上报与这里的写入
    // 走两条 IPC，先标后写才关得掉"上报在路上、Agent 命令已挤进来"的竞态窗口
    noteHumanPtyInput(sessionId)
    // 经传输管线：trzsz 传输中的输入由 filter 接管（Ctrl+C 中止），空闲直通
    sessions.get(sessionId)?.transfer.writeInput(data)
  })

  /**
   * 重载 shell integration：`sudo su` / `su -` / 手动 `bash` 起的新 shell
   * 是全新进程，PS1/PS0/PROMPT_COMMAND 都不是 exported（sudo 还 env_reset），OSC 133
   * 时序就此断掉，composer 永远等不到 133;A 而卡在 running。往 pty 写一行 source
   * 让新 shell 重新挂上，比让用户 exit 回原 shell 少一次现场丢失。
   * 写 pty 与 ssh:input 同权限级别，不涉及新的能力面。
   */
  ipcMain.handle('ssh:reinject-si', (_event, sessionId: string): boolean => {
    const session = sessions.get(sessionId)
    if (!session?.siPath) return false
    session.transfer.writeInput(`. ${session.siPath}\r`)
    return true
  })

  // 独立 exec channel：不打扰用户终端的一次性命令（Tab 补全实时查询首个用户）。
  // 权限级别与 ssh:input 相同；Agent 将来走这里必须先过主进程白名单闸门。
  ipcMain.handle(
    'ssh:exec',
    async (_event, sessionId: string, command: string): Promise<SshExecResult> => {
      const session = sessions.get(sessionId)
      if (!session) return { ok: false, error: '会话不存在或已断开' }
      return new Promise((resolve) => {
        session.conn.exec(command, (err, stream) => {
          if (err) {
            resolve({ ok: false, error: err.message })
            return
          }
          let out = ''
          const timer = setTimeout(() => {
            stream.close()
            resolve({ ok: false, error: '执行超时' })
          }, 3000)
          stream.on('data', (data: Buffer) => {
            // 输出上限 64KB，防远端超量输出拖垮渲染进程
            if (out.length < 65536) out += data.toString('utf-8')
          })
          stream.stderr.on('data', () => {
            /* 补全场景忽略 stderr */
          })
          stream.on('close', (code: number | null) => {
            clearTimeout(timer)
            resolve({ ok: true, stdout: out, exitCode: code ?? undefined })
          })
        })
      })
    }
  )

  ipcMain.on('ssh:resize', (_event, sessionId: string, cols: number, rows: number) => {
    const session = sessions.get(sessionId)
    if (!session) return
    session.stream.setWindow(rows, cols, 0, 0)
    session.transfer.setColumns(cols)
  })

  ipcMain.handle('ssh:disconnect', (_event, sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    session.transfer.dispose()
    session.stream.end()
    const closeConn = (): void => {
      session.conn.end()
    }
    const siPath = session.siPath
    if (!siPath || !session.sftpPromise) {
      closeConn()
      return
    }
    // 主动断开是唯一能确保连接还活着的时机，顺手删掉本会话的 SI 脚本（网络断开走不到
    // 这里，遗留交给下次连接的陈旧回收）。不 await：unlink 回完或 1s 兜底先到者胜
    const fallback = setTimeout(closeConn, 1000)
    void session.sftpPromise
      .then((sftp) =>
        sftp.unlink(siPath, () => {
          clearTimeout(fallback)
          closeConn()
        })
      )
      .catch(() => {
        clearTimeout(fallback)
        closeConn()
      })
  })
}

export function disposeAllSessions(): void {
  for (const [, session] of sessions) {
    session.transfer.dispose()
    session.stream.end()
    session.conn.end()
  }
  sessions.clear()
}
