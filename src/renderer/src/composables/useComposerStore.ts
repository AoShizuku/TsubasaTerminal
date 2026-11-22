import { reactive, ref } from 'vue'
import type { TerminalInputMode, TerminalWriteStatus } from '@shared/types'
import { isPromptLikeLine } from '@/lib/promptLine'
import { noteComposerCommand } from '@/lib/transcript'
import { getTerminal } from '@/lib/terminalRegistry'
import { clearSuggestion } from './useSuggestStore'
import { useSettingsStore } from './useSettingsStore'

/**
 * 终端输入路由模式（composer-design 的模式路由状态机）：
 * - none    从未收到 133;A（无 shell integration）→ 降级直通 pty
 * - prompt  收到 133;A，shell 空闲 → 按键进 composer
 * - running 整行发送后到下一个 prompt 之间 → 按键直通 pty（sudo 密码、y/n 交互）
 * - tui     备用屏幕缓冲区激活（vim/htop）→ composer 让位，直通 pty
 */
export type TerminalMode = 'none' | 'prompt' | 'running' | 'tui'

export interface ComposerState {
  mode: TerminalMode
  /** 是否收到过 133;A——TUI/命令结束后据此决定回 running（等下一个 A）还是回 none */
  integrationSeen: boolean
  /**
   * running 态下 pty 长时间静默、且光标停在像 shell prompt 的行上：
   * 疑似 `sudo su` 之类换了 shell 把 OSC 133 甩掉，133;A 永远不会来，composer
   * 会永久卡在 running。只驱动提示与两个手动按钮，不自动改 mode/idle 上报。
   */
  stalled: boolean
  draft: string
  /** 会话内命令历史（v0.5 升级为按主机持久化的主机记忆） */
  history: string[]
  /** null = 未在历史导航中 */
  historyIndex: number | null
  /** 进入历史导航前暂存的草稿 */
  stash: string
  searchOpen: boolean
  searchQuery: string
  searchIndex: number
  /** 会话累计脱敏命中数（主进程闸门上报，角标展示） */
  redactions: number
  /**
   * 本会话生效中的输入载体。偏好（全局或 v0.13.19 本机指定）变更经 applyInputPreference 走
   * pending 规则安全切换：草稿非空 / 终端行非空的现场不立即切，零丢字零错向。
   */
  effectiveInput: TerminalInputMode
  /** 偏好已变但现场不允许立即切换时的原因（状态行展示）；null=无 pending */
  inputPendingReason: string | null
  /**
   * pty 输入行是否可能非空（fail-closed，初始 true=未知即不可写）：
   * 有效 133;A 置 false；native prompt / none 下人的第一段 pty 输入置 true；
   * none 只能经用户显式「已回到空提示符」置 false。backspace 删空也不猜——
   * readline/zle 的自定义键绑定不是客户端能可靠模拟的。
   */
  lineDirty: boolean
  /** native 模式的审批决策草稿（与命令草稿分槽，绝不发送到 pty） */
  approvalDraft: string
}

const HISTORY_LIMIT = 500

const states = reactive<Record<string, ComposerState>>({})

/**
 * 只读探询（v0.12.2 多机浮层的逐台忙碌行）：**不能**改用 composerState()——
 * 它会惰性建状态，render 期写 reactive 就是让渲染自己触发自己的更新
 * （同 useApprovalStore.hasPendingApproval 的教训）。未建状态视为 null（按直通对待）。
 */
export function peekComposerMode(sessionId: string): TerminalMode | null {
  return states[sessionId]?.mode ?? null
}

/**
 * 关闭确认的忙碌原因，null = 空闲或判断不了。只读探询，同 peekComposerMode
 * 不建状态（TabBar 点击路径虽不在 render 期，口径保持一致）。
 * - tui / running → 忙；running 的 stalled 疑似换了 shell 已空闲，但也可能是程序在等
 *   输入——关闭不可撤销，宁可多问一次，文案写"可能"
 * - none 没有 shell integration，忙闲无从判断；每次都问会把确认框磨成噪音，不问
 */
export function peekCloseBusyReason(sessionId: string): string | null {
  const state = states[sessionId]
  if (!state) return null
  if (state.mode === 'tui') return '正在运行全屏应用（vim、htop 等）'
  if (state.mode === 'running') return state.stalled ? '可能有命令仍在运行' : '有命令正在运行'
  return null
}

