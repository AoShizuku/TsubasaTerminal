import { nextTick } from 'vue'
import { composerState } from '@/composables/useComposerStore'
import { getTerminal } from '@/lib/terminalRegistry'

/**
 * 焦点纪律（focus-design 三公理）的执行者：
 * "家"是终端表面——prompt 态为 composer 输入框，其余模式为 xterm。
 * 模式切换在两个接收器间自动移焦，用户无感；离家的表面各自持回程票调 focusHome()。
 */

let composerEl: HTMLTextAreaElement | null = null
let agentInputEl: HTMLElement | null = null
/** native 模式的审批决策输入：仅有提案时挂载，Ctrl+Shift+Y 借焦点 */
let approvalInputEl: HTMLElement | null = null

/**
 * 活动会话由上层注入（v0.12.2 前的整理）。
 *
 * 此前 focusHome() 直接 import useAppStore，与
 * `useAppStore → useAgentStore → useApprovalStore → focusManager` 首尾相接，
 * 构成渲染层唯一一个运行时循环依赖组。四个模块里 useAppStore 持有模块级单例
 * ref，一旦有人把 useAppStore() 提到模块顶层求值，加载顺序就会决定成败——
 * 现在能跑只是因为这一次调用恰好在函数体里。
 *
 * 断法沿用主进程既有的同一套 idiom（conversations 的 setActiveConvIdsProvider、
 * ToolContext.ptyGuard）：下层留注入口，上层在装配时把依赖递进来，
 * 方向由"焦点管理器找 store"翻成"App 告诉焦点管理器当前是谁"。
 */
type ActiveSessionProvider = () => string | null
let activeSessionProvider: ActiveSessionProvider | null = null

export function setActiveSessionProvider(provider: ActiveSessionProvider): void {
  activeSessionProvider = provider
}

export function registerComposer(el: HTMLTextAreaElement): void {
  composerEl = el
}

export function unregisterComposer(el: HTMLTextAreaElement): void {
  if (composerEl === el) composerEl = null
}

export function registerAgentInput(el: HTMLElement): void {
  agentInputEl = el
}

export function unregisterAgentInput(el: HTMLElement): void {
  if (agentInputEl === el) agentInputEl = null
}

export function focusAgentInput(): void {
  agentInputEl?.focus()
}

export function registerApprovalInput(el: HTMLElement): void {
  approvalInputEl = el
}

export function unregisterApprovalInput(el: HTMLElement): void {
  if (approvalInputEl === el) approvalInputEl = null
}

/** Ctrl+Shift+Y（v0.13.4 原生模式恢复）：把焦点显式借给审批决策输入。
 *  无决策输入（fixed 模式 / 无提案）返回 false，调用方不吞键 */
export function focusApprovalInput(): boolean {
  if (!approvalInputEl) return false
  approvalInputEl.focus()
  return true
}

/** 焦点是否停在"家"（composer / xterm / body）——只有这时模式切换才允许自动移焦 */
export function focusInHome(): boolean {
  const el = document.activeElement
  if (!el || el === document.body) return true
  if (el === composerEl) return true
  if (el.closest('.xterm')) return true
  return false
}

/**
 * 往 composer 草稿的光标处插入文本（v0.9.6 粘贴落点）。
 * textarea 的 value 由 v-model 绑着 store，直接写 `el.value` 会被下一次 patch
 * 抹掉——只能改 draft 再把光标补回去（nextTick 等 Vue 把新值写进 DOM）。
 * 焦点不在输入框时（右键点终端粘贴）选区读到的就是末尾，天然追加。
 */
export function insertIntoComposer(sessionId: string, text: string): void {
  const state = composerState(sessionId)
  const el = composerEl
  if (!el) {
    state.draft += text
    return
  }
  const start = el.selectionStart ?? state.draft.length
  const end = el.selectionEnd ?? start
  state.draft = state.draft.slice(0, start) + text + state.draft.slice(end)
  const caret = start + text.length
  el.focus()
  void nextTick(() => el.setSelectionRange(caret, caret))
}

/** 回家（v0.13.4 扩展）：fixed + prompt → composer；native 任意阶段与其余模式 → xterm。
 *  审批决策输入是"借走焦点的任务面"，不算 home */
export function focusHome(): void {
  const sessionId = activeSessionProvider?.() ?? null
  if (!sessionId) return
  const state = composerState(sessionId)
  if (
    state.mode === 'prompt' &&
    state.effectiveInput === 'composer' &&
    composerEl &&
    !composerEl.disabled
  ) {
    composerEl.focus()
    const end = composerEl.value.length
    composerEl.setSelectionRange(end, end)
  } else {
    getTerminal(sessionId)?.focus()
  }
}
