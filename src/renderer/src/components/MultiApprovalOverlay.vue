<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, ShieldAlert, X, XCircle } from 'lucide-vue-next'
import type { MultiProposalTarget } from '@shared/types'
import {
  approveMulti,
  denyMulti,
  dismissMulti,
  multiApprovalState,
  multiRemainingSeconds,
  registerMultiInput,
  unregisterMultiInput
} from '@/composables/useMultiApprovalStore'
import { peekComposerMode, peekWriteStatus } from '@/composables/useComposerStore'
import { useAppStore } from '@/composables/useAppStore'
import { envStyle } from '@/lib/env'
import { focusHome } from '@/lib/focusManager'
import { RISK_STYLE } from '@/lib/risk'
import { cn } from '@/lib/utils'

/**
 * 多机批次浮层（cli-bridge-design 9.5）："一卡罩 N 台"的决策与进度视图。
 *
 * 位置：浮在终端区**顶部**（注意力永远在底部 prompt 附近，顶部是已看过的历史，
 * 盖那里代价最小；放 composer 上方会顶掉当前工作输出）。挂在终端的外层包裹 div
 * （absolute），绝不碰 term.open 的那个元素——FitAddon 按 border-box 算行数，
 * 动它就是网格溢出老坑。全 tab 可见（跨会话单例）：批准 7 台前用户十有八九要挨个
 * 切过去看各台现状，卡只在目标 tab 上就等于逼人盲批。
 *
 * 键盘：浮层内 Ctrl+Enter 才真提交；Esc 按 focusManager 纪律**回家而非拒绝**
 * （拒绝要输 n）。无空批、无 `a` 免问——提示文案天然短一截，本身就是与单机卡的
 * 区分信号。草稿与 Composer 绝不共用。
 */

const state = multiApprovalState()
const { activeSession, activateSession } = useAppStore()

const proposal = computed(() => state.proposal)
const remaining = computed(() => multiRemainingSeconds())

/** 当前 tab 在 TUI 里时自动折叠成一行：目标机不可能在 TUI（ptyGuard 挡着），
 *  但活动 tab 可以是个正在 vim 的非目标机 */
const activeTui = computed(() => {
  const id = activeSession.value?.id
  return id ? peekComposerMode(id) === 'tui' : false
})
const collapsed = computed(() => state.collapsed || activeTui.value)

/** 逐台忙碌（v0.13.4 与单机 canExecuteExec 同一份 write-safe 口径，含 native
 *  半行 dirty 与 none 未声明）：变忙即标红 + 批准键变灰，省掉一次"批了又被
 *  主进程打回"。未建状态视为不可写（fail-closed）。 */
const BUSY_LABEL: Record<string, string> = {
  dirty: '输入行非空',
  running: '命令运行中',
  tui: 'TUI 中',
  'none-unverified': '待确认空提示符'
}

function targetBusyLabel(t: MultiProposalTarget): string | null {
  const status = peekWriteStatus(t.sessionId)
  if (status === 'clean') return null
  return status ? BUSY_LABEL[status] : '状态未知'
}
const anyBusy = computed(() => proposal.value?.targets.some((t) => targetBusyLabel(t) !== null) ?? false)

const doneCount = computed(
  () => Object.values(state.hostStatus).filter((s) => s.done).length
)
const failCount = computed(
  () => Object.values(state.hostStatus).filter((s) => s.done && s.exitCode !== 0).length
)

const keyHint = computed(() => {
  const p = proposal.value
  if (!p) return ''
  if (p.risk === 'high') {
    return `输入「${p.verb}」后 Ctrl+Enter 确认整批执行 · n 拒绝 · 其他文字留言 · Esc 返回终端`
  }
  return 'y 批准整批 · n 拒绝 · 其他文字留言，Ctrl+Enter 提交 · Esc 返回终端'
})

/** 提交语义（9.5）：空 / y / n / 确认词 / 其他文字留言——无空批、无 a */
function submit(): void {
  const p = proposal.value
  if (!p || state.phase !== 'pending') return
  const text = state.draft.trim()
  if (text === '') {
    state.error = `多机批量不支持空输入批准：y 批准 ${p.targets.length} 台 · n 拒绝 · 其他文字留言拒绝`
    return
  }
  state.error = null
  // 成功后的草稿清理由 resolved 事件统一做（批准转执行态清空、拒绝退场清空），
  // 失败时保住已输入的确认词
  if (p.risk === 'high' && text === p.verb) {
    void approveMulti(text)
    return
  }
  if (text === 'y' || text === 'Y') {
    if (p.risk === 'high') {
      state.error = `高危操作需输入「${p.verb}」确认执行`
      return
    }
    void approveMulti()
    return
  }
  if (text === 'n' || text === 'N') {
    void denyMulti()
    return
  }
  void denyMulti(text)
}

