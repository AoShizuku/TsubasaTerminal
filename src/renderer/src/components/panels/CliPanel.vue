<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Terminal } from 'lucide-vue-next'
import ToolCard from './ToolCard.vue'
import { useAppStore } from '@/composables/useAppStore'
import { useUiStore } from '@/composables/useUiStore'
import {
  CLI_STATUS_LABEL,
  CLI_STATUS_TONE,
  cliActivities,
  markCliSeen
} from '@/composables/useCliStore'
import type { CliActivity } from '@shared/types'

/**
 * 右栏 CLI 栏（cli-bridge-design 第七节）：当前会话里外部 agent 经 tsubasa-ssh 发起的
 * exec / push，一条一张卡，外观与 Agent 工具卡同一份。只读投影，不提供任何操作——
 * 审批仍在 composer 的审批台里做。
 */

const { activeSession, activeSessionId } = useAppStore()
const { rightPanelTab, rightPaneOpen } = useUiStore()

const scrollEl = ref<HTMLDivElement | null>(null)
const items = computed(() => cliActivities(activeSessionId.value))
const visible = computed(() => rightPanelTab.value === 'cli' && rightPaneOpen.value)

function titleOf(a: CliActivity): string {
  const who = a.agent ?? 'cli（匿名）'
  return `${who} · ${a.verb}${a.hosts ? ` · ${a.hosts} 台` : ''}`
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTo({ top: el.scrollHeight })
  })
}

// 新条目或状态推进：贴底时跟随，用户上翻在看时不拽回去
watch(
  items,
  () => {
    if (visible.value) markCliSeen(activeSessionId.value)
    const el = scrollEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) scrollToBottom()
  },
  { deep: true }
)

// 切到本栏 / 切会话：隐藏期间量不到高度，显示出来时直接落到最新一条
watch(
  [visible, activeSessionId],
  ([shown]) => {
    if (!shown) return
    markCliSeen(activeSessionId.value)
    scrollToBottom()
  },
  { immediate: true }
)
</script>

<template>
  <div ref="scrollEl" class="h-full space-y-2 overflow-y-auto p-3" data-testid="cli-panel">
    <template v-if="activeSession && items.length > 0">
      <ToolCard
        v-for="a in items"
        :key="a.id"
        :icon="Terminal"
        :title="titleOf(a)"
        :status-label="CLI_STATUS_LABEL[a.status]"
        :tone="CLI_STATUS_TONE[a.status]"
        :detail="a.detail"
        :summary="a.summary"
        data-testid="cli-activity-card"
        :data-status="a.status"
      >
        <template #meta>
          <span class="shrink-0 tabular-nums text-muted-foreground/70">{{ timeOf(a.startedAt) }}</span>
        </template>
        <div
          v-if="a.intent"
          class="mt-0.5 break-words text-meta leading-relaxed"
          data-testid="cli-activity-intent"
        >
          {{ a.intent }}
        </div>
      </ToolCard>
    </template>

    <div
      v-else
      class="flex h-full flex-col items-center justify-center gap-3 p-4 text-center"
      data-testid="cli-panel-empty"
    >
      <Terminal class="i-20 text-muted-foreground/40" />
      <p class="text-list leading-relaxed text-muted-foreground">
        {{ activeSession ? '外部 agent 经 tsubasa-ssh 在本会话执行的命令会列在这里' : '先连接一台主机' }}
      </p>
    </div>
  </div>
</template>
