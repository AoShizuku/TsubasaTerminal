import { reactive } from 'vue'
import type { CliMultiEvent, MultiProposalView } from '@shared/types'
import { focusHome } from '@/lib/focusManager'

/**
 * 多机批次浮层的渲染态（cli-bridge-design 9.5）：跨会话**单例**——
 * 主进程同一时刻至多挂一个多机提案（第二批被 105 挡），这里也只存一份。
 * 主进程 approvals.ts 是唯一事实源；approve/deny 只回传 proposalId 意图。
 *
 * 生命周期跨三阶段（审批 → 执行 → 终态）：批完用户只看得到一台的 pty，
 * 执行/终态两阶段就是全局视图，终态停留到用户关掉。
 */

export type MultiPhase = 'pending' | 'executing' | 'final'

export interface MultiHostStatus {
  done: boolean
  exitCode: number | null
}

interface MultiApprovalState {
  proposal: MultiProposalView | null
  phase: MultiPhase
  /** 逐台执行进度（approved 后 host-done 事件推进；key = sessionId） */
  hostStatus: Record<string, MultiHostStatus>
  /** 浮层自己的输入草稿——与 Composer 草稿**绝不共用**（9.5） */
  draft: string
  error: string | null
  /** 临时收起（收起 ≠ 放弃决策；不持久化） */
  collapsed: boolean
  /** 倒计时时基（挂起阶段每秒推进） */
  now: number
}

const state = reactive<MultiApprovalState>({
  proposal: null,
  phase: 'pending',
  hostStatus: {},
  draft: '',
  error: null,
  collapsed: false,
  now: Date.now()
})

let ticker: ReturnType<typeof setInterval> | null = null

function startTicker(): void {
  stopTicker()
  state.now = Date.now()
  ticker = setInterval(() => {
    state.now = Date.now()
  }, 1000)
}

function stopTicker(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}

export function multiApprovalState(): MultiApprovalState {
  return state
}

/** 是否有多机提案在挂起（Composer 的 Ctrl+Enter 拦截与路标看它） */
export function multiPending(): boolean {
  return state.proposal !== null && state.phase === 'pending'
}

/** 浮层是否可见（三阶段都算——tab 呼吸/终态短留同看） */
export function multiVisible(): boolean {
  return state.proposal !== null
}

/** 该会话是不是当前批次的目标（TabBar 呼吸徽章：波及范围可视化） */
export function isMultiTarget(sessionId: string): boolean {
  return state.proposal?.targets.some((t) => t.sessionId === sessionId) ?? false
}

/** 挂起阶段剩余秒数（路标与浮层共用；非挂起阶段返回 null） */
export function multiRemainingSeconds(): number | null {
  if (!multiPending() || !state.proposal) return null
  const left = state.proposal.createdAt + state.proposal.timeoutMs - state.now
  return Math.max(0, Math.ceil(left / 1000))
}

function applyEvent(event: CliMultiEvent): void {
  if (event.kind === 'new') {
    state.proposal = event.proposal
    state.phase = 'pending'
    state.hostStatus = {}
    state.draft = ''
    state.error = null
    state.collapsed = false
    startTicker()
    return
  }
  if (!state.proposal || state.proposal.id !== event.proposalId) return
  if (event.kind === 'resolved') {
    if (event.decision === 'approved') {
      // 批准 → 执行阶段：逐台进度由 host-done 推进
      state.phase = 'executing'
      state.error = null
      state.draft = ''
      stopTicker()
    } else {
      // 拒绝 / 撤回 / 取消：整批同命运，浮层直接退场（拒绝不需要终态视图——
      // 什么都没发生；撤回的解释在 CLI 侧 stderr）
      dismissMulti()
    }
    return
  }
  if (event.kind === 'host-done') {
    state.hostStatus[event.sessionId] = { done: true, exitCode: event.exitCode }
    return
  }
  // batch-done：转入终态，停留到用户关掉
  state.phase = 'final'
}

export function dismissMulti(): void {
  state.proposal = null
  state.phase = 'pending'
  state.hostStatus = {}
  state.draft = ''
  state.error = null
  state.collapsed = false
  stopTicker()
}

export async function approveMulti(confirmText?: string): Promise<void> {
  const p = state.proposal
  if (!p || state.phase !== 'pending') return
  const result = await window.api.cli.multiApprove(p.id, confirmText)
  if (!result.ok) state.error = result.error ?? '批准失败'
}

export async function denyMulti(comment?: string): Promise<void> {
  const p = state.proposal
  if (!p || state.phase !== 'pending') return
  const result = await window.api.cli.multiDeny(p.id, comment)
  if (!result.ok) state.error = result.error ?? '操作失败'
}

// ---------- 浮层输入框的焦点管理（Ctrl+Shift+Enter 前往；Esc 回家） ----------

let overlayInput: HTMLElement | null = null

export function registerMultiInput(el: HTMLElement): void {
  overlayInput = el
}

export function unregisterMultiInput(el: HTMLElement): void {
  if (overlayInput === el) overlayInput = null
}

export function focusMultiInput(): boolean {
  if (!multiPending() || !overlayInput) return false
  // 收起态先展开再落焦（focus 一个 display:none 的输入框是静默失败）
  state.collapsed = false
  requestAnimationFrame(() => overlayInput?.focus())
  return true
}

export function blurMultiToHome(): void {
  focusHome()
}

// ---------- 一次性 wiring ----------

let wired = false

export function initMultiWiring(): void {
  if (wired) return
  wired = true
  window.api.cli.onMulti((event) => applyEvent(event))
}