function onApproveClick(): void {
  const p = proposal.value
  if (!p) return
  if (p.risk === 'high') {
    const text = state.draft.trim()
    if (text !== p.verb) {
      state.error = `高危操作需输入「${p.verb}」确认执行`
      return
    }
    void approveMulti(text)
    return
  }
  void approveMulti()
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' && ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    submit()
    return
  }
  if (ev.key === 'Escape') {
    ev.preventDefault()
    focusHome()
  }
}

const inputEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (inputEl.value) registerMultiInput(inputEl.value)
})

onBeforeUnmount(() => {
  if (inputEl.value) unregisterMultiInput(inputEl.value)
})

function statusOf(t: MultiProposalTarget): { done: boolean; exitCode: number | null } | null {
  return state.hostStatus[t.sessionId] ?? null
}
</script>

<template>
  <div
    v-if="proposal"
    :class="
      cn(
        'absolute inset-x-2 top-2 z-20 rounded-md border bg-popover/95 shadow-lg backdrop-blur-sm',
        state.phase === 'pending' ? RISK_STYLE[proposal.risk].ring : 'ring-1 ring-inset ring-border'
      )
    "
    data-testid="multi-approval-card"
    :data-phase="state.phase"
    :data-risk="proposal.risk"
    data-keep-focus
  >
    <!-- 标题行：三阶段共用；折叠态只剩这一行 -->
    <div class="flex items-center gap-2 px-2.5 py-1.5 text-list">
      <ShieldAlert v-if="state.phase === 'pending'" class="i-12 shrink-0 text-muted-foreground" />
      <Loader2 v-else-if="state.phase === 'executing'" class="i-12 shrink-0 animate-spin text-info" />
      <CheckCircle2 v-else-if="failCount === 0" class="i-12 shrink-0 text-ok" />
      <XCircle v-else class="i-12 shrink-0 text-destructive" />
      <span class="shrink-0 font-medium" data-testid="multi-approval-summary">
        {{
          state.phase === 'pending'
            ? `${proposal.targets.length} 台待审批`
            : state.phase === 'executing'
              ? `${proposal.targets.length} 台执行中（${doneCount}/${proposal.targets.length}）`
              : `完成 ${doneCount - failCount}/${proposal.targets.length}${failCount ? `（${failCount} 台非零退出）` : ''}`
        }}
      </span>
      <span
        v-if="state.phase === 'pending'"
        :class="cn('shrink-0 rounded px-1 py-px text-badge font-medium', RISK_STYLE[proposal.risk].badge)"
      >{{ RISK_STYLE[proposal.risk].label }}</span>
      <span
        v-if="proposal.background"
        class="shrink-0 rounded bg-muted px-1 py-px text-badge text-muted-foreground"
      >后台化</span>
      <!-- 决策依据不截断：max-h 滚动只兜病态长命令 -->
      <span
        class="max-h-16 min-w-0 flex-1 overflow-y-auto break-all font-mono"
        data-testid="multi-approval-command"
      >{{ proposal.command }}</span>
      <span
        v-if="state.phase === 'pending' && remaining !== null"
        class="shrink-0 tabular-nums text-badge text-muted-foreground"
        data-testid="multi-approval-countdown"
      >剩余 {{ remaining }}s</span>
      <button
        v-if="state.phase !== 'final'"
        class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
        :title="collapsed ? '展开' : '临时收起（不是放弃决策，卡还在）'"
        data-testid="multi-approval-collapse"
        @click="state.collapsed = !state.collapsed"
      >
        <ChevronUp v-if="!collapsed" class="i-16" />
        <ChevronDown v-else class="i-16" />
      </button>
      <button
        v-if="state.phase === 'final'"
        class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
        title="关闭"
        data-testid="multi-approval-close"
        @click="dismissMulti()"
      >
        <X class="i-16" />
      </button>
    </div>

    <template v-if="!collapsed">
      <!-- 目标清单：逐台句柄/别名/环境/root/档位；挂起阶段某台变忙即标红 -->
      <div class="max-h-48 overflow-y-auto border-t px-2.5 py-1">
        <button
          v-for="t in proposal.targets"
          :key="t.sessionId"
          class="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left text-list hover:bg-accent/50"
          data-testid="multi-approval-target"
          :data-session="t.sessionId"
          title="点击切到该会话查看现状"
          @click="activateSession(t.sessionId)"
        >
          <span class="w-16 shrink-0 font-mono text-muted-foreground">{{ t.handle }}</span>
          <span class="min-w-0 truncate font-medium">{{ t.name }}</span>
          <span
            v-if="envStyle(t.envLevel)"
            :class="cn('shrink-0 rounded px-1 py-px text-badge', envStyle(t.envLevel)!.badge)"
          >⚠ {{ envStyle(t.envLevel)!.label }}</span>
          <span
            v-if="t.elevated"
            class="shrink-0 rounded bg-muted px-1 py-px text-badge text-muted-foreground"
          >⚠ root</span>
          <span class="min-w-0 flex-1" />
          <template v-if="state.phase === 'pending'">
            <span
              v-if="targetBusyLabel(t)"
              class="shrink-0 text-meta text-destructive"
              data-testid="multi-approval-busy"
            >{{ targetBusyLabel(t) }}</span>
            <span
              :class="cn('shrink-0 rounded px-1 py-px text-badge', RISK_STYLE[t.risk].badge)"
            >{{ RISK_STYLE[t.risk].label }}</span>
          </template>
          <template v-else>
            <Loader2 v-if="!statusOf(t)?.done" class="i-12 shrink-0 animate-spin text-info" />
            <span
              v-else
              :class="
                cn(
                  'shrink-0 font-mono text-badge',
                  statusOf(t)?.exitCode === 0 ? 'text-ok' : 'text-destructive'
                )
              "
              data-testid="multi-approval-host-exit"
            >{{ statusOf(t)?.exitCode === null ? '未捕获' : `exit ${statusOf(t)?.exitCode}` }}</span>
          </template>
        </button>
      </div>

      <!-- 审批说明 + 输入行：仅挂起阶段。各台按自身 cwd/包装执行的标注在这里 -->
      <div v-if="state.phase === 'pending'" class="border-t px-2.5 py-1.5">
        <p class="mb-1 break-words text-meta leading-relaxed text-muted-foreground">
          {{ proposal.reason }} · 各台按自身当前目录与身份执行；批准动作一次作用于全部
          {{ proposal.targets.length }} 台，不支持部分批准（要拆就留言拒绝，说明先动哪几台）
        </p>
        <div class="flex items-center gap-1.5">
          <input
            ref="inputEl"
            v-model="state.draft"
            data-testid="multi-approval-input"
            :placeholder="proposal.risk === 'high' ? `输入「${proposal.verb}」确认` : 'y / n / 留言…'"
            spellcheck="false"
            class="min-w-0 flex-1 rounded-sm bg-muted/50 px-2 py-1 font-mono text-code outline-none placeholder:text-muted-foreground/50"
            @keydown="onKeydown"
          />
          <button
            :class="
              cn(
                'shrink-0 rounded border px-2 py-0.5 text-meta disabled:opacity-40',
                proposal.risk === 'high'
                  ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                  : 'border-ok/40 text-ok hover:bg-ok/10'
              )
            "
            :disabled="anyBusy"
            :title="anyBusy ? '有目标终端正忙，等它空闲后再批准（all-or-nothing）' : undefined"
            data-testid="multi-approval-approve"
            @click="onApproveClick"
          >
            {{ proposal.risk === 'high' ? '确认执行' : `y 执行 ${proposal.targets.length} 台` }}
          </button>
          <button
            class="shrink-0 rounded border px-2 py-0.5 text-meta text-muted-foreground hover:bg-accent"
            data-testid="multi-approval-deny"
            @click="denyMulti()"
          >
            N 拒绝
          </button>
        </div>
        <p v-if="state.error" class="mt-0.5 text-meta text-destructive" data-testid="multi-approval-error">
          {{ state.error }}
        </p>
        <p v-else-if="anyBusy" class="mt-0.5 text-meta text-warn">
          有目标终端不可写（见逐台红字原因）——整批 all-or-nothing，等它空闲后再批准
        </p>
        <p v-else class="mt-0.5 text-meta text-muted-foreground/60" data-testid="multi-approval-keys">
          {{ keyHint }}
        </p>
      </div>
    </template>
  </div>
</template>
