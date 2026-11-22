<script lang="ts">
/**
 * 对话框外壳。外观自绘（overlay.css 的 .dlg 一族），
 * 焦点陷阱 / ESC 关闭 / 滚动锁定 / aria 交给 reka-ui —— 这几件事自己写十有八九
 * 写不对，此前三个弹窗各自手抄一遍 `Teleport + fixed inset-0 + bg-black/60`，
 * ESC 根本没接。
 *
 * 两处**本仓库特有**、照抄姊妹项目会出事的接缝：
 *
 * 1. `data-modal` 必须挂在 DialogContent 上。App.vue 的 catchStrayKey 靠它豁免
 *    ——没有它，弹窗里敲的每个字符都会被劫回终端。
 * 2. `@close-auto-focus` 必须拦掉。reka-ui 默认把焦点还给触发它的按钮，而本仓库
 *    的焦点纪律是"关掉浮层就回家"（focus-design）：焦点停在设置齿轮上时，
 *    composer 收不到键。拦掉默认行为，改调 focusHome()。
 *    例外是叠放（经验编辑器上的"放弃修改？"）：下层弹窗还开着时回家
 *    会把焦点送进被遮住的终端，这时交还 reka-ui 默认行为，焦点回到下层弹窗里。
 */
/** 跨实例的"当前开着几个弹窗"：叠放时关掉上层不该回家 */
const openDialogs = new Set<symbol>()
</script>

<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { X } from 'lucide-vue-next'
import { focusHome } from '@/lib/focusManager'
import { dialogScrimBase, useDialogScrim } from '@/composables/useDialogScrim'

const scrimRef = useDialogScrim()

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    width?: number
    /** 正在提交时禁止点遮罩/ESC 关闭，避免半途中断写操作 */
    busy?: boolean
    /** 关闭按钮的 testid。默认够用；已有 e2e 依赖旧名字的弹窗把旧名传进来 */
    closeTestid?: string
    /** 压在其他弹窗之上（确认框）：不依赖 Teleport 的挂载先后决定谁在上面 */
    top?: boolean
  }>(),
  { width: 560, closeTestid: 'dlg-close' }
)

/** 默认落焦是第一个可聚焦元素（标题栏的 ✕）；确认框要自己挑按钮 */
const emit = defineEmits<{ openAutoFocus: [ev: Event] }>()

const open = defineModel<boolean>('open', { required: true })

const selfId = Symbol('dlg')

function onCloseAutoFocus(ev: Event): void {
  // open 的 watch 在 patch 前已把自己摘掉，剩下的就是下层弹窗
  if (openDialogs.size > 0) return
  ev.preventDefault()
  focusHome()
}

function onEscapeKeyDown(ev: Event): void {
  if (props.busy) ev.preventDefault()
}

/**
 * ESC 的归属：下拉弹层开着时这一下**归弹层**，不该顺手把整个对话框也关掉。
 *
 * **不能用 `escape-key-down` 里的 `preventDefault()`**。reka-ui 传出来的就是原生
 * KeyboardEvent，它按 `event.defaultPrevented` 决定要不要 dismiss——一 prevent，
 * 浏览器关闭弹层的**默认动作也一起没了**：实测连按三次 ESC，弹层和对话框都不动，
 * 比不修还糟（弹层卡死，只能点别处才关得掉）。
 *
 * 正解是让默认动作照跑、只挡住 reka-ui：它的监听器（VueUse `onKeyStroke`）挂在
 * **window 的冒泡阶段**，所以在 document 冒泡阶段 `stopPropagation()` 就够了——
 * 事件到不了 window，弹层照常关闭。App.vue 的全局键路由挂在 window 的**捕获**
 * 阶段（更早），不受影响。
 *
 * 判据用 `select:open` 而不是 `ev.target`：键盘导航时 target 会在选项间移动。
 */
function guardPickerEscape(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return
  if (!document.querySelector('select:open')) return
  ev.stopPropagation()
}

watch(
  open,
  (value) => {
    if (value) {
      document.addEventListener('keydown', guardPickerEscape)
      openDialogs.add(selfId)
    } else {
      document.removeEventListener('keydown', guardPickerEscape)
      openDialogs.delete(selfId)
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', guardPickerEscape)
  openDialogs.delete(selfId)
})
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay as-child>
        <div
          :ref="scrimRef"
          class="scrim"
          :class="{ 'is-top': top }"
          :style="{ '--scrim-opacity': dialogScrimBase }"
        />
      </DialogOverlay>
      <DialogContent
        class="dlg"
        :class="{ 'is-top': top }"
        data-modal
        :style="{ width: `${width}px` }"
        @interact-outside="busy && $event.preventDefault()"
        @escape-key-down="onEscapeKeyDown"
        @open-auto-focus="emit('openAutoFocus', $event)"
        @close-auto-focus="onCloseAutoFocus"
      >
        <div class="dlg-hd">
          <div class="min-w-0 flex-1">
            <DialogTitle as="h3">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" as="p" class="truncate">
              {{ description }}
            </DialogDescription>
          </div>
          <DialogClose class="btn btn-ghost btn-icon" title="关闭" :data-testid="closeTestid">
            <X class="i-16" />
          </DialogClose>
        </div>

        <slot name="tabs" />

        <div class="dlg-body">
          <slot />
        </div>

        <div v-if="$slots.footer" class="dlg-ft">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
