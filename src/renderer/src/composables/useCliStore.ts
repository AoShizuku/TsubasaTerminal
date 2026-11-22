import { reactive } from 'vue'

/**
 * CLI 意图旁白（cli-bridge-design 七）：白名单命令经旁路 channel 自动执行时
 * 用户终端完全不可见，composer 状态行的这条旁白是唯一的 UI 槽位。
 * 只留最近一条、30s 自动淡出——它是"刚刚发生了什么"的旁白，不是活动日志
 * （完整记录在 audit.jsonl）；措辞用过去时，不声称"正在执行"，永不撒谎。
 */

export interface CliNarration {
  agent: string
  command: string
  intent?: string
  exitCode: number | null
}

const NARRATION_TTL_MS = 30_000

const narrations = reactive<Record<string, CliNarration | null>>({})
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function cliNarration(sessionId: string): CliNarration | null {
  return narrations[sessionId] ?? null
}

export function onCliExec(sessionId: string, narration: CliNarration): void {
  narrations[sessionId] = narration
  const prev = timers.get(sessionId)
  if (prev) clearTimeout(prev)
  timers.set(
    sessionId,
    setTimeout(() => {
      narrations[sessionId] = null
      timers.delete(sessionId)
    }, NARRATION_TTL_MS)
  )
}

export function disposeCliNarration(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  delete narrations[sessionId]
}
