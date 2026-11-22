import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  RedactionSummaryEntry,
  TranscriptUnit,
  TranscriptUnitRaw
} from '../shared/types'
import { redact } from './redaction'
import { sanitizeForMachine, stripPromptSpTail } from './sanitize'

/**
 * 结构化转录的主进程侧：存储 + 机器消费者出口。
 * 单元入库即净化脱敏并缓存（角标是本版唯一的实时消费者；
 * Agent v0.7 上线后读的就是这份缓存）。人的屏幕不走这里。
 * 主机记忆 v1：composer 命令脱敏后追加到 userData/history/<hostId>.jsonl。
 */

const UNIT_LIMIT = 500
const HISTORY_COMPACT_BYTES = 1024 * 1024
const HISTORY_KEEP_LINES = 5000

interface SessionTranscript {
  units: TranscriptUnit[]
  nextId: number
  redactionTotal: number
  /** type:fingerprint → 计数 */
  summary: Map<string, RedactionSummaryEntry>
  /** 当前 pty 身份：最近一次 OSC 7 上报的 id -un；未上报/丢失为 null。
   *  单元里的 ptyUser 是"命令启动时"的值，这里是"此刻"的值——错位检测与
   *  审批审计要的是后者（提案将以此刻的身份在 pty 里执行） */
  ptyUser: string | null
}

const transcripts = new Map<string, SessionTranscript>()

function ensure(sessionId: string): SessionTranscript {
  let t = transcripts.get(sessionId)
  if (!t) {
    t = { units: [], nextId: 1, redactionTotal: 0, summary: new Map(), ptyUser: null }
    transcripts.set(sessionId, t)
  }
  return t
}

/** pty 上报数据的防御性校验：POSIX 用户名样式之外一律不认（数据通道内容可伪造） */
function cleanPtyUser(raw: unknown): string | null {
  return typeof raw === 'string' && /^[\w.-]{1,64}$/.test(raw) ? raw : null
}

/** 当前 pty 身份（错位检测 / 审批审计共用）；探不到为 null，消费方自行标 unknown */
export function getCurrentPtyUser(sessionId: string): string | null {
  return transcripts.get(sessionId)?.ptyUser ?? null
}

function historyDir(): string {
  return join(app.getPath('userData'), 'history')
}

function historyFile(hostId: string): string {
  // hostId 是应用生成的 UUID/受控 id，仍防御性过滤路径字符
  return join(historyDir(), `${hostId.replace(/[^\w-]/g, '_')}.jsonl`)
}

interface HistoryLine {
  cmd: string
  cwd: string | null
  exitCode: number | null
  ts: number
}

async function appendHistory(hostId: string, line: HistoryLine): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true })
  const file = historyFile(hostId)
  await fs.appendFile(file, JSON.stringify(line) + '\n', 'utf-8')
  try {
    const stat = await fs.stat(file)
    if (stat.size > HISTORY_COMPACT_BYTES) {
      const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean)
      await fs.writeFile(file, lines.slice(-HISTORY_KEEP_LINES).join('\n') + '\n', 'utf-8')
    }
  } catch {
    // 压缩失败不影响正常写入
  }
}

async function listHistory(hostId: string, limit: number): Promise<string[]> {
  let content: string
  try {
    content = await fs.readFile(historyFile(hostId), 'utf-8')
  } catch {
    return []
  }
  const commands: string[] = []
  const seen = new Set<string>()
  const lines = content.split('\n').filter(Boolean)
  // 倒序（最新在前），跨会话去重保最新
  for (let i = lines.length - 1; i >= 0 && commands.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as HistoryLine
      if (typeof parsed.cmd !== 'string' || !parsed.cmd || seen.has(parsed.cmd)) continue
      seen.add(parsed.cmd)
      commands.push(parsed.cmd)
    } catch {
      // 跳过损坏行
    }
  }
  return commands
}

async function processUnit(
  sessionId: string,
  hostId: string,
  raw: TranscriptUnitRaw,
  notify: (total: number) => void
): Promise<void> {
  const t = ensure(sessionId)
  // 命令文本：composer 精确记录优先；直打场景用回显净化文本近似（含 prompt，如实）
  const commandText = raw.command ?? sanitizeForMachine(raw.echo).trim()
  const commandRed = await redact(sanitizeForMachine(commandText))
  const outputRed = await redact(sanitizeForMachine(stripPromptSpTail(raw.output)))
  const hits = [...commandRed.hits, ...outputRed.hits]

  const unit: TranscriptUnit = {
    id: t.nextId++,
    command: commandRed.text,
    output: outputRed.text,
    outputTruncated: raw.outputTruncated,
    exitCode: raw.exitCode,
    cwd: raw.cwd,
    ptyUser: cleanPtyUser(raw.ptyUser),
    redactions: hits.length,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt
  }
  t.units.push(unit)
  if (t.units.length > UNIT_LIMIT) t.units.splice(0, t.units.length - UNIT_LIMIT)

  if (hits.length > 0) {
    t.redactionTotal += hits.length
    for (const hit of hits) {
      const key = `${hit.type}:${hit.fingerprint}`
      const entry = t.summary.get(key)
      if (entry) entry.count += 1
      else t.summary.set(key, { type: hit.type, fingerprint: hit.fingerprint, count: 1 })
    }
    notify(t.redactionTotal)
  }

  // 先通知消费者（waitForUnit 靠这里回流批准 exec 的执行结果），
  // 历史落盘放最后——磁盘失败不能把结果回流一并吞掉
  for (const listener of unitListeners) listener(sessionId, unit)

  // 主机记忆：只入库 composer 精确命令（回显近似含 prompt 噪声，不进历史），脱敏后落盘
  if (raw.command && commandRed.text.trim()) {
    await appendHistory(hostId, {
      cmd: commandRed.text.slice(0, 4096),
      cwd: raw.cwd,
      exitCode: raw.exitCode,
      ts: raw.endedAt
    })
  }
}

