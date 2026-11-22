import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsLocal } from 'fs'
import {
  EXPERIENCE_DETAIL_LIMIT,
  EXPERIENCE_SUMMARY_LIMIT,
  type AgentEvent,
  type AgentRisk,
  type AgentScreenPayload,
  type ExperienceScope
} from '../../shared/types'
import { shellQuote } from '../../shared/shell'
import { getCurrentPtyUser, getTranscriptUnits, latestCwd, waitForUnit } from '../transcript'
import { awaitElevation, execOnSession, getSessionMeta, getSftp } from '../ssh'
import { buildElevatedExec, type ElevationState } from '../elevation'
import { redact } from '../redaction'
import { sanitizeForMachine } from '../sanitize'
import { classifySftpError } from '../sftpError'
import { auditLog, type AuditActor } from '../audit'
import {
  expandTilde,
  gateCommand,
  gateRemotePath,
  gateWriteFile,
  parseSaveOutput,
  trustableRisk,
  wrapBackground,
  wrapSaveOutput,
  type GateResult
} from './gate'
import { pushFile, PushError } from './pushEngine'
import { formatUnitId, parseUnitRef } from './unitRef'
import { runTrustedCommand, submitProposal } from './approvals'
import { isTerminalIdle } from './terminalState'
import { readExperienceForAgent, saveExperience, validateExperience } from './experience'
import { getHostProfile } from './hostprofile'
import { isTrusted } from './trust'
import type { ToolSpec } from './providers'

/**
 * Agent 八工具（agent-design 第五节）——四件套 v0.7 定型，v0.8.1 增补 write_file，
 * v0.8.3 增补 wait，v0.10.3 增补 read_experience/save_experience。
 * 三通道内容出口统一：净化（ANSI/Unicode）+ 脱敏（主进程单点闸门）+ nonce 定界符
 * ——经验两工具例外：经验内容落盘都过了人审，属指令侧，不包定界符（knowledge-design 第六节）。
 * 闸门规则与审批语义的完整版在 system prompt（闸门先验注入），
 * 工具描述只留调用要点——两处重复即两处漂移。
 */

const EXEC_TIMEOUT_MS = 15000
const READ_OUTPUT_DEFAULT_LINES = 200
const READ_OUTPUT_MAX_LINES = 500
const SCREEN_TIMEOUT_MS = 3000
/** 批准的 exec 在用户终端跑：等执行结果回流的窗口（apt install 级别的长命令也等得起） */
const APPROVED_RESULT_WAIT_MS = 15 * 60_000
/** 批准 exec 的输出回流上限（超出头尾截断，标注可 read_output 补读） */
const APPROVED_OUTPUT_LIMIT = 32 * 1024
/** wait 单次上限：等待期间 agent:send 拒收新消息（running 锁），上限小 + 分次调用覆盖长等待 */
const WAIT_MAX_SECONDS = 120
/** 转存后回给 LLM 的预览行数：够它看清日志格式与字段、决定 grep 什么，又不成负担 */
const SAVE_PREVIEW_LINES = 30

/** 头尾截断（loop 的勾选注入与此同语义） */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n…[中段截断，完整内容可用 read_output 分页读取]…\n${text.slice(-half)}`
}

/**
 * 注入启发式（advisory，误报无害）：终端数据中的指令样文本。
 * 必须对 wrap 之前的裸文本调用——wrap 后必含合法 </terminal-data> 闭合，
 * 且内容里的伪造闭合已被 wrap 拆散，检测会恒真/恒假双向失效。
 */
export function detectInjection(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions/i, '检测到"忽略先前指示"样文本'],
    [/disregard\s+.{0,30}(instructions|prompt)/i, '检测到"无视指示"样文本'],
    [/you\s+are\s+now\s+/i, '检测到角色重定义样文本'],
    [/new\s+instructions?\s*[:：]/i, '检测到"新指令"样文本'],
    [/忽略(之前|以上|先前|上面)的?(所有)?(指示|指令|提示)/, '检测到"忽略先前指示"样文本'],
    [/<\/terminal-data/i, '检测到伪造定界符闭合']
  ]
  for (const [re, label] of patterns) {
    if (re.test(text)) return label
  }
  return null
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_screen',
    description:
      '读取用户终端当前屏幕的文本快照（含光标位置与 buffer 类型）。当用户在 TUI（vim/htop/less 等，bufferType=alternate）中求助、或转录无法覆盖当前画面时调用；日常命令输出优先用 list_transcript / read_output。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_transcript',
    description:
      '列出本会话最近执行的命令概要（id、命令、退出码、cwd、时间、输出行数）——不含输出正文。要看某条命令的输出，用返回的 id 调 read_output。单元 id 是带会话前缀的字符串（如 "3f2a19c8:7"），只在当前会话内有效——历史对话中出现的旧 id 已失效，不要引用。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，默认 20，最大 100' },
        before_id: {
          type: 'string',
          description: '只返回早于该单元的记录（向更早翻页），取 list_transcript 返回的 id'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'read_output',
    description:
      '按单元 id 分页读取某条命令的输出正文（已脱敏）。offset/limit 以行为单位，默认前 200 行。',
    inputSchema: {
      type: 'object',
      properties: {
        unit_id: {
          type: 'string',
          description: 'list_transcript 返回的单元 id（带会话前缀，如 "3f2a19c8:7"）'
        },
        offset: { type: 'integer', description: '起始行（0 起），默认 0' },
        limit: { type: 'integer', description: '行数，默认 200，最大 500' }
      },
      required: ['unit_id'],
      additionalProperties: false
    }
  },
  {
    name: 'exec',
    description:
      '在远端主机上执行一条命令。只读白名单命令自动执行，其余经用户审批后在用户终端执行——白名单清单、审批语义与"哪些写法会被解析拒绝"见系统提示的闸门规则一节。本工具是阻塞的：命令必须能自行退出，否则会占住用户终端、你也拿不到结果（启动常驻服务用 background 参数）。写文件不要用本工具变通（用 write_file），等待不要用远端 sleep（用 wait）。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的单条命令' },
        risk: {
          type: 'string',
          enum: ['low', 'mid', 'high'],
          description: '你评估的风险档位：low=只读，mid=可逆写操作，high=破坏性/系统级'
        },
        reason: { type: 'string', description: '一句话说明为什么要执行这条命令（渲染给用户看）' },
        background: {
          type: 'boolean',
          description:
            '仅用于启动不会自行退出的常驻进程（web 服务、守护进程）：系统代为 nohup 后台化并把输出重定向到日志文件，返回日志路径，随后可 wait 几秒再读日志确认启动结果。会自行结束的长任务（编译/打包/下载/安装）不要用，照常前台执行以拿到真实退出码。不要自己写 & 或重定向（会被闸门拒绝）；后台化的命令一律需要用户审批。'
        },
        save_to_file: {
          type: 'boolean',
          description:
            '输出可能很大时设为 true（拉日志、导全量清单）：系统把 stdout/stderr 全量落到远端临时文件——不截断——只返回行数、字节数与前 30 行预览，随后你用只读白名单命令点查那个文件（grep -n 关键词、grep -c、sed -n 起止p、tail -n），上下文里只进真正需要的那几行。"从几万行 INFO 里捞某个 request id"就该这么做，不要先把日志全量拉回来再自己过滤。落点路径由系统生成，不要自己写重定向（会被闸门拒绝）；与 background 互斥。'
        }
      },
      required: ['command', 'risk', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'wait',
    description:
      '本地定时等待——不在远端执行任何命令、不占用用户终端、无需审批。需要等远端慢过程（镜像拉取、服务启动、apt 锁释放等）完成后再复查时调用；单次上限 120 秒，更长的等待分多次调用，每次醒来先用只读命令复查状态再决定是否继续等。不要在远端执行 sleep/watch 来等待（会被闸门拒绝）。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '等待秒数（1..120）' },
        reason: { type: 'string', description: '一句话说明在等什么（渲染给用户看）' }
      },
      required: ['seconds', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'write_file',
    description:
      '向远端主机写入一个文件（UTF-8，全文覆盖或新建；不支持追加/部分编辑）。审批流程由系统处理：用户在只读查看器中逐行审阅全文后决定，批准即写入并返回 status=approved_and_written（含 previous 新建/覆盖信息）——调用前无需向用户求确认，提交的内容必须是文件的最终完整状态（改已有文件先用 cat 读现状再写回合并后的全文）。路径必须是规范化绝对路径，内容上限 256KB。这是唯一的文件写入通道，不要用重定向/tee/python 变通。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件的绝对路径（POSIX）' },
        content: { type: 'string', description: '文件的完整内容（全文覆盖写入）' },
        reason: { type: 'string', description: '一句话说明写这个文件的目的（渲染给用户看）' }
      },
      required: ['path', 'content', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'read_experience',
    description:
      '按 id 读取一条排障经验的正文（id 与梗概见系统提示的排障经验索引一节）。本地读取、免审批、不碰远端。遇到与索引条目症状相关的问题，先读经验再动手侦察——那是本机特有的历史，侦察不出来。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '经验 id（索引行方括号内的短码，如 "ab12cd34"）' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'save_experience',
    description:
      `把本次排障的结论存为经验，供未来对话在本机（或全部主机）召回。仅在用户明确要求记录时（"记一下""存个经验"）调用，不要主动追问要不要保存。summary 必须是"症状 → 结论"形态的一句话（≤${EXPERIENCE_SUMMARY_LIMIT} 字，用 → 连接，前半是用户会撞上的症状词）；detail ≤${EXPERIENCE_DETAIL_LIMIT} 字符，建议结构：## 症状 / ## 排查路径（做过什么、排除了什么）/ ## 真因 / ## 处置 / ## 验证。只记非显然的因果、反直觉的坑、时序特性与组织约定；通用知识、一次性操作记录、大段命令输出不要存。永不自动保存：提交后由用户审阅（用户可修改内容），status=approved_and_saved 才表示已落盘；本对话的经验索引不会更新，新条目从下一个对话起生效。`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: `梗概："症状 → 结论"一句话（≤${EXPERIENCE_SUMMARY_LIMIT} 字，含 →）`
        },
        detail: { type: 'string', description: `正文（markdown，≤${EXPERIENCE_DETAIL_LIMIT} 字符）` },
        scope: {
          type: 'string',
          enum: ['host', 'global'],
          description: '作用域：host=仅本机（缺省）；global=所有主机通用（如"我们的 nginx 502 一般是连接池满"）'
        }
      },
      required: ['summary', 'detail'],
      additionalProperties: false
    }
  }
]

