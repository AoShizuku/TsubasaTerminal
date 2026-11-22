import type { Client, SFTPWrapper } from 'ssh2'

/**
 * 以 root 身份运行的 SFTP（identity-design「以 root 身份运行的 SFTP」）。
 *
 * SFTP subsystem 由 sshd 直接 fork，协议层面没有切到 root 的入口。这里改在 exec
 * channel 上跑 `sudo sftp-server`，靠临时接管 ssh2 的三处内部 API 把它伪装成一次
 * subsystem 请求——SFTP 实例本身仍由 ssh2 官方构造，我们只换了那一个请求的类型。
 * 换掉 `getSftp` 返回的实例即可对齐全部消费者（文件栏 / ZMODEM 桥 / write_file）。
 *
 * 三处接管点（防御性存在检查全覆盖，任一不匹配即整会话降级，绝不崩）：
 *   1. `_protocol.subsystem` → 改发 `exec`（与 `subsystem` 签名一致、协议层同为
 *      channel request，服务端回同样的 success/failure）
 *   2. SFTP 实例的 `_init` → 拦下自动发 INIT；**它被调用的时刻就是"服务端已接受
 *      exec 请求"的精确锚点**，不必另找信号
 *   3. SFTP 实例的 `stderr` → ssh2 把它设成 fakeStderr（push 是空函数），而
 *      CHANNEL_EXTENDED_DATA 统一走 `channel.stderr.push(data)`——不换成真收集器，
 *      sudo 的哨兵一个字节都收不到，表现是干等超时
 *
 * 时序与判据均经 Ubuntu 真机 spike 验证（Ubuntu 22.04 / sudo 1.9.9 / ssh2 1.17.0）：
 * 写密码后**立即**补发 INIT 不丢字节——连"密码与 INIT 合包、sudo 一次 read() 同时
 * 拿到两者"都不丢（sudo `-S` 严格按行读、读到 \n 即停，剩余字节原样留给 exec 后的
 * sftp-server），故不需要任何延迟保护参数。
 */

/** ssh2 内部协议对象（无公开类型，按用到的三个方法收窄） */
interface Ssh2Protocol {
  subsystem(chanId: number, name: string, wantReply: boolean): void
  exec(chanId: number, cmd: string, wantReply: boolean): void
  channelData(chanId: number, data: Buffer): void
}

/** ssh2 的 SFTP 实例（EventEmitter 子类，鸭子类型地像 Channel——故 stderr 也要自己管） */
interface Ssh2Sftp extends SFTPWrapper {
  _init(): void
  outgoing: { id: number }
  incoming: { id: number }
  stderr: unknown
}

interface Ssh2Client extends Client {
  _protocol?: Ssh2Protocol
  _chanMgr?: { _channels: Record<string, unknown> }
}

/** stderr 收集器：换掉 fakeStderr。只需满足 client.js 对 channel.stderr 的用法 */
interface StderrCollector {
  readable: boolean
  writable: boolean
  push(data: Buffer | null): boolean
  once(): void
  on(): void
  emit(): void
  end(): void
  _write(_chunk: unknown, _enc: unknown, cb?: () => void): void
}

function makeCollector(onText: (all: string) => void): StderrCollector {
  let text = ''
  return {
    readable: false,
    writable: false,
    push(data: Buffer | null): boolean {
      if (data === null) return true
      text += data.toString('utf-8')
      // sudo 的提示很短；截断防远端异常输出撑爆内存
      if (text.length > 8192) text = text.slice(-4096)
      onText(text)
      return true // 必须真值：返回 false 会让 client.js 置 _waitChanDrain 卡住流
    },
    once() {},
    on() {},
    emit() {},
    end() {},
    _write(_chunk, _enc, cb) {
      cb?.()
    }
  }
}

export interface ElevatedSftpOptions {
  /** exec channel 上跑的完整命令（主进程模板拼装，不经 LLM） */
  serverCmd: string
  /** `-S` 模式的 sudo 密码；null = `-n` 模式（密码一个字节不发） */
  password: string | null
  /** `-S` 模式的哨兵提示（`sudo -p` 自设，避开多语言/自定义 passprompt） */
  sentinel: string
  /** 总窗口：探不到哨兵、拿不到 VERSION 都靠它兜底，不永久挂起 */
  timeoutMs: number
}