/** Agent 工具（list_transcript / read_output / exec cwd 对齐）读取会话转录缓存 */
export function getTranscriptUnits(sessionId: string): TranscriptUnit[] {
  return transcripts.get(sessionId)?.units ?? []
}

/**
 * 最近一次 OSC 7 上报的 cwd（system prompt 的主机档案注入、loop 的 cwd 变更通知、
 * exec 的 cd 前缀三处共用）。
 *
 * v0.12.2 前的整理：原先住在 llm/tools.ts，害得只想知道"当前在哪个目录"的
 * systemPrompt.ts 反向 import 整个工具执行模块——而它读的数据就在这里，
 * 与工具执行无关。
 */
export function latestCwd(sessionId: string): string | null {
  const units = getTranscriptUnits(sessionId)
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i].cwd) return units[i].cwd
  }
  return null
}

/** 单元处理完成回调（审批台匹配批准命令的执行结果进审计日志） */
type UnitListener = (sessionId: string, unit: TranscriptUnit) => void
const unitListeners = new Set<UnitListener>()

export function onUnitProcessed(cb: UnitListener): () => void {
  unitListeners.add(cb)
  return () => unitListeners.delete(cb)
}

/**
 * 等待指定命令的转录单元出现（批准 exec 后阻塞回流执行结果）。
 * 首选命令文本精确匹配（渲染进程已为批准命令记了精确文本）；
 * 传入 sinceMs（批准写入时刻）时增加两层兜底：
 * - 订阅前一瞬已闭合的存量单元也纳入匹配，回流链路慢半拍不漏；
 * - 精确文本可能被脱敏改写、或被运行中发送的 stdin 行顶掉——批准后第一个闭合
 *   且起始晚于批准时刻的单元按执行结果回捞（批准仅在 shell 空闲时可提交，
 *   写入后首个闭合的单元只会是这条命令自己）。
 * 超时/中止返回 null——命令仍在跑或 shell integration 不可用。
 */
export function waitForUnit(
  sessionId: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  sinceMs = 0
): Promise<TranscriptUnit | null> {
  if (sinceMs > 0) {
    const units = transcripts.get(sessionId)?.units ?? []
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i].endedAt < sinceMs) break
      if (units[i].command === command) return Promise.resolve(units[i])
    }
  }
  return new Promise((resolve) => {
    let finish: (unit: TranscriptUnit | null) => void = () => {}
    let sawUnit = false
    const unsubscribe = onUnitProcessed((sid, unit) => {
      if (sid !== sessionId) return
      if (unit.command === command) {
        finish(unit)
        return
      }
      const isFirst = !sawUnit
      sawUnit = true
      if (isFirst && sinceMs > 0 && unit.startedAt >= sinceMs) finish(unit)
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
    const onAbort = (): void => finish(null)
    signal?.addEventListener('abort', onAbort, { once: true })
    finish = (unit) => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(unit)
    }
  })
}

export function registerTranscriptHandlers(): void {
  ipcMain.on(
    'transcript:report',
    (event, sessionId: string, hostId: string, raw: TranscriptUnitRaw) => {
      const sender = event.sender
      void processUnit(sessionId, hostId, raw, (total) => {
        if (!sender.isDestroyed()) sender.send('transcript:redactions', sessionId, total)
      }).catch(() => {
        // 单元处理失败不影响终端主链路
      })
    }
  )

  ipcMain.on('transcript:identity', (_event, sessionId: string, user: unknown) => {
    ensure(String(sessionId)).ptyUser = cleanPtyUser(user)
  })

  ipcMain.on('transcript:dispose', (_event, sessionId: string) => {
    transcripts.delete(sessionId)
  })

  ipcMain.handle('transcript:get', (_event, sessionId: string): TranscriptUnit[] => {
    return transcripts.get(sessionId)?.units ?? []
  })

  ipcMain.handle('transcript:summaries', (_event, sessionId: string) => {
    return (transcripts.get(sessionId)?.units ?? []).map((u) => ({
      id: u.id,
      command: u.command.slice(0, 200),
      exitCode: u.exitCode,
      cwd: u.cwd,
      endedAt: u.endedAt,
      outputBytes: u.output.length,
      redactions: u.redactions
    }))
  })

  ipcMain.handle(
    'transcript:redaction-summary',
    (_event, sessionId: string): RedactionSummaryEntry[] => {
      const t = transcripts.get(sessionId)
      return t ? [...t.summary.values()] : []
    }
  )

  ipcMain.handle('history:list', (_event, hostId: string, limit?: number) => {
    return listHistory(hostId, Math.min(limit ?? 500, 2000))
  })
}
