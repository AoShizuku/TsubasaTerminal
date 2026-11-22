<script setup lang="ts">
/**
 * 分栏把手：零宽 flex 项，6px 热区骑在侧栏边线上各吃 3px，
 * 不占布局、不挪 border 的位置。只管指针，不管几何——上下限、写盘都在
 * useUiStore 的 begin/move/endPaneDrag，这里只吐 dx。
 *
 * 焦点纪律（focus-design 实现接缝）：调宽不是"去干别的事"，焦点该在哪还在哪。
 * pointerdown 上 preventDefault 阻止 mousedown 把焦点从 Agent 输入框踢到 body、
 * 也阻止起选区；根元素标 data-keep-focus 让收尾的 click 不触发 App 的回家逻辑。
 *
 * 拖动期间铺一层 fixed 的透明幕布：指针已被捕获、事件不经过它，它只负责让
 * 光标在整个窗口范围内保持 col-resize（光标形状按指针下的元素算，不按捕获目标），
 * 顺带压掉扫过 tab / 主机条目时的 hover 高亮。
 */
import { ref } from 'vue'
import type { PaneSide } from '@shared/layout'

defineProps<{ side: PaneSide }>()

const emit = defineEmits<{
  start: []
  /** 指针相对按下点的横向位移（px），方向含义由调用方按 side 解释 */
  move: [dx: number]
  end: []
  /** 双击：回默认宽 */
  reset: []
}>()

const dragging = ref(false)
let pointerId: number | null = null
let startX = 0

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 || pointerId !== null) return
  ev.preventDefault()
  const el = ev.currentTarget as HTMLElement
  el.setPointerCapture(ev.pointerId)
  pointerId = ev.pointerId
  startX = ev.clientX
  dragging.value = true
  emit('start')
}

function onPointerMove(ev: PointerEvent): void {
  if (ev.pointerId !== pointerId) return
  emit('move', ev.clientX - startX)
}

/** pointerup / pointercancel / lostpointercapture 都走这里，靠 pointerId 幂等 */
function finish(ev: PointerEvent): void {
  if (ev.pointerId !== pointerId) return
  pointerId = null
  dragging.value = false
  emit('end')
}
</script>

<template>
  <div
    class="sash"
    :data-side="side"
    :data-dragging="dragging || undefined"
    :data-testid="`sash-${side}`"
    data-keep-focus
  >
    <div
      class="sash-hit"
      title="拖动调整宽度，双击恢复默认"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="finish"
      @pointercancel="finish"
      @lostpointercapture="finish"
      @dblclick="emit('reset')"
    />
    <div v-if="dragging" class="sash-veil" />
  </div>
</template>