/**
 * 本机输入方式覆盖：sessionId → 主机的 inputMode，undefined = 跟随全局。
 * 不放进 ComposerState：openSession 早于状态的惰性创建，首次建状态时 effectiveInput
 * 就得按本机设置起步。由 app store 下发——它在上层，这里反向 import 它即成环。
 */
const hostInputOverrides = reactive<Record<string, TerminalInputMode | undefined>>({})
/** 已建会话的覆盖值真变了才 +1：App 据此重放 pending 表并落焦（开会话时的首次下发不算） */
const overrideRevision = ref(0)

export function setSessionInputOverride(sessionId: string, mode: TerminalInputMode | undefined): void {
  if (sessionId in hostInputOverrides && hostInputOverrides[sessionId] === mode) return
  hostInputOverrides[sessionId] = mode
  if (states[sessionId]) overrideRevision.value += 1
}

/** 响应式读：App 的 watch 用它感知"已开会话的本机设置被改了" */
export function inputOverrideRevision(): number {
  return overrideRevision.value
}

/** 本会话的输入方式是否由主机单独指定（状态行标注来源，免得和设置页对不上） */
export function inputPreferenceFromHost(sessionId: string): boolean {
  return hostInputOverrides[sessionId] !== undefined
}

/** 本会话的输入偏好：本机指定优先，其次全局（设置未加载时按默认 composer 兜底） */
function inputPreference(sessionId: string): TerminalInputMode {
  return (
    hostInputOverrides[sessionId] ??
    useSettingsStore().settings.value?.terminalInputMode ??
    'composer'
  )
}

export function composerState(sessionId: string): ComposerState {
  if (!states[sessionId]) {
    states[sessionId] = {
      mode: 'none',
      integrationSeen: false,
      stalled: false,
      draft: '',
      history: [],
      historyIndex: null,
      stash: '',
      searchOpen: false,
      searchQuery: '',
      searchIndex: 0,
      redactions: 0,
      effectiveInput: inputPreference(sessionId),
      inputPendingReason: null,
      lineDirty: true,
      approvalDraft: ''
    }
  }
  return states[sessionId]
}

/**
 * write-safe 事实的唯一计算点：渲染层所有"能不能批 exec"的 UI 判定
 * 与上报主进程的状态都从这里出，别在组件里再抄一份口径。
 */
export function computeWriteStatus(state: ComposerState): TerminalWriteStatus {
  if (state.mode === 'running') return 'running'
  if (state.mode === 'tui') return 'tui'
  if (state.mode === 'prompt') {
    return state.effectiveInput === 'native' && state.lineDirty ? 'dirty' : 'clean'
  }
  // none：无下一次可信 133;A，clean 只能来自用户显式声明
  return state.lineDirty ? 'none-unverified' : 'clean'
}

/** 只读探询版（多机浮层逐台忙碌行用）：未建状态返回 null（fail-closed 按不可写对待） */
export function peekWriteStatus(sessionId: string): TerminalWriteStatus | null {
  const state = states[sessionId]
  return state ? computeWriteStatus(state) : null
}

/** 上报去抖：native 下每个键都过 noteHumanPtyInput，状态没变就别刷 IPC */
const lastReported = new Map<string, TerminalWriteStatus>()

function reportWriteState(sessionId: string, state: ComposerState): void {
  const status = computeWriteStatus(state)
  if (lastReported.get(sessionId) === status) return
  lastReported.set(sessionId, status)
  window.api.agent.noteTerminalWriteState(sessionId, status)
}

/** 会话挂载时报一次初始态（无 SI 主机可能永远没有模式变化，CLI 的状态列靠它） */
export function initComposerReporting(sessionId: string): void {
  reportWriteState(sessionId, composerState(sessionId))
}

/** 主机记忆预载：持久化历史填进会话历史前部，↑/Ctrl+R 即刻跨会话可用 */
export async function preloadHostHistory(sessionId: string, hostId: string): Promise<void> {
  const persisted = await window.api.history.list(hostId, 200)
  const state = composerState(sessionId)
  if (persisted.length === 0) return
  // list 返回最新在前；历史数组语义是旧→新，翻转后拼在本会话已有记录之前
  const merged = [...persisted.reverse(), ...state.history]
  state.history = merged.slice(-500)
}

