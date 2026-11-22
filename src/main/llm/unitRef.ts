/**
 * 转录单元的 Agent 面向寻址（unit id 的包装与校验）。
 *
 * 从 tools.ts 拆出来（v0.12.2 前的整理）：这三个函数是零依赖的纯字符串处理，
 * 而 `cli/bindings.ts` 只为了一个 `unitPrefix` 就得 import 整个 1300 行的
 * tools.ts——连带把 ssh / audit / gate / approvals 整条工具执行依赖链拖进来。
 * 句柄提拔与工具执行是两件事，不该共用一个模块。
 */

/**
 * 单元 id 的会话前缀（knowledge-design 2.4）：Agent 面向的 unit id 一律是
 * `<前缀>:<序号>` 形态，前缀取 sessionId（renderer 的 crypto.randomUUID()）截断——
 * 全局唯一，**不得用会话内自增序号**（应用重启后序号复用，隔夜接续会精确退化回
 * "新会话恰好也有 id 7 → 读到另一台机器输出"的静默错读）。内部存储与 UI 勾选
 * 仍是裸数字（TranscriptUnit.id），前缀只在 Agent 出入口包装/校验。
 */
export function unitPrefix(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8) || 'session'
}

export function formatUnitId(sessionId: string, id: number): string {
  return `${unitPrefix(sessionId)}:${id}`
}

/**
 * 解析 Agent 传来的 unit id：只认"当前会话前缀:数字"。陌生前缀（迁移/接续前的
 * 历史引用）与裸数字（v0.10.1 存量对话的旧格式）一律拒绝——宁可多花一轮
 * list_transcript，不能静默读错会话。
 */
export function parseUnitRef(
  sessionId: string,
  raw: unknown
): { ok: true; id: number } | { ok: false; reason: string } {
  const text = String(raw ?? '').trim()
  const m = /^(\w+):(\d+)$/.exec(text)
  if (m && m[1] === unitPrefix(sessionId)) return { ok: true, id: Number(m[2]) }
  return {
    ok: false,
    reason: `unit id "${text}" 不是当前会话的有效引用（来自其他会话或恢复前的历史，引用已失效）。请用 list_transcript 重新获取当前会话的单元 id`
  }
}