export class ElevatedSftpError extends Error {
  constructor(
    message: string,
    /** 'api' = ssh2 内部 API 不匹配（升级碎了）；'auth' = sudo 认证被拒；'init' = 起不来/超时 */
    readonly kind: 'api' | 'auth' | 'init'
  ) {
    super(message)
    this.name = 'ElevatedSftpError'
  }
}

/**
 * 接管期间必须串行：同一连接上若有第二个 `conn.sftp()` 并发调用会被误接管
 * （它会拿到我们的 exec channel，而我们拿到它的）。按连接排队。
 */
const locks = new WeakMap<Client, Promise<unknown>>()

export function openElevatedSftp(conn: Client, opts: ElevatedSftpOptions): Promise<SFTPWrapper> {
  const prev = locks.get(conn) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(() => openElevatedSftpLocked(conn, opts))
  locks.set(
    conn,
    next.catch(() => undefined)
  )
  return next
}

function openElevatedSftpLocked(conn: Client, opts: ElevatedSftpOptions): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    const client = conn as Ssh2Client
    const proto = client._protocol
    if (
      typeof proto?.subsystem !== 'function' ||
      typeof proto?.exec !== 'function' ||
      typeof proto?.channelData !== 'function'
    ) {
      reject(new ElevatedSftpError('ssh2 内部 API 不匹配（_protocol）', 'api'))
      return
    }

    let settled = false
    let restored = false
    /** 接管到的实例：失败路径要靠它主动收掉 channel */
    let opened: Ssh2Sftp | null = null
    const cleanups: Array<() => void> = []
    const origSubsystem = proto.subsystem
    const restore = (): void => {
      if (restored) return
      restored = true
      // 失败路径也必须复原，否则后续普通 SFTP 全部走偏
      proto.subsystem = origSubsystem
    }
    const finish = (err: ElevatedSftpError | null, sftp?: SFTPWrapper): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      restore()
      for (const fn of cleanups) fn()
      if (!err) {
        resolve(sftp as SFTPWrapper)
        return
      }
      // 失败即主动收掉 channel，别把 sudo sftp-server 晾在那儿等 socket 断
      try {
        opened?.end()
      } catch {
        /* 已经断了 */
      }
      reject(err)
    }
    const timer = setTimeout(
      () => finish(new ElevatedSftpError('root 版 SFTP 建立超时', 'init')),
      opts.timeoutMs
    )

    proto.subsystem = (chanId: number, name: string, wantReply: boolean): void => {
      proto.subsystem = origSubsystem // 只接管这一次
      restored = true

      const sftp = locateSftp(client, chanId)
      if (!sftp) {
        // 定位失败绝不许默默继续：静默 fallback 会拿到登录用户的普通 SFTP，
        // 表现只是"权限不对"而不报错——正是本设计要消灭的"让人去猜"
        finish(new ElevatedSftpError('ssh2 内部 API 不匹配（定位 SFTP 实例失败）', 'api'))
        // channel 已开，仍发原请求让 ssh2 自己走完关闭流程
        origSubsystem.call(proto, chanId, name, wantReply)
        return
      }

      const protoInit = Object.getPrototypeOf(sftp)._init as (() => void) | undefined
      if (typeof protoInit !== 'function') {
        finish(new ElevatedSftpError('ssh2 内部 API 不匹配（SFTP._init）', 'api'))
        origSubsystem.call(proto, chanId, name, wantReply)
        return
      }

      opened = sftp
      const origStderr = sftp.stderr
      let sentinelSeen = 0
      let passwordSent = false
      const collector = makeCollector((all) => {
        const seen = all.split(opts.sentinel).length - 1
        if (seen <= sentinelSeen) return
        sentinelSeen = seen
        if (passwordSent) {
          // 哨兵再现 = 密码被拒。**主判据**：真机实测它比 channel 退出早 6 倍
          // （1.9s vs 10s+，sudo 要把三次尝试耗尽才退出），握手期间用户在干等，
          // 必须据此主动收口而不是等 channel 自己死。不重试——存储的密码错是
          // 确定性错误，且 pty 握手已先验过一次。
          finish(new ElevatedSftpError('sudo 密码被拒（stderr 再现哨兵）', 'auth'))
          return
        }
        passwordSent = true
        sendPasswordThenInit()
      })
      sftp.stderr = collector

      const sendInit = (): void => {
        // 原型方法第一行是 this._init = noop，故先摘掉实例上的遮蔽再调
        delete (sftp as unknown as { _init?: unknown })._init
        sftp._init()
      }
      const sendPasswordThenInit = (): void => {
        if (opts.password === null) {
          sendInit()
          return
        }
        // 不发 EOF——stdin 之后归 SFTP 协议。紧接着立刻补发 INIT：真机证明
        // sudo 按行读、不预读，剩余字节原样留给 sftp-server，无竞态窗口
        proto.channelData(chanId, Buffer.from(`${opts.password}\n`, 'utf-8'))
        sendInit()
      }

      sftp._init = (): void => {
        // 这一刻 = 服务端已接受 exec 请求（channel request success）
        if (opts.password === null) {
          // `-n` 模式：sudo 不读 stdin，没有混流问题，直接补发 INIT
          sendInit()
          return
        }
        // `-S` 模式：等 stderr 哨兵（sudo 的提示走 extended data，与 stdout 上的
        // 协议流是两条流，互不污染），由 collector 回调驱动后续
      }

      // 收口后放掉收集器：sftp-server 正常不写 stderr，留着只会白攒内存
      cleanups.push(() => {
        if (sftp.stderr === collector) sftp.stderr = origStderr
      })

      proto.exec(chanId, opts.serverCmd, wantReply)
    }

    conn.sftp((err, sftp) => {
      restore()
      if (err) {
        // channel 退出 = 兜底判据（sudo 不在 sudoers / sftp-server 起不来 / 密码
        // 三次耗尽）。主判据在 collector 里，通常先它一步收口
        finish(new ElevatedSftpError(`root 版 SFTP 未能建立：${err.message}`, 'init'))
        return
      }
      finish(null, sftp)
    })
  })
}

