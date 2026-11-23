<script lang="ts">
/** 状态徽标配色档：成功 / 等人 / 被否或出错 / 其余 */
export type ToolTone = 'muted' | 'ok' | 'warn' | 'danger'
</script>

<script setup lang="ts">
import type { Component } from 'vue'
import { Wrench } from 'lucide-vue-next'

/**
 * 工具执行卡：Agent 消息流的工具调用与右栏 CLI 栏的活动条目共用一份外观——
 * 同一件事（一条命令被执行 / 审批）在两处长得一样，用户不用学两套。
 * 状态文案与配色由调用方按各自的状态集映射后传入。
 */

const TONE_CLASS: Record<ToolTone, string> = {
  muted: 'bg-muted text-muted-foreground',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-destructive/15 text-destructive'
}

withDefaults(
  defineProps<{
    title: string
    statusLabel: string
    tone: ToolTone
    /** 命令原文等：等宽、整段换行不截断 */
    detail: string
    summary?: string
    icon?: Component
  }>(),
  { summary: '', icon: () => Wrench }
)
</script>

<template>
  <div class="rounded-md border px-2.5 py-1.5">
    <div class="flex items-center gap-1.5 text-meta">
      <component :is="icon" class="i-12 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate font-mono font-medium">{{ title }}</span>
      <span class="flex-1" />
      <!-- 徽标左侧的附加信息位（CLI 栏放时间） -->
      <slot name="meta" />
      <span :class="['shrink-0 rounded px-1 py-px text-badge', TONE_CLASS[tone]]">
        {{ statusLabel }}
      </span>
    </div>
    <div class="mt-0.5 break-all font-mono text-meta leading-relaxed text-muted-foreground">
      {{ detail }}
    </div>
    <slot />
    <div v-if="summary" class="mt-0.5 break-words text-meta text-muted-foreground">
      {{ summary }}
    </div>
  </div>
</template>
