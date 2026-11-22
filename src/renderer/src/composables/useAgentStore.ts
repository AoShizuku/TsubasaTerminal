import { reactive, ref } from 'vue'
import type {
  AgentEvent,
  AgentScreenPayload,
  AgentSendResult,
  LlmProfile,
  SystemPromptBreakdown
} from '@shared/types'
import {
  clearExecuting,
  disposeApprovals,
  onProposalNew,
  onProposalResolved,
  onTransferProgress,
  onTrustChanged,
  onTrustedExec
} from './useApprovalStore'
import { disposeCliNarration, onCliExec } from './useCliStore'
import { composerState } from './useComposerStore'
import { getTerminal } from '@/lib/terminalRegistry'

/**
 * Agent 渲染态（per-SSH-会话，内存态，关会话即失）：
 * 主进程 loop 推事件流，这里拼装成可渲染的对话条目；
 * 勾选拾取的语义是"随下一条消息附带，发送即消费"（agent-design 第八节）。
 */

export type ChatItem =
  | { kind: 'user'; text: string; attachedUnits: number[] }
  | { kind: 'assistant'; thinking: string; text: string; live: boolean }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      detail: string
      status:
        | 'running'
        | 'ok'
        | 'executed'
        | 'proposed'
        | 'approved'
        | 'denied'
        | 'rejected'
        | 'error'
      summary: string
    }
  | { kind: 'advisory'; text: string }
  | { kind: 'notice'; text: string }

/** token 圆环数据：上轮请求的官方 usage（主进程透传，本地不估算） */
export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
}

export interface AgentSessionState {
  items: ChatItem[]
  busy: boolean
  /** 勾选待附带的转录单元 id */
  attached: number[]
  lastError: string | null
  usage: AgentUsage | null
  /**
   * 本会话的模型选择：会话创建时取"最后一次选择"的快照，此后只随
   * 本会话自己的选择变——别的 tab 换模型不会把这里带走。null = 尚未定（跟随最后一次选择）
   */
  profileId: string | null
  /** 当前对话绑定的 profile（主进程事实的镜像）：非空时选择器锁定，换模型 = 新建对话 */
  boundProfileId: string | null
}

const states = reactive<Record<string, AgentSessionState>>({})

export const llmProfiles = ref<LlmProfile[]>([])
/** 最后一次选择（落 settings）：新会话的默认，不再是全局生效的选择 */
export const activeProfileId = ref<string | null>(null)

export function agentState(sessionId: string): AgentSessionState {
  if (!states[sessionId]) {
    states[sessionId] = {
      items: [],
      busy: false,
      attached: [],
      lastError: null,
      usage: null,
      profileId: activeProfileId.value,
      boundProfileId: null
    }
  }
  return states[sessionId]
}

/** 会话实际生效的 profile：绑定的对话优先，其次本会话的选择，最后跟随最后一次选择 */
export function sessionProfileId(sessionId: string): string | null {
  const state = agentState(sessionId)
  if (state.boundProfileId) return state.boundProfileId
  if (state.profileId && llmProfiles.value.some((p) => p.id === state.profileId)) {
    return state.profileId
  }
  return activeProfileId.value
}

export async function loadLlmProfiles(): Promise<void> {
  llmProfiles.value = await window.api.llm.profiles()
  const settings = await window.api.settings.get()
  activeProfileId.value =
    settings.activeLlmProfileId && llmProfiles.value.some((p) => p.id === settings.activeLlmProfileId)
      ? settings.activeLlmProfileId
      : (llmProfiles.value[0]?.id ?? null)
}

/**
 * 本会话选定模型（只用于没有活动对话时）：同时记为"最后一次选择"，新开的会话跟随它。
 * 有活动对话时的换模型先经 startNewConversation 解绑，调用方负责确认。
 */
export async function selectSessionProfile(sessionId: string, id: string): Promise<void> {
  agentState(sessionId).profileId = id
  activeProfileId.value = id
  await window.api.settings.set({ activeLlmProfileId: id })
}

/**
 * 新建对话（v0.13.14 收进 store）：主进程摘下当前对话指针，渲染态清场并解除
 * 模型锁定。面板的新建按钮与"换模型 = 新建对话"共用这一处。
 */
