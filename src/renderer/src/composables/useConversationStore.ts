import { ref } from 'vue'
import type {
  AgentEvent,
  AgentResumeConfirm,
  ConversationExportResult,
  ConversationMeta
} from '@shared/types'
import { agentState, foldEvents, TOOL_STATUS_LABEL, type ChatItem } from './useAgentStore'

/**
 * 对话历史渲染态：列表缓存 + 回溯视图。全局单例——历史是跨会话的
 * 一等对象（convId 主键），Agent 面板跟随 active 会话，但回溯查看不属于任何会话；
 * 切 tab 时由面板负责关掉回溯（header 的 select/圆环已是新会话的，主体不能还看着旧的）。
 * v0.10.2 起回溯可"在当前会话继续"（接续/迁移）——活动对话除外。
 */

export const conversationList = ref<ConversationMeta[]>([])
export const reviewMeta = ref<ConversationMeta | null>(null)
export const reviewItems = ref<ChatItem[]>([])
/** 回溯对话的原始事件流：接续时灌回实时消息流 + 重算成本估算都要它 */
export const reviewEvents = ref<AgentEvent[]>([])

export async function refreshConversations(): Promise<void> {
  conversationList.value = await window.api.conversations.list()
}

/** 打开回溯：读 events.jsonl 重放成渲染条目；对话已被清理则返回 false */
export async function openReview(meta: ConversationMeta): Promise<boolean> {
  const events = await window.api.conversations.events(meta.convId)
  if (!events) return false
  reviewEvents.value = events
  reviewItems.value = foldEvents(events)
  reviewMeta.value = meta
  return true
}

export function closeReview(): void {
  reviewMeta.value = null
  reviewItems.value = []
  reviewEvents.value = []
}

// ---------- 接续与迁移 ----------

/** 事件流里最后一次 usage：≈ 恢复后要全量重算的上下文体积（隔夜 cache 必然全失效） */
export function lastUsageOf(
  events: AgentEvent[]
): { inputTokens: number; outputTokens: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'usage') return { inputTokens: e.inputTokens, outputTokens: e.outputTokens }
  }
  return null
}

/**
 * 在当前会话继续该对话：主进程回灌原生消息（同主机接续 / 换主机迁移由主进程判定），
 * 成功后把回溯事件灌进当前会话的实时消息流——看起来就是"接着聊"。
 * 主进程沿用原对话的 profile，本会话的选择器锁到它（v0.13.14 起只动本会话，
 * 不再改全局选择——否则恢复一个对话会把别的 tab 的模型一起带走）。
 * 模型有变化时 ok=false 并带 confirm，调用方问过人后带 accept 重发。
 */
export async function resumeConversation(
  sessionId: string,
  meta: ConversationMeta,
  opts: {
    hostLabel: string
    integrationSeen?: boolean
    accept?: { profileId: string; model: string }
  }
): Promise<{ ok: boolean; error?: string; confirm?: AgentResumeConfirm }> {
  const result = await window.api.agent.resumeConversation(sessionId, meta.convId, opts)
  if (!result.ok) return { ok: false, error: result.error, confirm: result.confirm }
  // 重新读事件流（主进程刚追加了接续/迁移的 notice 接缝行）
  const events = (await window.api.conversations.events(meta.convId)) ?? reviewEvents.value
  const state = agentState(sessionId)
  state.items = foldEvents(events)
  state.lastError = null
  // 圆环恢复旧值：恢复后的上下文体积就是当时的量（下一轮官方 usage 会刷新它）
  const usage = lastUsageOf(events)
  state.usage = usage ? { ...usage, cacheReadTokens: null } : null
  if (result.profileId) {
    state.profileId = result.profileId
    state.boundProfileId = result.profileId
  }
  closeReview()
  await refreshConversations()
  return { ok: true }
}

export async function renameConversation(convId: string, title: string): Promise<void> {
  conversationList.value = await window.api.conversations.rename(convId, title)
  if (reviewMeta.value?.convId === convId) {
    reviewMeta.value = conversationList.value.find((m) => m.convId === convId) ?? reviewMeta.value
  }
}

export async function removeConversation(convId: string): Promise<void> {
  conversationList.value = await window.api.conversations.remove(convId)
  if (reviewMeta.value?.convId === convId && !conversationList.value.some((m) => m.convId === convId)) {
    closeReview()
  }
}

export async function clearConversations(): Promise<void> {
  conversationList.value = await window.api.conversations.clear()
  if (reviewMeta.value && !conversationList.value.some((m) => m.convId === reviewMeta.value?.convId)) {
    closeReview()
  }
}

// ---------- markdown 导出（2.8：排完写故障报告，面板本就是 md 渲染，导出近乎零成本） ----------

export function formatConvTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 条目流 → markdown：assistant 原文保留（本就是模型输出的 md），
 * 用户/工具/标注降级为标题与引用块。thinking 不导出——报告要的是结论与动作，
 * 不是思考过程（面板里仍可折叠查看）。
 *
 * 角色归属靠**显式回合分组**，不靠事件顺序隐式承接：工具行自身不带角色，
 * 在 markdown 里只能从上一个 `##` 标题继承。Agent 若在调工具前没吐可见文本，
 * `## Agent` 就不会出现，整串工具调用会挂到用户名下（OpenAI responses 的纯
 * function_call 轮就没有 output_text；Anthropic 的 preamble 只是习惯不是保证）。
 * 故：user 关掉当前 Agent 回合，assistant/tool 输出前按需补一次标题；
 * 同一回合内多段文本共用一个标题，advisory/notice 是系统提示不触发也不重置。
 */
export function conversationMarkdown(
  meta: ConversationMeta,
  items: ChatItem[],
  hostNames: string[]
): string {
  const lines: string[] = [
    `# ${meta.title}`,
    '',
    `> Tsubasa Terminal 对话导出 · 主机：${hostNames.join('、') || '未知'} · ${formatConvTime(meta.createdAt)} · ${meta.turnCount} 轮`,
    ''
  ]
  let inAgent = false
  const openAgent = (): void => {
    if (inAgent) return
    lines.push('## Agent', '')
    inAgent = true
  }
  for (const item of items) {
    if (item.kind === 'user') {
      inAgent = false
      lines.push('## 用户', '', item.text, '')
      if (item.attachedUnits.length > 0) {
        lines.push(`_附带 ${item.attachedUnits.length} 条命令记录_`, '')
      }
    } else if (item.kind === 'assistant') {
      if (item.text) {
        openAgent()
        lines.push(item.text, '')
      }
    } else if (item.kind === 'tool') {
      openAgent()
      const status = TOOL_STATUS_LABEL[item.status] ?? item.status
      lines.push(
        `> 🔧 **${item.name}** ${item.detail}${item.summary ? ` — ${item.summary}` : ''}（${status}）`,
        ''
      )
    } else if (item.kind === 'advisory') {
      lines.push(`> ⚠️ ${item.text}`, '')
    } else {
      lines.push(`> ${item.text}`, '')
    }
  }
  return lines.join('\n')
}

export function exportConversation(
  meta: ConversationMeta,
  items: ChatItem[],
  hostNames: string[]
): Promise<ConversationExportResult> {
  return window.api.conversations.exportMarkdown(
    meta.convId,
    conversationMarkdown(meta, items, hostNames)
  )
}
