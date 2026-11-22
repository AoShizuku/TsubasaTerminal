/**
 * OSC 合理性校验（security-design 落地顺序第 3 步）：
 * 远端输出可以伪造 OSC 133/7 骗状态机——伪造 "133;A" 能在命令运行中把 composer
 * 骗回 prompt 态抢走输入。防线：
 * 1. A 时序：合法 A 只出现在 D 之后（SI 脚本 PROMPT_COMMAND 保证 D→7→A 相邻）；
 *    C 之后 D 之前的 A 是输出内容伪造，忽略。
 * 2. 频率限流：单会话 133 事件滑动窗口超阈值即丢弃（防洪水扰乱状态机）。
 * 伪造者若连 D;code 一起伪造则与真实序列不可区分——数据通道内信号本就可伪造，
 * 这里只抬门槛；根本防线是审批闸门与转录净化。
 */

const RATE_LIMIT_PER_SECOND = 30

interface GuardState {
  lastKind: string | null
  window: number[]
}

const guards = new Map<string, GuardState>()

function ensure(sessionId: string): GuardState {
  let g = guards.get(sessionId)
  if (!g) {
    g = { lastKind: null, window: [] }
    guards.set(sessionId, g)
  }
  return g
}

export interface Note133Result {
  /** false = 限流丢弃，本事件不得分发给任何消费者 */
  ok: boolean
  /** 本事件之前的最近 133 事件类型 */
  prev: string | null
}

export function note133(sessionId: string, kind: string): Note133Result {
  const g = ensure(sessionId)
  const now = Date.now()
  g.window = g.window.filter((t) => now - t < 1000)
  g.window.push(now)
  if (g.window.length > RATE_LIMIT_PER_SECOND) return { ok: false, prev: g.lastKind }
  const prev = g.lastKind
  g.lastKind = kind
  return { ok: true, prev }
}

/** A（prompt 就绪）仅在紧随 D（命令结束）或会话初始时可信 */
export function acceptPromptReady(prev: string | null): boolean {
  return prev === null || prev === 'D' || prev === 'A'
}

export function disposeGuard(sessionId: string): void {
  guards.delete(sessionId)
}
