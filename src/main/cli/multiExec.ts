import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import { CLI_EXIT, type CliRequest } from '../../shared/cli'
import type { AgentRisk } from '../../shared/types'
import { getSessionSender } from '../ssh'
import {
  emitMultiEvent,
  submitMultiProposal,
  type MultiTargetInput
} from '../llm/approvals'
import {
  collectTerminalResult,
  executeAutoPlan,
  planExec,
  type ExecPlanned,
  type ToolContext,
  type ToolExecution
} from '../llm/tools'
import { completeMultiJob, registerJob, type MultiHostOutcome, type MultiOutcome } from './jobs'
import { resolveRef, type SessionRow } from './bindings'
import {
  clampTimeout,
  emitNarration,
  execOutcome,
  grabAttention,
  ptyBusyReason,
  toolActor,
  warnAnonymous
} from './execShared'
import type { CliIo } from './commands'

/**
 * 多机并行（cli-bridge-design 第九节）：`exec --hosts a,b,c`。
 *
 * 这一层仍**不实现任何安全逻辑**——它只是把 tools.ts 的 planExec / executeAutoPlan /
 * collectTerminalResult 与 approvals.ts 的 submitMultiProposal 按 9.3 的纪律排序：
 * 先算完 N 台 verdict 再定路径（否则 auto 的台在卡弹出前就跑掉了）；全白名单走
 * 旁路逐台并行；只要有一台要审批，**一卡罩 N 台**整批等决策。
 */

const MAX_HOSTS = 7

interface MultiTargetCtx {
  row: SessionRow
  sender: WebContents
  ctx: ToolContext
  plan: ExecPlanned
}

/** 目标解析 fail-closed（9.3.7）：任一未命中整批 103、任一歧义整批 104、重复 124。
 *  与 `-s` 同款纪律：不读不写粘性绑定。 */
function resolveTargets(io: CliIo, refs: string[]): { ok: true; rows: SessionRow[] } | { ok: false; code: number } {
  const rows: SessionRow[] = []
  const seen = new Map<string, string>()
  for (const ref of refs) {
    const matches = resolveRef(ref)
    if (matches.length === 0) {
      io.err(
        `--hosts ${ref}：没有匹配的已连接会话，整批未执行。多机不自动开会话——` +
          `先跑 hosts 确认别名，再逐台 use 拿建联包（否则没有这台的主机档案先验），` +
          `最后 exec --hosts。\n`
      )
      return { ok: false, code: CLI_EXIT.NO_SESSION }
    }
    if (matches.length > 1) {
      io.err(`--hosts ${ref}：匹配到 ${matches.length} 个会话，整批未执行。请用 8 位句柄指定：\n`)
      for (const m of matches) {
        io.err(`  ${m.handle}  ${m.meta.name}  ${m.meta.username}@${m.meta.host}:${m.meta.port}\n`)
      }
      return { ok: false, code: CLI_EXIT.AMBIGUOUS }
    }
    const row = matches[0]
    const dup = seen.get(row.sessionId)
    if (dup) {
      io.err(`--hosts 目标重复：${ref} 与 ${dup} 指向同一个会话（${row.handle}）\n`)
      return { ok: false, code: CLI_EXIT.USAGE }
    }
    seen.set(row.sessionId, ref)
    rows.push(row)
  }
  return { ok: true, rows }
}

/** stderr 首行回显（3.4 同款纵深）：多机时列出全部目标，隔离失手第一行就暴露 */
function echoTargets(io: CliIo, req: CliRequest, rows: SessionRow[]): void {
  const handles = rows.map((r) => r.handle).join(',')
  const names = rows.map((r) => r.meta.name).join(',')
  const who = req.agent ? ` · agent ${req.agent}` : ''
  io.err(`# session ${handles} · ${names}${who}\n`)
}

function hostRisk(plans: ExecPlanned[]): AgentRisk {
  const order: Record<AgentRisk, number> = { low: 0, mid: 1, high: 2 }
  return plans.reduce<AgentRisk>((acc, p) => (order[p.risk] > order[acc] ? p.risk : acc), 'low')
}

