import { reactive } from 'vue'
import type { CliActivity, CliActivityStatus } from '@shared/types'

/**
 * 右栏 CLI 栏的数据（cli-bridge-design 第七节）：外部 agent 经 tsubasa-ssh 在各会话发起的
 * exec / push，按会话分列。白名单命令经旁路 channel 执行时终端完全不可见，这张列表是它
 * 在界面上的落点；审批路径的结局（批准 / 拒绝 / 超时撤回）一并列入，列表才完整。
 *
 * 主进程按 activity.id 多次推送同一条（开始 → 待审批 → 执行中 → 终态），这里原位覆盖。
 * 只住内存、每会话留最近 CLI_ACTIVITY_LIMIT 条、关会话即清；权威记录是 audit.jsonl。
 */

export const CLI_ACTIVITY_LIMIT = 200

/** 状态文案；与 Agent 工具卡同义的几档沿用同一措辞 */
export const CLI_STATUS_LABEL: Record<CliActivityStatus, string> = {
  running: '执行中…',
  proposed: '待审批',
  executed: '已执行',
  approved: '已批准',
  denied: '已拒绝',
  rejected: '被拒绝',
  withdrawn: '超时撤回',
  busy: '会话忙',
  aborted: '已取消',
  error: '出错'
}

/** 状态配色：成功绿、等人黄、被否与出错红，没执行但也不怪谁的灰 */
export const CLI_STATUS_TONE: Record<CliActivityStatus, 'muted' | 'ok' | 'warn' | 'danger'> = {
  running: 'muted',
  proposed: 'warn',
  executed: 'ok',
  approved: 'ok',
  denied: 'danger',
  rejected: 'danger',
  withdrawn: 'muted',
  busy: 'muted',
  aborted: 'muted',
  error: 'danger'
}

interface SessionActivities {
  items: CliActivity[]
  /** 本会话最新一条的序号；未读判断只看新条目，不看已有条目的状态推进 */
  latestSeq: number
  seenSeq: number
}

const sessions = reactive<Record<string, SessionActivities>>({})
let seq = 0

function sessionOf(sessionId: string): SessionActivities {
  let s = sessions[sessionId]
  if (!s) {
    sessions[sessionId] = { items: [], latestSeq: 0, seenSeq: 0 }
    s = sessions[sessionId]
  }
  return s
}

const EMPTY: readonly CliActivity[] = Object.freeze([])

export function cliActivities(sessionId: string | null): readonly CliActivity[] {
  if (!sessionId) return EMPTY
  return sessions[sessionId]?.items ?? EMPTY
}

export function onCliActivity(sessionId: string, activity: CliActivity): void {
  const s = sessionOf(sessionId)
  const index = s.items.findIndex((a) => a.id === activity.id)
  if (index >= 0) {
    s.items[index] = activity
    return
  }
  s.items.push(activity)
  if (s.items.length > CLI_ACTIVITY_LIMIT) s.items.splice(0, s.items.length - CLI_ACTIVITY_LIMIT)
  seq += 1
  s.latestSeq = seq
}

/** 该会话有没有用户还没在 CLI 栏里看到的新条目（栏标签上的未读点） */
export function cliUnread(sessionId: string | null): boolean {
  if (!sessionId) return false
  const s = sessions[sessionId]
  return Boolean(s && s.latestSeq > s.seenSeq)
}

export function markCliSeen(sessionId: string | null): void {
  if (!sessionId) return
  const s = sessions[sessionId]
  if (s) s.seenSeq = s.latestSeq
}

export function disposeCliActivity(sessionId: string): void {
  delete sessions[sessionId]
}
