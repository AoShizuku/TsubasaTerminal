import type { ElevationFailReason } from '../shared/types'
import { buildSftpServerProbe, parseSftpServerPath } from './elevatedSftp'
import { shellQuote } from '../shared/shell'

/**
 * 登录后以 root 运行（identity-design）：pty `sudo -i` 握手 + exec 通道
 * 探活，all-or-nothing——任一步失败整会话退回登录用户，绝不留下"pty 是 root、
 * exec 仍是登录用户"的身份分裂（2³ 种组合没法各自表述）。
 *
 * 本模块不持会话状态、不碰 ssh.ts（IO 全部经回调注入），保持可单测；
 * 判别一律靠**行为 + 版本号**，不靠 stderr 文本——sudo 走 gettext，报错随 locale 变。
 */

export interface ElevationState {
  /** true = 握手 + 探活全过，pty 与 exec 通道均为 root */
  active: boolean
  /** active=false 时的降级原因 */
  reason?: ElevationFailReason
  /** exec 通道认证模式（探 1 定死，全会话不变）：none=`sudo -n`；password=每 channel `sudo -S` 自认证 */
  authMode: 'none' | 'password'
  /** exec 通道 cwd 机制（探 2 定死）：chdir=`-D <cwd>`；template=`bash -c 'cd … && …'` 兜底 */
  cwdMode: 'chdir' | 'template'
  /** `sudo --version` 解析值（顺带存进主机档案） */
  sudoVersion?: string
  /** root 版 SFTP 用的 sftp-server 路径（探 3 定死，v0.11.2） */
  sftpServerPath?: string
}

export interface ElevationIo {
  /** 写 pty（经传输管线，与 ssh:input 同路） */
  writeInput(data: string): void
  /** 订阅 pty 输出（utf-8 解码后的文本片段）；返回退订函数 */
  onOutput(cb: (text: string) => void): () => void
  /** 独立 exec channel；stdin 非空时打开即写入并 EOF（探 `-S` 模式用） */
  exec(
    command: string,
    timeoutMs: number,
    stdin?: string
  ): Promise<{ ok: boolean; exitCode?: number; stdout?: string }>
  /** 主机配置的 sudo 密码（主进程解密后传入，绝不出主进程） */
  password: string | null
  /** 主机配置的 sftp-server 路径覆盖；留空则探测 */
  sftpServerPath: string | null
  /**
   * 探 3：完整起一次 root 版 SFTP。**成功的 channel 直接留作会话的
   * SFTP 实例**（由调用方持有）——不懒建，懒建与 all-or-nothing 直接矛盾：
   * 懒到会话中途才发现 sftp-server 起不来时，pty/exec 早已是 root，来不及整会话退回。
   * 返回 null = 成功；返回降级原因 = 失败。
   * authMode 由探 1 定死后传入——不能在这里按"有没有配密码"重算：NOPASSWD 机器
   * 即使配了密码也走 `-n`，两种模式不混。
   */
  openSftp(serverPath: string, authMode: ElevationState['authMode']): Promise<ElevationFailReason | null>
}

/**
 * 哨兵与探针的"键入形态"用 `''` 拆开：pty 会回显我们敲的命令，完整哨兵若出现在
 * 回显里，检测会把自己的输入当成 sudo 的提示。POSIX shell 相邻引号串接后
 * 才凑出完整哨兵——回显里永远是拆开的两半（换行折行也拼不出）。
 */
const PW_SENTINEL = 'TSUBASATERMINAL_PW:'
const PW_SENTINEL_TYPED = "'TSUBASATERMINAL''_PW:'"
const ELEV_PROBE_TYPED = `echo __TSUBASATERMINAL''_ELEV__$(id -un)`
/** 身份标记后必须紧跟用户名样式字符：回显里的 `__…ELEV__$(…` 后是 `$`，天然不匹配 */
const ELEV_MARKER_RE = /__TSUBASATERMINAL_ELEV__([A-Za-z0-9._-]+)/

/** 提示静默判定：sudo 提示通常在回显后几十 ms 内到；静默这么久还没见哨兵即视为无提示（NOPASSWD） */
const QUIET_MS = 700
/** pty 握手总窗口：提示匹配不到时的兜底，不永久挂起 */
const PTY_TIMEOUT_MS = 15000
/** 每条探活命令的窗口（真机单条几十 ms） */
const PROBE_TIMEOUT_MS = 5000

interface PtyResult {
  ok: boolean
  reason?: ElevationFailReason
}

