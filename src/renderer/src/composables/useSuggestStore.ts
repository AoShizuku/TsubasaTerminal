import { reactive } from 'vue'
import type { AgentSuggestion } from '@shared/types'
import { onUnitReported } from '@/lib/transcript'

/**
 * 补全 L3 渲染态（completion-design）：命令结束（单元上报）触发主进程
 * agent:suggest，返回的预测/修复建议在 composer 上以 ghost text 呈现，
 * → 接受。未启用（settings.completionLlmEnabled=false）时主进程直接回
 * null，这里保持安静。用户开始下一条命令即弃。
 */

export interface SuggestState {
  suggestion: AgentSuggestion | null
  /** 竞态令牌：新触发/新命令使旧的在途应答失效 */
  seq: number
}

const states = reactive<Record<string, SuggestState>>({})

export function suggestState(sessionId: string): SuggestState {
  if (!states[sessionId]) {
    states[sessionId] = { suggestion: null, seq: 0 }
  }
  return states[sessionId]
}

/** 用户发送新命令/切模式时清掉旧建议 */
export function clearSuggestion(sessionId: string): void {
  const state = suggestState(sessionId)
  state.suggestion = null
  state.seq += 1
}

export function disposeSuggest(sessionId: string): void {
  delete states[sessionId]
}

let wired = false

/**
 * 触发闸（注入式——不 import useComposerStore：它反向 import 了本模块的
 * clearSuggestion，直接引用就是新环）。App 装配时递入"该会话此刻有没有建议宿主"：
 * native 没有 ghost 展示面、TUI 态 composer 整体隐藏，都不该发请求——
 * 没有展示/接受宿主还烧用户 key 是静默浪费（TUI 空转是此前就有的病，一并治）。
 */
let suggestGate: ((sessionId: string) => boolean) | null = null

export function setSuggestGate(gate: (sessionId: string) => boolean): void {
  suggestGate = gate
}

export function initSuggestWiring(): void {
  if (wired) return
  wired = true
  onUnitReported((sessionId, unit) => {
    // 空回车 / Ctrl+C 中断的空单元不值得打 LLM
    if (!unit.command && !unit.echo.trim()) return
    if (suggestGate && !suggestGate(sessionId)) return
    const state = suggestState(sessionId)
    state.suggestion = null
    const seq = ++state.seq
    void window.api.agent.suggest(sessionId).then((suggestion) => {
      if (!suggestion) return
      const current = states[sessionId]
      if (!current || current.seq !== seq) return
      current.suggestion = suggestion
    })
  })
}
