<script setup lang="ts">
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import type { SystemPromptBreakdown, SystemPromptSection } from '@shared/types'

/**
 * 上下文构成（v0.10.0 UI 改版）：这个对话带了什么背景、谁写的、各占多大。
 *
 * 与 systemPrompt.ts 的分节**不是一一对应**——那边按"改动频率 + prompt cache 前缀"
 * 切六节，是拼装的需要；这边按"用户能不能改它"归行：
 *   - 代码两节（角色纪律 + exec 闸门）合成一行：用户既改不了也不区分
 *   - 人写两节保持分开：作用域不同（全局 / 本机），编辑落点也不同
 *   - 探测一节独立：它会过期，出错时要能一眼指认
 *   - 排障经验索引独立：对话提炼经人确认，pin/删在经验管理里——
 *     "本次注入了哪些经验"必须一眼可见，不可见的上下文注入是调试黑洞
 * 字符数不显示——用户关心的是占多少上下文，不是字符串长度。
 */

const props = defineProps<{
  info: SystemPromptBreakdown
  /** true = 弹层里的紧凑版（对话中回看）；false = 空态展开版（开口之前） */
  dense?: boolean
}>()

const emit = defineEmits<{
  view: [row: Row]
  editGlobal: []
  editHost: []
}>()

interface Row {
  key: string
  title: string
  scope: string
  source: SystemPromptSection['source']
  estTokens: number
  text: string
  /** 人写行才有：点「＋」去哪写 */
  edit?: 'global' | 'host'
}

const SOURCE_LABEL: Record<SystemPromptSection['source'], string> = {
  code: '代码',
  human: '人写',
  probe: '探测'
}

const SOURCE_BADGE: Record<SystemPromptSection['source'], string> = {
  code: 'bg-muted text-muted-foreground',
  human: 'bg-primary/15 text-primary',
  probe: 'bg-warn/15 text-warn'
}

/** 堆叠条的段色：与徽章同色系，条与行能对上 */
const SOURCE_BAR: Record<SystemPromptSection['source'], string> = {
  code: 'bg-muted-foreground/35',
  human: 'bg-primary',
  probe: 'bg-warn'
}

function find(key: string): SystemPromptSection | undefined {
  return props.info.sections.find((s) => s.key === key)
}

const rows = computed<Row[]>(() => {
  const builtin = props.info.sections.filter((s) => s.source === 'code')
  const global = find('global-knowledge')
  const host = find('host-knowledge')
  const profile = find('host-profile')
  const experience = find('experience-index')
  return [
    {
      key: 'builtin',
      title: '内建指令与闸门规则',
      scope: '版本内固定',
      source: 'code',
      estTokens: builtin.reduce((sum, s) => sum + s.estTokens, 0),
      text: builtin.map((s) => s.text).join('\n\n')
    },
    {
      key: 'global-knowledge',
      title: '全局知识',
      scope: '所有主机通用',
      source: 'human',
      estTokens: global?.estTokens ?? 0,
      text: global?.text ?? '',
      edit: 'global'
    },
    {
      key: 'host-knowledge',
      title: '本机知识',
      scope: '仅这台主机',
      source: 'human',
      estTokens: host?.estTokens ?? 0,
      text: host?.text ?? '',
      edit: 'host'
    },
    {
      key: 'host-profile',
      title: '主机档案',
      scope: '连接时探测',
      source: 'probe',
      estTokens: profile?.estTokens ?? 0,
      text: profile?.text ?? ''
    },
    {
      key: 'experience-index',
      title: '排障经验索引',
      scope: '对话提炼 · 你确认',
      source: 'human',
      estTokens: experience?.estTokens ?? 0,
      text: experience?.text ?? ''
    }
  ]
})

const total = computed(() => props.info.totalEstTokens)

/** 空节不占段；总量为 0 时不画条（连不上/没探到，画一条空槽比画错强） */
const bars = computed(() =>
  total.value > 0
    ? rows.value
        .filter((r) => r.estTokens > 0)
        .map((r) => ({ key: r.key, source: r.source, pct: (r.estTokens / total.value) * 100 }))
    : []
)

function onRow(row: Row): void {
  if (row.estTokens > 0) emit('view', row)
  else if (row.edit === 'global') emit('editGlobal')
  else if (row.edit === 'host') emit('editHost')
}
</script>

<template>
  <div :class="dense ? 'space-y-2' : 'space-y-3'" data-testid="context-breakdown">
    <p :class="cn('leading-relaxed tabular-nums text-muted-foreground', dense ? 'text-meta' : 'text-list')">
      <span data-testid="context-breakdown-live">
        {{ info.live ? '这个对话带着' : '下一个对话会带上' }}
      </span>
      <span class="text-foreground" data-testid="context-breakdown-total">
        约 {{ total.toLocaleString() }} tokens
      </span>
      背景（估算）
    </p>

    <!-- 堆叠条：谁占了多大，一眼看完；读 5 个数字自己心算是我们的问题不是用户的 -->
    <div class="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
      <div
        v-for="b in bars"
        :key="b.key"
        :class="SOURCE_BAR[b.source]"
        :style="{ width: `${b.pct}%` }"
        :data-testid="`context-bar-${b.key}`"
      />
    </div>

    <div class="space-y-px">
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        :class="
          cn(
            'flex w-full items-center gap-1.5 rounded px-1 text-left hover:bg-accent',
            dense ? 'py-1 text-meta' : 'py-1.5 text-list',
            row.estTokens === 0 && 'text-muted-foreground'
          )
        "
        :title="row.estTokens > 0 ? `查看全文（${row.scope}）` : '还没写，点这里去写'"
        data-testid="context-row"
        :data-key="row.key"
        :data-source="row.source"
        @click="onRow(row)"
      >
        <span
          :class="cn('shrink-0 rounded px-1 py-px text-badge', SOURCE_BADGE[row.source])"
        >{{ SOURCE_LABEL[row.source] }}</span>
        <span class="min-w-0 flex-1 truncate">{{ row.title }}</span>
        <span
          v-if="row.estTokens > 0"
          class="shrink-0 tabular-nums text-muted-foreground"
          data-testid="context-row-tokens"
        >
          {{ row.estTokens.toLocaleString() }}
        </span>
        <span
          v-else-if="row.edit"
          class="flex shrink-0 items-center gap-0.5 text-muted-foreground/70"
          data-testid="context-row-empty"
        >
          <Plus class="i-12" />未填写
        </span>
        <span v-else class="shrink-0 text-muted-foreground/70">空</span>
      </button>
    </div>

    <!-- 知识改动的提示只在真改过时出现：常驻着就只是每次都要略过的一段字 -->
    <p
      v-if="info.pendingKnowledgeChange"
      :class="cn('leading-relaxed text-warn', dense ? 'text-meta' : 'text-list')"
      data-testid="context-pending-knowledge"
    >
      知识已改动，<b>下一个对话才生效</b>——它在缓存最前缀，中途换等于后续每轮全部重算。
    </p>
  </div>
</template>