/**
 * 模式变更的唯一出口：顺带把结构化 write-safe 状态上报主进程。
 * 信任免问要把命令写进 pty，终端不可写时写进去就是喂给前台进程或与
 * 用户半行拼接——批准路径主进程还会复核，免问路径没有 UI，这条上报是它的眼睛。
 */
function setMode(state: ComposerState, sessionId: string, mode: TerminalMode): void {
  state.mode = mode
  // 任何模式切换都开启新周期——stalled 只描述"当前这段 running 卡住了"
  state.stalled = false
  if (mode === 'running') {
    // 计时起点从进入 running 起算：否则上一条命令留下的陈旧时间戳会让新命令秒判 stalled
    noteOutput(sessionId)
    ensureStallPolling()
  }
  reportWriteState(sessionId, state)
}

/**
 * shell integration 断链检测。running 的唯一出口是 133;A，而 `sudo su`
 * 起的新 shell 是全新进程（PS1/PS0/PROMPT_COMMAND 都不是 exported，sudo 还 env_reset），
 * A 永远不会来，composer 就此永久卡死。这里只做"疑似"判定，处置权交给用户：
 * 自动降级到 none 会连带把终端上报为空闲，Agent 免问路径就会把命令写进 pty，
 * 而 running 卡住也可能是命令真在跑（sleep、静默编译期），写进去就是喂给前台进程。
 * 所以自动的部分只负责显示提示，误判的代价被压到"多一行灰字"。
 */
let stallPollMs = 2000
let stallThresholdMs = 10000
let stallTimer: ReturnType<typeof setInterval> | null = null
let stallScanCount = 0
/** pty 最后一次有字节到达的时刻。每个 data chunk 都写，故意不进 reactive */
const lastOutputAt = new Map<string, number>()

/**
 * e2e 用：调低静默阈值与巡检周期（经 window.__tsubasaterminal 暴露），生产路径不调用。
 * 改周期时重建已有 interval，否则连接阶段留下的 2s 定时器仍会拖慢短阈值用例。
 */
export function setStallThresholdMs(thresholdMs: number, pollMs = stallPollMs): void {
  stallThresholdMs = thresholdMs
  if (pollMs === stallPollMs) return
  stallPollMs = pollMs
  if (stallTimer) {
    clearInterval(stallTimer)
    stallTimer = null
  }
  if (
    Object.values(states).some(
      (state) => state.mode === 'running' && state.integrationSeen && !state.stalled
    )
  ) {
    ensureStallPolling()
  }
}

/** e2e 用：让反例等待巡检确实越过静默阈值，而不是依赖固定 sleep。 */
export function getStallScanCount(): number {
  return stallScanCount
}

/** pty 有输出——热路径，只写一个时间戳 */
export function noteOutput(sessionId: string): void {
  lastOutputAt.set(sessionId, Date.now())
}

/** pty 最后一次有输出的时刻（v0.11.0 自动重载的静默判定共用这份心跳） */
export function getLastOutputAt(sessionId: string): number {
  return lastOutputAt.get(sessionId) ?? 0
}

/**
 * 光标所在行看着像 shell prompt：把"换了 shell 正在等输入"与"命令真在跑"
 * 分开的关键一条。sudo su 后光标停在 `root@host:~#` 上，而 sleep 300 停在空行；
 * sudo 的密码提示以 `:` 结尾，同样不在此列——自动重载靠这条不往密码提示里灌文本。
 */
export function cursorLineLooksLikePrompt(sessionId: string): boolean {
  const term = getTerminal(sessionId)
  if (!term) return false
  const buffer = term.buffer.active
  const text = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
  return isPromptLikeLine(text)
}

function scanStalled(): void {
  stallScanCount += 1
  const now = Date.now()
  let stillWatching = false
  for (const [sessionId, state] of Object.entries(states)) {
    if (state.mode !== 'running' || !state.integrationSeen || state.stalled) continue
    stillWatching = true
    if (now - (lastOutputAt.get(sessionId) ?? now) < stallThresholdMs) continue
    if (!cursorLineLooksLikePrompt(sessionId)) continue
    state.stalled = true
  }
  // 没有还在观察的会话就停表，别让空转的 interval 常驻
  if (!stillWatching && stallTimer) {
    clearInterval(stallTimer)
    stallTimer = null
  }
}

function ensureStallPolling(): void {
  if (!stallTimer) stallTimer = setInterval(scanStalled, stallPollMs)
}