function toOutcome(t: MultiTargetCtx, execution: ToolExecution | null, failure?: string): MultiHostOutcome {
  return {
    sessionId: t.row.sessionId,
    handle: t.row.handle,
    name: t.row.meta.name,
    execution,
    failure
  }
}

/**
 * 聚合输出（9.4.5/9.4.6）：stdout 一个 JSON 对象（N 台的纯 stdout 分不清谁是谁），
 * stderr 逐台一行人读摘要。退出码：整批同命运的（102/125/103）直接用；逐台执行的
 * 全同则透传，不一致退 109「逐台结果不一致，逐台读」。
 * 同步路径与 `job` 轮询共用这一份（9.4.7——别写成两套）。
 */
export function renderMultiOutcome(io: CliIo, outcome: MultiOutcome): number {
  if (outcome.decision === 'denied') {
    io.err(`用户否决了整批命令${outcome.comment ? `，留言：${outcome.comment}` : ''}\n`)
    printJson(io, outcome)
    return CLI_EXIT.DENIED
  }
  if (outcome.decision === 'withdrawn') {
    io.err('等待窗口内未获用户决策，整批提案已主动撤回（命令未在任何一台执行）。可稍后重发，或用 --async + job 轮询等更久。\n')
    printJson(io, outcome)
    return CLI_EXIT.TIMEOUT
  }
  if (outcome.decision === 'aborted') {
    io.err('整批提案已取消（某个目标会话被关闭，或请求被中止）——命令未在任何一台执行。\n')
    printJson(io, outcome)
    return CLI_EXIT.NO_SESSION
  }
  const codes: number[] = []
  for (const r of outcome.results) {
    if (!r.execution) {
      io.err(`# ${r.name}（${r.handle}）未执行：${r.failure ?? '未知原因'}\n`)
      codes.push(CLI_EXIT.NO_SESSION)
      continue
    }
    const o = execOutcome(r.execution)
    codes.push(o.code)
    io.err(`# ${r.name}（${r.handle}）→ exit ${o.exitCode ?? '?'} · cli ${o.code}\n`)
  }
  printJson(io, outcome)
  const allSame = codes.every((c) => c === codes[0])
  if (allSame) return codes[0] ?? CLI_EXIT.OK
  io.err('# 逐台结果不一致（109）：读 stdout JSON 的 results，逐台分别处理\n')
  return CLI_EXIT.MIXED
}

function printJson(io: CliIo, outcome: MultiOutcome): void {
  const json = {
    command: outcome.command,
    batchId: outcome.batchId,
    decision: outcome.decision,
    ...(outcome.comment ? { comment: outcome.comment } : {}),
    results: outcome.results.map((r) => {
      if (!r.execution) {
        return { handle: r.handle, host: r.name, code: CLI_EXIT.NO_SESSION, exitCode: null, stdout: '', notes: [r.failure ?? '未执行'] }
      }
      const o = execOutcome(r.execution)
      return { handle: r.handle, host: r.name, code: o.code, exitCode: o.exitCode, stdout: o.body, notes: o.notes }
    })
  }
  io.out(JSON.stringify(json, null, 2) + '\n')
}

