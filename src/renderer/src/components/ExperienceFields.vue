<script setup lang="ts">
import { computed } from 'vue'
import { EXPERIENCE_DETAIL_LIMIT, EXPERIENCE_SUMMARY_LIMIT } from '@shared/types'

/**
 * 排障经验的字段区（v0.13.1 抽取）：梗概 + 正文 + 字数计数 + 两条软提示。
 *
 * 一条经验有三个人写的时点——Agent 起草后在审批台改（ExperienceViewer，中栏）、
 * 从历史对话提炼补录、事后回头编辑（后两处共用 ExperienceEditor 弹窗）——
 * 字段区三处同形。此前是两份手抄，且**已经漂了**：审批版用 limit 常量、
 * 提炼版硬编码 `maxlength="80"/"4096"`。收成一处，limit 只有一个来源。
 *
 * 三个根节点靠父容器的 flex-col 撑开（正文 `flex-1`），父级必须给确定高度。
 *
 * 软提示都是**软的**：形态与脱敏占位符会影响召回质量与可用性，但决定权在人
 * （knowledge-design 4.2 / 4.5），只有非空与上限是底线校验，在主进程。
 */

defineProps<{
  /** e2e 定位前缀：`<testid>-summary` / `-detail` / `-hint` */
  testid: string
}>()

const summary = defineModel<string>('summary', { required: true })
const detail = defineModel<string>('detail', { required: true })

/** 空梗概不提示（还没写就说形态不对是噪音）——有内容却没箭头才提示 */
const arrowMissing = computed(
  () => summary.value.trim() !== '' && !/→|->/.test(summary.value)
)
/** 提炼原料已过脱敏闸门，占位符会跟着进正文（4.5） */
const hasRedacted = computed(() => (summary.value + detail.value).includes('«REDACTED'))
</script>

<template>
  <div class="shrink-0">
    <div class="mb-0.5 flex items-baseline gap-2 text-meta text-muted-foreground">
      <span>梗概（"症状 → 结论"一句话，是未来对话召回它的钩子）</span>
      <span class="tabular-nums">{{ summary.length }}/{{ EXPERIENCE_SUMMARY_LIMIT }}</span>
    </div>
    <input
      v-model="summary"
      :data-testid="`${testid}-summary`"
      :maxlength="EXPERIENCE_SUMMARY_LIMIT"
      class="input mono"
    />
  </div>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-0.5 flex items-baseline gap-2 text-meta text-muted-foreground">
      <span>正文（症状 / 排查路径 / 真因 / 处置 / 验证）</span>
      <span class="tabular-nums">{{ detail.length }}/{{ EXPERIENCE_DETAIL_LIMIT }}</span>
    </div>
    <textarea
      v-model="detail"
      :data-testid="`${testid}-detail`"
      :maxlength="EXPERIENCE_DETAIL_LIMIT"
      spellcheck="false"
      class="input mono min-h-24 flex-1 resize-none"
    />
  </div>
  <p
    v-if="arrowMissing || hasRedacted"
    class="shrink-0 text-meta leading-relaxed text-warn"
    :data-testid="`${testid}-hint`"
  >
    <template v-if="arrowMissing">梗概建议写成"症状 → 结论"（用 → 连接）——触发词是症状，Agent 才想得起来读。</template>
    <template v-if="hasRedacted">内容含脱敏占位符（«REDACTED:…»），请手工补全或删除该行——占位符存进去下次也读不出真值。</template>
  </p>
</template>
