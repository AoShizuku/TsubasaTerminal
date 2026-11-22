<script setup lang="ts" generic="T">
/**
 * 下拉框（v0.13.0 修订）。外观走 controls.css 的 `.input`，行为是原生 `<select>`。
 *
 * **为什么要自备 `<button><selectedcontent>`**——不是为了好看，是因为
 * `appearance: base-select`（main.css 的 base 层用它接管暗色下的弹层反色）把
 * select 变成 flex 容器后，塞进去的匿名文本盒**完全够不着**：
 *
 * - `overflow` 被 UA **硬锁成 `visible`**（实测 hidden / clip / auto / overflow-x
 *   一律回落 visible，连内联样式都压不动）。于是长选项不是省略号而是**整段溢出**，
 *   把设置弹窗撑出一条横向滚动条——字体下拉列的正是系统字体名，
 *   `CaskaydiaCove Nerd Font` 这种长度是常态而非极端。
 * - select 的 `align-items` 是 `normal`（= stretch），匿名盒被拉满控件高，
 *   文字按 `line-height` 贴顶：28px 的框配 18px 行高，**文字比中线高 5px**。
 *
 * 自己给一个 `<button>`，这两件事就都落回作者手里：按钮负责裁剪与居中，
 * `<selectedcontent>` 负责把选中项的内容克隆进来，`::picker-icon`（箭头）
 * 仍是 select 的伪元素、占 flex 的第二格，所以箭头不会被长文字挤掉。
 *
 * `<selectedcontent>` 对 Vue 是未知标签，已在 electron.vite.config.ts 的
 * `isCustomElement` 里放行，否则每次渲染都会警告"Failed to resolve component"。
 * `<button>` 进 select 会触发 Vue 编译器的嵌套告警——它内嵌的白名单还停在
 * select 只认 optgroup/option/hr 的年代（上游 main 分支也没更新），且
 * compileTemplate 把 onWarn 硬编码接管、配置层递不进去，已在
 * electron.vite.config.ts 的 customLogger 出口滤掉这一条已知误报。
 */
defineProps<{ disabled?: boolean }>()
const model = defineModel<T>()
</script>

<template>
  <select v-model="model" class="input" :disabled="disabled">
    <button><selectedcontent /></button>
    <slot />
  </select>
</template>
