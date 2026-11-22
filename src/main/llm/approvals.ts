import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AgentProposal,
  AgentRisk,
  AgentSendResult,
  CliMultiEvent,
  ExperienceEdits,
  ExperienceScope,
  HostEnvLevel,
  MultiProposalView,
  TerminalWriteStatus
} from '../../shared/types'
import { getSession, getSessionSender } from '../ssh'
import { getCurrentPtyUser, waitForUnit } from '../transcript'
import { auditLog, type AuditActor } from '../audit'
import { validateExperience } from './experience'
import { trustableRisk } from './gate'
import {
  disposeTerminalState,
  isTerminalIdle,
  markCommandWritten,
  noteTerminalWriteState,
  terminalBusyText
} from './terminalState'
import { grantTrust, listTrust } from './trust'

/**
 * 审批台主进程侧（composer-design Phase 3，v0.8.1 阻塞语义）：
 * - 提案原文自存在这里；渲染进程只回传 approve(proposalId) 意图，
 *   主进程执行的是自己存的字符串——UI 被篡改也偷换不了命令；
 * - 高危确认词（exec=真动词 / write_file=文件名）在主进程校验，不信 UI 禁用态；
 * - 提交方（exec / write_file 工具、轮数熔断续跑）**无限期阻塞**等待决策：
 *   y/N/comment 直接成为工具结果回流 Agent（comment 即对话轮），
 *   批准的 exec 还会继续等到执行结果回流——上一条不跑完，下一条提不出来。
 *   等待期间没有 API 调用在飞，不烧钱；stop 中止即取消提案（没有迟到决策）。
 * - 每会话同一时刻至多一个待决提案（ReAct 循环天然串行）。
 */

export type ApprovalDecision =
  /** edits 仅 save_experience：用户在查看器里确认（可能改过）的内容，
   *  落盘以它为准——人写即指令通道，这不是"UI 篡改"而是设计要的人审形态。
   *  writeFailures 仅多机批准：批准瞬间的重查与写入之间仍有微小竞态，
   *  写失败的目标 sessionId 列在这里，调用方按"该台未执行"处理 */
  | { outcome: 'approved'; edits?: ExperienceEdits; writeFailures?: string[] }
  | { outcome: 'denied'; comment?: string }
  /** 用户 stop / 会话关闭：提案随之取消 */
  | { outcome: 'aborted' }
  /** 挂起超时主动撤回（v0.12.1 CLI 审批路径）：命令未执行，与用户否决语义分开——
   *  幽灵提案（外部 agent 已放弃、用户五分钟后随手批准）的正解就是提案不许比
   *  调用方的注意力活得久 */
  | { outcome: 'withdrawn' }

/** 多机批量的单台目标：执行以主进程自存的逐台 ptyCommand 为准 */
export interface MultiTargetInput {
  sessionId: string
  handle: string
  name: string
  /** applyEnvShift 后的逐台档位（卡上逐台展示；整批档位取 max） */
  risk: AgentRisk
  envLevel: HostEnvLevel
  elevated: boolean
  /** 该台实际写入 pty 的命令（bg/save 落点逐台不同） */
  ptyCommand: string
}

interface PendingProposal {
  proposal: AgentProposal
  sessionId: string
  sender: WebContents
  /** 发起方（v0.12.0 审计合流）：决策条目要能回答"谁提的这一条" */
  actor?: AuditActor
  /** 多机批量：非空即"一卡罩 N 台"，sessionId 仅是首个目标；
   *  挂起期间 N 台全被视作有待决提案（agent:send 与 CLI pty 路口都挡） */
  targets?: MultiTargetInput[]
  /** 多机批次审计 id：同批 N 条审计靠它串起来 */
  batchId?: string
  waiter: ((d: ApprovalDecision) => void) | null
}

const proposals = new Map<string, PendingProposal>()

function emitEvent(entry: PendingProposal, event: AgentEvent): void {
  if (!entry.sender.isDestroyed()) entry.sender.send('agent:event', entry.sessionId, event)
}

/** 审计里命令字段的形态：write_file 记路径、save_experience 记梗概、
 *  transfer 记两端路径，continue 不进审计 */
function auditCommand(p: AgentProposal): string {
  if (p.kind === 'write_file') return `write_file ${p.path}`
  if (p.kind === 'save_experience') return `save_experience ${p.summary ?? ''}`
  if (p.kind === 'transfer') return `push ${p.localPath ?? ''} -> ${p.path ?? ''}`
  return p.command
}

