import { getSession, getSessionMeta, listSessions, type SessionMeta } from '../ssh'
import { unitPrefix } from '../llm/unitRef'

/**
 * 会话寻址与粘性绑定（cli-bridge-design 第三节）：按 clientId 隔离、只住内存。
 *
 * 句柄直接提拔 `unitPrefix`（sessionId 去横线截 8 位）——它早就印在 Agent 与转录出口
 * 的每个 unit id 上（`3f2a19c8:7`），`log` 的输出与寻址天生自洽，不引入第二套编号。
 * 内部流转一律用完整 sessionId，8hex 只在出入口包装/解析。
 *
 * 粘性绑定住在**主进程内存**（CLI 每次调用是一次性进程，粘不住任何状态），
 * key = clientId（CLI 侧算好带上）。**故意不落盘**：应用重启后会话全没了，
 * 绑定随内存消亡正是对的语义，落盘反而制造指向已死会话的陈旧状态。
 */

export interface Binding {
  sessionId: string
  handle: string
  /** `use` 那一刻的查找键，只用于文案回显——绑定粘的是句柄不是别名 */
  alias: string
}

const bindings = new Map<string, Binding>()

export function sessionHandle(sessionId: string): string {
  return unitPrefix(sessionId)
}

export interface SessionRow {
  sessionId: string
  handle: string
  meta: SessionMeta
}

export function allSessions(): SessionRow[] {
  return listSessions().map(({ sessionId, meta }) => ({
    sessionId,
    handle: sessionHandle(sessionId),
    meta
  }))
}

const HANDLE_RE = /^[0-9a-f]{8}$/

/**
 * 解析 `use` 的参数：长得像 8hex 按句柄精确匹配，否则按主机别名匹配
 * （别名 = 主机配置里的显示名，大小写不敏感；再退一步认 host 字段，
 * 方便直接写 IP）。命中 0/1/N 三态由调用方翻成 103 / 绑定 / 104——
 * **不挑、不猜**：同主机多标签是支持场景，替用户挑一个就是最恶劣的错误形态。
 */
export function resolveRef(ref: string): SessionRow[] {
  const needle = ref.trim()
  if (!needle) return []
  const rows = allSessions()
  if (HANDLE_RE.test(needle)) {
    return rows.filter((r) => r.handle === needle)
  }
  const lower = needle.toLowerCase()
  const byName = rows.filter((r) => r.meta.name.toLowerCase() === lower)
  if (byName.length > 0) return byName
  return rows.filter((r) => r.meta.host.toLowerCase() === lower)
}

export function bind(clientId: string, row: SessionRow, alias: string): Binding {
  const entry: Binding = { sessionId: row.sessionId, handle: row.handle, alias }
  bindings.set(clientId, entry)
  return entry
}

export type BindingLookup =
  | { ok: true; binding: Binding; meta: SessionMeta }
  | { ok: false; reason: string }

/**
 * 每次调用 lazy 校验（3.4）：活性校验做在调用时，不靠会话关闭事件清 Map
 * （清只是卫生，不是护栏）。死了响亮 103，外部 agent 重新 `use` 拿新句柄与新建联包，
 * 转录前缀随之切换——不存在静默漂移的窗口。
 */
export function currentBinding(clientId: string, sessionFlag?: string): BindingLookup {
  // -s/--session 逐条覆盖：解析完即用，不读不写粘性
  if (sessionFlag) {
    const matches = resolveRef(sessionFlag)
    if (matches.length === 0) {
      return { ok: false, reason: `-s ${sessionFlag}：找不到该会话（已关闭，或句柄/别名写错）` }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `-s ${sessionFlag}：匹配到 ${matches.length} 个会话，请用 8 位句柄指定`
      }
    }
    const row = matches[0]
    return {
      ok: true,
      binding: { sessionId: row.sessionId, handle: row.handle, alias: row.meta.name },
      meta: row.meta
    }
  }
  const entry = bindings.get(clientId)
  if (!entry) {
    return {
      ok: false,
      reason: '未绑定会话，先跑 tsubasa-ssh use <别名|句柄>（别名看 hosts，已开的会话看 sessions）'
    }
  }
  if (!getSession(entry.sessionId)) {
    bindings.delete(clientId)
    return {
      ok: false,
      reason: `绑定的会话 ${entry.handle}（${entry.alias}）已关闭，重新 use 一次`
    }
  }
  const meta = getSessionMeta(entry.sessionId)
  if (!meta) {
    bindings.delete(clientId)
    return { ok: false, reason: `绑定的会话 ${entry.handle} 已失效，重新 use 一次` }
  }
  return { ok: true, binding: entry, meta }
}

/** `sessions` 列表里给当前绑定打星用 */
export function boundSessionId(clientId: string): string | null {
  return bindings.get(clientId)?.sessionId ?? null
}

/** 会话标记（生产机 / root）：建联包与 stderr 回显共用一份 */
export function sessionTags(meta: SessionMeta): string[] {
  const tags: string[] = []
  if (meta.envLevel === 'production') tags.push('production')
  else if (meta.envLevel === 'experiment') tags.push('experiment')
  if (meta.elevated) tags.push('root')
  return tags
}
