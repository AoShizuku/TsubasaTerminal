<script setup lang="ts">
import { computed } from 'vue'
import { BookMarked, X } from 'lucide-vue-next'
import ExperienceFields from './ExperienceFields.vue'
import Sel from './ui/Sel.vue'
import { approvalState, toggleViewer } from '@/composables/useApprovalStore'
import { composerState } from '@/composables/useComposerStore'

/**
 * save_experience 审批查看器：形态复用 write_file 那套（中栏占位、
 * 防盲批、决策仍在 composer），但**理由不同**——write_file 审的是"会不会改坏机器"，
 * 这里审的是"**会不会污染未来所有对话的上下文**"（持久、高权重、每轮生效）。
 * 不碰远端，故无风险圈、无确认词，中性边框。
 *
 * 与 write_file 的另一处不同：**可编辑**。Agent 起草、人改完落盘正是指令通道
 * 铁律要的形态——这里改的是 expEdit 副本，批准时随 approve 回传主进程校验落盘。
 * 字段区自 v0.13.1 与提炼/编辑面板共用 ExperienceFields。
 */

const props = defineProps<{ sessionId: string }>()

const state = computed(() => approvalState(props.sessionId))
const proposal = computed(() => state.value.current)
// TUI 时让位（v0.13.1 二次返工）：理由同 WriteFileViewer
const visible = computed(
  () =>
    proposal.value?.kind === 'save_experience' &&
    state.value.viewerOpen &&
    composerState(props.sessionId).mode !== 'tui'
)
const edit = computed(() => state.value.expEdit)
</script>

<template>
  <div
    v-if="visible && proposal && edit"
    class="flex max-h-[45%] min-h-32 shrink-0 flex-col border-t bg-background ring-1 ring-inset ring-border"
    data-testid="exp-viewer"
  >
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-list">
      <BookMarked class="i-12 shrink-0 text-muted-foreground" />
      <span class="shrink-0 font-medium">存为排障经验</span>
      <span class="min-w-0 truncate text-meta text-muted-foreground">
        内容会进未来所有对话的上下文——可直接修改，批准保存的是修改后的版本
      </span>
      <span class="min-w-0 flex-1" />
      <label class="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
        作用域
        <Sel v-model="edit.scope" data-testid="exp-viewer-scope" class="wf-120 h-6 text-meta">
          <option value="host">仅本机</option>
          <option value="global">所有主机</option>
        </Sel>
      </label>
      <button
        class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="收起（决策在下方输入框：y/n/留言 + Ctrl+Enter）"
        data-testid="exp-viewer-close"
        @click="toggleViewer(sessionId)"
      >
        <X class="i-16" />
      </button>
    </div>
    <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
      <ExperienceFields
        v-model:summary="edit.summary"
        v-model:detail="edit.detail"
        testid="exp-viewer"
      />
    </div>
  </div>
</template>