/**
 * pty 有效身份（v0.11.0 审计身份修正）：exec 提案在用户终端里执行，`sudo su` 之后
 * 实际身份是 root——此前审计一律记 SessionMeta 的登录用户，日志在撒谎。
 * 取值用 pty 上报（OSC 7 userinfo），探不到标 unknown：不猜，更不沿用登录身份。
 */
function ptyIdentity(sessionId: string): string {
  return getCurrentPtyUser(sessionId) ?? 'unknown'
}

export interface ProposalInput {
  kind: AgentProposal['kind']
  command: string
  risk: AgentRisk
  reason: string
  verb: string
  path?: string
  content?: string
  exists?: boolean
  oldSize?: number
  /** 动词可否进 `a` 信任集（闸门算好，主进程批准时二次校验） */
  trustable?: boolean
  /** 空 Ctrl+Enter 即批准（low 档、非生产机、非 continue） */
  blankApprove?: boolean
  /** save_experience：待人审的经验内容 */
  summary?: string
  detail?: string
  scope?: ExperienceScope
  /** transfer：本机源路径 / 源大小 / 显式 mode / 原属主 / 大文件标注 */
  localPath?: string
  size?: number
  modeStr?: string
  owner?: string
  large?: boolean
}

// 终端可写事实（v0.13.4 结构化 + fail-closed）单点在 terminalState.ts——
// 这里只是消费方之一；上报 IPC 的注册仍在本文件（审批域的入口集中在一处）。

/** 提案是否罩住该会话：单机看 sessionId，多机看整个 targets */
function coversSession(entry: PendingProposal, sessionId: string): boolean {
  if (entry.sessionId === sessionId) return true
  return entry.targets?.some((t) => t.sessionId === sessionId) ?? false
}

/** 会话是否有待决提案：CLI 的 pty 路口互斥要看它——审批台单提案语义
 *  此前靠 ReAct 串行天然保证，CLI 成为第二提交方后必须显式守住 */
export function hasPendingProposal(sessionId: string): boolean {
  for (const entry of proposals.values()) {
    if (coversSession(entry, sessionId)) return true
  }
  return false
}

/** 会话是否有 CLI 发起的待决提案：agent:send 要挡——两个大脑抢一张审批卡 */
export function hasCliProposal(sessionId: string): boolean {
  for (const entry of proposals.values()) {
    if (coversSession(entry, sessionId) && String(entry.actor ?? '').startsWith('cli')) return true
  }
  return false
}

/** 是否有多机批量提案挂起：批次浮层是跨会话单例，审批输入语义要全局唯一，
 *  挂起期间第二个多机批次与其他 CLI 提案一律 105——用户此刻只该面对一张卡 */
export function hasMultiPendingProposal(): boolean {
  for (const entry of proposals.values()) {
    if (entry.targets) return true
  }
  return false
}

/** 某条提案是否仍在挂起（v0.12.1 `job` 轮询：区分"待决策"与"已批准执行中"） */
export function isProposalPending(proposalId: string): boolean {
  return proposals.has(proposalId)
}

/** 提交提案并阻塞等待决策；决策 / stop 中止 / 超时撤回三条路恰好 resolve 一次。
 *  timeoutMs：挂起窗口，到点**主动撤回**——只有 CLI 传（内置 Agent 无限期等）；
 *  onCreated：提案回执（`--async` 要立刻把 proposalId 带回给调用方）。 */