/**
 * pty 侧握手：写 `sudo -i`（带自设哨兵提示，容忍多语言与自定义 passprompt——
 * `-p` 覆盖它们）→ 见哨兵则喂密码 → 身份探针 `echo …$(id -un)` 验证真到了 root。
 * 密码提示第二次出现 = 密码被拒（sudo 校验失败才会重提示，行为判别不读文本）。
 * 探针可能被慢到的提示当成密码吃掉一次——哨兵随后出现会照常走喂密码路径，
 * 喂完重发探针即可（sudo 默认 3 次尝试，烧掉的那次是探针不是密码）。
 */
function ptyHandshake(io: ElevationIo): Promise<PtyResult> {
  return new Promise((resolve) => {
    let buf = ''
    let sentinelSeen = 0
    let passwordSent = false
    let settled = false

    const finish = (result: PtyResult, interrupt: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      clearTimeout(quiet)
      unsubscribe()
      // 可能还挂着 sudo 的密码提示：^C 收掉，别让后续输入被当密码吃
      if (interrupt) io.writeInput('\x03')
      resolve(result)
    }

    const sendVerify = (): void => {
      io.writeInput(`${ELEV_PROBE_TYPED}\r`)
    }

    const overall = setTimeout(() => finish({ ok: false, reason: 'timeout' }, true), PTY_TIMEOUT_MS)
    // 静默兜底：一直没见哨兵（NOPASSWD / sudo 直接失败）就发身份探针定分晓
    let quiet = setTimeout(sendVerify, QUIET_MS)

    const unsubscribe = io.onOutput((text) => {
      buf += text
      if (buf.length > 16384) buf = buf.slice(-8192)
      clearTimeout(quiet)

      // 密码提示（哨兵完整形态只可能由 sudo 打印，回显是 `''` 拆开的）
      const occurrences = buf.split(PW_SENTINEL).length - 1
      if (occurrences > sentinelSeen) {
        sentinelSeen = occurrences
        if (passwordSent) {
          // 第二次提示 = 存储的密码被拒（确定性错误，不重试）
          finish({ ok: false, reason: 'password' }, true)
          return
        }
        if (!io.password) {
          finish({ ok: false, reason: 'no-password' }, true)
          return
        }
        passwordSent = true
        io.writeInput(`${io.password}\r`)
        sendVerify()
        return
      }

      const marker = ELEV_MARKER_RE.exec(buf)
      if (marker) {
        if (marker[1] === 'root') finish({ ok: true }, false)
        // 身份仍是登录用户：sudo 被 sudoers 拒了（密码对但不在名单等），已回到 shell
        else finish({ ok: false, reason: 'not-root' }, false)
        return
      }

      // 输出还在流动但没等到哨兵/标记：重置静默计时
      if (!settled) quiet = setTimeout(sendVerify, QUIET_MS)
    })

    io.writeInput(`sudo -p ${PW_SENTINEL_TYPED} -i\r`)
  })
}

export function parseSudoVersion(stdout: string | undefined): string | undefined {
  return stdout?.match(/Sudo version (\d+\.\d+\.\d+)/i)?.[1]
}

/**
 * 完整身份切换：pty 握手 → exec 探活套件。任一步失败即降级——pty 已到 root 的
 * 失败路径写 `exit` 退回登录 shell（all-or-nothing 的收口），pty 还没切过去的
 * 失败路径什么都不用退。
 */
