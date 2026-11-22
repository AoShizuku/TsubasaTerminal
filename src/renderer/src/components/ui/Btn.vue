<script setup lang="ts">
/**
 * 按钮。取代 `components/ui/button` —— 那是 shadcn-vue 逐字符复制进
 * 仓库的源码，姊妹项目正因这条分发方式而拒用它（见 doc/tsubasa-alignment.md
 * §4）。这里外观全部走 controls.css 的 .btn 一族，无 cva、无复制件。
 *
 * 变体表与姊妹项目 src/components/ui/Btn.vue 一一对应。图标不做注册表，
 * 直接把 lucide 组件塞进插槽——本仓库已在别处这么用，没必要为两个弹窗另起一套。
 */
import { computed, type HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'danger' | 'ghost'
    size?: 'md' | 'sm'
    /** 只有图标、没有文字时置位；务必同时给 title 或 aria-label */
    iconOnly?: boolean
    active?: boolean
    type?: 'button' | 'submit'
    class?: HTMLAttributes['class']
  }>(),
  { variant: 'default', size: 'md', type: 'button' }
)

const classes = computed(() =>
  cn(
    'btn',
    {
      'btn-primary': props.variant === 'primary',
      'btn-danger': props.variant === 'danger',
      'btn-ghost': props.variant === 'ghost',
      'btn-sm': props.size === 'sm',
      'btn-icon': props.iconOnly,
      'is-on': props.active
    },
    props.class
  )
)
</script>

<template>
  <button :type="type" :class="classes">
    <slot />
  </button>
</template>
