<script setup lang="ts">
/**
 * 确认框。App 挂唯一一个实例，内容由 lib/confirm 的 confirmDialog 下发。
 *
 * 默认落焦按后果分：危险操作落在「取消」（手滑回车不会误删），其余落在「确认」
 * （与原生 confirm 的回车习惯一致）。✕ / Esc / 点遮罩都算取消。
 * 叠在别的弹窗上时 `top` 保证压在最上面，关闭后焦点回到下层弹窗（见 Dlg）。
 */
import { computed, ref, watch, type ComponentPublicInstance } from 'vue'
import Btn from './Btn.vue'
import Dlg from './Dlg.vue'
import { confirmRequest, settleConfirm, type ConfirmOptions } from '@/lib/confirm'

/** 最近一次请求的内容：摘下请求的那一帧里标题不至于先变空 */
const shown = ref<ConfirmOptions>({ title: '', message: '' })
watch(confirmRequest, (request) => {
  if (request) shown.value = request
})

const open = computed({
  get: () => confirmRequest.value !== null,
  set: (value) => {
    if (!value) settleConfirm(false)
  }
})

const cancelBtn = ref<ComponentPublicInstance | null>(null)
const okBtn = ref<ComponentPublicInstance | null>(null)

function onOpenAutoFocus(ev: Event): void {
  const target = shown.value.danger && shown.value.cancelText !== null ? cancelBtn : okBtn
  const el = target.value?.$el as HTMLElement | undefined
  if (!el) return
  ev.preventDefault()
  el.focus()
}
</script>

<template>
  <Dlg
    v-model:open="open"
    :title="shown.title"
    :width="420"
    top
    close-testid="confirm-close"
    @open-auto-focus="onOpenAutoFocus"
  >
    <div class="confirm-body" data-testid="confirm-dialog">
      <p class="confirm-msg" data-testid="confirm-message">{{ shown.message }}</p>
      <pre v-if="shown.detail" class="confirm-detail" data-testid="confirm-detail">{{ shown.detail }}</pre>
    </div>

    <template #footer>
      <span class="min-w-0 flex-1" />
      <Btn
        v-if="shown.cancelText !== null"
        ref="cancelBtn"
        data-testid="confirm-cancel"
        @click="settleConfirm(false)"
      >
        {{ shown.cancelText ?? '取消' }}
      </Btn>
      <Btn
        ref="okBtn"
        :variant="shown.danger ? 'danger' : 'primary'"
        data-testid="confirm-ok"
        @click="settleConfirm(true)"
      >
        {{ shown.confirmText ?? '确定' }}
      </Btn>
    </template>
  </Dlg>
</template>
