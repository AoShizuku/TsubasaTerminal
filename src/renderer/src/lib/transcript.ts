import type { TranscriptUnitRaw } from '@shared/types'
import { parseOsc7WithUser } from '@/composables/useFileStore'

/**
 * 结构化转录组装器：对 pty 原始字节流做增量 OSC 扫描，
 * 按 133;B（输入开始）/ 133;C（输出开始）/ 133;D（命令结束）切
 * "命令-输出-退出码"单元，完成即上报主进程（净化与脱敏在主进程出口做）。
 *
 * 自行扫描字节流、不依赖 xterm 的 OSC 回调：跨 chunk 的转义序列由 tail 缓冲兜住，
 * 多字节 UTF-8 由流式 TextDecoder 兜住。喂入时机在 xterm 解析完同一块之后
 * （write 回调），C 时刻才能配上屏幕读出的命令行。
 */

const ECHO_LIMIT = 16 * 1024
const OUTPUT_LIMIT = 1024 * 1024
/** 未闭合 OSC 的最大等待长度，超过按普通文本吞掉（防伪造超长 OSC 拖死扫描器） */
const PENDING_OSC_LIMIT = 4096

type Phase = 'idle' | 'echo' | 'output'

interface TranscriptState {
  hostId: string
  decoder: TextDecoder
  /** chunk 尾部未闭合的转义序列，留待下一 chunk */
  tail: string
  phase: Phase
  echo: string
  output: string
  outputTruncated: boolean
  cwd: string | null
  /** pty 身份：OSC 7 userinfo 位上报的 id -un；无上报为 null */
  ptyUser: string | null
  /** composer 整行发送的命令文本，与下一个 B..C 段配对 */
  pendingCommand: string | null
  /**
   * xterm 解析到 133;C 时从屏幕读出的命令行（见 lib/commandLine），按出现
   * 次序排队。本组装器在同一 chunk 被 xterm 解析完后才扫描（TerminalView 的 write
   * 回调），所以扫到第 n 个 C 时队首就是它的屏幕读数；每个 chunk 扫完清空，错位不跨块。
   */
  screenCommands: Array<string | null>
  /** 当前单元的屏幕命令行（C 时取出并校验，D 时代替回显上报） */
  screenCommand: string | null
  startedAt: number
}

const states = new Map<string, TranscriptState>()

export function initTranscript(sessionId: string, hostId: string): void {
  states.set(sessionId, {
    hostId,
    decoder: new TextDecoder('utf-8'),
    tail: '',
    phase: 'idle',
    echo: '',
    output: '',
    outputTruncated: false,
    cwd: null,
    ptyUser: null,
    pendingCommand: null,
    screenCommands: [],
    screenCommand: null,
    startedAt: 0
  })
}

export function disposeTranscript(sessionId: string): void {
  states.delete(sessionId)
  window.api.transcript.dispose(sessionId)
}

/** composer 整行发送时记录精确命令文本（直打场景无此信息，单元 command 为 null） */
export function noteComposerCommand(sessionId: string, text: string): void {
  const state = states.get(sessionId)
  if (state) state.pendingCommand = text
}

/** xterm 解析到 133;C 时的屏幕读数入队（null = 读不到，占位保持次序） */
export function noteScreenCommand(sessionId: string, text: string | null): void {
  states.get(sessionId)?.screenCommands.push(text)
}

