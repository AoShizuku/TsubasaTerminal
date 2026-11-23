<script setup lang="ts">
import { ref } from 'vue'
import { AlertTriangle, Loader2 } from 'lucide-vue-next'
import ToolCard, { type ToolTone } from './ToolCard.vue'
import { TOOL_STATUS_LABEL, type ChatItem } from '@/composables/useAgentStore'
import { copyText } from '@/lib/clipboard'
import { confirmDialog } from '@/lib/confirm'
import { focusHome } from '@/lib/focusManager'
import { renderMarkdown } from '@/lib/markdown'
import { isWebUrl } from '@shared/url'

/**
 * Agent 消息流渲染（v0.10.1 自 AgentPanel 抽出）：实时对话与历史回溯
 * 是同一套条目、同一套 markup——回溯"看起来就像当时"靠的是共用而不是复刻。
 */

defineProps<{ items: ChatItem[] }>()

type ToolStatus = Extract<ChatItem, { kind: 'tool' }>['status']

function toolTone(status: ToolStatus): ToolTone {
  if (status === 'executed' || status === 'approved') return 'ok'
  if (status === 'proposed') return 'warn'
  if (status === 'rejected' || status === 'denied' || status === 'error') return 'danger'
  return 'muted'
}

// ---------- 消息复制：复制的是 markdown 原文，不是渲染结果 ----------

/**
 * 鼠标选区拿到的是渲染后的纯文本——代码块缩进、列表符号、表格线全丢；
 * 这个按钮给的是模型原样输出的 markdown，贴到别处仍是结构化的。
 */
const copiedIndex = ref<number | null>(null)

async function copyMessage(index: number, text: string): Promise<void> {
  if (!(await copyText(text))) return
  copiedIndex.value = index
  // 回程票：复制按钮是纯鼠标动作，点完焦点立即回家，不停在按钮上吃掉后续按键
  focusHome()
  setTimeout(() => {
    if (copiedIndex.value === index) copiedIndex.value = null
  }, 1500)
}

// ---------- markdown 消费侧：代码块复制 + 链接确认后外开（委托处理 v-html 内容） ----------

function onMarkdownClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null
  if (!target) return
  const copyBtn = target.closest('button[data-md-copy]')
  if (copyBtn) {
    ev.preventDefault()
    const code = copyBtn.parentElement?.querySelector('pre')?.textContent ?? ''
    void copyText(code).then((ok) => {
      if (!ok) return
      copyBtn.textContent = '已复制'
      setTimeout(() => (copyBtn.textContent = '复制'), 1500)
    })
    focusHome()
    return
  }
  const link = target.closest('a[href]')
  if (link) {
    // Agent 文本可能复述被注入的远端内容：链接绝不直接导航，确认后 openExternal
    ev.preventDefault()
    void confirmOpenLink(link.getAttribute('href') ?? '')
  }
}

/**
 * URL 放进 detail 块完整展示（不截断，截成省略号正好方便伪装）。非 http/https
 * 主进程会拒绝，这里提前如实告知，而不是确认之后什么都不发生。
 */
async function confirmOpenLink(url: string): Promise<void> {
  if (!isWebUrl(url)) {
    await confirmDialog({
      title: '无法打开链接',
      message: '出于安全考虑，只能在外部浏览器打开 http / https 链接。',
      detail: url,
      confirmText: '知道了',
      cancelText: null
    })
    return
  }
  const ok = await confirmDialog({
    title: '打开外部链接',
    message: '在外部浏览器打开该链接？',
    detail: url,
    confirmText: '打开'
  })
  if (ok) window.open(url)
}
</script>