/**
 * 按 `outgoing.id` 定位 SFTP 实例。
 *
 * 两个坑（spike 实际栽进去过）：
 * - **不能 `_chanMgr.get(chanId)`**：`subsystem()` 收到的是 `chan.outgoing.id`（远端
 *   id），而 `_chanMgr` 按 local id 索引。两者经常凑巧相等（都从 0 开始分配），是
 *   本地怎么测都不出、换个并发时序才炸的坑。
 * - **不能按 `type === 'sftp'` 过滤**：实例的 `type` 是 `'session'`（SSH 协议层面
 *   sftp 也是 session channel）。
 */
function locateSftp(client: Ssh2Client, chanId: number): Ssh2Sftp | null {
  const channels = client._chanMgr?._channels
  if (!channels) return null
  for (const key of Object.keys(channels)) {
    const chan = channels[key] as Ssh2Sftp | undefined
    if (!chan || typeof chan !== 'object') continue
    if (chan.outgoing?.id !== chanId) continue
    if (typeof chan._init !== 'function') continue
    return chan
  }
  return null
}

/** 哨兵：`sudo -p` 自设，避开多语言与自定义 `Defaults passprompt`。exec channel
 *  无回显，不需要 pty 侧那种 `''` 拆分的键入形态 */
export const SFTP_SUDO_SENTINEL = 'TSUBASATERMINAL_SFTP_PW:'

/** sftp-server 跨发行版候选路径（探测脚本按序取第一个可执行的） */
export const SFTP_SERVER_CANDIDATES = [
  '/usr/lib/openssh/sftp-server', // Debian / Ubuntu
  '/usr/libexec/openssh/sftp-server', // RHEL 系
  '/usr/lib/ssh/sftp-server' // Alpine / SUSE
]

/**
 * sftp-server 路径探测脚本：候选列表按序试 → 回落到 sshd_config 的 `Subsystem sftp`
 * 行（通常 0644 可读）。不需要 root，走普通 exec 即可。
 * 输出单行路径；`internal-sftp`（sshd 进程内实现，无独立二进制）会被下游判掉。
 */
export function buildSftpServerProbe(): string {
  const tests = SFTP_SERVER_CANDIDATES.map((p) => `[ -x ${p} ] && { echo ${p}; exit 0; }`).join('; ')
  return `${tests}; awk '/^[[:space:]]*[Ss]ubsystem[[:space:]]+sftp[[:space:]]/ { print $3; exit }' /etc/ssh/sshd_config 2>/dev/null`
}

/** 探测输出 → 可用路径；internal-sftp 与非绝对路径一律判为探不到 */
export function parseSftpServerPath(stdout: string | undefined): string | null {
  for (const raw of (stdout ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('/')) continue
    if (line.includes('internal-sftp')) continue
    if (/[\s'"\\]/.test(line)) continue // 形态可疑就不用，宁可降级
    return line
  }
  return null
}