/**
 * 用户点「切回直通模式」：卡死时的保底出口。integrationSeen 一并归零：这个会话的
 * SI 已不可信，TUI 退出时不该再回 running。
 * v0.13.4 起降级**不再等于解锁**：none 也是 fail-closed（lineDirty 保持），要放行
 * Agent 写 pty 还需用户在状态条点「已回到空提示符」——降级是模式判断，
 * "输入行为空"是另一个事实，两个声明不合并。
 */
export function resetToPassthrough(sessionId: string): void {
  const state = composerState(sessionId)
  state.integrationSeen = false
  state.lineDirty = true
  setMode(state, sessionId, 'none')
}

/**
 * 用户显式声明「已回到空提示符」（none 模式唯一的解锁路径）：
 * 这是人的现场判断，不是从屏幕尾行或静默时间推断——那两样都能被输出内容伪造。
 */
export function declareLineClean(sessionId: string): void {
  const state = composerState(sessionId)
  if (state.mode !== 'none') return
  state.lineDirty = false
  applyInputPreference(sessionId)
  reportWriteState(sessionId, state)
}

/**
 * 人的 pty 输入即将发出：native prompt / none 下置 dirty——在字节写
 * pty **之前**标记并上报；主进程的 ssh:input 路口还会先标后转发，双保险关竞态。
 * fixed prompt 不标：人的草稿住本地 textarea，pty 行仍为空（能落到 pty 的只有
 * Ctrl+C 这类控制键，它们不产生行内容）。
 */
export function noteHumanPtyInput(sessionId: string): void {
  const state = composerState(sessionId)
  const dirties =
    (state.mode === 'prompt' && state.effectiveInput === 'native') || state.mode === 'none'
  if (dirties && !state.lineDirty) {
    state.lineDirty = true
    reportWriteState(sessionId, state)
  }
}

/** 人的 pty 输入统一出口：先标记（渲染侧）再发送。TerminalView onData 与
 *  App 的游离按键兜底都走这里，别绕过它直接调 window.api.ssh.input */
export function sendHumanInput(sessionId: string, data: string): void {
  noteHumanPtyInput(sessionId)
  window.api.ssh.input(sessionId, data)
}

/**
 * 把输入偏好（本机指定优先，其次全局）安全地落到本会话（v0.13.4 pending 表）：
 * - → native：草稿非空不切（提示先发送或清空；草稿绝不静默丢弃），其余立即切；
 * - → composer：native prompt 且行 dirty 不切（等下一次可信 133;A），其余立即切；
 * - running/tui 两个方向都立即切——那两个阶段本就直通，差异到下一次 prompt 才显现；
 * - none 恒为直通行为（textarea 禁用），effectiveInput 只决定 SI 恢复后的形态。
 * 焦点转移不在这里做（store 不 import focusManager——那是个现成的环）；
 * 设置变更的调用方（App）与模式切换的 watcher（Composer）各自负责落焦。
 */
export function applyInputPreference(sessionId: string): void {
  const state = composerState(sessionId)
  const pref = inputPreference(sessionId)
  if (pref === state.effectiveInput) {
    state.inputPendingReason = null
    return
  }
  if (pref === 'native') {
    if (state.draft.trim() !== '') {
      state.inputPendingReason = '输入方式将切换为原生终端：先发送或清空当前草稿'
      return
    }
    state.effectiveInput = 'native'
  } else {
    if (state.mode === 'prompt' && state.lineDirty) {
      state.inputPendingReason = '输入方式将切换为固定输入栏：等当前终端行结束（提交或 Ctrl+C）'
      return
    }
    state.effectiveInput = 'composer'
  }
  state.inputPendingReason = null
  reportWriteState(sessionId, state)
}

/** 全局设置或本机设置变更时对所有已建会话应用一遍（App 的 watch 调用） */
export function applyInputPreferenceAll(): void {
  for (const sessionId of Object.keys(states)) applyInputPreference(sessionId)
}

/** OSC 133;A：prompt 就绪，composer 激活。新 prompt 的编辑行为空——lineDirty
 *  复位（唯一的自动复位点；伪造的 A 已被 oscGuard 拦在上游）；pending 的输入
 *  偏好切换也在这一刻兑现（native 半行阻塞的 → fixed 现在安全了） */
export function onPromptReady(sessionId: string): void {
  const state = composerState(sessionId)
  state.integrationSeen = true
  state.lineDirty = false
  applyInputPreference(sessionId)
  if (state.mode !== 'tui') setMode(state, sessionId, 'prompt')
  else reportWriteState(sessionId, state)
}