<template>
  <template v-for="(item, i) in items" :key="i">
    <div
      v-if="item.kind === 'user'"
      class="group relative ml-6 rounded-md bg-primary/10 px-2.5 py-1.5 text-body leading-relaxed"
      data-testid="agent-user-msg"
    >
      <button
        type="button"
        class="absolute -top-2 right-0 z-10 rounded border bg-card px-1.5 py-0.5 text-badge leading-none text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        data-testid="agent-msg-copy"
        @click="copyMessage(i, item.text)"
      >
        {{ copiedIndex === i ? '已复制' : '复制' }}
      </button>
      {{ item.text }}
      <span v-if="item.attachedUnits.length" class="mt-1 block text-meta text-muted-foreground">
        附带 {{ item.attachedUnits.length }} 条命令记录
      </span>
    </div>

    <div v-else-if="item.kind === 'assistant'" class="space-y-1" data-testid="agent-assistant-msg">
      <details v-if="item.thinking" class="rounded-md border border-dashed px-2 py-1">
        <summary class="cursor-pointer text-meta text-muted-foreground">思考过程</summary>
        <div class="mt-1 whitespace-pre-wrap text-meta leading-relaxed text-muted-foreground">
          {{ item.thinking }}
        </div>
      </details>
      <div
        v-if="item.text || item.live"
        class="group relative rounded-md bg-muted px-2.5 py-1.5 text-body leading-relaxed"
      ><!-- 复制 markdown 原文：选区拿到的是渲染结果，代码块与列表结构会丢 -->
        <button
          v-if="item.text"
          type="button"
          class="absolute -top-2 right-0 z-10 rounded border bg-card px-1.5 py-0.5 text-badge leading-none text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          data-testid="agent-msg-copy"
          @click="copyMessage(i, item.text)"
        >
          {{ copiedIndex === i ? '已复制' : '复制' }}
        </button><!-- md 渲染（html:false，流式期全量重渲）；thinking 折叠区保持纯文本 -->
        <div
          v-if="item.text"
          class="md-body"
          data-testid="agent-md"
          @click="onMarkdownClick"
          v-html="renderMarkdown(item.text)"
        /><Loader2 v-if="item.live && !item.text" class="inline i-12 animate-spin text-muted-foreground" /></div>
    </div>

    <ToolCard
      v-else-if="item.kind === 'tool'"
      :title="item.name"
      :status-label="TOOL_STATUS_LABEL[item.status]"
      :tone="toolTone(item.status)"
      :detail="item.detail"
      :summary="item.summary"
      data-testid="agent-tool-card"
      :data-status="item.status"
    />

    <div
      v-else-if="item.kind === 'advisory'"
      class="flex items-start gap-1.5 rounded-md bg-warn/10 px-2.5 py-1.5 text-meta leading-relaxed text-warn"
      data-testid="agent-advisory"
    >
      <AlertTriangle class="mt-px i-12 shrink-0" />
      <span>{{ item.text }}</span>
    </div>

    <p v-else class="px-1 text-meta text-muted-foreground" data-testid="agent-notice">
      {{ item.text }}
    </p>
  </template>
</template>

<!-- md-body 内容来自 v-html，scoped 作用不到，这里用普通样式块 -->
<style>
.md-body > *:first-child {
  margin-top: 0;
}
.md-body > *:last-child {
  margin-bottom: 0;
}
.md-body p,
.md-body ul,
.md-body ol,
.md-body blockquote,
.md-body table {
  margin: 0.375rem 0;
}
.md-body h1,
.md-body h2,
.md-body h3,
.md-body h4 {
  margin: 0.5rem 0 0.25rem;
  font-weight: 600;
  /* 消息正文是 13，标题上一档 */
  font-size: var(--fs-14);
}
.md-body ul,
.md-body ol {
  padding-left: 1.25rem;
}
.md-body ul {
  list-style: disc;
}
.md-body ol {
  list-style: decimal;
}
.md-body code {
  font-family: var(--ff-mono);
  /* 正文里的等宽：比 13 小半号 */
  font-size: var(--fs-code-body);
  background: color-mix(in oklab, var(--muted-foreground) 15%, transparent);
  border-radius: 0.25rem;
  padding: 0.0625rem 0.25rem;
  word-break: break-all;
}
.md-body .md-code {
  position: relative;
  margin: 0.375rem 0;
}
.md-body .md-code pre {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: color-mix(in oklab, var(--background) 60%, transparent);
  padding: 0.5rem;
}
.md-body .md-code pre code {
  background: none;
  padding: 0;
  word-break: normal;
}
.md-body .md-copy {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  z-index: 1;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: var(--fs-10);
  line-height: 1;
  padding: 0.1875rem 0.375rem;
  opacity: 0;
  transition: opacity 0.15s;
}
.md-body .md-code:hover .md-copy {
  opacity: 1;
}
.md-body .md-copy:hover {
  color: var(--foreground);
}
.md-body a {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-all;
  cursor: pointer;
}
.md-body blockquote {
  border-left: 2px solid var(--border);
  padding-left: 0.5rem;
  color: var(--muted-foreground);
}
.md-body table {
  border-collapse: collapse;
  /* 表格内容同列表层 */
  font-size: var(--fs-12);
}
.md-body th,
.md-body td {
  border: 1px solid var(--border);
  padding: 0.125rem 0.375rem;
}
.md-body hr {
  margin: 0.5rem 0;
  border-color: var(--border);
}
</style>
