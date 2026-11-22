import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getSessionMeta } from '../ssh'

/**
 * `a` 信任集（见 agent-design"审批摩擦阶梯与信任集"）：
 * 批准本条 + 本作用域内该动词免问。与"低风险自动执行"的本质区别是
 * **信任由用户在具体上下文里显式授予**，不是主机标签默认给的，且有失效边界。
 *
 * 作用域：普通机会话级（关会话即清）/ 实验机跨会话持久（trust.json 按 hostId）/
 * 生产机不可用——实验机 = 信任记忆的作用域，不是"免审批的机器"。
 * 等级取主进程自持 SessionMeta，不信 renderer 回传（与审计身份同待遇）。
 *
 * LLM 全程无感知：信任集不进 system prompt，工具结果也不标注是否免了审批。
 * 否则模型会倾向挑免问路径绕路，被注入时更是直接交出攻击面
 * （同 v0.8.1 熔断续跑"y 零注入"哲学）。审计另当别论——那是给人看的，照记。
 */

/** 动词形态校验：信任集会落盘，不接受任意字符串 */
const VERB_RE = /^[\w.+-]{1,64}$/
const MAX_VERBS_PER_HOST = 64

/** 会话级信任（普通机/实验机都先进这里，实验机另落盘） */
const sessionTrust = new Map<string, Set<string>>()
/** 持久信任（实验机）：hostId → verbs */
let persisted: Record<string, string[]> | null = null

function trustFile(): string {
  return join(app.getPath('userData'), 'trust.json')
}

async function load(): Promise<Record<string, string[]>> {
  if (persisted) return persisted
  try {
    const parsed = JSON.parse(await fs.readFile(trustFile(), 'utf-8'))
    persisted = {}
    for (const [hostId, verbs] of Object.entries(parsed)) {
      if (Array.isArray(verbs)) {
        persisted[hostId] = verbs.filter((v): v is string => typeof v === 'string' && VERB_RE.test(v))
      }
    }
  } catch {
    persisted = {}
  }
  return persisted
}

/** 启动即预热：isTrusted 是同步判定，必须在首个提案前就绪 */
export function preloadTrust(): void {
  void load()
}

function persistedFor(hostId: string | null): string[] {
  if (!hostId || !persisted) return []
  return persisted[hostId] ?? []
}

/** 本会话当前生效的免问动词（会话级 ∪ 持久级，排序稳定供 UI 展示）。
 *  root 会话**不读** trust.json：普通会话里授予的 verb 信任不能变成
 *  root 免问——授予时用户看到的对象不是 root，跨会话搬运即越权。 */
export function listTrust(sessionId: string): string[] {
  const meta = getSessionMeta(sessionId)
  if (meta?.envLevel === 'production') return []
  const merged = new Set([
    ...(sessionTrust.get(sessionId) ?? []),
    ...(meta?.envLevel === 'experiment' && !meta.elevated ? persistedFor(meta.hostId) : [])
  ])
  return [...merged].sort()
}

export function isTrusted(sessionId: string, verb: string): boolean {
  if (!verb) return false
  return listTrust(sessionId).includes(verb)
}

/**
 * 授予信任。生产机一律拒绝（主进程硬校验，不信 UI 禁用态）；
 * 实验机同时落盘，跨会话记得住。返回是否真的记下了。
 */
export function grantTrust(sessionId: string, verb: string): boolean {
  if (!VERB_RE.test(verb)) return false
  const meta = getSessionMeta(sessionId)
  if (meta?.envLevel === 'production') return false
  let set = sessionTrust.get(sessionId)
  if (!set) {
    set = new Set()
    sessionTrust.set(sessionId, set)
  }
  if (set.size >= MAX_VERBS_PER_HOST && !set.has(verb)) return false
  set.add(verb)
  // root 会话**不写** trust.json：本会话内的授予是"对 root 的免问"，
  // 落盘会让它在未来的普通会话里以另一重身份复活。会话级照常（用户授予时知道对象是 root）
  if (meta?.envLevel === 'experiment' && meta.hostId && !meta.elevated) {
    void savePersisted(meta.hostId, verb)
  }
  return true
}

async function savePersisted(hostId: string, verb: string): Promise<void> {
  const store = await load()
  const verbs = new Set(store[hostId] ?? [])
  if (verbs.has(verb) || verbs.size >= MAX_VERBS_PER_HOST) return
  verbs.add(verb)
  store[hostId] = [...verbs].sort()
  try {
    await fs.writeFile(trustFile(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    // 落盘失败只损失"跨会话记得住"，本会话信任仍在内存里生效
  }
}

/** 清空本会话主机的免问动词（会话级 + 该主机的持久级一并清）。
 *  root 会话只清会话级——不读不写 trust.json 是整条纪律，清空也是写 */
export async function clearTrust(sessionId: string): Promise<void> {
  sessionTrust.delete(sessionId)
  const meta = getSessionMeta(sessionId)
  if (!meta?.hostId || meta.elevated) return
  const store = await load()
  if (!store[meta.hostId]) return
  delete store[meta.hostId]
  try {
    await fs.writeFile(trustFile(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    // 同上：内存已清，落盘失败下次启动会复现旧记录（清空可重试）
  }
}

export function disposeTrust(sessionId: string): void {
  sessionTrust.delete(sessionId)
}

export function registerTrustHandlers(): void {
  preloadTrust()
  ipcMain.handle('agent:trust-list', (_event, sessionId: string): string[] =>
    listTrust(String(sessionId))
  )
  ipcMain.handle('agent:trust-clear', async (_event, sessionId: string): Promise<string[]> => {
    await clearTrust(String(sessionId))
    return listTrust(String(sessionId))
  })
}
