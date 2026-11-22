import {
  composerState,
  cursorLineLooksLikePrompt,
  getLastOutputAt
} from '@/composables/useComposerStore'
import { onCommandStarted } from './transcript'

/**
 * 自动重载 shell integration（identity-design 存量兜底）：
 * `sudo su` / `su -` / `sudo -i` 起的新 shell 甩掉 OSC 133/7，转录断流、cwd 停更、
 * 身份上报消失。v0.9.5 给了手动重载按钮，这里把"用户手动敲的那行"自动化——
 * 检测到身份切换命令开始（133;C 时刻的命令文本）后武装监视器，等新 shell 落到
 * prompt（静默 + 光标行像 prompt，条件与 stalled 检测同源）就替用户 source 一次。
 *
 * 与 stalled 检测的分工：stalled 是兜底提示（任何断链原因，10s 阈值，处置交给人）；
 * 这里只认三个明确的身份切换命令，秒级恢复，误判代价 = 往前台进程多写一行 source
 * （与用户自己点"重新装载"按错时机同价）。密码提示以 `:` 结尾不像 prompt，
 * 不会被灌入——这是敢自动化的前提。
 *
 * v0.11.1 的自动切换握手不进记录管线、不产生转录事件，天然不会误触发这里。
 */

const ELEVATION_PATTERNS = [/^sudo\s+su\b/, /^su\s+-/, /^sudo\s+-i\b/]
/** 静默窗口：远快于 stalled 的 10s——目标是"下一个 prompt"，不是"确认卡死" */
const QUIET_MS = 700
const POLL_MS = 300
/** 武装超时：迟迟等不到 prompt（用户在 root 下直接进了长流程）就放弃，交还给 stalled 提示 */
const ARM_TIMEOUT_MS = 90_000

const armedAt = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null
let wired = false

export function isElevationCommand(command: string): boolean {
  const trimmed = command.trim()
  return ELEVATION_PATTERNS.some((re) => re.test(trimmed))
}

function scan(): void {
  const now = Date.now()
  for (const [sessionId, since] of armedAt) {
    const state = composerState(sessionId)
    // prompt/none = 133;A 已回来（切换失败退回原 shell）或用户手动降级——不用管了
    if (now - since > ARM_TIMEOUT_MS || state.mode === 'prompt' || state.mode === 'none') {
      armedAt.delete(sessionId)
      continue
    }
    // tui 让位（用户在 root 下直接开了 vim），保持武装等它退出
    if (state.mode !== 'running') continue
    if (now - getLastOutputAt(sessionId) < QUIET_MS) continue
    if (!cursorLineLooksLikePrompt(sessionId)) continue
    armedAt.delete(sessionId)
    // 主进程写 `. /tmp/.tsubasaterminal-si-*.sh`；无 siPath（SI 未启用）时静默返回 false
    void window.api.ssh.reinjectSi(sessionId)
  }
  if (armedAt.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 幂等接线：订阅"命令开始"事件（TerminalView 挂载时调用一次即可） */
export function initSiReinject(): void {
  if (wired) return
  wired = true
  onCommandStarted((sessionId, command) => {
    if (!isElevationCommand(command)) return
    // SI 从未生效的会话没有可重挂的时序，也拿不到 133;C——防御性再拦一道
    if (!composerState(sessionId).integrationSeen) return
    armedAt.set(sessionId, Date.now())
    if (!timer) timer = setInterval(scan, POLL_MS)
  })
}

export function disposeSiReinject(sessionId: string): void {
  armedAt.delete(sessionId)
}
