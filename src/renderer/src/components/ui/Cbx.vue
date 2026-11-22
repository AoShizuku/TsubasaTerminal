<script setup lang="ts">
/** 复选框。外观走 .cbx，行为交给 reka-ui。多选清单用它，二元开关用 Sw。 */
import { CheckboxRoot } from 'reka-ui'
import { Check } from 'lucide-vue-next'

defineProps<{ disabled?: boolean }>()
const model = defineModel<boolean>({ default: false })
</script>

<template>
  <CheckboxRoot v-model="model" :disabled="disabled" class="cbx" :class="{ on: model }">
    <Check v-if="model" :size="12" :stroke-width="2.25" />
  </CheckboxRoot>
</template>