export async function startNewConversation(sessionId: string): Promise<AgentSendResult> {
  const result = await window.api.agent.newConversation(sessionId)
  if (result.ok) {
    const state = agentState(sessionId)
    state.items = []
    state.usage = null
    state.lastError = null
    state.boundProfileId = null
  }
  return result
}

/** 工具卡状态文案（面板、回溯视图、markdown 导出共用一份口径） */
export const TOOL_STATUS_LABEL: Record<string, string> = {
  running: '执行中…',
  ok: '完成',
  executed: '已执行',
  proposed: '待审批',
  approved: '已批准',
  denied: '已拒绝',
  rejected: '被闸门拒绝',
  error: '出错'
}

/** 流式段落：最后一项若是进行中的 assistant 直接续写，否则开新段 */
function liveAssistant(items: ChatItem[]): Extract<ChatItem, { kind: 'assistant' }> {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant' && last.live) return last
  const item: Extract<ChatItem, { kind: 'assistant' }> = {
    kind: 'assistant',
    thinking: '',
    text: '',
    live: true
  }
  items.push(item)
  return item
}

function sealAssistant(items: ChatItem[]): void {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant' && last.live) last.live = false
}

/**
 * 事件 → 渲染条目的纯拼装（v0.10.1 抽出）：实时流与回溯重放共用同一份逻辑，
 * 落盘时聚合成段的 thinking/text 与逐 token 增量在这里拼出同样的结果。
 * 副作用（busy/usage/审批分发）留在 applyEvent——回放绝不能碰审批台。
 */
export function foldEvent(items: ChatItem[], event: AgentEvent): void {
  switch (event.kind) {
    case 'user':
      items.push({ kind: 'user', text: event.text, attachedUnits: event.attachedUnits })
      break
    case 'thinking':
      liveAssistant(items).thinking += event.text
      break
    case 'text':
      liveAssistant(items).text += event.text
      break
    case 'tool-start':
      sealAssistant(items)
      items.push({
        kind: 'tool',
        toolUseId: event.toolUseId,
        name: event.name,
        detail: event.detail,
        status: 'running',
        summary: ''
      })
      break
    case 'tool-end': {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === 'tool' && item.toolUseId === event.toolUseId) {
          item.status = event.status
          item.summary = event.summary
          break
        }
      }
      break
    }
    case 'advisory':
      items.push({ kind: 'advisory', text: event.text })
      break
    case 'notice':
      items.push({ kind: 'notice', text: event.text })
      break
    case 'turn-end':
      sealAssistant(items)
      if (event.reason === 'error') {
        items.push({ kind: 'notice', text: `出错：${event.error ?? '未知错误'}` })
      } else if (event.reason === 'stopped') {
        items.push({ kind: 'notice', text: '已停止' })
      }
      // round-limit 的暂停说明由主进程 notice 事件下发（v0.8.1 续跑确认）
      break
    default:
      break
  }
}

/** 回溯重放（events.jsonl → 渲染条目）；尾部若缺 turn-end（进行中的对话）手动封段 */
export function foldEvents(events: AgentEvent[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const event of events) foldEvent(items, event)
  sealAssistant(items)
  return items
}

function applyEvent(sessionId: string, event: AgentEvent): void {
  const state = agentState(sessionId)
  switch (event.kind) {
    case 'turn-start':
      state.busy = true
      state.lastError = null
      break
    case 'tool-end':
      // 批准 exec 的结果已回流，composer 的"执行中"指示退场
      clearExecuting(sessionId)
      break
    case 'usage':
      state.usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens
      }
      break
    case 'proposal-new':
      onProposalNew(sessionId, event.proposal)
      break
    case 'proposal-resolved':
      onProposalResolved(sessionId, event.proposalId, event.command, event.decision)
      break
    case 'trust':
      onTrustChanged(sessionId, event.verbs)
      break
    case 'trusted-exec':
      onTrustedExec(sessionId, event.command)
      break
    case 'cli-exec':
      // CLI 意图旁白：不进对话流（foldEvent 忽略），只落 composer 状态行
      onCliExec(sessionId, {
        agent: event.agent,
        command: event.command,
        intent: event.intent,
        exitCode: event.exitCode
      })
      break
    case 'cli-exec-end':
      // CLI bridge 不经过内置 Agent 的 tool-end/turn-end：写 pty 的命令等待收场后
      // 由主进程单独收口。按命令匹配，避免并发时误清另一条正在执行的命令。
      clearExecuting(sessionId, event.command)
      break
    case 'transfer-progress':
      // CLI push 进度：不进对话流（foldEvent 忽略），只落 composer 状态行
      onTransferProgress(sessionId, event.label, event.percent)
      break
    case 'turn-end':
      state.busy = false
      clearExecuting(sessionId)
      if (event.reason === 'error') state.lastError = event.error ?? '未知错误'
      break
    default:
      break
  }
  foldEvent(state.items, event)
}