/** xterm buffer 切换：alternate = 全屏 TUI；回到 normal 先按运行中处理，等下一个 133;A */
export function onBufferTypeChange(sessionId: string, type: 'normal' | 'alternate'): void {
  const state = composerState(sessionId)
  if (type === 'alternate') setMode(state, sessionId, 'tui')
  else setMode(state, sessionId, state.integrationSeen ? 'running' : 'none')
}

/** 会话关闭/出错：composer 退场。lineDirty 回到 fail-closed——重连后的 shell
 *  （尤其 tmux 保活回原现场）在下一个有效 133;A 之前不可写 */
export function onSessionGone(sessionId: string): void {
  const state = states[sessionId]
  if (!state) return
  state.lineDirty = true
  setMode(state, sessionId, 'none')
}

/**
 * 批准的 exec 由主进程写入 pty：composer 同步进入运行态（与 sendCommand 同语义，
 * 等下一个 133;A 回 prompt）。否则执行期间仍显示"就绪"，误导用户把交互应答
 * （dpkg 的 y/N、sudo 密码）当新命令从 composer 发送（v0.8.5 真机 apt 踩坑）。
 *
 * OSC 133;C 也走这里：原生输入下人在 pty 里直接回车提交，前两条入口都
 * 不经过，mode 会停在 prompt 直到下一个 A——stalled 提示与自动重载 SI 都以 running
 * 为前提，于是双双失效。只做 prompt→running：伪造的 C 只会把状态推向更保守的一侧。
 */
export function enterRunning(sessionId: string): void {
  const state = composerState(sessionId)
  if (state.mode === 'prompt') setMode(state, sessionId, 'running')
}

export function disposeComposer(sessionId: string): void {
  delete states[sessionId]
  delete hostInputOverrides[sessionId]
  lastOutputAt.delete(sessionId)
  lastReported.delete(sessionId)
}

/** 整行发送：本地组稿一次性发给 pty，shell 回显自然出现在上方终端流里 */
export function sendCommand(sessionId: string, text: string): void {
  const state = composerState(sessionId)
  window.api.ssh.input(sessionId, text.replace(/\r?\n/g, '\r') + '\r')
  const trimmed = text.trim()
  // 转录单元的精确命令文本（回显里混着 prompt 与控制序列，composer 是唯一可靠来源）。
  // 仅 shell 空闲时这一行才是命令——running/tui 态发出的整行是前台进程的 stdin
  // （y/N 应答、sudo 密码），记入会顶掉正在跑命令的文本，让批准 exec 的结果回流
  // 匹配落空卡死（v0.8.5 真机 apt 交互踩坑）；同理不入命令历史（密码不进 ↑ 历史）
  const atShellPrompt = state.mode === 'prompt' || state.mode === 'none'
  if (trimmed && atShellPrompt) noteComposerCommand(sessionId, trimmed)
  if (trimmed && atShellPrompt && state.history[state.history.length - 1] !== trimmed) {
    state.history.push(trimmed)
    if (state.history.length > HISTORY_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_LIMIT)
    }
  }
  state.draft = ''
  state.historyIndex = null
  state.stash = ''
  setMode(state, sessionId, 'running')
  // 上一条命令的 L3 建议随新命令作废
  clearSuggestion(sessionId)
  // 草稿清空 = fixed→native 的 pending 条件解除；running 期切换本就无感
  applyInputPreference(sessionId)
}

/** prompt 态下落在 xterm 上的可打印字符，路由回 composer 草稿 */
export function appendDraft(sessionId: string, ch: string): void {
  composerState(sessionId).draft += ch
}

/** ↑：进入/后退历史 */
export function historyPrev(sessionId: string): void {
  const state = composerState(sessionId)
  if (state.history.length === 0) return
  if (state.historyIndex === null) {
    state.stash = state.draft
    state.historyIndex = state.history.length - 1
  } else if (state.historyIndex > 0) {
    state.historyIndex -= 1
  }
  state.draft = state.history[state.historyIndex]
}

/** ↓：前进历史，走到底恢复暂存草稿 */
export function historyNext(sessionId: string): void {
  const state = composerState(sessionId)
  if (state.historyIndex === null) return
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex += 1
    state.draft = state.history[state.historyIndex]
  } else {
    state.historyIndex = null
    state.draft = state.stash
    state.stash = ''
  }
}