export async function runElevation(io: ElevationIo): Promise<ElevationState> {
  const fail = (reason: ElevationFailReason): ElevationState => ({
    active: false,
    reason,
    authMode: 'none',
    cwdMode: 'chdir'
  })

  let pty: PtyResult
  try {
    pty = await ptyHandshake(io)
  } catch {
    return fail('error')
  }
  if (!pty.ok) return fail(pty.reason ?? 'error')

  // pty 已是 root：此后任何失败都要退回登录 shell 再降级
  const degrade = (reason: ElevationFailReason): ElevationState => {
    io.writeInput('exit\r')
    return fail(reason)
  }

  try {
    // 探 1：认证模式。不赌 sudo timestamp——默认 tty→ppid 记账，跨 channel 不可见，
    // pty 握手刷的票据在 exec channel 上查不到（identity-design"认证模式"节）。
    let authMode: ElevationState['authMode']
    const probeN = await io.exec('sudo -n true', PROBE_TIMEOUT_MS)
    if (probeN.ok && probeN.exitCode === 0) {
      authMode = 'none' // NOPASSWD / global 票据：全会话密码零发送
    } else if (io.password) {
      const probeS = await io.exec("sudo -S -p '' true", PROBE_TIMEOUT_MS, `${io.password}\n`)
      if (probeS.ok && probeS.exitCode === 0) authMode = 'password'
      else return degrade('no-exec-auth') // requiretty 等：exec channel 无 tty，sudo 直接拒
    } else {
      return degrade('no-exec-auth')
    }

    // 探 2：cwd 机制。`-D` 通 → chdir 主路；不通 → 模板兜底（`bash -c 'cd … && …'`）。
    //
    // 真机修订（Ubuntu sudo 1.9.9）：初版设计假设"版本 ≥ 1.9.3 而 -D 被拒 =
    // 管理员显式限制 CWD → 整会话降级"。真机证明这个前提是错的——stock sudoers
    // **默认就拒 `-D`**（需 `Defaults runcwd=*` 或 CWD 标签才放行，云镜像基本不配），
    // 于是"版本够但被拒"是常态而非信号。照原设计几乎所有 stock 机都会降级，功能
    // 对准的正是这些机器。且 `sudo -i` 一旦获准，用户在 root shell 里本就能任意 cd，
    // exec 通道的 cwd 限制不构成真实边界。故 `-D` 被拒一律回退模板，不降级。
    // 版本号只留作主机档案展示（不再参与判定）。
    const auth = sudoAuthArgs(authMode)
    const stdin = authMode === 'password' ? `${io.password}\n` : undefined
    const probeD = await io.exec(`sudo ${auth} -D /root true`, PROBE_TIMEOUT_MS, stdin)
    const versionOut = await io.exec('sudo --version', PROBE_TIMEOUT_MS)
    const sudoVersion = parseSudoVersion(versionOut.stdout)
    const cwdMode: ElevationState['cwdMode'] =
      probeD.ok && probeD.exitCode === 0 ? 'chdir' : 'template'

    // 探 3：SFTP 链路。SFTP subsystem 由 sshd fork、协议层面没有切 root
    // 的入口，故改在 exec channel 上跑 `sudo sftp-server`（见 elevatedSftp.ts）。
    // 路径先取主机配置覆盖，否则按发行版候选探 + 回落 sshd_config 的 Subsystem 行。
    let sftpServerPath = io.sftpServerPath?.trim() || null
    if (!sftpServerPath) {
      const probeServer = await io.exec(buildSftpServerProbe(), PROBE_TIMEOUT_MS)
      sftpServerPath = parseSftpServerPath(probeServer.stdout)
    }
    // internal-sftp（sshd 进程内实现，无独立二进制）也落这里——探不到就整会话降级
    if (!sftpServerPath) return degrade('no-sftp-server')
    const sftpFail = await io.openSftp(sftpServerPath, authMode)
    if (sftpFail) return degrade(sftpFail)

    return { active: true, authMode, cwdMode, sudoVersion, sftpServerPath }
  } catch {
    return degrade('error')
  }
}

/** exec 通道认证参数（两种模式不混：`-n` 模式绝不写密码——NOPASSWD 下 sudo 不读
 *  stdin，写进去的密码字节会被命令自己继承读走） */
export function sudoAuthArgs(authMode: ElevationState['authMode']): string {
  return authMode === 'none' ? '-n' : "-S -p ''"
}

/**
 * Agent exec 的 root 包装（主进程模板拼装，闸门判定跟随 Agent 原文——与
 * wrapBackground 的关系相同）。chdir 模式走 `-D`（cwd 取 pty 的 OSC 7 上报：
 * root 会话三平面同为 root，借 pty cwd 恢复合法）；模板模式整串 shellQuote 进
 * bash -c——这是继 wrapBackground / wrapSaveOutput 之后**第三处登记在案的模板
 * 豁免**：模板固定 + command 已过硬解析 + 全串转义，不构成给 LLM 的执行跳板。
 */
export function buildElevatedExec(
  state: Pick<ElevationState, 'authMode' | 'cwdMode'>,
  command: string,
  cwd: string | null
): string {
  const auth = sudoAuthArgs(state.authMode)
  if (state.cwdMode === 'chdir') {
    const chdir = cwd ? `-D ${shellQuote(cwd)} ` : ''
    return `sudo ${auth} ${chdir}-- ${command}`
  }
  const body = cwd ? `cd -- ${shellQuote(cwd)} && ${command}` : command
  return `sudo ${auth} -- bash -c ${shellQuote(body)}`
}

/**
 * 内部脚本的 root 包装（主机档案探测等含 `;` 的多命令串）：整串 sh -c。
 * 只喂主进程自己的固定脚本，不经 LLM——不加这层的话 `a; b; c` 里只有 a 在 sudo 下跑。
 */
export function buildElevatedScript(
  state: Pick<ElevationState, 'authMode'>,
  script: string
): string {
  return `sudo ${sudoAuthArgs(state.authMode)} -- sh -c ${shellQuote(script)}`
}