// ---------- read_screen 的主进程↔渲染进程请求-应答 ----------

const screenWaiters = new Map<
  string,
  { resolve: (payload: AgentScreenPayload | null) => void; timer: NodeJS.Timeout }
>()

export function registerScreenResponseHandler(): void {
  ipcMain.on(
    'agent:screen-response',
    (_event, requestId: string, payload: AgentScreenPayload | null) => {
      const waiter = screenWaiters.get(requestId)
      if (waiter) {
        screenWaiters.delete(requestId)
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
      }
    }
  )
}

function requestScreen(sender: WebContents, sessionId: string): Promise<AgentScreenPayload | null> {
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      screenWaiters.delete(requestId)
      resolve(null)
    }, SCREEN_TIMEOUT_MS)
    screenWaiters.set(requestId, { resolve, timer })
    if (sender.isDestroyed()) {
      screenWaiters.delete(requestId)
      clearTimeout(timer)
      resolve(null)
      return
    }
    sender.send('agent:screen-request', requestId, sessionId)
  })
}

// ---------- 工具执行 ----------

export interface ToolContext {
  sessionId: string
  /** 当前对话 id：save_experience 的 sourceConvId——来源对话可回跳 */
  convId: string
  sender: WebContents
  signal: AbortSignal
  /** nonce 定界符包裹（对话级，loop 持有 nonce） */
  wrap: (source: 'transcript' | 'screen' | 'exec', text: string) => string
  /**
   * 审计发起方（v0.12.0 审计合流）：`executeTool` 是内置 Agent 与 CLI 通道的**共同**
   * 下游——闸门/审批/脱敏/审计全挂在这里，actor 是这条接缝上唯一需要线穿的东西。
   * 缺省 'agent'（loop.ts 显式传，CLI 传 `cli:<名>`）。
   */
  actor?: AuditActor
  /**
   * 允许写用户 pty：审批路径与后台化最终都落在用户终端上。false 时 exec
   * 遇到"需要审批"直接响亮打回，**绝不**降级成静默执行。缺省 true。
   * v0.12.1 起 CLI 的 exec 翻开它走审批路径；CLI 其余工具保持 false（本就不碰 pty）。
   */
  allowPty?: boolean
  /**
   * pty 路口互斥（v0.12.1 CLI）：propose/background 进入前调用，返回非 null =
   * 会话忙的原因（内置 Agent 在跑 / 终端非空闲 / 已有待决提案），响亮打回
   * （CLI 翻成 105"稍后重试"）。内置 Agent 不设——它的互斥由 loop 串行、
   * 审批台单提案语义与渲染侧 canExecuteExec 天然保证，且它等得起。
   */
  ptyGuard?: () => string | null
  /**
   * 提案挂起窗口毫秒数：到点**主动撤回**并返回 withdrawn——调用方
   * 有超时窗口（CC Bash 默认 120s）时必须设，否则就是幽灵提案。内置 Agent 不设。
   */
  proposalTimeoutMs?: number
  /** 提案回执（v0.12.1 `--async`）：提案创建即回传 proposalId，供调用方立刻返回再轮询 */
  onProposalCreated?: (proposalId: string) => void
}

/**
 * 机读出口：CLI 要的是**纯 stdout + 真实退出码**（可管道、跟 ssh 一致），
 * 而 `content` 是喂 LLM 的形态（JSON meta + nonce 定界符）——两者不能互相凑合。
 * 所以在同一个 ToolExecution 上并排给出：CLI 读 raw、loop 读 content，
 * 闸门、脱敏与审计仍然只有一份。
 */
export interface ToolRaw {
  /** 正文（已净化 + 已脱敏，无 meta 无定界符） */
  text: string
  /** 远端命令真实退出码；取不到为 null——CLI 的 0..99 透传就靠它 */
  exitCode?: number | null
  /** 结构化补充（转录清单、转存落点…），由 CLI 侧决定怎么渲染 */
  data?: Record<string, unknown>
}

export interface ToolExecution {
  content: string
  isError?: boolean
  uiStatus: 'ok' | 'executed' | 'proposed' | 'approved' | 'denied' | 'rejected' | 'error'
  uiSummary: string
  /** 注入启发式命中标签（对包装前的裸文本检测），loop 据此发 advisory 事件并给 LLM 加标注 */
  advisory?: string
  /** CLI 通道的机读出口；内置 Agent 路径忽略它 */
  raw?: ToolRaw
}

const RISK_ORDER: Record<AgentRisk, number> = { low: 0, mid: 1, high: 2 }

/**
 * 生产机非对称位移（agent-design 主机等级矩阵，v0.9）：提案档 mid→high（只升不降）、
 * high 档确认词改为主机显示别名（GitHub 删库模式——强迫确认"是哪台机器"）。
 * 只作用于审批路径：只读白名单照常自动执行，reject 也不经过这里。
 * 等级取主进程自持 SessionMeta，不信渲染进程回传。
 *
 * root 会话位移（与每一处身份变化同版捆绑，见 identity-design 的捆绑表）：
 * - `'exec'`：low→mid——root 拆掉了"只读命令的破坏上限由 OS 权限位兜底"
 *   这层前提，唯一的免问资格（low 档空 Ctrl+Enter）随位移自然消失；mid/high 本就
 *   逐条人审 + 确认词，不再加码。
 * - `'write'`（与 root 版 SFTP 同版）：mid→high——`write_file` 无 low 档，
 *   而切到 root 后它能写全盘（`/etc`、别人的 `~/.ssh`、cron），"逐条人审"这一档
 *   不足以匹配破坏上限，上确认词仪式。
 * 两种 root 位移与生产机位移**各自独立、叠加取 max**（不级联——级联会把 low 一路推到 high）。
 */
function applyEnvShift(
  sessionId: string,
  risk: AgentRisk,
  verb: string,
  rootShift: false | 'exec' | 'write' = false
): { risk: AgentRisk; verb: string } {
  const meta = getSessionMeta(sessionId)
  const rootShifted: AgentRisk =
    rootShift && meta?.elevated
      ? rootShift === 'write'
        ? risk === 'mid'
          ? 'high'
          : risk
        : risk === 'low'
          ? 'mid'
          : risk
      : risk
  if (meta?.envLevel !== 'production') return { risk: rootShifted, verb }
  const envShifted: AgentRisk = risk === 'mid' ? 'high' : risk
  const shifted = RISK_ORDER[envShifted] >= RISK_ORDER[rootShifted] ? envShifted : rootShifted
  return { risk: shifted, verb: shifted === 'high' ? meta.name : verb }
}

async function runReadScreen(ctx: ToolContext): Promise<ToolExecution> {
  const payload = await requestScreen(ctx.sender, ctx.sessionId)
  if (!payload) {
    return {
      content: '读取屏幕失败：会话不存在或超时',
      isError: true,
      uiStatus: 'error',
      uiSummary: '读取失败'
    }
  }
  const clean = await redact(sanitizeForMachine(payload.text))
  const meta = `bufferType=${payload.bufferType} cursor=${payload.cursorRow},${payload.cursorCol}`
  return {
    content: `${meta}\n${ctx.wrap('screen', clean.text)}`,
    uiStatus: 'ok',
    uiSummary: `已读屏（${payload.bufferType}）`,
    advisory: detectInjection(clean.text) ?? undefined,
    raw: {
      text: clean.text,
      data: {
        bufferType: payload.bufferType,
        cursorRow: payload.cursorRow,
        cursorCol: payload.cursorCol
      }
    }
  }
}

