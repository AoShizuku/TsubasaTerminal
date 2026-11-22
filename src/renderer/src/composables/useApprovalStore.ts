import { reactive } from 'vue'
import type { AgentProposal, ExperienceEdits, ProposalDecision } from '@shared/types'
import { focusHome } from '@/lib/focusManager'
import { composerState, enterRunning } from '@/composables/useComposerStore'
import { noteComposerCommand } from '@/lib/transcript'

/**
 * 审批台渲染态（per-SSH-会话）：主进程 approvals.ts 是唯一事实源，
 * 这里只是显示层——approve/deny 回传的只有 proposalId 意图。
 * v0.8.1 阻塞语义下每会话至多一个待决提案（ReAct 串行），无队列。
 * 决策面即 composer 本体：Enter 归终端、Ctrl+Enter 归审批（composer-design）。
 */

export interface ApprovalState {
  /** 当前待决提案（exec / write_file / save_experience / continue）；null = 无 */
  current: AgentProposal | null
  /** 高危确认词不匹配、空输入等错误提示 */
  error: string | null
  /** write_file / save_experience 查看器展开状态（中栏占位，不覆盖终端） */
  viewerOpen: boolean
  /** 本提案的内容是否被看过——没看过不能批（防盲批软拦截） */
  viewed: boolean
  /** 已批准 exec 的执行中指示（命令文本；tool-end/turn-end 清除）；
   *  transfer也复用此槽（标签如 `push app.exe`，进度事件驱动） */
  executing: string | null
  /** transfer 传输进度百分比；null = 无传输进行中 */
  transferPercent: number | null
  /** 本会话生效的免问动词（v0.9.2 `a` 信任集）——主进程是事实源，这里只显示 */
  trustedVerbs: string[]
  /**
   * save_experience 查看器里的可编辑草稿：批准时随 approve 回传主进程。
   * 人写即指令通道——这是唯一一处"UI 上的内容会成为执行内容"的提案，
   * 设计如此（Agent 起草、人改完落盘），不是打破"主进程自存原文"的口子。
   */
  expEdit: ExperienceEdits | null
}

const states = reactive<Record<string, ApprovalState>>({})

export function approvalState(sessionId: string): ApprovalState {
  if (!states[sessionId]) {
    states[sessionId] = {
      current: null,
      error: null,
      viewerOpen: false,
      viewed: false,
      executing: null,
      transferPercent: null,
      trustedVerbs: [],
      expEdit: null
    }
  }
  return states[sessionId]
}

/**
 * 只读探询（v0.12.1 fix，TabBar 待审批徽章用）：**不能**改用 approvalState()——
 * 它会惰性建状态，在 render 期写 reactive 就是让渲染自己触发自己的更新。
 * 读不存在的 key 照样被 Vue track，之后新增时该 tab 会重渲染。
 */
export function hasPendingApproval(sessionId: string): boolean {
  return states[sessionId]?.current != null
}

export function onTrustChanged(sessionId: string, verbs: string[]): void {
  approvalState(sessionId).trustedVerbs = verbs
}

/** 连接后拉一次（实验机的持久信任跨会话仍在），之后靠 agent:event 同步 */
export async function loadTrust(sessionId: string): Promise<void> {
  onTrustChanged(sessionId, await window.api.agent.trustList(sessionId))
}

export async function clearTrust(sessionId: string): Promise<void> {
  onTrustChanged(sessionId, await window.api.agent.trustClear(sessionId))
}

/**
 * 信任免问的 exec 由主进程直接写入 pty（无提案卡）：渲染侧要做的与"批准"
 * 完全相同——记精确命令文本供转录配对、进运行态（否则用户的交互应答会被
 * 当成新命令，v0.8.6 踩坑）。
 */
export function onTrustedExec(sessionId: string, command: string): void {
  const state = approvalState(sessionId)
  noteComposerCommand(sessionId, command)
  state.executing = command
  enterRunning(sessionId)
}

