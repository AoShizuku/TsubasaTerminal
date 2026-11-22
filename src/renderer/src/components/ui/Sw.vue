<script setup lang="ts">
/**
 * 开关。外观自绘（.sw 的伪元素滑块），行为交给 reka-ui：
 * role="switch" / aria-checked / 空格回车键。
 *
 * 它取代设置与主机表单里的原生 `<input type="checkbox">` —— 那些在暗色下靠
 * `accent-primary` 上色、靠 `mt-0.5` 手工对齐，八套主题下的表现全靠运气。
 *
 * e2e 无需改判定方式：Playwright 的 toBeChecked 认 aria 角色白名单，
 * switch 在里面（coreBundle 的 kAriaCheckedRoles）。
 */
import { SwitchRoot } from 'reka-ui'

defineProps<{ disabled?: boolean }>()
const model = defineModel<boolean>({ default: false })
</script>

<template>
  <SwitchRoot v-model="model" :disabled="disabled" class="sw" :class="{ on: model }" />
</template>