function runListTranscript(ctx: ToolContext, input: Record<string, unknown>): ToolExecution {
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
  // before_id 同一套前缀纪律：陌生前缀/旧格式直接 rejected，不静默当"无过滤"处理
  let beforeId = Infinity
  if (input.before_id !== undefined && input.before_id !== null && input.before_id !== '') {
    const ref = parseUnitRef(ctx.sessionId, input.before_id)
    if (!ref.ok) {
      return {
        content: JSON.stringify({ status: 'rejected', reason: ref.reason }),
        uiStatus: 'rejected',
        uiSummary: '翻页引用了失效的单元 id'
      }
    }
    beforeId = ref.id
  }
  const units = getTranscriptUnits(ctx.sessionId)
    .filter((u) => u.id < beforeId)
    .slice(-limit)
  const rows = units.map((u) => ({
    id: formatUnitId(ctx.sessionId, u.id),
    command: u.command.slice(0, 200),
    exitCode: u.exitCode,
    cwd: u.cwd,
    endedAt: new Date(u.endedAt).toISOString(),
    outputLines: u.output ? u.output.split('\n').length : 0,
    truncated: u.outputTruncated
  }))
  return {
    content: JSON.stringify({ total: getTranscriptUnits(ctx.sessionId).length, units: rows }),
    uiStatus: 'ok',
    uiSummary: `${rows.length} 条命令概要`,
    raw: { text: '', data: { total: getTranscriptUnits(ctx.sessionId).length, units: rows } }
  }
}

function runReadOutput(ctx: ToolContext, input: Record<string, unknown>): ToolExecution {
  const ref = parseUnitRef(ctx.sessionId, input.unit_id)
  if (!ref.ok) {
    return {
      content: JSON.stringify({ status: 'rejected', reason: ref.reason }),
      uiStatus: 'rejected',
      uiSummary: '引用了失效的单元 id',
      raw: { text: ref.reason, exitCode: null, data: { badRef: true } }
    }
  }
  const unitId = ref.id
  const unit = getTranscriptUnits(ctx.sessionId).find((u) => u.id === unitId)
  if (!unit) {
    return {
      content: `单元 ${formatUnitId(ctx.sessionId, unitId)} 不存在（可能已被环形缓冲淘汰），先用 list_transcript 查看可用 id`,
      isError: true,
      uiStatus: 'error',
      uiSummary: `单元 ${unitId} 不存在`
    }
  }
  const lines = unit.output.split('\n')
  const offset = Math.max(Number(input.offset) || 0, 0)
  const limit = Math.min(
    Math.max(Number(input.limit) || READ_OUTPUT_DEFAULT_LINES, 1),
    READ_OUTPUT_MAX_LINES
  )
  const page = lines.slice(offset, offset + limit).join('\n')
  const meta = `command=${JSON.stringify(unit.command.slice(0, 200))} exitCode=${unit.exitCode} totalLines=${lines.length} range=${offset}..${Math.min(offset + limit, lines.length)}${unit.outputTruncated ? ' (采集时已截断)' : ''}`
  return {
    content: `${meta}\n${ctx.wrap('transcript', page)}`,
    uiStatus: 'ok',
    uiSummary: `读取 #${unitId} 输出 ${offset}..${offset + limit} 行`,
    advisory: detectInjection(page) ?? undefined,
    raw: {
      text: page,
      exitCode: unit.exitCode,
      data: {
        command: unit.command,
        exitCode: unit.exitCode,
        totalLines: lines.length,
        offset,
        cwd: unit.cwd,
        truncated: unit.outputTruncated
      }
    }
  }
}

/**
 * 写入用户终端的命令：阻塞等转录单元闭合，退出码与输出直接成为工具结果
 * （v0.8.1 阻塞语义）。两个来源共用——approved 走过审批台，executed 是信任
 * 免问（对 LLM 与白名单自动执行同形，不标注免了审批：零注入，见 trust.ts）。
 */
export async function collectTerminalResult(
  ctx: ToolContext,
  command: string,
  mode: 'approved' | 'executed',
  opts: { backgroundLog?: string; savePath?: string } = {}
): Promise<ToolExecution> {
  const { backgroundLog, savePath } = opts
  // startedAt 给 waitForUnit 兜底：命令文本被脱敏改写/被 stdin 行顶掉时按
  // "写入后首个闭合单元"回捞，不再卡满 15 分钟等待窗口
  const startedAt = Date.now()
  const unit = await waitForUnit(
    ctx.sessionId,
    command,
    APPROVED_RESULT_WAIT_MS,
    ctx.signal,
    startedAt
  )
  // CLI bridge 的审批/免问路径没有内置 Agent 的 tool-end / turn-end 事件；等待一
  // 结束就单独通知渲染侧清掉 composer 的“已批准 · 执行中”指示。**结果没捕获到
  // （超时 / 请求方断连 abort）也照发**——这个徽章跟的是"这次 CLI 请求还在等这条
  // 命令"，请求收场就该退场，与内置 Agent 的 turn-end 无条件清除同语义；漏发的话
  // 徽章此后永远没人清（外部 agent 的超时窗口比等待窗口短，abort 是日常路径）。
  // 命令仍在跑的话，composer 的 running 态由 OSC 133 独立驱动，照旧如实显示终端忙。
  // 只给 CLI actor 发，且带上实际写入 pty 的命令（不是 unit.command——兜底匹配命中
  // 时两者不同），避免并发时误清另一条命令。
  if (ctx.actor?.startsWith('cli') && !ctx.sender.isDestroyed()) {
    const event: AgentEvent = { kind: 'cli-exec-end', command }
    ctx.sender.send('agent:event', ctx.sessionId, event)
  }
  const approved = mode === 'approved'
  const label = backgroundLog ? '已后台启动' : savePath ? '已转存' : approved ? '已批准执行' : '已执行'
  if (!unit) {
    return {
      content: JSON.stringify({
        status: mode,
        ...(backgroundLog ? { logPath: backgroundLog } : {}),
        ...(savePath ? { path: savePath } : {}),
        note: backgroundLog
          ? `用户已批准，后台启动命令已写入用户终端，但未在等待窗口内捕获到结果。进程可能已在后台运行——读 ${backgroundLog} 确认，不要重复启动。`
          : savePath
            ? `命令已写入用户终端执行，但未在等待窗口内捕获到结果。输出可能已落在 ${savePath}——用 wc -l 或 tail 确认后再点查。`
            : `${approved ? '用户已批准，' : ''}命令已写入用户终端执行，但未在等待窗口内捕获到执行结果（可能仍在运行，或 shell integration 不可用）。稍后可用 list_transcript / read_output 查看。`
      }),
      uiStatus: mode,
      uiSummary: `${label}（结果未捕获）`,
      // CLI 侧翻成 107（命令未取得退出码，"没跑完"≠"失败了"）
      raw: {
        text: '',
        exitCode: null,
        data: {
          resultPending: true,
          ...(backgroundLog ? { logPath: backgroundLog } : {}),
          ...(savePath ? { savedTo: savePath } : {})
        }
      }
    }
  }
  // 转录出口已脱敏（read_output 同样直接用 unit.output），不重复过闸门
  if (savePath) return await savedOutputResult(ctx, unit.output, savePath, mode, label, false)
  const output = truncateMiddle(unit.output, APPROVED_OUTPUT_LIMIT)
  // background 的 exitCode 是 shell 收下后台任务的码，不是进程的码——不点破的话
  // LLM 会把 exit 0 当"服务已正常启动"，这正是要防的误读
  const meta = JSON.stringify({
    status: mode,
    ...(backgroundLog
      ? {
          logPath: backgroundLog,
          note: `用户已批准，命令已在用户终端后台启动（nohup，stdout/stderr 重定向到 ${backgroundLog}）。下面的 exitCode 只表示"后台任务提交成功"，不代表进程运行正常——请用 wait 等几秒再读 ${backgroundLog}（tail/cat）确认启动结果；输出里的 [任务号] PID 可用于后续停止。`
        }
      : approved
        ? { note: '用户已批准，命令已在用户终端执行完毕，以下是执行输出' }
        : {}),
    exitCode: unit.exitCode
  })
  return {
    content: `${meta}\n${ctx.wrap('transcript', output)}`,
    uiStatus: mode,
    uiSummary: backgroundLog
      ? `${label}（日志 ${backgroundLog}）`
      : `${label}（exit ${unit.exitCode ?? '?'}）`,
    advisory: detectInjection(output) ?? undefined,
    // CLI 机读出口：转录单元的输出已在采集出口脱敏，全文给（LLM 那份才截断）
    raw: {
      text: unit.output,
      exitCode: unit.exitCode,
      data: backgroundLog ? { logPath: backgroundLog } : {}
    }
  }
}

/**
 * 转存结果的统一出口：两条执行路径（独立通道 auto / 用户终端审批）拿到的
 * 都是 wrapSaveOutput 的 stdout，在这里解析成同一个结构。
 *
 * 上下文里只进"规模数字 + 前 N 行预览"，全文留在远端等 grep——note 必须把这个
 * 分工说透，否则 LLM 转存完顺手 `cat` 一遍，绕一圈回到全量进上下文。
 */
