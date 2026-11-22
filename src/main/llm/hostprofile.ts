import { awaitElevation, execOnSession } from '../ssh'
import { buildElevatedScript } from '../elevation'
import { sanitizeForMachine } from '../sanitize'

/**
 * 主机档案（v0.8.3 上下文工程）：agent-design 第八节的欠账——system prompt
 * 该有 host/用户/OS，此前只注入了 hostLabel。首次 agent:send 时独立 channel
 * 一次性采集，按 SSH 会话缓存（主机不会中途换发行版）；超时/失败静默降级为缺项。
 */

export interface HostProfile {
  /** uname -sr，如 "Linux 5.15.0-185-generic" */
  kernel?: string
  /** id -un（不用 whoami——留给白名单 exec 语义，探测命令避免撞词） */
  user?: string
  /** /etc/os-release 的 PRETTY_NAME，如 "Ubuntu 22.04.5 LTS" */
  os?: string
  /**
   * $HOME 实值：`~` 展开的依据。不由 user 推断——root 的 home 是
   * /root 不是 /home/root，而容器/NFS 环境里 home 落在哪都有可能，猜错就是
   * 把命令指向不存在的路径。探不到就不展开（闸门照旧打回，引导用绝对路径）。
   */
  home?: string
  /** sudo 版本：root 会话探活时顺带解析存档；非 root 会话缺省 */
  sudoVersion?: string
}

const PROBE_SEP = '__TSUBASATERMINAL_PROFILE_SEP__'
const PROBE_COMMAND =
  `uname -sr; echo ${PROBE_SEP}; id -un; echo ${PROBE_SEP}; ` +
  `echo "$HOME"; echo ${PROBE_SEP}; cat /etc/os-release`
const PROBE_TIMEOUT_MS = 5000
const FIELD_LIMIT = 120

/** 缓存 Promise 而非结果：并发首问只探测一次 */
const cache = new Map<string, Promise<HostProfile | null>>()

function cleanField(raw: string | undefined): string | undefined {
  const value = raw ? sanitizeForMachine(raw).trim() : ''
  return value ? value.slice(0, FIELD_LIMIT) : undefined
}

async function probe(sessionId: string): Promise<HostProfile | null> {
  // 身份切换收口后再探：握手期间抢跑会以登录用户身份缓存下错误的档案，
  // 档案里的 user/home 与人屏就又是一对新的错位。root 会话探测跟随认证模式包装，
  // 探出来的 id -un / $HOME 是 root / /root——与 pty 一致。
  const elevation = await awaitElevation(sessionId)
  const rootMode = elevation?.active ? elevation : null
  const command = rootMode ? buildElevatedScript(rootMode, PROBE_COMMAND) : PROBE_COMMAND
  const result = await execOnSession(sessionId, command, PROBE_TIMEOUT_MS, undefined, {
    sudoAuth: Boolean(rootMode)
  })
  if (!result.ok || !result.stdout) return null
  const [kernel, user, home, osRelease] = result.stdout.split(PROBE_SEP)
  const pretty = osRelease?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1]
  const homePath = cleanField(home)
  const profile: HostProfile = {
    kernel: cleanField(kernel),
    user: cleanField(user),
    os: cleanField(pretty),
    // 未设 $HOME 时 echo 出空行；非绝对路径一律不认（展开出来的必须是绝对路径）
    home: homePath?.startsWith('/') ? homePath : undefined,
    sudoVersion: rootMode?.sudoVersion
  }
  return profile.kernel || profile.user || profile.os || profile.home ? profile : null
}

export function getHostProfile(sessionId: string): Promise<HostProfile | null> {
  let pending = cache.get(sessionId)
  if (!pending) {
    pending = probe(sessionId).catch(() => null)
    cache.set(sessionId, pending)
    // 失败不缓存：临时故障（会话繁忙/刚断开）不该让整个会话永远无档案
    void pending.then((profile) => {
      if (!profile) cache.delete(sessionId)
    })
  }
  return pending
}

export function disposeHostProfile(sessionId: string): void {
  cache.delete(sessionId)
}
