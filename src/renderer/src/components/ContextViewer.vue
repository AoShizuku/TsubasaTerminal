<script setup lang="ts">
import { computed, watch } from 'vue'
import { FileText, X } from 'lucide-vue-next'
import { closeContextViewer, useContextViewer } from '@/composables/useAgentStore'
import { approvalState } from '@/composables/useApprovalStore'
import { composerState } from '@/composables/useComposerStore'
import { cn } from '@/lib/utils'

/**
 * 上下文原文只读查看器（v0.10.0 UI 改版）：system prompt 某一节的全文。
 *
 * 为什么在中栏而不是右栏的弹层里：原文动辄两千多字，塞进 320px 宽的弹层就得
 * 弹层自己滚 + 原文块再滚，两条滚动条并排。这里跟 write_file 查看器同一个位置、
 * 同一套语义（中栏占位、终端 refit 让位、纯显示不做第二个决策面）。
 *
 * **中栏只读位是独占的，这块的优先级最低**：待审批的 write_file 要逐行审阅、
 * TUI 要整屏，两者都直接把它顶掉——终端被挤成一条缝比看不到这段原文严重得多。
 */

const props = defineProps<{ sessionId: string }>()

const { contextViewer } = useContextViewer()

const view = computed(() =>
  contextViewer.value?.sessionId === props.sessionId ? contextViewer.value : null
)

/**
 * 中栏只读位被更该占它的东西占着：待审批的 write_file / save_experience 要逐行
 * 审阅。经验编辑器已改为模态弹窗（v0.13.1 二次返工），不再是这个位置的占用方，
 * 于是**让位链只剩这一档**。
 */
const occupied = computed(() => {
  const kind = approvalState(props.sessionId).current?.kind
  return kind === 'write_file' || kind === 'save_experience'
})

/**
 * TUI 全屏**不是让位链上的一档**（v0.13.1 二次返工）：它压根不占这个插槽——
 * 是整个中栏区暂时归了全屏应用，composer 同样是整体隐藏。把它排进"谁占插槽"
 * 的序里是类型错误，代价就是每个占用方都得自己记得检查它（此前四个里三个漏了）。
 *
 * 所以这里只是**藏起来**：退出 vim 一切恢复原状。被提案顶掉才是真关掉——那时
 * 用户的注意力已经转移，让它自己冒回来是个惊吓。
 */
const tuiHidden = computed(() => composerState(props.sessionId).mode === 'tui')

watch([occupied, view], ([isOccupied, current]) => {
  if (isOccupied && current) closeContextViewer()
})

const lines = computed(() => (view.value?.text ?? '').split('\n').length)

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  code: { label: '代码写的', cls: 'bg-muted text-muted-foreground' },
  human: { label: '你写的', cls: 'bg-primary/15 text-primary' },
  probe: { label: '连接时探测', cls: 'bg-warn/15 text-warn' }
}
</script>

<template>
  <div
    v-if="view && !occupied && !tuiHidden"
    class="flex max-h-[45%] min-h-24 shrink-0 flex-col border-t bg-background"
    data-testid="context-viewer"
  >
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-list">
      <FileText class="i-12 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate font-medium">{{ view.title }}</span>
      <span
        :class="cn('shrink-0 rounded px-1 py-px text-badge', SOURCE_BADGE[view.source].cls)"
      >{{ SOURCE_BADGE[view.source].label }}</span>
      <span class="shrink-0 text-meta text-muted-foreground">
        {{ view.scope }} · {{ lines }} 行 · 进 Agent 的 system prompt
      </span>
      <span class="min-w-0 flex-1" />
      <button
        class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="收起"
        data-testid="context-viewer-close"
        @click="closeContextViewer()"
      >
        <X class="i-16" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <pre
        class="whitespace-pre-wrap break-words px-3 py-2 text-code-body leading-relaxed"
        data-testid="context-viewer-content"
        >{{ view.text }}</pre
      >
    </div>
  </div>
</template>