async function savedOutputResult(
  ctx: ToolContext,
  stdout: string,
  savePath: string,
  uiStatus: ToolExecution['uiStatus'],
  label: string,
  redactPreview: boolean
): Promise<ToolExecution> {
  const saved = parseSaveOutput(stdout)
  const preview = redactPreview
    ? (await redact(sanitizeForMachine(saved.preview))).text
    : saved.preview
  const meta = JSON.stringify({
    status: 'saved_to_file',
    path: savePath,
    exitCode: saved.exitCode,
    lines: saved.lines,
    bytes: saved.bytes,
    note:
      `命令输出已**全量、未截断**落在远端文件 ${savePath}，下面只是前 ${SAVE_PREVIEW_LINES} 行预览。` +
      `要找具体内容请用只读白名单命令点查这个文件（grep -n '关键词' ${savePath}、grep -c ERROR ${savePath}、` +
      `sed -n '1000,1100p' ${savePath}、tail -n 50 ${savePath}），点查是自动执行的。` +
      `不要 cat 全文——那等于把刚才省下的东西又搬进上下文。`
  })
  return {
    content: `${meta}\n${ctx.wrap('exec', preview)}`,
    uiStatus,
    uiSummary: `${label}（${saved.lines ?? '?'} 行 → ${savePath}）`,
    advisory: detectInjection(preview) ?? undefined,
    raw: {
      text: preview,
      exitCode: saved.exitCode,
      data: { savedTo: savePath, lines: saved.lines, bytes: saved.bytes }
    }
  }
}

/**
 * 主进程生成的 /tmp 落点（v0.9.7 后台日志，v0.9.8 起转存共用）：交给 LLM 指定
 * 就等于把 `>` 的目标还给它，绕开 gateWriteFile 的路径分险开出任意写文件的口子。
 * 会话内序号递增，重复调用不互相覆盖（不做 rotate，量级由用户自理）。
 */
const outputSeq = new Map<string, number>()
function generatedLogPath(sessionId: string, kind: 'bg' | 'out'): string {
  const seq = (outputSeq.get(sessionId) ?? 0) + 1
  outputSeq.set(sessionId, seq)
  const suffix = kind === 'bg' ? '' : '-out'
  return `/tmp/tsubasaterminal-${sessionId.slice(0, 8)}${suffix}-${seq}.log`
}

/**
 * exec 的"只算不执行"前半段（v0.12.2 抽出，cli-bridge-design 9.3.1）：
 * `~` 展开 / 身份收口 / cwd 决定 / 闸门判定 / 风险位移 / 包装文本，全部算完再定路径。
 * 抽出的动因是多机批量——必须先算完 N 台 verdict 再决定整批走 auto 还是一卡罩 N 台，
 * 否则 auto 的台在卡弹出前就跑掉了。单机 runExec 与 CLI 多机共用这一份，安全逻辑不分叉。
 */
export interface ExecPlanned {
  planned: true
  /** `~` 展开后的命令原文（闸门解析的对象；审计也用它） */
  command: string
  /** auto = 白名单旁路直执行；propose = 需审批（含 background 强制审批） */
  action: 'auto' | 'propose'
  /** 审批路径写 pty 的文本（bg/save 由主进程包装，逐会话落点不同） */
  ptyCommand: string
  logPath?: string
  savePath?: string
  verdict: GateResult
  /** applyEnvShift 后的档位与确认词（单机高危确认词=主机别名；多机改用 gate 真动词） */
  risk: AgentRisk
  confirmVerb: string
  blankApprove: boolean
  trustable: boolean
  borrowedCwd: string | null
  /** pty 上报的原始 cwd（身份错位时 borrowedCwd 为 null，错位提示仍要说清终端在哪） */
  terminalCwd: string | null
  mismatch: boolean
  ptyUser: string | null
  execUser?: string
  rootExec: ElevationState | null
}

export type ExecPlan = { planned: false; execution: ToolExecution } | ExecPlanned

export async function planExec(
  ctx: ToolContext,
  input: Record<string, unknown>
): Promise<ExecPlan> {
  const raw = String(input.command ?? '')
  const background = input.background === true
  const saveToFile = input.save_to_file === true
  if (background && saveToFile) {
    return {
      planned: false,
      execution: {
        content: JSON.stringify({
          status: 'rejected',
          reason:
            'background 与 save_to_file 不能同时用——后台化本身就把 stdout/stderr 重定向到日志文件了，返回的 logPath 就是要点查的文件'
        }),
        uiStatus: 'rejected',
        uiSummary: 'background 与 save_to_file 互斥'
      }
    }
  }

  // ~ 展开：主进程按主机档案的 $HOME 机械替换后再进硬解析，argv 里落的
  // 是绝对路径。只在真出现 ~ 时才等档案——没有的话不必为它触发一次远端探测。
  const command = raw.includes('~')
    ? expandTilde(raw, (await getHostProfile(ctx.sessionId))?.home)
    : raw
  const llmRisk: AgentRisk = input.risk === 'high' ? 'high' : input.risk === 'mid' ? 'mid' : 'low'

  // 身份切换收口 + 执行 cwd 前置：闸门的路径敏感度维度解析相对路径
  // 所依据的 cwd 必须与命令实际执行的 cwd 恒等，所以 cwd 的决定要走在闸门前面。
  // awaitElevation 同时挡掉握手期间的抢跑——握手没收口就 exec，跑出来的正是身份分裂。
  const elevation = await awaitElevation(ctx.sessionId)
  const rootExec = elevation?.active ? elevation : null
  const cwd = latestCwd(ctx.sessionId)
  const ptyUser = getCurrentPtyUser(ctx.sessionId)
  // 只有 pty 报了身份才值得等主机档案（对话建立时已探测，通常是缓存命中）
  const execUser = ptyUser ? (await getHostProfile(ctx.sessionId))?.user : undefined
  // 身份错位：pty 上报身份与独立 exec 身份不一致时不借 pty cwd——
  // 跨平面借来的状态靠不住。root 会话三平面同为 root，借用恢复合法
  const mismatch = Boolean(ptyUser && execUser && ptyUser !== execUser)
  const borrowedCwd = cwd && !mismatch ? cwd : null

  const verdict = gateCommand(command, llmRisk, { cwd: borrowedCwd })

  if (verdict.action === 'reject') {
    return {
      planned: false,
      execution: {
        content: JSON.stringify({ status: 'rejected', reason: verdict.reason }),
        uiStatus: 'rejected',
        uiSummary: verdict.reason ?? '已拒绝',
        raw: { text: verdict.reason ?? '已拒绝', exitCode: null }
      }
    }
  }

  // 后台化/ 转存：闸门解析的是 Agent 原文，写进 pty 的是包装后
  // 的命令——与白名单直通的 cwd 前缀拼接同模式。& 与重定向只由主进程拼，LLM 手里
  // 永远没有；两个落点路径都由主进程生成。
  const logPath = background ? generatedLogPath(ctx.sessionId, 'bg') : undefined
  const savePath = saveToFile ? generatedLogPath(ctx.sessionId, 'out') : undefined
  const ptyCommand = logPath
    ? wrapBackground(command, logPath)
    : savePath
      ? wrapSaveOutput(command, savePath, SAVE_PREVIEW_LINES)
      : command

  // 位移后的档位与确认词只在审批路径消费（auto 的审计仍记 verdict.risk），
  // 但 plan 上恒算——多机批量里 auto 资格的台也要并进卡、按位移档展示
  const { risk, verb } = applyEnvShift(ctx.sessionId, verdict.risk, verdict.verb, 'exec')
  return {
    planned: true,
    command,
    // background 一律进审批台：后台化把输出从用户眼前拿走，削弱的正是"用户可见是
    // 最后的监督兜底"，auto 与信任免问两条快车道都不给
    action: verdict.action === 'propose' || logPath ? 'propose' : 'auto',
    ptyCommand,
    logPath,
    savePath,
    verdict,
    risk,
    confirmVerb: verb,
    trustable: !logPath && verdict.trustable && trustableRisk(risk),
    // 空批资格：low 档 + 非生产机；root 会话下 low 已被位移成 mid，资格自然消失
    blankApprove:
      !logPath && risk === 'low' && getSessionMeta(ctx.sessionId)?.envLevel !== 'production',
    borrowedCwd,
    terminalCwd: cwd,
    mismatch,
    ptyUser,
    execUser,
    rootExec
  }
}