export function onProposalNew(sessionId: string, proposal: AgentProposal): void {
  const state = approvalState(sessionId)
  state.current = proposal
  state.error = null
  // 到达时收起（不重排用户正在看的终端）；exec/continue 无内容可看，视为已看
  state.viewerOpen = false
  state.viewed = proposal.kind !== 'write_file' && proposal.kind !== 'save_experience'
  // 经验草稿从提案初始化：查看器里改的是这份副本，批准时整体回传
  state.expEdit =
    proposal.kind === 'save_experience'
      ? {
          summary: proposal.summary ?? '',
          detail: proposal.detail ?? '',
          scope: proposal.scope ?? 'host'
        }
      : null
}

export function onProposalResolved(
  sessionId: string,
  proposalId: string,
  command: string,
  decision: ProposalDecision
): void {
  const state = approvalState(sessionId)
  if (state.current?.id !== proposalId) return
  // 批准的 exec 由主进程写入 pty：为转录记精确命令文本（IPC 先于 SSH 回显到达），
  // 并让 composer 进入运行态——执行期间不再显示"就绪"，用户的交互应答不会被当作新命令
  if (decision === 'approved' && state.current.kind === 'exec') {
    noteComposerCommand(sessionId, command)
    state.executing = command
    enterRunning(sessionId)
  }
  state.current = null
  state.error = null
  state.viewerOpen = false
  state.viewed = false
  state.expEdit = null
}

/** 批准 exec 的执行结束（tool-end / turn-end 触发），清执行中指示 */
export function clearExecuting(sessionId: string, command?: string): void {
  const state = states[sessionId]
  if (state && (command === undefined || state.executing === command)) state.executing = null
}

/**
 * transfer 传输进度（v0.13.2 CLI push）：批准后到 rename 落地之间的"执行中 · N%"。
 * percent=null = 传输结束（成功失败都清）——主进程 finally 里必发，不留悬挂指示。
 */
export function onTransferProgress(sessionId: string, label: string, percent: number | null): void {
  const state = approvalState(sessionId)
  if (percent === null) {
    if (state.executing === label) state.executing = null
    state.transferPercent = null
    return
  }
  state.executing = label
  state.transferPercent = percent
}

export function toggleViewer(sessionId: string): void {
  const state = approvalState(sessionId)
  state.viewerOpen = !state.viewerOpen
  /**
   * **只有真渲染出来才算看过**（v0.13.1 二次返工修）。此前是无条件 `viewed = true`，
   * 而中栏那版的经验编辑器会把查看器"藏起来"——展开徽标 → viewed 置位 → 查看器
   * 因让位而没渲染 → y 直接批准从未显示过的内容，防盲批被绕过。讽刺的是"藏起来"
   * 这档语义引进来正是为了保住防盲批体验（省一次重开的点击）。
   *
   * 编辑器改弹窗后让位方只剩 TUI（那时 composer 整体隐藏、徽标本就点不到），
   * 判定仍必须跟着"实际可见"走——不能再假定"点开 = 看见"。
   */
  if (state.viewerOpen && composerState(sessionId).mode !== 'tui') state.viewed = true
  // 开合均回家（仅用户主动 toggle 走这里，提案到达的收起不经此函数不抢焦点）：
  // 展开后滚轮阅读不需要焦点，焦点留家=看完直接 y+Ctrl+Enter，全程一次点击
  focusHome()
}

export async function approveProposal(
  sessionId: string,
  proposalId: string,
  confirmText?: string,
  trust?: boolean
): Promise<boolean> {
  const state = approvalState(sessionId)
  // save_experience：把查看器里（可能改过的）内容一并回传；Vue 响应式对象跨 IPC 会
  // 抛 could not be cloned，先手工展开成 plain object
  const edits =
    state.current?.kind === 'save_experience' && state.expEdit
      ? { summary: state.expEdit.summary, detail: state.expEdit.detail, scope: state.expEdit.scope }
      : undefined
  const result = await window.api.agent.approve(sessionId, proposalId, confirmText, trust, edits)
  if (!result.ok) state.error = result.error ?? '批准失败'
  return result.ok
}

export async function denyProposal(
  sessionId: string,
  proposalId: string,
  comment?: string
): Promise<boolean> {
  const state = approvalState(sessionId)
  const result = await window.api.agent.deny(sessionId, proposalId, comment)
  if (!result.ok) state.error = result.error ?? '操作失败'
  return result.ok
}

export function disposeApprovals(sessionId: string): void {
  delete states[sessionId]
}
