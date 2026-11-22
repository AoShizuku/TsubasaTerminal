import type { ToolExecution } from '../llm/tools'

/**
 * 异步 exec 的 job 登记簿（cli-bridge-design 五.①）。
 *
 * `exec --async` 在提案挂起的瞬间返回 proposalId，之后 `job <id>` 轮询——
 * 适合"批准后执行很久"的命令（阻塞模式装不进外部 agent 的 Bash 超时窗口）。
 * job 只是**结果的暂存柜**：提案生命周期仍在 approvals.ts（超时撤回照常生效，
 * 撤回结果也存进来供轮询读到 125），执行仍在 executeTool——这里不实现任何安全逻辑。
 *
 * 终态结果保留 10 分钟、可重复读取（管道抖动重查不该丢结果），到点清理；
 * 只住内存，随应用退出消亡（与粘性绑定同语义——重启后会话全没了，job 也该没了）。
 */

/** 多机批量的单台终态：execution=null 表示该台没执行成（写入失败等） */
export interface MultiHostOutcome {
  sessionId: string
  handle: string
  name: string
  execution: ToolExecution | null
  /** 该台未执行的原因（execution=null 时非空） */
  failure?: string
}

/** 多机批量的整批终态：同步路径与 job 轮询共用同一份渲染 */
export interface MultiOutcome {
  command: string
  batchId: string
  /** executed = 全白名单逐台直执行（没进审批）；其余为审批终态 */
  decision: 'executed' | 'approved' | 'denied' | 'withdrawn' | 'aborted'
  comment?: string
  /** executed/approved 时逐台结果；其余为空（整批同命运） */
  results: MultiHostOutcome[]
}

export interface CliJob {
  proposalId: string
  sessionId: string
  /** 8hex 会话句柄（stderr 回显用）；多机 job 是首个目标 */
  handle: string
  agent?: string
  command: string
  createdAt: number
  /** 终态时刻；null = 仍在挂起/执行 */
  doneAt: number | null
  /** 终态结果；null = 未到终态 */
  execution: ToolExecution | null
  /** 多机批量 job：终态存这里，execution 恒为 null */
  multi?: MultiOutcome | null
}

const jobs = new Map<string, CliJob>()

/** 终态结果保留窗口：轮询方拿到结果后仍可重查，10 分钟后清理 */
const DONE_KEEP_MS = 10 * 60_000
/** 登记簿硬上限（防泄漏兜底；正常远到不了——每会话同时至多一个待决提案） */
const MAX_JOBS = 64

function sweep(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.doneAt !== null && now - job.doneAt > DONE_KEEP_MS) jobs.delete(id)
  }
  if (jobs.size > MAX_JOBS) {
    // 超限先丢最老的终态；仍超（病态量级的未终态 job）按创建序丢最老
    const sorted = [...jobs.values()].sort(
      (a, b) => Number(b.doneAt !== null) - Number(a.doneAt !== null) || a.createdAt - b.createdAt
    )
    for (const job of sorted) {
      if (jobs.size <= MAX_JOBS) break
      jobs.delete(job.proposalId)
    }
  }
}

export function registerJob(
  job: Pick<CliJob, 'proposalId' | 'sessionId' | 'handle' | 'agent' | 'command' | 'multi'>
): void {
  sweep()
  jobs.set(job.proposalId, {
    ...job,
    createdAt: Date.now(),
    doneAt: null,
    execution: null
  })
}

export function completeJob(proposalId: string, execution: ToolExecution): void {
  const job = jobs.get(proposalId)
  if (!job) return
  job.execution = execution
  job.doneAt = Date.now()
}

/** 多机批量 job 的终态 */
export function completeMultiJob(proposalId: string, outcome: MultiOutcome): void {
  const job = jobs.get(proposalId)
  if (!job) return
  job.multi = outcome
  job.doneAt = Date.now()
}

export function getJob(proposalId: string): CliJob | null {
  sweep()
  return jobs.get(proposalId) ?? null
}