export function submitProposal(
  ctx: {
    sessionId: string
    sender: WebContents
    signal: AbortSignal
    actor?: AuditActor
    timeoutMs?: number
    onCreated?: (proposalId: string) => void
  },
  input: ProposalInput
): Promise<ApprovalDecision> {
  const proposal: AgentProposal = {
    id: randomUUID(),
    kind: input.kind,
    command: input.command,
    risk: input.risk,
    reason: input.reason.slice(0, 500),
    verb: input.verb,
    createdAt: Date.now(),
    path: input.path,
    content: input.content,
    exists: input.exists,
    oldSize: input.oldSize,
    trustable: input.trustable,
    blankApprove: input.blankApprove,
    summary: input.summary,
    detail: input.detail,
    scope: input.scope,
    localPath: input.localPath,
    size: input.size,
    modeStr: input.modeStr,
    owner: input.owner,
    large: input.large
  }
  const entry: PendingProposal = {
    proposal,
    sessionId: ctx.sessionId,
    sender: ctx.sender,
    actor: ctx.actor,
    waiter: null
  }
  proposals.set(proposal.id, entry)
  if (proposal.kind !== 'continue') {
    void auditLog(ctx.sessionId, {
      kind: 'proposal',
      actor: ctx.actor,
      proposalId: proposal.id,
      command: auditCommand(proposal),
      risk: proposal.risk,
      reason: proposal.reason,
      // 只有 exec 在 pty 里执行；write_file/save_experience 走 SFTP/本地，不带
      ...(proposal.kind === 'exec' ? { ptyUser: ptyIdentity(ctx.sessionId) } : {})
    })
  }
  emitEvent(entry, { kind: 'proposal-new', proposal })
  ctx.onCreated?.(proposal.id)

  return new Promise<ApprovalDecision>((resolve) => {
    let timer: NodeJS.Timeout | null = null
    const settle = (decision: ApprovalDecision): void => {
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      entry.waiter = null
      resolve(decision)
    }
    const onAbort = (): void => {
      // 阻塞语义下没有"迟到决策"：中止即取消提案，渲染侧同步清卡
      proposals.delete(proposal.id)
      emitEvent(entry, {
        kind: 'proposal-resolved',
        proposalId: proposal.id,
        command: proposal.command,
        decision: 'denied'
      })
      settle({ outcome: 'aborted' })
    }
    // 超时撤回：提案不许比调用方的注意力活得久。撤回如实进审计——
    // "挂过又消失的卡"要能在日志里回答"去哪了"
    if (ctx.timeoutMs && ctx.timeoutMs > 0) {
      timer = setTimeout(() => {
        proposals.delete(proposal.id)
        emitEvent(entry, {
          kind: 'proposal-resolved',
          proposalId: proposal.id,
          command: proposal.command,
          decision: 'withdrawn'
        })
        if (proposal.kind !== 'continue') {
          void auditLog(ctx.sessionId, {
            kind: 'decision',
            actor: ctx.actor,
            decision: 'withdrawn',
            proposalId: proposal.id,
            command: auditCommand(proposal),
            risk: proposal.risk
          })
        }
        settle({ outcome: 'withdrawn' })
      }, ctx.timeoutMs)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    entry.waiter = settle
  })
}

/** 轮数熔断续跑确认：复用提案基建（同一个决策面、同一套 approve/deny IPC） */
export function askContinuation(
  ctx: { sessionId: string; sender: WebContents; signal: AbortSignal },
  rounds: number
): Promise<ApprovalDecision> {
  return submitProposal(ctx, {
    kind: 'continue',
    command: '',
    risk: 'low',
    reason: `Agent 已连续调用 ${rounds} 轮工具`,
    verb: ''
  })
}

/** 批准 exec 写入终端后盯转录：命令单元闭合即补记退出码（best-effort 审计），
 *  与工具侧同用 waitForUnit 的兜底匹配——命令文本错位时审计不再丢 result */
const RESULT_WATCH_MS = 15 * 60_000

function watchResult(sessionId: string, command: string, proposalId?: string, batchId?: string): void {
  void waitForUnit(sessionId, command, RESULT_WATCH_MS, undefined, Date.now()).then((unit) => {
    if (!unit) return
    void auditLog(sessionId, {
      kind: 'result',
      proposalId,
      batchId,
      command,
      exitCode: unit.exitCode,
      // 单元自带执行时刻的 pty 身份（比"此刻"更准——命令跑完身份可能已变）
      ptyUser: unit.ptyUser ?? 'unknown'
    })
  })
}

/**
 * 把命令写进用户可见终端（进转录、可审计）。批准路径与信任免问路径共用：
 * 先发事件再写 pty——IPC 到达早于 SSH 回显往返，渲染侧据此记精确命令文本
 * 并进运行态，B..C 段配对可靠。经传输管线统一入口。
 *
 * v0.13.4：这里是所有 Agent/CLI 写用户 pty 的最后一跳，write-safe 守卫收口在此
 * ——调用方可以（也应该）提前检查以给出更好的错误，但不能只靠调用方记得。
 * 返回值区分"会话断开"与"终端不可写"（此前压成一个 boolean，UI 会把 dirty
 * 错报成断线）；写入成功即同步标 running，两个写入方不会在同一空闲窗口里互踩。
 */
type TerminalWriteResult = 'written' | 'gone' | 'busy'

function writeToTerminal(
  sessionId: string,
  sender: WebContents,
  command: string,
  event: AgentEvent
): TerminalWriteResult {
  const session = getSession(sessionId)
  if (!session) return 'gone'
  if (!isTerminalIdle(sessionId)) return 'busy'
  if (!sender.isDestroyed()) sender.send('agent:event', sessionId, event)
  session.transfer.writeInput(command + '\r')
  markCommandWritten(sessionId)
  return 'written'
}

/**
 * 信任免问执行：动词已被用户显式授予免问，跳过审批台直接在
 * 用户终端执行。走 pty 不走独立 channel——mid 档命令会交互（apt 的 conffile
 * 询问，v0.8.6 教训），且用户可见是最后的监督兜底。审计标 trusted 如实区分。
 */
export function runTrustedCommand(
  sessionId: string,
  sender: WebContents,
  command: string,
  verb: string,
  risk: AgentRisk
): boolean {
  if (writeToTerminal(sessionId, sender, command, { kind: 'trusted-exec', command }) !== 'written') {
    return false
  }
  void auditLog(sessionId, {
    kind: 'auto-exec',
    command,
    risk,
    trusted: verb,
    ptyUser: ptyIdentity(sessionId)
  })
  watchResult(sessionId, command)
  return true
}

// ---------- 多机批量提案（cli-bridge-design 9.3） ----------

/** 批次事件走独立单向 IPC `cli:multi`，不并进 agent:event——那条流要过 foldEvent
 *  进对话回放，批次浮层是跨会话 UI 不是会话事件 */
export function emitMultiEvent(sender: WebContents, event: CliMultiEvent): void {
  if (!sender.isDestroyed()) sender.send('cli:multi', event)
}

/**
 * 一卡罩 N 台（9.3 七条纪律的主进程半边）：审批单元=整批不拆、风险=max(逐台位移档)、
 * 确认词用动词不用主机名、无空批、无 `a` 免问。提案原文（逐台 ptyCommand）自存在
 * 这里，渲染进程只回传 proposalId 意图。挂起期间 N 台全被 hasPendingProposal 罩住。
 */
export function submitMultiProposal(
  ctx: {
    sender: WebContents
    signal: AbortSignal
    actor?: AuditActor
    /** 多机恒有超时（调用方只有 CLI，而 CLI 恒有窗口）——多机没有无限期等待的形态 */
    timeoutMs: number
    batchId: string
    onCreated?: (proposalId: string) => void
  },
  input: {
    command: string
    risk: AgentRisk
    reason: string
    verb: string
    background: boolean
    targets: MultiTargetInput[]
  }
): Promise<ApprovalDecision> {
  const proposal: AgentProposal = {
    id: randomUUID(),
    kind: 'exec',
    command: input.command,
    risk: input.risk,
    reason: input.reason.slice(0, 500),
    verb: input.verb,
    createdAt: Date.now(),
    trustable: false,
    blankApprove: false
  }
  const entry: PendingProposal = {
    proposal,
    sessionId: input.targets[0].sessionId,
    sender: ctx.sender,
    actor: ctx.actor,
    targets: input.targets,
    batchId: ctx.batchId,
    waiter: null
  }
  proposals.set(proposal.id, entry)
  // 审计 N 台 N 条：逐台记实际要写入的命令与位移后档位，batchId 串起同一批
  for (const t of input.targets) {
    void auditLog(t.sessionId, {
      kind: 'proposal',
      actor: ctx.actor,
      proposalId: proposal.id,
      batchId: ctx.batchId,
      command: t.ptyCommand,
      risk: t.risk,
      reason: proposal.reason,
      ptyUser: ptyIdentity(t.sessionId)
    })
  }
  const view: MultiProposalView = {
    id: proposal.id,
    command: input.command,
    risk: input.risk,
    verb: input.verb,
    reason: proposal.reason,
    createdAt: proposal.createdAt,
    timeoutMs: ctx.timeoutMs,
    background: input.background,
    targets: input.targets.map((t) => ({
      sessionId: t.sessionId,
      handle: t.handle,
      name: t.name,
      risk: t.risk,
      envLevel: t.envLevel,
      elevated: t.elevated
    }))
  }
  emitMultiEvent(ctx.sender, { kind: 'new', proposal: view })
  ctx.onCreated?.(proposal.id)

  return new Promise<ApprovalDecision>((resolve) => {
    let timer: NodeJS.Timeout | null = null
    const settle = (decision: ApprovalDecision): void => {
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      entry.waiter = null
      resolve(decision)
    }
    const onAbort = (): void => {
      proposals.delete(proposal.id)
      emitMultiEvent(ctx.sender, { kind: 'resolved', proposalId: proposal.id, decision: 'aborted' })
      settle({ outcome: 'aborted' })
    }
    // 超时撤回：与单机同语义（提案不许比调用方的注意力活得久），逐台记 withdrawn
    timer = setTimeout(() => {
      proposals.delete(proposal.id)
      emitMultiEvent(ctx.sender, { kind: 'resolved', proposalId: proposal.id, decision: 'withdrawn' })
      for (const t of input.targets) {
        void auditLog(t.sessionId, {
          kind: 'decision',
          actor: ctx.actor,
          decision: 'withdrawn',
          proposalId: proposal.id,
          batchId: ctx.batchId,
          command: t.ptyCommand,
          risk: t.risk
        })
      }
      settle({ outcome: 'withdrawn' })
    }, ctx.timeoutMs)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    entry.waiter = settle
  })
}

/**
 * 批准整批：确认词（高危=动词）主进程硬校验；批准瞬间**重查 N 台 idle**——
 * 用户看卡的这段时间里某台的用户自己敲了命令，写进去就是喂给前台进程。
 * all-or-nothing：任一台忙则整批不执行，提案留在原地等用户再试（与"整批不拆"一致）。
 */
function resolveMultiApprove(proposalId: string, confirmText: string | undefined): AgentSendResult {
  const entry = proposals.get(proposalId)
  if (!entry?.targets) return { ok: false, error: '提案不存在或已处理' }
  const { proposal, targets } = entry
  if (proposal.risk === 'high' && (confirmText ?? '').trim() !== proposal.verb) {
    return { ok: false, error: `高危操作需输入「${proposal.verb}」确认执行` }
  }
  for (const t of targets) {
    if (!getSession(t.sessionId)) {
      // 目标会话没了（disposeProposals 的兜底竞态）：这批永远执行不了，整批取消
      proposals.delete(proposalId)
      emitMultiEvent(entry.sender, { kind: 'resolved', proposalId, decision: 'aborted' })
      entry.waiter?.({ outcome: 'aborted' })
      return { ok: false, error: `目标会话 ${t.name}（${t.handle}）已断开，整批已取消` }
    }
    if (!isTerminalIdle(t.sessionId)) {
      return {
        ok: false,
        error: `${t.name} 终端不可写（${terminalBusyText(t.sessionId)}），整批未执行——等它空闲后再批准`
      }
    }
  }
  proposals.delete(proposalId)
  const writeFailures: string[] = []
  for (const t of targets) {
    // 事件用 trusted-exec 形态：渲染侧的处理与"批准"完全相同（记精确命令文本供
    // 转录配对 + 进运行态 + 执行中指示），且不进对话流——正是多机要的语义
    const written = writeToTerminal(
      t.sessionId,
      getSessionSender(t.sessionId) ?? entry.sender,
      t.ptyCommand,
      { kind: 'trusted-exec', command: t.ptyCommand }
    )
    if (written !== 'written') {
      writeFailures.push(t.sessionId)
      continue
    }
    void auditLog(t.sessionId, {
      kind: 'decision',
      actor: entry.actor,
      decision: 'approved',
      proposalId,
      batchId: entry.batchId,
      command: t.ptyCommand,
      risk: t.risk,
      ptyUser: ptyIdentity(t.sessionId)
    })
    watchResult(t.sessionId, t.ptyCommand, proposalId, entry.batchId)
  }
  emitMultiEvent(entry.sender, { kind: 'resolved', proposalId, decision: 'approved' })
  entry.waiter?.({
    outcome: 'approved',
    ...(writeFailures.length ? { writeFailures } : {})
  })
  return { ok: true }
}

function resolveMultiDeny(proposalId: string, comment: string | undefined): AgentSendResult {
  const entry = proposals.get(proposalId)
  if (!entry?.targets) return { ok: false, error: '提案不存在或已处理' }
  const trimmed = comment?.trim().slice(0, 2000) || undefined
  proposals.delete(proposalId)
  emitMultiEvent(entry.sender, { kind: 'resolved', proposalId, decision: 'denied' })
  for (const t of entry.targets) {
    void auditLog(t.sessionId, {
      kind: 'decision',
      actor: entry.actor,
      decision: 'denied',
      proposalId,
      batchId: entry.batchId,
      command: t.ptyCommand,
      risk: t.risk,
      comment: trimmed
    })
  }
  entry.waiter?.({ outcome: 'denied', comment: trimmed })
  return { ok: true }
}

function resolveApprove(
  sessionId: string,
  proposalId: string,
  confirmText: string | undefined,
  trust: boolean,
  rawEdits?: ExperienceEdits
): AgentSendResult {
  const entry = proposals.get(proposalId)
  if (!entry || entry.sessionId !== sessionId) {
    return { ok: false, error: '提案不存在或已处理' }
  }
  if (entry.targets) return { ok: false, error: '多机批量提案请在批次卡上决策' }
  const { proposal } = entry
  // 高危加重交互：确认词主进程硬校验（防 y 肌肉记忆 + 防 UI 篡改）
  if (proposal.risk === 'high' && (confirmText ?? '').trim() !== proposal.verb) {
    return { ok: false, error: `高危操作需输入「${proposal.verb}」确认执行` }
  }
  // save_experience 的用户修改：人写即指令通道，只做底线校验
  // （非空 + 上限；"症状 → 结论"形态对人不硬拦，UI 有提示）。校验不过打回给用户改，
  // 不能带病落盘——这条内容会进未来所有对话的上下文
  let edits: ExperienceEdits | undefined
  if (proposal.kind === 'save_experience' && rawEdits) {
    const summary = String(rawEdits.summary ?? '').replace(/\s+/g, ' ').trim()
    const detail = String(rawEdits.detail ?? '')
    const check = validateExperience(summary, detail, false)
    if (!check.ok) return { ok: false, error: check.reason }
    edits = { summary, detail, scope: rawEdits.scope === 'global' ? 'global' : 'host' }
  }
  // `a` 免问：资格（动词可信任 + 档位 ≤ mid）与环境（生产机不可用）全在主进程校验
  if (trust) {
    if (proposal.kind !== 'exec' || !proposal.trustable || !trustableRisk(proposal.risk)) {
      return { ok: false, error: '该命令不支持免问（高危、跨机或跳板类动词一律逐条审批）' }
    }
    if (!grantTrust(sessionId, proposal.verb)) {
      return { ok: false, error: '本机不支持免问（生产机每条都问）' }
    }
  }

  if (proposal.kind === 'exec') {
    // v0.13.4：批准瞬间复核 write-safe——渲染侧禁用按钮只是 UX，直接伪造 approve
    // IPC 也必须在这里被挡住；忙则提案留在原地，等用户清空终端行/退出前台程序再批
    if (!isTerminalIdle(sessionId)) {
      return {
        ok: false,
        error: `终端不可写（${terminalBusyText(sessionId)}），未执行——等终端空闲后再批准`
      }
    }
    proposals.delete(proposalId)
    const written = writeToTerminal(sessionId, entry.sender, proposal.command, {
      kind: 'proposal-resolved',
      proposalId,
      command: proposal.command,
      decision: 'approved'
    })
    if (written !== 'written') {
      proposals.set(proposalId, entry)
      return written === 'gone'
        ? { ok: false, error: '会话已断开，无法执行' }
        : {
            ok: false,
            error: `终端不可写（${terminalBusyText(sessionId)}），未执行——等终端空闲后再批准`
          }
    }
    void auditLog(sessionId, {
      kind: 'decision',
      actor: entry.actor,
      decision: 'approved',
      proposalId,
      command: proposal.command,
      risk: proposal.risk,
      trusted: trust ? proposal.verb : undefined,
      // 批准即写入 pty：记录命令将以谁的身份执行（sudo su 之后是 root）
      ptyUser: ptyIdentity(sessionId)
    })
    if (trust) emitEvent(entry, { kind: 'trust', verbs: listTrust(sessionId) })
    watchResult(sessionId, proposal.command, proposalId)
    entry.waiter?.({ outcome: 'approved' })
    return { ok: true }
  }

  // write_file：SFTP 写入由工具侧以主进程自存内容执行（内容从未跨 IPC，同样可信）；
  // save_experience：落盘由工具侧执行（edits 优先——人确认后的版本）；
  // transfer：上传由工具侧按主进程自存的路径执行；
  // continue：纯放行信号。四者都不碰 pty，不受终端忙碌限制。
  proposals.delete(proposalId)
  emitEvent(entry, {
    kind: 'proposal-resolved',
    proposalId,
    command: proposal.command,
    decision: 'approved'
  })
  if (
    proposal.kind === 'write_file' ||
    proposal.kind === 'save_experience' ||
    proposal.kind === 'transfer'
  ) {
    void auditLog(sessionId, {
      kind: 'decision',
      actor: entry.actor,
      decision: 'approved',
      proposalId,
      command: edits ? `save_experience ${edits.summary}` : auditCommand(proposal),
      risk: proposal.risk
    })
  }
  entry.waiter?.({ outcome: 'approved', edits })
  return { ok: true }
}

function resolveDeny(
  sessionId: string,
  proposalId: string,
  comment: string | undefined
): AgentSendResult {
  const entry = proposals.get(proposalId)
  if (!entry || entry.sessionId !== sessionId) {
    return { ok: false, error: '提案不存在或已处理' }
  }
  if (entry.targets) return { ok: false, error: '多机批量提案请在批次卡上决策' }
  const { proposal } = entry
  const trimmed = comment?.trim().slice(0, 2000) || undefined
  proposals.delete(proposalId)
  emitEvent(entry, {
    kind: 'proposal-resolved',
    proposalId,
    command: proposal.command,
    decision: 'denied'
  })
  if (proposal.kind !== 'continue') {
    void auditLog(sessionId, {
      kind: 'decision',
      actor: entry.actor,
      decision: 'denied',
      proposalId,
      command: auditCommand(proposal),
      risk: proposal.risk,
      comment: trimmed
    })
  }
  entry.waiter?.({ outcome: 'denied', comment: trimmed })
  return { ok: true }
}

export function disposeProposals(sessionId: string): void {
  disposeTerminalState(sessionId)
  for (const [id, entry] of proposals) {
    if (!coversSession(entry, sessionId)) continue
    proposals.delete(id)
    // 多机批量：任一目标会话关闭即整批取消（all-or-nothing——批准了也执行不全，
    // "以为打了 7 台其实只打了 6 台"正是批量作业最恶劣的形态）
    if (entry.targets) {
      emitMultiEvent(entry.sender, { kind: 'resolved', proposalId: id, decision: 'aborted' })
    }
    entry.waiter?.({ outcome: 'aborted' })
  }
}

export function registerApprovalHandlers(): void {
  ipcMain.handle(
    'agent:approve',
    (
      _event,
      sessionId: string,
      proposalId: string,
      confirmText?: string,
      trust?: boolean,
      edits?: ExperienceEdits
    ): AgentSendResult =>
      resolveApprove(String(sessionId), String(proposalId), confirmText, trust === true, edits)
  )
  // 终端可写状态上报（v0.13.4 结构化）：只收白名单内的合法值，别的一律当未知丢弃
  // ——fail-closed 下丢弃即不可写，不会因渲染层被篡改而放宽
  const WRITE_STATUSES = new Set(['clean', 'dirty', 'running', 'tui', 'none-unverified'])
  ipcMain.on('agent:terminal-write-state', (_event, sessionId: string, status: string) => {
    if (WRITE_STATUSES.has(status)) {
      noteTerminalWriteState(String(sessionId), status as TerminalWriteStatus)
    }
  })
  ipcMain.handle(
    'agent:deny',
    (_event, sessionId: string, proposalId: string, comment?: string): AgentSendResult =>
      resolveDeny(String(sessionId), String(proposalId), comment)
  )
  // 多机批量：proposalId 全局唯一，不按会话寻址——批次本来就跨会话
  ipcMain.handle(
    'cli:multi-approve',
    (_event, proposalId: string, confirmText?: string): AgentSendResult =>
      resolveMultiApprove(String(proposalId), confirmText)
  )
  ipcMain.handle(
    'cli:multi-deny',
    (_event, proposalId: string, comment?: string): AgentSendResult =>
      resolveMultiDeny(String(proposalId), comment)
  )
}
