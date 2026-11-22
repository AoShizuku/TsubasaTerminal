import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AgentRisk } from '../shared/types'
import { getSessionMeta } from './ssh'
import { redact } from './redaction'
import { sanitizeForMachine } from './sanitize'

/**
 * 审计日志：谁 / 何时 / 哪台机器 / 什么命令 / 什么结果，
 * 含每次审批决策。userData/audit.jsonl 追加写，机器消费者语义——
 * 命令文本与脱敏闸门同待遇（security-design：审计日志属"是"列）。
 * 身份信息取主进程自持的 SessionMeta，不信渲染进程回传。
 */

const COMPACT_BYTES = 4 * 1024 * 1024
const KEEP_LINES = 20000

export type AuditKind =
  /** 白名单命令直接自动执行 */
  | 'auto-exec'
  /** 提案产生（进入审批台） */
  | 'proposal'
  /** 审批决策（approved/denied，含 comment 与高危确认词校验结果） */
  | 'decision'
  /** 批准后写入终端执行的命令在转录中出现，补记退出码 */
  | 'result'
  /** 文件传输：trzsz 通道或 ZMODEM→SFTP 桥 */
  | 'transfer'

/**
 * 动作发起方（v0.12.0 审计合流）：内置 Agent 与 CLI 通道最终写同一个执行平面，
 * 日志里必须分得清是谁按的。`cli:<名>` 的名字由 `--agent` 自报（各家接入文件负责传），
 * 没报就是裸 `cli`。`user`（记人敲的命令）缓一拍——那会把 audit.jsonl 从
 * "Agent 活动"变成全量记录，压缩参数要跟着调。
 */
export type AuditActor = 'agent' | 'user' | (string & {})

export interface AuditEntry {
  kind: AuditKind
  command: string
  /** 谁发起的：缺省视为内置 Agent（v0.12.0 前的全部存量条目都是它） */
  actor?: AuditActor
  risk?: AgentRisk
  reason?: string
  proposalId?: string
  /**
   * 多机批次 id（v0.12.2 CLI `--hosts`）：同一次批量的 N 台各记一条，靠它串起来——
   * 没有共同 id 的话，事后查"这是不是同一次批量"只能靠时间戳猜。
   */
  batchId?: string
  /** withdrawn：CLI 提案超时主动撤回——命令未执行，与用户否决分开记 */
  decision?: 'approved' | 'denied' | 'withdrawn'
  comment?: string
  exitCode?: number | null
  truncated?: boolean
  /** v0.9.2 信任免问：免掉审批的动词（放宽审批 ≠ 放宽审计，如实区分自动来源） */
  trusted?: string
  /**
   * pty 有效身份（v0.11.0 审计身份修正）：在用户终端执行的命令记 shell 上报的
   * id -un——`sudo su` 之后是 root，不再冒用登录用户；探不到就标 'unknown'，
   * 不猜。独立 exec / SFTP 面的条目不带此字段（结构上恒为登录用户，见 host 字段）。
   */
  ptyUser?: string
  /**
   * exec 平面有效身份：root 会话的独立通道命令以 root 运行，如实标注；
   * 非 root 会话不带（结构上恒为登录用户，见 host 字段）。
   */
  execUser?: string
  /** 身份切换已生效的会话：所有条目统一标注，取主进程 SessionMeta */
  elevated?: boolean
  /** write_file / transfer：字节数 */
  bytes?: number
  /** transfer：经由哪条通道（v0.13.2 加 cli = CLI push） */
  via?: 'trzsz' | 'bridge' | 'cli'
  /** transfer：方向（download=远端→本地） */
  direction?: 'download' | 'upload'
  /** transfer：涉及的文件名 */
  files?: string[]
  /** transfer：保存位置（下载=本地目录，上传=远端目录） */
  savedTo?: string
  /** transfer：trzsz 传输时长 */
  durationMs?: number
  /**
   * transfer（v0.13.2 CLI push）：**实际写进远端临时文件的字节**的 sha256——上传循环
   * 边传边算，不是提案时对本地文件预算的（那证明不了批准后传的是什么）。
   */
  sha256?: string
  /** transfer：结局如实记——成功/失败原因、走没走降级 rename、清不掉的残留路径 */
  outcome?: string
}

export function auditFile(): string {
  return join(app.getPath('userData'), 'audit.jsonl')
}

/** 追加一条审计记录；失败静默（审计不能反过来阻断主链路）。
 *  返回写盘成败：审计是 best-effort 这条裁决不变，但 CLI push 把审计当
 *  事后追踪的唯一出口，写失败要能在 stderr 明示——调用方自己决定要不要看这个值。 */
export async function auditLog(sessionId: string, entry: AuditEntry): Promise<boolean> {
  try {
    const meta = getSessionMeta(sessionId)
    const commandRed = await redact(sanitizeForMachine(entry.command))
    const commentRed = entry.comment
      ? (await redact(sanitizeForMachine(entry.comment))).text.slice(0, 1024)
      : undefined
    const line = {
      ts: new Date().toISOString(),
      sessionId,
      hostId: meta?.hostId ?? null,
      host: meta ? `${meta.username}@${meta.host}:${meta.port}` : null,
      hostName: meta?.name ?? null,
      // 身份切换会话统一标注：host 字段里的登录用户不再是有效身份
      ...(meta?.elevated ? { elevated: true } : {}),
      ...entry,
      command: commandRed.text.slice(0, 4096),
      ...(commentRed !== undefined ? { comment: commentRed } : {})
    }
    const file = auditFile()
    await fs.appendFile(file, JSON.stringify(line) + '\n', 'utf-8')
    const stat = await fs.stat(file)
    if (stat.size > COMPACT_BYTES) {
      const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean)
      await fs.writeFile(file, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf-8')
    }
    return true
  } catch {
    // 审计写入失败不影响执行主链路
    return false
  }
}

export function registerAuditHandlers(): void {
  ipcMain.on('audit:reveal', () => {
    shell.showItemInFolder(auditFile())
  })
}
