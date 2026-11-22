<script setup lang="ts">
import { computed } from 'vue'
import { FileText, X } from 'lucide-vue-next'
import { approvalState, toggleViewer } from '@/composables/useApprovalStore'
import { composerState } from '@/composables/useComposerStore'
import { RISK_STYLE } from '@/lib/risk'
import { cn } from '@/lib/utils'

/**
 * write_file 只读查看器：批准的是文件的最终完整状态，必须能逐行审阅。
 * 中栏占位（插在终端与 composer 之间，终端 refit 让位），不覆盖终端输出；
 * 纯显示面——决策仍在 composer（统一交互逻辑，不做第二个输入表面）。
 * 内容永远全文展示不截断（工具层已限 256KB，超限根本到不了这里）。
 */

const props = defineProps<{ sessionId: string }>()

const state = computed(() => approvalState(props.sessionId))
const proposal = computed(() => state.value.current)
/**
 * TUI 时让位（v0.13.1 二次返工）：全屏应用要整屏，而 TUI 态 composer 整体隐藏、
 * **y/n 根本打不了**——此时还挂着一份批不动的查看器纯属挤终端。
 *
 * 这里不再有第二个条件。经验编辑器已改为模态弹窗、退出让位链，连带删掉的还有
 * "藏起来"那档语义——它当初是为省一次点击（收起编辑器不用重开查看器）而设，
 * 代价却是 `toggleViewer` 把没渲染的查看器记成"已查看"，防盲批被绕过。
 */
const visible = computed(
  () =>
    proposal.value?.kind === 'write_file' &&
    state.value.viewerOpen &&
    composerState(props.sessionId).mode !== 'tui'
)

const content = computed(() => proposal.value?.content ?? '')
const lines = computed(() => content.value.split('\n'))
/** 行号列与内容同行高对齐（两个 pre 并排，同一滚动容器） */
const gutter = computed(() => lines.value.map((_, i) => i + 1).join('\n'))

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  return `${(n / 1024).toFixed(1)}KB`
}
</script>

<template>
  <!-- 风险圈与审批卡同色延伸：同属"Agent 的内容"，审批语境贯穿 -->
  <div
    v-if="visible && proposal"
    :class="
      cn(
        'flex max-h-[45%] min-h-24 shrink-0 flex-col border-t bg-background',
        RISK_STYLE[proposal.risk].ring
      )
    "
    data-testid="write-viewer"
  >
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-list">
      <FileText class="i-12 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate font-mono text-code font-medium">{{ proposal.path }}</span>
      <span class="shrink-0 text-meta tabular-nums text-muted-foreground">
        {{
          proposal.exists === true
            ? `覆盖（原 ${proposal.oldSize ?? '?'} 字节）`
            : proposal.exists === false
              ? '新建'
              : '覆盖状态未知'
        }}
        · {{ lines.length }} 行 · {{ formatBytes(content.length) }}
      </span>
      <span
        :class="cn('shrink-0 rounded px-1 py-px text-badge font-medium', RISK_STYLE[proposal.risk].badge)"
      >{{ RISK_STYLE[proposal.risk].label }}</span>
      <span class="min-w-0 flex-1" />
      <button
        class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="收起（决策在下方输入框：y/n/留言 + Ctrl+Enter）"
        data-testid="write-viewer-close"
        @click="toggleViewer(sessionId)"
      >
        <X class="i-16" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="flex min-w-max font-mono text-code-body leading-relaxed">
        <pre
          class="select-none border-r bg-muted/30 px-2 py-1 text-right text-muted-foreground/50"
          data-testid="write-viewer-gutter"
        >{{ gutter }}</pre>
        <pre class="px-2 py-1" data-testid="write-viewer-content">{{ content }}</pre>
      </div>
    </div>
  </div>
</template>