async function runExec(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecution> {
  const plan = await planExec(ctx, input)
  if (!plan.planned) return plan.execution
  const { logPath, savePath, verdict, risk } = plan
  const effective = plan.ptyCommand

  if (plan.action === 'propose') {
    // 不写 pty 的调用方（v0.12.0 硬边界）：审批台与后台化都要写用户 pty，
    // 响亮打回（CLI 侧翻成退出码），不静默降级去旁路执行——
    // 那等于把"需要人看着"的命令偷偷跑掉，正是闸门存在的理由。
    if (ctx.allowPty === false) {
      const why = logPath
        ? '后台化命令一律需要用户审批（后台化把输出从用户眼前拿走，削弱的正是"用户可见"这层监督兜底）'
        : verdict.sensitive
          ? `命中敏感路径（${verdict.sensitive}），已取消自动执行资格，需要用户审批`
          : '命令不在只读白名单内，需要用户审批'
      const reason =
        `${why}。当前调用方不允许写用户终端，无法走审批路径。` +
        `请改用只读命令自查，或请用户在 Tsubasa Terminal 界面里执行这一条。`
      return {
        content: JSON.stringify({ status: 'rejected', reason }),
        uiStatus: 'rejected',
        uiSummary: '需要审批，当前调用方不放行',
        raw: { text: reason, exitCode: null, data: { needsApproval: true } }
      }
    }
    // pty 路口互斥（v0.12.1 CLI）：同会话内置 Agent 在跑 / 终端非空闲 / 已有待决提案
    // 都拒——别让两个大脑抢一只手。只读白名单走旁路 channel 不经此处，照常并行。
    const busyReason = ctx.ptyGuard?.()
    if (busyReason) {
      return {
        content: JSON.stringify({ status: 'busy', reason: busyReason }),
        uiStatus: 'rejected',
        uiSummary: '会话忙，稍后重试',
        raw: { text: busyReason, exitCode: null, data: { busy: true } }
      }
    }
    const verb = plan.confirmVerb
    // 敏感路径命中要让用户看见"为什么这条只读命令也要问"——labels 不经 LLM，规则生成
    const reasonText = verdict.sensitive
      ? `【敏感路径，已取消自动执行——${verdict.sensitive}】${String(input.reason ?? '')}`
      : String(input.reason ?? '')

    // 信任免问：动词已被用户显式授予 → 跳过审批台，直接在用户终端执行。
    // 终端忙时不走这条路（写进去就是喂给前台进程）——退回审批台由用户挑时机。
    // 对 LLM 零注入：结果与白名单自动执行同形，不标注"免了审批"。
    if (
      plan.trustable &&
      isTrusted(ctx.sessionId, verb) &&
      isTerminalIdle(ctx.sessionId) &&
      runTrustedCommand(ctx.sessionId, ctx.sender, effective, verb, risk)
    ) {
      return await collectTerminalResult(ctx, effective, 'executed', { savePath })
    }

    // v0.8.1 阻塞语义：白名单外 → 审批台，等到决策；批准后继续等执行结果回流——
    // 工具结果就是"这个动作的结果"，不让 LLM 再花轮次去转录里捞
    const decision = await submitProposal(
      {
        sessionId: ctx.sessionId,
        sender: ctx.sender,
        signal: ctx.signal,
        actor: ctx.actor,
        timeoutMs: ctx.proposalTimeoutMs,
        onCreated: ctx.onProposalCreated
      },
      {
        kind: 'exec',
        // 审批台展示的即写进 pty 的：用户批准的文本与实际执行的必须一字不差
        command: effective,
        risk,
        reason: reasonText,
        verb,
        trustable: plan.trustable,
        blankApprove: plan.blankApprove
      }
    )
    switch (decision.outcome) {
      case 'approved':
        return await collectTerminalResult(ctx, effective, 'approved', {
          backgroundLog: logPath,
          savePath
        })
      case 'denied':
        return {
          content: JSON.stringify({
            status: 'denied',
            ...(decision.comment
              ? { comment: decision.comment, note: '用户拒绝并留言，请根据留言修订方案' }
              : { note: '用户拒绝了该命令' })
          }),
          uiStatus: 'denied',
          uiSummary: decision.comment ? `用户拒绝：${decision.comment}` : '用户已拒绝',
          raw: {
            text: decision.comment ? `用户拒绝并留言：${decision.comment}` : '用户拒绝了该命令',
            exitCode: null,
            data: { denied: true, ...(decision.comment ? { comment: decision.comment } : {}) }
          }
        }
      case 'aborted':
        return {
          content: JSON.stringify({ status: 'aborted', note: '本轮被用户中止，提案已取消' }),
          uiStatus: 'rejected',
          uiSummary: '已中止，提案取消',
          raw: { text: '会话中止，提案已取消（命令未执行）', exitCode: null, data: { aborted: true } }
        }
      case 'withdrawn':
        // 只有设了 proposalTimeoutMs 的调用方（CLI）会走到：挂起窗口内无人决策，
        // 提案已主动撤回——命令未执行，不是被拒绝
        return {
          content: JSON.stringify({
            status: 'withdrawn',
            note: '提案在等待窗口内未获用户决策，已主动撤回，命令未执行。可稍后重发，或改用异步方式等待更久。'
          }),
          uiStatus: 'rejected',
          uiSummary: '审批超时，提案已撤回',
          raw: {
            text: '等待窗口内未获用户决策，提案已主动撤回（命令未执行）。可稍后重发，或用 --async + job 轮询等更久。',
            exitCode: null,
            data: { withdrawn: true }
          }
        }
    }
  }

  return await executeAutoPlan(ctx, plan)
}

/**
 * 白名单只读 → 独立通道自动执行（planExec 的 auto 后半段，v0.12.2 抽出）。
 * 多机批量与单机共用；batchId 只有多机传（审计里把同一批的 N 条串起来）。
 */
export async function executeAutoPlan(
  ctx: ToolContext,
  plan: ExecPlanned,
  opts: { batchId?: string } = {}
): Promise<ToolExecution> {
  const { command, savePath, verdict, borrowedCwd, terminalCwd, mismatch, ptyUser, execUser, rootExec } =
    plan
  // cwd/错位已在闸门前算好：
  // - 普通会话：借 pty cwd 拼机械 cd 前缀；身份错位不借，退回 exec $HOME；
  // - root 会话：走 buildElevatedExec——chdir 模式 `sudo -D <cwd> --`，
  //   模板模式 `sudo -- bash -c 'cd … && …'`，认证模式握手时已定死。
  const based = rootExec
    ? buildElevatedExec(rootExec, command, borrowedCwd)
    : borrowedCwd
      ? `cd -- ${shellQuote(borrowedCwd)} && ${command}`
      : command
  // 转存包装拼在 root/cwd 包装之外：`sudo … -- cmd >path` 的重定向由外层 shell 以
  // 登录用户执行（/tmp 可写），命令本体在 sudo 下跑——rc 分段照旧取 sudo 的退出码
  const fullCommand = savePath ? wrapSaveOutput(based, savePath, SAVE_PREVIEW_LINES) : based
  const result = await execOnSession(ctx.sessionId, fullCommand, EXEC_TIMEOUT_MS, ctx.signal, {
    sudoAuth: Boolean(rootExec)
  })
  if (!result.ok) {
    return {
      content: JSON.stringify({ status: 'error', error: result.error }),
      isError: true,
      uiStatus: 'error',
      uiSummary: result.error ?? '执行失败',
      raw: { text: result.error ?? '执行失败', exitCode: null }
    }
  }
  void auditLog(ctx.sessionId, {
    kind: 'auto-exec',
    actor: ctx.actor,
    batchId: opts.batchId,
    command: savePath ? `${command} → ${savePath}` : command,
    risk: verdict.risk,
    exitCode: result.exitCode ?? null,
    truncated: result.truncated || undefined,
    // 有效身份：exec 平面在 root 会话以 root 运行；非 root 会话结构上
    // 恒为登录用户（host 字段已载），不重复标注
    execUser: rootExec ? 'root' : undefined
  })
  // 失败翻译：我们拼的 cd 前缀被拒 = 命令根本没跑。不翻译的话
  // Agent 只能从 exitCode 1 反推、把权限问题误诊成命令问题。只认 Permission
  // denied——目录不存在等其他 cd 失败不是身份错位，照常回原始输出。
  // 转存路径的真实退出码在 wrapSaveOutput 的分段里（channel 退出码恒为 head 的 0）
  const savedRc = savePath ? parseSaveOutput(result.stdout ?? '').exitCode : null
  const failedExit = savePath
    ? savedRc !== null && savedRc !== 0
    : typeof result.exitCode === 'number' && result.exitCode !== 0
  if (borrowedCwd && failedExit && /\bcd:.*permission denied/i.test(result.stdout ?? '')) {
    return {
      content: JSON.stringify({
        status: 'cd-denied',
        exitCode: savePath ? savedRc : (result.exitCode ?? null),
        cwd: borrowedCwd,
        note:
          `命令实际未执行：独立 exec 通道以 SSH 登录用户${execUser ? `（${execUser}）` : ''}身份运行，` +
          `进入终端当前目录 ${borrowedCwd} 被拒（Permission denied）——终端可能已用 sudo/su 切换身份，` +
          `而独立 exec、文件栏与传输不会跟随身份切换。需要该身份权限的操作请直接提案` +
          `（走审批台、在用户终端以终端当前身份执行）；侦察请改用登录用户可达的绝对路径。`
      }),
      uiStatus: 'error',
      uiSummary: `exec 通道身份不足：cd ${borrowedCwd} 被拒，命令未执行`,
      raw: {
        text: `命令未执行：进入终端当前目录 ${borrowedCwd} 被拒（Permission denied）`,
        exitCode: null,
        data: { cwd: borrowedCwd, cwdDenied: true }
      }
    }
  }
  if (savePath) {
    return await savedOutputResult(ctx, result.stdout ?? '', savePath, 'executed', '已转存', true)
  }
  const clean = await redact(sanitizeForMachine(result.stdout ?? ''))
  const meta = JSON.stringify({
    status: 'executed',
    exitCode: result.exitCode ?? null,
    truncated: Boolean(result.truncated),
    cwd: borrowedCwd,
    ...(mismatch
      ? {
          identityMismatch: { ptyUser, execUser },
          note:
            `终端当前身份是 ${ptyUser}，而独立 exec 通道仍以 SSH 登录用户 ${execUser} 运行——` +
            `身份错位，已不借用终端当前目录${terminalCwd ? `（终端在 ${terminalCwd}）` : ''}，` +
            `本命令在 ${execUser} 的 $HOME 下执行。exec 通道命令请使用绝对路径；` +
            `需要 ${ptyUser} 身份的操作请直接提案（走审批台、在用户终端执行）。`
        }
      : {})
  })
  return {
    content: `${meta}\n${ctx.wrap('exec', clean.text)}`,
    uiStatus: 'executed',
    uiSummary: `已执行（exit ${result.exitCode ?? '?'}）`,
    advisory: detectInjection(clean.text) ?? undefined,
    raw: {
      text: clean.text,
      exitCode: result.exitCode ?? null,
      data: { cwd: borrowedCwd, truncated: Boolean(result.truncated) }
    }
  }
}

/** 到点 resolve true；被 abort 提前 resolve false */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * wait：本地定时等待。缺时间原语时 Agent 会提案远端 sleep 当定时器
 * （占用户 pty + 烧审批 + 垃圾单元进转录），这是唯一的正门——不碰远端、免审批。
 */
async function runWait(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecution> {
  const requested = Math.floor(Number(input.seconds))
  if (!Number.isFinite(requested) || requested < 1) {
    return {
      content: JSON.stringify({
        status: 'rejected',
        reason: `seconds 必须是 1..${WAIT_MAX_SECONDS} 的整数`
      }),
      uiStatus: 'rejected',
      uiSummary: 'seconds 参数无效'
    }
  }
  const seconds = Math.min(requested, WAIT_MAX_SECONDS)
  const completed = await abortableSleep(seconds * 1000, ctx.signal)
  if (!completed) {
    return {
      content: JSON.stringify({ status: 'aborted', note: '等待被用户中止' }),
      uiStatus: 'rejected',
      uiSummary: '等待被中止'
    }
  }
  return {
    content: JSON.stringify({
      status: 'waited',
      seconds,
      ...(seconds < requested
        ? {
            note: `请求 ${requested}s 超单次上限 ${WAIT_MAX_SECONDS}s，实际等待 ${seconds}s；请先复查状态，仍需等待再调用`
          }
        : {})
    }),
    uiStatus: 'ok',
    uiSummary: `已等待 ${seconds} 秒`
  }
}

/** write_file：唯一的文件写入通道，永不自动执行，一律进审批台 */
async function runWriteFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecution> {
  const path = String(input.path ?? '').trim()
  const content = typeof input.content === 'string' ? input.content : null
  if (content === null) {
    return {
      content: JSON.stringify({ status: 'rejected', reason: 'content 必须是字符串' }),
      uiStatus: 'rejected',
      uiSummary: 'content 必须是字符串'
    }
  }
  const gate = gateWriteFile(path, content)
  if (!gate.ok) {
    return {
      content: JSON.stringify({ status: 'rejected', reason: gate.reason }),
      uiStatus: 'rejected',
      uiSummary: gate.reason ?? '已拒绝'
    }
  }

  // stat（best-effort）：覆盖警示进审批卡片；code 2 = SFTP NO_SUCH_FILE
  let exists: boolean | undefined
  let oldSize: number | undefined
  try {
    const sftp = await getSftp(ctx.sessionId)
    const stat = await new Promise<{ size: number }>((resolve, reject) =>
      sftp.stat(path, (err, s) => (err ? reject(err) : resolve(s)))
    )
    exists = true
    oldSize = stat.size
  } catch (err) {
    exists = (err as { code?: number }).code === 2 ? false : undefined
  }

  // 生产机同规则位移：mid→high、high 确认词改主机别名（write_file 无 low 档）。
  // root 会话再叠一层 mid→high（与 SFTP 平面切 root 同版捆绑）：
  // 此刻 getSftp 返回的已是 root 实例，这个写落在哪都拦不住，档位必须跟上
  const { risk, verb } = applyEnvShift(ctx.sessionId, gate.risk, gate.confirmWord, 'write')
  const decision = await submitProposal(
    { sessionId: ctx.sessionId, sender: ctx.sender, signal: ctx.signal, actor: ctx.actor },
    {
      kind: 'write_file',
      command: '',
      risk,
      reason: String(input.reason ?? ''),
      verb,
      path,
      content,
      exists,
      oldSize
    }
  )
  if (decision.outcome === 'denied') {
    return {
      content: JSON.stringify({
        status: 'denied',
        ...(decision.comment
          ? { comment: decision.comment, note: '用户拒绝并留言，请根据留言修订方案' }
          : { note: '用户拒绝了该文件写入' })
      }),
      uiStatus: 'denied',
      uiSummary: decision.comment ? `用户拒绝：${decision.comment}` : '用户已拒绝'
    }
  }
  // aborted / withdrawn（后者仅设超时的调用方可达，write_file 结构上不设）都不落盘
  if (decision.outcome !== 'approved') {
    return {
      content: JSON.stringify({ status: 'aborted', note: '本轮被用户中止，提案已取消' }),
      uiStatus: 'rejected',
      uiSummary: '已中止，提案取消'
    }
  }

  // 批准 → 写入的是主进程自存的原始内容（从未跨 IPC）
  const bytes = Buffer.byteLength(content, 'utf-8')
  try {
    const sftp = await getSftp(ctx.sessionId)
    await new Promise<void>((resolve, reject) =>
      sftp.writeFile(path, content, (err) => (err ? reject(err) : resolve()))
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void auditLog(ctx.sessionId, { kind: 'result', command: `write_file ${path}`, exitCode: 1 })
    // errno 分流：EACCES 是身份问题不是路径问题——SFTP 与独立 exec 同为
    // 登录用户，终端身份切换不跟随；不点破的话 LLM 会在错误的方向上反复重试
    const kind = classifySftpError(err)
    const hint =
      kind === 'permission'
        ? '。SFTP 写入以 SSH 登录用户身份进行，终端里的 sudo/su 切换身份不影响本工具；' +
          '需要更高权限时，可先写到登录用户可写的路径（如 /tmp），再提案 sudo cp 到目标位置（走审批台）'
        : '（若目录不存在，可先提案 mkdir）'
    return {
      content: JSON.stringify({
        status: 'error',
        error: `写入失败：${message}${hint}`
      }),
      isError: true,
      uiStatus: 'error',
      uiSummary: `写入失败：${message}`
    }
  }
  void auditLog(ctx.sessionId, {
    kind: 'result',
    command: `write_file ${path}`,
    exitCode: 0,
    bytes
  })
  // v0.8.3：status 带足"已审批"语义（LLM 见 'written' 总以为没走审批、反复求确认）；
  // previous 回流提案前的 stat（原本只上审批卡片），省掉"先 cat 确认新建还是覆盖"的侦察轮
  return {
    content: JSON.stringify({
      status: 'approved_and_written',
      note: '用户已审阅并批准，文件已写入',
      path,
      bytes,
      previous: { existed: exists ?? null, oldSize: oldSize ?? null }
    }),
    uiStatus: 'approved',
    uiSummary: `已写入 ${path}(${bytes} 字节)`
  }
}

// ---------- CLI push（cli-bridge-design 第十一节）----------

/** 大文件警示阈值：不设硬上限（构建产物可以很大），过线在卡上与 stderr 显眼标注 */
const PUSH_LARGE_BYTES = 100 * 1024 * 1024

/**
 * 同目标互斥（11.4 复审补）：per (sessionId, canonical 目标)，批准起持有到
 * rename + 清理 + 审计落笔才释放。审批台单卡语义挡不住 --async——第一笔还在传，
 * 第二笔完全可能再次获批写同一目标。不进 approvalBusyReason：不同目标并行合法，
 * 互斥按目标粒度做；每会话并发上限 2 防多路大传输挤死 SFTP 通道（文件栏共用）。
 */
const activeTransfers = new Map<string, Set<string>>()
const MAX_TRANSFERS_PER_SESSION = 2

function transferBusyReason(sessionId: string, canonicalPath: string): string | null {
  const set = activeTransfers.get(sessionId)
  if (set?.has(canonicalPath)) {
    return '该目标路径有一笔传输正在进行（可能是 --async 的上一笔）：等它落地后再重试'
  }
  if ((set?.size ?? 0) >= MAX_TRANSFERS_PER_SESSION) {
    return `本会话已有 ${set?.size} 笔传输进行中（上限 ${MAX_TRANSFERS_PER_SESSION}）：等一笔完成再发`
  }
  return null
}

function acquireTransfer(sessionId: string, canonicalPath: string): boolean {
  if (transferBusyReason(sessionId, canonicalPath)) return false
  const set = activeTransfers.get(sessionId) ?? new Set<string>()
  set.add(canonicalPath)
  activeTransfers.set(sessionId, set)
  return true
}

function releaseTransfer(sessionId: string, canonicalPath: string): void {
  const set = activeTransfers.get(sessionId)
  set?.delete(canonicalPath)
  if (set && set.size === 0) activeTransfers.delete(sessionId)
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/**
 * push：CLI 专属动词，**不进 LLM 工具面**（TOOL_SPECS 不加）——executeTool
 * 的 switch 与工具面数组分离，闸门/审批/审计仍全挂这条共同下游。
 *
 * 形态"传路径不传字节"（11.2）：字节不进管道，主进程直接从磁盘读。上传机械在
 * pushEngine.ts（'wx' 独占 + 边传边 sha256 + 无进度超时 + backup-rename 降级），
 * 这里只做编排：本地 fail-closed 校验 → 远端路径闸门 → 父目录 realpath →
 * 覆盖 stat → 同目标互斥 → 审批 → 引擎 → 审计。
 */
async function runPush(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecution> {
  const localPath = String(input.local_path ?? '').trim()
  const remoteInput = String(input.remote_path ?? '').trim()
  const mode = typeof input.mode === 'number' ? input.mode : undefined
  const reason = String(input.reason ?? '')

  const rejected = (text: string, data?: Record<string, unknown>): ToolExecution => ({
    content: JSON.stringify({ status: 'rejected', reason: text }),
    uiStatus: 'rejected',
    uiSummary: text.slice(0, 120),
    raw: { text, exitCode: null, data }
  })

  // mode 已由 CLI 侧按八进制解析，这里 fail-closed 复查范围
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
    return rejected('--mode 超出权限位范围（八进制 0..7777）', { badRef: true })
  }

  // 本地文件 fail-closed（CLI 侧的预检只为快速失败，这里才是判定）：
  // 必须存在、必须 regular file（fifo/device 会让上传循环挂住）、必须可读
  let localStat: { size: number; mtimeMs: number }
  try {
    const st = await fsLocal.stat(localPath)
    if (!st.isFile()) return rejected(`本地路径不是普通文件：${localPath}`, { badRef: true })
    await fsLocal.access(localPath, 4 /* R_OK */)
    localStat = { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return rejected(`本地文件不存在或不可读：${localPath}`, { badRef: true })
  }

  // 远端路径纪律（词法，先挡明显坏形态；分险以 canonical 为准）
  const lexGate = gateRemotePath(remoteInput)
  if (!lexGate.ok) return rejected(`远端路径不合规：${lexGate.reason}`)

  // 父目录 realpath（11.5 复审折半采纳）：canonical 落点上卡、以它分险；
  // 失败即拒——目标目录都不可达，传了也是错
  let sftp: Awaited<ReturnType<typeof getSftp>>
  try {
    sftp = await getSftp(ctx.sessionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: message, isError: true, uiStatus: 'error', uiSummary: message, raw: { text: message, exitCode: null } }
  }
  const slash = remoteInput.lastIndexOf('/')
  const parentDir = slash > 0 ? remoteInput.slice(0, slash) : '/'
  const base = remoteInput.slice(slash + 1)
  let canonicalDir: string
  try {
    canonicalDir = await new Promise<string>((resolve, reject) =>
      sftp.realpath(parentDir, (err, abs) => (err ? reject(err) : resolve(abs)))
    )
  } catch {
    return rejected(`远端目标目录不存在或不可达：${parentDir}（目标路径不猜，请给出已存在目录下的完整文件路径）`)
  }
  const canonicalTarget = canonicalDir === '/' ? `/${base}` : `${canonicalDir}/${base}`
  const gate = gateRemotePath(canonicalTarget)
  if (!gate.ok) return rejected(`远端路径不合规（canonical ${canonicalTarget}）：${gate.reason}`)

  // 覆盖 stat（best-effort，同 write_file）：exists/oldSize 上卡；原 mode 供覆盖继承；
  // uid 标注属主——rename 换 inode 会换走属主，覆盖他人文件必须让人看见
  let exists: boolean | undefined
  let oldSize: number | undefined
  let oldMode: number | undefined
  let owner: string | undefined
  try {
    const st = await new Promise<{ size: number; mode: number; uid?: number }>((resolve, reject) =>
      sftp.stat(canonicalTarget, (err, s) => (err ? reject(err) : resolve(s)))
    )
    exists = true
    oldSize = st.size
    oldMode = st.mode & 0o7777
    owner = st.uid === 0 ? 'root' : st.uid !== undefined ? `uid ${st.uid}` : undefined
  } catch (err) {
    exists = (err as { code?: number }).code === 2 ? false : undefined
  }

  // 忙检查：审批三因（CLI 递入的 approvalBusyReason 子集）+ 同目标互斥（transfer 专属）
  const busy = ctx.ptyGuard?.()
  if (busy) return rejected(busy, { busy: true })
  const inflight = transferBusyReason(ctx.sessionId, canonicalTarget)
  if (inflight) return rejected(inflight, { transferBusy: true })

  // 覆盖且未显式 --mode：接原 mode（11.6——rename 换 inode，不接就变 umask 默认 644）
  const effectiveMode = mode ?? (exists && oldMode !== undefined ? oldMode : undefined)
  const large = localStat.size > PUSH_LARGE_BYTES

  const { risk, verb } = applyEnvShift(ctx.sessionId, gate.risk, gate.confirmWord, 'write')
  let proposalId: string | undefined
  const decision = await submitProposal(
    {
      sessionId: ctx.sessionId,
      sender: ctx.sender,
      signal: ctx.signal,
      actor: ctx.actor,
      timeoutMs: ctx.proposalTimeoutMs,
      onCreated: (id) => {
        proposalId = id
        ctx.onProposalCreated?.(id)
      }
    },
    {
      kind: 'transfer',
      command: '',
      risk,
      reason,
      verb,
      path: canonicalTarget,
      exists,
      oldSize,
      localPath,
      size: localStat.size,
      modeStr: mode !== undefined ? mode.toString(8) : undefined,
      owner,
      large,
      trustable: false
    }
  )
  if (decision.outcome === 'denied') {
    return {
      content: JSON.stringify({ status: 'denied' }),
      uiStatus: 'denied',
      uiSummary: decision.comment ? `用户拒绝：${decision.comment}` : '用户已拒绝',
      raw: {
        text: decision.comment ? `用户拒绝并留言：${decision.comment}` : '用户拒绝了该上传',
        exitCode: null,
        data: { denied: true, ...(decision.comment ? { comment: decision.comment } : {}) }
      }
    }
  }
  if (decision.outcome === 'withdrawn') {
    return rejected('等待窗口内未获用户决策，提案已主动撤回（文件未上传）。可稍后重发，或用 --async + job 轮询等更久。', { withdrawn: true })
  }
  if (decision.outcome !== 'approved') {
    return rejected('会话中止，提案已取消（文件未上传）', { aborted: true })
  }

  // 批准 → 互斥占位（挂起期间可能有并发批准，acquire 失败按忙打回）
  if (!acquireTransfer(ctx.sessionId, canonicalTarget)) {
    return rejected(transferBusyReason(ctx.sessionId, canonicalTarget) ?? '目标正在传输中', {
      transferBusy: true
    })
  }
  const label = `push ${base}`
  let lastPct = -1
  const sendProgress = (percent: number | null): void => {
    if (ctx.sender.isDestroyed()) return
    const event: AgentEvent = { kind: 'transfer-progress', label, percent }
    ctx.sender.send('agent:event', ctx.sessionId, event)
  }
  const startedAt = Date.now()
  try {
    sendProgress(0)
    const outcome = await pushFile({
      sftp,
      localPath,
      remotePath: canonicalTarget,
      expectedSize: localStat.size,
      expectedMtimeMs: localStat.mtimeMs,
      mode: effectiveMode,
      signal: ctx.signal,
      onProgress: (acked) => {
        const pct = localStat.size > 0 ? Math.floor((acked / localStat.size) * 100) : 100
        if (pct !== lastPct) {
          lastPct = pct
          sendProgress(pct)
        }
      }
    })
    const auditOk = await auditLog(ctx.sessionId, {
      kind: 'transfer',
      actor: ctx.actor,
      via: 'cli',
      direction: 'upload',
      command: `push ${localPath} -> ${canonicalTarget}`,
      files: [base],
      bytes: outcome.bytes,
      savedTo: canonicalDir,
      durationMs: Date.now() - startedAt,
      sha256: outcome.sha256,
      proposalId,
      outcome:
        'ok' +
        (outcome.fallbackRename ? ' fallback-rename' : '') +
        (outcome.leftovers.length ? ` leftovers=${outcome.leftovers.join(',')}` : '')
    })
    // 警示（残留/审计失败）不进 stdout 正文——CLI 的 stdout 要纯净可管道，
    // 由 execOutcome 按 data 标记翻成 stderr notes
    const text = `已上传 ${canonicalTarget}（${fmtBytes(outcome.bytes)}，sha256 ${outcome.sha256}）`
    return {
      content: JSON.stringify({ status: 'approved_and_uploaded', path: canonicalTarget, bytes: outcome.bytes, sha256: outcome.sha256 }),
      uiStatus: 'approved',
      uiSummary: `已上传 ${canonicalTarget}（${fmtBytes(outcome.bytes)}）`,
      raw: {
        text,
        exitCode: null,
        data: { transferred: true, auditFailed: !auditOk, leftovers: outcome.leftovers }
      }
    }
  } catch (err) {
    const pushErr = err instanceof PushError ? err : null
    const message = pushErr?.message ?? (err instanceof Error ? err.message : String(err))
    const leftovers = pushErr?.leftovers ?? []
    const auditOk = await auditLog(ctx.sessionId, {
      kind: 'transfer',
      actor: ctx.actor,
      via: 'cli',
      direction: 'upload',
      command: `push ${localPath} -> ${canonicalTarget}`,
      files: [base],
      durationMs: Date.now() - startedAt,
      proposalId,
      outcome: `failed: ${message}` + (leftovers.length ? ` leftovers=${leftovers.join(',')}` : '')
    })
    const kind = classifySftpError(err)
    const hint =
      kind === 'permission'
        ? '。SFTP 上传以 SSH 登录用户身份进行，终端里的 sudo/su 切换不影响本工具'
        : ''
    const text =
      `上传失败：${message}${hint}` +
      (leftovers.length ? `\n清理失败，远端残留：${leftovers.join('、')}（可手动删除）` : '') +
      (!auditOk ? '\n审计写盘失败：本次传输未能落 audit.jsonl' : '')
    return {
      content: JSON.stringify({ status: 'error', error: text }),
      isError: true,
      uiStatus: 'error',
      uiSummary: `上传失败：${message}`.slice(0, 120),
      raw: { text, exitCode: null, data: { leftovers } }
    }
  } finally {
    sendProgress(null)
    releaseTransfer(ctx.sessionId, canonicalTarget)
  }
}

/**
 * read_experience（v0.10.3 第七工具）：渐进式披露的读取半边——索引常驻 system，
 * 正文在这里按需取回。本地只读、不碰远端，免审批。只放行当前主机可见的条目
 * （global 或 hostId 匹配，含被截断未注入的——淘汰 ≠ 不可读）。
 * 内容不包 <terminal-data>：条目落盘都过了人审，属指令侧（knowledge-design 第六节）。
 */
async function runReadExperience(
  ctx: ToolContext,
  input: Record<string, unknown>
): Promise<ToolExecution> {
  const id = String(input.id ?? '').trim()
  if (!id) {
    return {
      content: JSON.stringify({ status: 'not_found', note: 'id 不能为空，见系统提示中的排障经验索引' }),
      isError: true,
      uiStatus: 'error',
      uiSummary: 'id 不能为空'
    }
  }
  const hostId = getSessionMeta(ctx.sessionId)?.hostId
  const found = await readExperienceForAgent(id, hostId)
  if (!found) {
    return {
      content: JSON.stringify({
        status: 'not_found',
        note: `经验 ${id} 不存在或不属于当前主机，可用的 id 见系统提示中的排障经验索引`
      }),
      isError: true,
      uiStatus: 'error',
      uiSummary: `经验 ${id} 不存在`,
      raw: { text: `经验 ${id} 不存在或不属于当前主机，可用的 id 见 use 返回的排障经验索引` }
    }
  }
  const { meta, detail } = found
  return {
    content: JSON.stringify({
      status: 'ok',
      id: meta.id,
      scope: meta.scope,
      summary: meta.summary,
      detail,
      createdAt: new Date(meta.createdAt).toISOString(),
      note: '经验是过去某时刻的结论，可能已过期；与现实对不上时向用户指出（写明 id），不要试图改写。'
    }),
    uiStatus: 'ok',
    uiSummary: `读取经验 [${meta.id}] ${meta.summary.slice(0, 40)}`,
    raw: {
      text: detail,
      data: {
        id: meta.id,
        scope: meta.scope,
        summary: meta.summary,
        createdAt: new Date(meta.createdAt).toISOString()
      }
    }
  }
}

/**
 * save_experience（v0.10.3 第八工具）：永不自动保存，一律进审批台——它不碰远端，
 * 审的不是"会不会改坏机器"，是"**会不会污染未来所有对话的上下文**"（持久、
 * 高权重、跨会话、每轮生效——写进知识层的注入是永久后门）。故不做风险分级、
 * 不要确认词，但必须人审 + 防盲批；用户在查看器里改过的内容随批准回传
 * （decision.edits），落盘的是人确认后的版本。
 */
async function runSaveExperience(
  ctx: ToolContext,
  input: Record<string, unknown>
): Promise<ToolExecution> {
  const summary = String(input.summary ?? '').replace(/\s+/g, ' ').trim()
  const detail = typeof input.detail === 'string' ? input.detail : ''
  const scope: ExperienceScope = input.scope === 'global' ? 'global' : 'host'
  // Agent 起草强制"症状 → 结论"形态（4.2 召回质量的命门）；打回重写零成本
  const check = validateExperience(summary, detail, true)
  if (!check.ok) {
    return {
      content: JSON.stringify({ status: 'rejected', reason: check.reason }),
      uiStatus: 'rejected',
      uiSummary: check.reason ?? '内容校验未通过'
    }
  }
  const hostId = getSessionMeta(ctx.sessionId)?.hostId
  if (scope === 'host' && !hostId) {
    return {
      content: JSON.stringify({ status: 'rejected', reason: '当前会话没有归属主机，无法保存本机经验' }),
      uiStatus: 'rejected',
      uiSummary: '会话无归属主机'
    }
  }

  const decision = await submitProposal(
    { sessionId: ctx.sessionId, sender: ctx.sender, signal: ctx.signal, actor: ctx.actor },
    {
      kind: 'save_experience',
      command: '',
      // 无风险分级（不碰远端）；low 仅作 UI 中性底色的占位，卡片不显示风险徽章
      risk: 'low',
      reason: '存入后将进入未来所有对话的上下文（经验索引），审的是内容是否值得长期记住',
      verb: 'save_experience',
      summary,
      detail,
      scope
    }
  )
  if (decision.outcome === 'denied') {
    return {
      content: JSON.stringify({
        status: 'denied',
        ...(decision.comment
          ? { comment: decision.comment, note: '用户拒绝并留言，请根据留言修订内容后再提交' }
          : { note: '用户拒绝保存该经验' })
      }),
      uiStatus: 'denied',
      uiSummary: decision.comment ? `用户拒绝：${decision.comment}` : '用户已拒绝'
    }
  }
  // aborted / withdrawn（后者仅设超时的调用方可达，save_experience 结构上不设）都不落盘
  if (decision.outcome !== 'approved') {
    return {
      content: JSON.stringify({ status: 'aborted', note: '本轮被用户中止，提案已取消' }),
      uiStatus: 'rejected',
      uiSummary: '已中止，提案取消'
    }
  }

  // 批准 → 落盘的是用户确认（可能改过）的版本；edits 已在主进程校验过底线
  const final = decision.edits ?? { summary, detail, scope }
  const saved = await saveExperience({
    scope: final.scope,
    hostId: final.scope === 'host' ? hostId : undefined,
    summary: final.summary,
    detail: final.detail,
    sourceConvId: ctx.convId
  })
  // 人批了、盘没写成（v0.13.1 二次返工）：必须如实回给 Agent，否则它以为存过了，
  // 之后在回复里引用一个不存在的 id——审计同样记 exitCode=1，别让它看着像成功
  if (!saved.ok) {
    void auditLog(ctx.sessionId, {
      kind: 'result',
      command: `save_experience 落盘失败：${saved.reason}`,
      exitCode: 1,
      bytes: 0
    })
    return {
      content: JSON.stringify({ status: 'save_failed', reason: saved.reason }),
      isError: true,
      uiStatus: 'error',
      uiSummary: `经验未保存：${saved.reason}`
    }
  }
  const meta = saved.meta
  void auditLog(ctx.sessionId, {
    kind: 'result',
    command: `save_experience [${meta.id}] ${meta.summary}`,
    exitCode: 0,
    bytes: meta.bytes
  })
  return {
    content: JSON.stringify({
      status: 'approved_and_saved',
      id: meta.id,
      scope: meta.scope,
      note:
        '用户已审阅并保存。本对话的经验索引是开始时的快照，不会更新（你已经知道这条内容，无需重读）；新条目从下一个对话起进入索引。'
    }),
    uiStatus: 'approved',
    uiSummary: `已存经验 [${meta.id}] ${meta.summary.slice(0, 40)}`
  }
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown
): Promise<ToolExecution> {
  const input = (rawInput ?? {}) as Record<string, unknown>
  try {
    switch (name) {
      case 'read_screen':
        return await runReadScreen(ctx)
      case 'list_transcript':
        return runListTranscript(ctx, input)
      case 'read_output':
        return runReadOutput(ctx, input)
      case 'exec':
        return await runExec(ctx, input)
      case 'wait':
        return await runWait(ctx, input)
      case 'write_file':
        return await runWriteFile(ctx, input)
      // CLI 专属：不在 TOOL_SPECS（LLM 工具面）里，只有 CLI 通道会发
      case 'push':
        return await runPush(ctx, input)
      case 'read_experience':
        return await runReadExperience(ctx, input)
      case 'save_experience':
        return await runSaveExperience(ctx, input)
      default:
        return {
          content: `未知工具 ${name}`,
          isError: true,
          uiStatus: 'error',
          uiSummary: `未知工具 ${name}`
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `工具执行异常：${message}`, isError: true, uiStatus: 'error', uiSummary: message }
  }
}