export async function sendToAgent(
  sessionId: string,
  text: string,
  hostLabel: string
): Promise<{ ok: boolean; error?: string }> {
  const profileId = sessionProfileId(sessionId)
  if (!profileId) return { ok: false, error: '请先在设置中配置模型服务' }
  const state = agentState(sessionId)
  if (state.busy) return { ok: false, error: '上一轮仍在进行' }
  const attachUnitIds = [...state.attached]
  const result = await window.api.agent.send(sessionId, text, {
    profileId,
    attachUnitIds,
    hostLabel,
    // 主机档案注入的转录可用性提示（133;A 是否见过）
    integrationSeen: composerState(sessionId).integrationSeen
  })
  if (result.ok) {
    // 勾选发送即消费
    state.attached = []
    // 发送成功 = 对话已绑定这个 profile（新建或沿用，主进程不再静默换模型）
    state.profileId = profileId
    state.boundProfileId = profileId
  } else if (result.boundProfileId) {
    // 渲染层与主进程脱节（不该发生，但别让它卡死）：以主进程为准拨回选择器
    state.boundProfileId = result.boundProfileId
  }
  return result
}

/**
 * system prompt 分段明细：与 sendToAgent 同一套入参口径——
 * integrationSeen 的事实源在 composer，别让调用方各自去凑。
 */
export function loadSystemPrompt(
  sessionId: string,
  hostLabel: string
): Promise<SystemPromptBreakdown> {
  return window.api.agent.systemPrompt(sessionId, {
    hostLabel,
    integrationSeen: composerState(sessionId).integrationSeen
  })
}

/**
 * 上下文原文查看器（v0.10.0 UI 改版）：原文归中栏（宽度够、只有一条滚动条），
 * 右栏的构成面板只负责"多大、谁写的"。跟 write_file 查看器同一个位置、同一套语义。
 */
export interface ContextViewerState {
  sessionId: string
  title: string
  scope: string
  source: 'code' | 'human' | 'probe'
  text: string
}

const contextViewer = ref<ContextViewerState | null>(null)

export function openContextViewer(view: ContextViewerState): void {
  contextViewer.value = view
}

export function closeContextViewer(): void {
  contextViewer.value = null
}

export function useContextViewer() {
  return { contextViewer }
}

export function stopAgent(sessionId: string): void {
  window.api.agent.stop(sessionId)
}

export function disposeAgentSession(sessionId: string): void {
  window.api.agent.dispose(sessionId)
  delete states[sessionId]
  disposeApprovals(sessionId)
  disposeCliNarration(sessionId)
}

// ---------- 一次性 wiring（App 挂载时调用） ----------

let wired = false

export function initAgentWiring(): void {
  if (wired) return
  wired = true

  window.api.agent.onEvent((sessionId, event) => applyEvent(sessionId, event))

  // read_screen：从 xterm 状态机取当前可视区快照（净化脱敏在主进程出口做）
  window.api.agent.onScreenRequest((requestId, sessionId) => {
    const term = getTerminal(sessionId)
    if (!term) {
      window.api.agent.screenResponse(requestId, null)
      return
    }
    const buffer = term.buffer.active
    const start = Math.max(0, buffer.length - term.rows)
    const lines: string[] = []
    for (let i = start; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    const payload: AgentScreenPayload = {
      text: lines.join('\n'),
      cursorRow: buffer.baseY + buffer.cursorY - start,
      cursorCol: buffer.cursorX,
      bufferType: term.buffer.active === term.buffer.alternate ? 'alternate' : 'normal'
    }
    window.api.agent.screenResponse(requestId, payload)
  })
}