function stripEcho(echo: string): string {
  return echo
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** 剥 ANSI/OSC 转义与控制字符，取最后一个非空行（直打命令的回显近似） */
function approximateCommandFromEcho(echo: string): string | null {
  const lines = stripEcho(echo).split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : null
}

/**
 * 屏幕读数必须是回显字节的子序列（忽略空白）：屏幕上每个字符都经回显画上去过，
 * 重绘只会多画不会少画。tmux 重排绘制、标记错位读到 prompt 等异常读数在这里落空，
 * 退回回显近似——宁可旧的噪声，不要看似干净的错命令。
 */
export function screenMatchesEcho(screen: string, echo: string): boolean {
  const want = [...screen.replace(/\s/g, '')]
  if (want.length === 0) return false
  let i = 0
  for (const ch of stripEcho(echo).replace(/\s/g, '')) {
    if (ch === want[i]) i += 1
    if (i === want.length) return true
  }
  return false
}

/**
 * ZMODEM 拦截桥的上下文：主进程检测到起始帧时，触发命令与 cwd
 * 都在本组装器状态里——composer 精确文本优先，直打场景以回显近似。
 */
export function getTranscriptContext(sessionId: string): {
  cwd: string | null
  command: string | null
} {
  const state = states.get(sessionId)
  if (!state) return { cwd: null, command: null }
  return {
    cwd: state.cwd,
    command: state.pendingCommand ?? state.screenCommand ?? approximateCommandFromEcho(state.echo)
  }
}

/** 单元上报回调（补全 L3 的触发时刻：命令结束 = 用户在读输出的停顿） */
type UnitReportedListener = (sessionId: string, unit: TranscriptUnitRaw) => void
const unitListeners = new Set<UnitReportedListener>()

export function onUnitReported(cb: UnitReportedListener): () => void {
  unitListeners.add(cb)
  return () => unitListeners.delete(cb)
}

/**
 * 命令开始回调（v0.11.0 自动重载 SI 的触发点）：133;C 时刻命令文本已知
 * （composer 精确文本优先，直打场景回显近似），而单元要等 133;D 才闭合——
 * `sudo su` 的单元要到 exit 才闭合，等它就晚了。
 */
type CommandStartedListener = (sessionId: string, command: string) => void
const commandStartedListeners = new Set<CommandStartedListener>()

export function onCommandStarted(cb: CommandStartedListener): () => void {
  commandStartedListeners.add(cb)
  return () => commandStartedListeners.delete(cb)
}

export function feedTranscript(sessionId: string, data: Uint8Array): void {
  const state = states.get(sessionId)
  if (!state) return
  const text = state.tail + state.decoder.decode(data, { stream: true })
  state.tail = ''
  scan(sessionId, state, text)
  // 本块的屏幕读数已按次序配对完；剩下的（两边对 C 的计数偶然不一致）不得漂到下一块
  state.screenCommands.length = 0
}

function appendText(state: TranscriptState, text: string): void {
  if (!text) return
  if (state.phase === 'echo') {
    if (state.echo.length < ECHO_LIMIT) state.echo += text.slice(0, ECHO_LIMIT - state.echo.length)
  } else if (state.phase === 'output') {
    if (state.output.length < OUTPUT_LIMIT) {
      state.output += text.slice(0, OUTPUT_LIMIT - state.output.length)
    } else {
      state.outputTruncated = true
    }
  }
  // idle（B 之前的 banner/杂输出）不属于任何单元，忽略
}

function handleOsc(sessionId: string, state: TranscriptState, payload: string): void {
  if (payload.startsWith('133;')) {
    const kind = payload[4]
    if (kind === 'B') {
      state.phase = 'echo'
      state.echo = ''
    } else if (kind === 'C') {
      const screen = state.screenCommands.shift() ?? null
      state.screenCommand = screen !== null && screenMatchesEcho(screen, state.echo) ? screen : null
      state.phase = 'output'
      state.output = ''
      state.outputTruncated = false
      state.startedAt = Date.now()
      const started =
        state.pendingCommand ?? state.screenCommand ?? approximateCommandFromEcho(state.echo)
      if (started) {
        for (const listener of commandStartedListeners) listener(sessionId, started)
      }
    } else if (kind === 'D') {
      if (state.phase === 'idle') return
      const exitRaw = payload.slice(6)
      const exitCode = /^\d+$/.test(exitRaw) ? Number(exitRaw) : null
      const unit: TranscriptUnitRaw = {
        command: state.pendingCommand,
        // 直打命令：屏幕读数代替回显上报——主进程照旧按回显近似处理，
        // 不进 Tsubasa Terminal 历史（composer-design：原生命令历史归远端 shell）
        echo: state.screenCommand ?? state.echo,
        // B 后直接 D（如空回车、Ctrl+C 中断）没有输出段
        output: state.phase === 'output' ? state.output : '',
        outputTruncated: state.outputTruncated,
        exitCode,
        // cwd/ptyUser 都是"命令启动时"的值：本次报告的新值在 D 之后的 OSC 7 里才到
        cwd: state.cwd,
        ptyUser: state.ptyUser,
        startedAt: state.startedAt || Date.now(),
        endedAt: Date.now()
      }
      window.api.transcript.report(sessionId, state.hostId, unit)
      for (const listener of unitListeners) listener(sessionId, unit)
      state.pendingCommand = null
      state.screenCommand = null
      state.phase = 'idle'
      state.echo = ''
      state.output = ''
      state.outputTruncated = false
      state.startedAt = 0
    }
  } else if (payload.startsWith('7;')) {
    // 与文件栏共用带合理性校验的解析（伪造 cwd 形态非法则丢弃）
    const parsed = parseOsc7WithUser(payload.slice(2))
    if (parsed) {
      state.cwd = parsed.path
      // pty 身份变化即报主进程（含 → null：无 user 的 OSC 7 意味着身份来源丢失，
      // 不沿用旧值——错位检测与审计宁可 unknown 不猜）
      if (parsed.user !== state.ptyUser) {
        state.ptyUser = parsed.user
        window.api.transcript.identity(sessionId, parsed.user)
      }
    }
  }
}

function scan(sessionId: string, state: TranscriptState, text: string): void {
  let pos = 0
  while (pos < text.length) {
    const esc = text.indexOf('\x1b]', pos)
    if (esc === -1) {
      // 无 OSC 起始；末尾若是孤立 ESC，可能是被切断的 '\x1b]'，留 tail
      if (text.endsWith('\x1b')) {
        appendText(state, text.slice(pos, -1))
        state.tail = '\x1b'
      } else {
        appendText(state, text.slice(pos))
      }
      return
    }
    appendText(state, text.slice(pos, esc))
    // 找 OSC 终止符：BEL 或 ST（ESC \）
    const bel = text.indexOf('\x07', esc + 2)
    const st = text.indexOf('\x1b\\', esc + 2)
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
    if (end === -1) {
      const rest = text.slice(esc)
      if (rest.length <= PENDING_OSC_LIMIT) {
        state.tail = rest
      } else {
        // 超长未闭合 OSC：按文本吞掉，防拖死
        appendText(state, rest)
      }
      return
    }
    handleOsc(sessionId, state, text.slice(esc + 2, end))
    pos = end + (end === bel ? 1 : 2)
  }
}
