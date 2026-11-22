<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { copyText, pasteToSession, trimTerminalSelection } from '@/lib/clipboard'
import { focusHome } from '@/lib/focusManager'
import { getTerminal } from '@/lib/terminalRegistry'
import { cn } from '@/lib/utils'

/**
 * 终端右键菜单（Shift+右键唤出）。
 *
 * 自绘而不用 Electron 的 `Menu.popup`：原生菜单 Playwright 点不到，而"提交前
 * e2e 全绿"是硬约定；应用菜单本来也已经 `setApplicationMenu(null)` 收进渲染层。
 * 样式沿用补全面板那套 popover，主题贯穿免费拿到。
 */

const props = defineProps<{ sessionId: string; x: number; y: number }>()
const emit = defineEmits<{ close: [] }>()

/** 贴边翻转用的估值（4 项 + 分隔线）；宽度由 min-w 兜底，超出也只是右缘略近 */
const MENU_W = 200
const MENU_H = 136

const style = computed(() => ({
  left: `${Math.max(4, Math.min(props.x, window.innerWidth - MENU_W - 4))}px`,
  top: `${Math.max(4, Math.min(props.y, window.innerHeight - MENU_H - 4))}px`
}))

/** 选区快照：菜单打开这一刻算一次——"复制"执行完会清掉选区，禁用态不该跟着跳 */
const hasSelection = ref(getTerminal(props.sessionId)?.hasSelection() === true)

function onCopy(): void {
  const term = getTerminal(props.sessionId)
  if (!term?.hasSelection()) return
  void copyText(trimTerminalSelection(term.getSelection()))
  term.clearSelection()
  focusHome()
  emit('close')
}

function onPaste(): void {
  void pasteToSession(props.sessionId)
  emit('close')
}

function onSelectAll(): void {
  getTerminal(props.sessionId)?.selectAll()
  // 不顺手复制：菜单项只做自己那一件事，复制留给下一次右键或 Ctrl+Shift+C。
  // 焦点回家不影响 xterm 选区（自绘的，与 DOM 焦点无关）
  focusHome()
  emit('close')
}

function onClear(): void {
  getTerminal(props.sessionId)?.clear()
  focusHome()
  emit('close')
}

/** 点菜单外关闭；用 capture 抢在 xterm 起新选区之前只是顺带，不阻断那次点击 */
function onOutsideMouseDown(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null
  if (!target?.closest('[data-testid="terminal-context-menu"]')) emit('close')
}

function onEscape(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return
  ev.preventDefault()
  ev.stopPropagation()
  focusHome()
  emit('close')
}

onMounted(() => {
  window.addEventListener('mousedown', onOutsideMouseDown, true)
  window.addEventListener('keydown', onEscape, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onOutsideMouseDown, true)
  window.removeEventListener('keydown', onEscape, true)
})

const ITEM = 'flex w-full items-center justify-between gap-6 rounded-sm px-2 py-1 text-left text-list'
</script>

<template>
  <!-- data-modal 复用 catchStrayKey 的弹窗豁免：菜单开着时按键不该被劫回终端 -->
  <div
    class="fixed z-50 min-w-[180px] rounded-md border bg-popover p-1 shadow-lg"
    :style="style"
    data-testid="terminal-context-menu"
    data-modal
    data-keep-focus
  >
    <button
      :class="cn(ITEM, hasSelection ? 'hover:bg-accent' : 'cursor-default opacity-40')"
      :disabled="!hasSelection"
      data-testid="menu-copy"
      @click="onCopy"
    >
      <span>复制</span>
      <span class="text-badge text-muted-foreground">Ctrl+Shift+C</span>
    </button>
    <button :class="cn(ITEM, 'hover:bg-accent')" data-testid="menu-paste" @click="onPaste">
      <span>粘贴</span>
      <span class="text-badge text-muted-foreground">Ctrl+Shift+V</span>
    </button>
    <div class="my-1 border-t" />
    <button :class="cn(ITEM, 'hover:bg-accent')" data-testid="menu-select-all" @click="onSelectAll">
      <span>全选</span>
    </button>
    <button :class="cn(ITEM, 'hover:bg-accent')" data-testid="menu-clear" @click="onClear">
      <span>清空回滚缓冲</span>
    </button>
  </div>
</template>