export async function runExecMulti(
  io: CliIo,
  req: CliRequest,
  command: string,
  signal: AbortSignal
): Promise<number> {
  // 目标集必须显式列举（不给 all）；上限 7 台——数字取在"卡片一屏读得完 + 批完能
  // 挨个切 tab 看"的上沿。撞上限的代价要说给调用方听：分批 = 两次审批，且第二批
  // 审批时第一批已跑完、集群正处在中间态——能装进一批就别拆
  const refs = (req.flags.hosts ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (req.flags.session) {
    io.err('--hosts 与 -s/--session 不能同时用：多机目标已显式列举，不再有"当前会话"\n')
    return CLI_EXIT.USAGE
  }
  if (refs.length < 2) {
    io.err('--hosts 需要至少 2 台（逗号分隔）；单台请用 use 绑定或 -s 指定\n')
    return CLI_EXIT.USAGE
  }
  if (refs.length > MAX_HOSTS) {
    io.err(
      `--hosts 上限 ${MAX_HOSTS} 台（本次 ${refs.length} 台），整批未执行。分批的代价：两次审批，` +
        `且第二批审批时第一批已跑完、集群正处在中间态——请按依赖关系谨慎分组，逐批告知用户进度。\n`
    )
    return CLI_EXIT.USAGE
  }
  const resolved = resolveTargets(io, refs)
  if (!resolved.ok) return resolved.code
  echoTargets(io, req, resolved.rows)
  warnAnonymous(io, req)

  const actor = toolActor(req)
  const intent = req.flags.intent?.trim() || undefined
  const batchId = randomUUID()
  const targets: MultiTargetCtx[] = []
  for (const row of resolved.rows) {
    const sender = getSessionSender(row.sessionId)
    if (!sender || sender.isDestroyed()) {
      io.err(`${row.meta.name}（${row.handle}）所属窗口已关闭，整批未执行\n`)
      return CLI_EXIT.NO_SESSION
    }
    targets.push({
      row,
      sender,
      ctx: {
        sessionId: row.sessionId,
        convId: 'cli',
        sender,
        signal,
        wrap: (_source, text) => text,
        actor,
        allowPty: true
      },
      plan: null as unknown as ExecPlanned
    })
  }

  // 先算完 N 台 verdict 再定路径（9.3.1 硬前提）；闸门 reject 按 fail-closed 罩整批——
  // "跑得通的那几台先跑"正是批量作业最恶劣的形态
  const input: Record<string, unknown> = {
    command,
    risk: 'low',
    background: req.flags.bg === true,
    save_to_file: req.flags.save === true
  }
  const plans = await Promise.all(targets.map((t) => planExec(t.ctx, input)))
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    if (!plan.planned) {
      io.err(`# ${targets[i].row.meta.name}（${targets[i].row.handle}）被拒，整批未执行（fail-closed）：\n`)
      const o = execOutcome(plan.execution)
      for (const note of o.notes) io.err(`${note}\n`)
      return o.code
    }
    targets[i].plan = plan
  }

  // 全白名单：逐台旁路并行直执行，不进审批（这半本就是外部 agent 自己也做得到的，
  // --hosts 的增值只是省调用与聚合格式）
  if (targets.every((t) => t.plan.action === 'auto')) {
    const results = await Promise.all(
      targets.map(async (t) => {
        const execution = await executeAutoPlan(t.ctx, t.plan, { batchId })
        emitNarration(t.sender, t.row.sessionId, req.agent, command, intent, execution)
        return toOutcome(t, execution)
      })
    )
    return renderMultiOutcome(io, { command, batchId, decision: 'executed', results })
  }

  // 一卡罩 N 台：pty 路口互斥逐台过（内置 Agent 在跑 / 终端忙 / 已有提案都拒 105），
  // 挂起期间这 N 台的 agent:send 与其他 CLI 提案全被挡——卡片与 stderr 都要说清
  for (const t of targets) {
    const busy = ptyBusyReason(t.row.sessionId)
    if (busy) {
      io.err(`${t.row.meta.name}（${t.row.handle}）${busy}；整批未执行\n`)
      return CLI_EXIT.BUSY
    }
  }
  const timeoutSec = clampTimeout(req.flags.timeout)
  const agentLabel = req.agent ? `cli:${req.agent}` : 'cli（匿名）'
  const sensitiveNotes = targets
    .filter((t) => t.plan.verdict.sensitive)
    .map((t) => `${t.row.meta.name}：${t.plan.verdict.sensitive}`)
  const reason =
    (sensitiveNotes.length ? `【敏感路径，已取消自动执行——${sensitiveNotes.join('；')}】` : '') +
    (intent
      ? `[${agentLabel}] ${intent}`
      : `[${agentLabel}] 经 CLI 通道发起（未提供 --intent 意图说明）`)
  const multiTargets: MultiTargetInput[] = targets.map((t) => ({
    sessionId: t.row.sessionId,
    handle: t.row.handle,
    name: t.row.meta.name,
    risk: t.plan.risk,
    envLevel: t.row.meta.envLevel,
    elevated: t.row.meta.elevated,
    ptyCommand: t.plan.ptyCommand
  }))
  // 确认词用动词不用主机名（9.3.3）：多机有 N 个候选主机名，且"手打这台机器的名字"
  // 的语义在 7 台上不成立；生产机/root 台在卡上逐台高亮
  const verb = targets[0].plan.verdict.verb
  const risk = hostRisk(targets.map((t) => t.plan))
  io.err(
    `# 本批 ${targets.length} 台需用户审批（一张卡罩整批，挂起窗口 ${timeoutSec}s）；` +
      `挂起期间这 ${targets.length} 台的其他提案会被暂挡\n`
  )

  // onCreated 的 proposalId 在 runBatch 内部（host-done 事件）与 --async 注册两处用
  let lastProposalId: string | null = null

  const runBatch = async (
    batchSignal: AbortSignal,
    onCreated?: (proposalId: string) => void
  ): Promise<MultiOutcome> => {
    let dismissNotice: () => void = () => {}
    const firstSender = targets[0].sender
    const decision = await submitMultiProposal(
      {
        sender: firstSender,
        signal: batchSignal,
        actor,
        timeoutMs: timeoutSec * 1000,
        batchId,
        onCreated: (proposalId) => {
          lastProposalId = proposalId
          dismissNotice = grabAttention(
            firstSender,
            targets[0].row.sessionId,
            req.agent,
            `${targets.length} 台（${targets.map((t) => t.row.meta.name).join('、')}）：${intent ?? command}`
          )
          onCreated?.(proposalId)
        }
      },
      {
        command,
        risk,
        reason,
        verb,
        background: req.flags.bg === true,
        targets: multiTargets
      }
    ).finally(() => dismissNotice())
    if (decision.outcome !== 'approved') {
      return {
        command,
        batchId,
        decision: decision.outcome,
        ...(decision.outcome === 'denied' && decision.comment ? { comment: decision.comment } : {}),
        results: []
      }
    }
    // 批准后逐台等执行结果回流（各台按自己的 effective 文本配对转录单元）；
    // 每台收场即向浮层推进度，全部收场推 batch-done——批完用户只看得到一台的 pty，
    // 浮层的执行/终态两阶段就是全局视图
    const failures = new Set(decision.writeFailures ?? [])
    const proposalId = lastProposalId
    const results = await Promise.all(
      targets.map(async (t) => {
        if (failures.has(t.row.sessionId)) {
          if (proposalId) {
            emitMultiEvent(firstSender, {
              kind: 'host-done',
              proposalId,
              sessionId: t.row.sessionId,
              exitCode: null
            })
          }
          return toOutcome(t, null, '批准瞬间该会话已断开，命令未写入')
        }
        const execution = await collectTerminalResult(
          { ...t.ctx, signal: batchSignal },
          t.plan.ptyCommand,
          'approved',
          { backgroundLog: t.plan.logPath, savePath: t.plan.savePath }
        )
        if (proposalId) {
          emitMultiEvent(firstSender, {
            kind: 'host-done',
            proposalId,
            sessionId: t.row.sessionId,
            exitCode: typeof execution.raw?.exitCode === 'number' ? execution.raw.exitCode : null
          })
        }
        return toOutcome(t, execution)
      })
    )
    if (proposalId) emitMultiEvent(firstSender, { kind: 'batch-done', proposalId })
    return { command, batchId, decision: 'approved', results }
  }

  if (req.flags.async === true) {
    const jobController = new AbortController()
    let resolveCreated: (proposalId: string) => void = () => {}
    const created = new Promise<string>((resolve) => (resolveCreated = resolve))
    const batchPromise = runBatch(jobController.signal, (proposalId) => resolveCreated(proposalId))
    const proposalId = await created
    registerJob({
      proposalId,
      sessionId: targets[0].row.sessionId,
      handle: targets[0].row.handle,
      agent: req.agent,
      command,
      multi: null
    })
    void batchPromise.then(
      (outcome) => completeMultiJob(proposalId, outcome),
      () =>
        completeMultiJob(proposalId, {
          command,
          batchId,
          decision: 'aborted',
          results: []
        })
    )
    io.err(
      `# 多机提案已挂起等待用户审批（窗口 ${timeoutSec}s，超时自动撤回整批）。` +
        `轮询：tsubasa-ssh job ${proposalId}\n`
    )
    io.out(proposalId + '\n')
    return CLI_EXIT.OK
  }

  const outcome = await runBatch(signal)
  return renderMultiOutcome(io, outcome)
}
