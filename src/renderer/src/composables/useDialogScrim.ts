import { computed, onScopeDispose, ref, shallowReactive, type ComponentPublicInstance } from 'vue'
import type { ColorScheme } from '@shared/shellPalette'

/** 黑色遮罩的唯一透明度来源，DOM 遮罩与原生窗口按钮使用同一合成参数。 */
export const DIALOG_SCRIM_OPACITY = 0.58
/**
 * 亮色下的遮罩浓度：0.58 的黑幕压在白底上是一整块深灰，弹窗像被扔进暗室；
 * 取姊妹项目浅色遮罩的 0.34（它是 rgba(22,22,28,.34)，我们保持纯黑以便原生按钮预合成）。
 */
export const DIALOG_SCRIM_OPACITY_LIGHT = 0.34

const scheme = ref<ColorScheme>('dark')
/** 明暗由 App.vue 随配色方案下发（applyAppTheme 的派生结果） */
export function setDialogScrimScheme(next: ColorScheme): void {
  scheme.value = next
}
/** 单层遮罩的透明度：Dlg 内联给 CSS，多层叠加与原生预合成都从它算 */
export const dialogScrimBase = computed(() =>
  scheme.value === 'light' ? DIALOG_SCRIM_OPACITY_LIGHT : DIALOG_SCRIM_OPACITY
)

const scrims = shallowReactive(new Set<symbol>())
export const dialogScrimOpacity = computed(() => 1 - (1 - dialogScrimBase.value) ** scrims.size)

/** 跟踪实际挂载的遮罩，而非设置/主机表单等各自的 open 状态。 */
export function useDialogScrim(): (element: Element | ComponentPublicInstance | null) => void {
  const id = Symbol('dialog-scrim')
  onScopeDispose(() => scrims.delete(id))
  return (element) => {
    if (element) scrims.add(id)
    else scrims.delete(id)
  }
}

/** Native overlay 不在 DOM 遮罩下，预合成与网页相同的黑色遮罩；多层按透明度叠加。 */
export function underDialogScrim(hex: string): string {
  if (dialogScrimOpacity.value === 0) return hex
  const remaining = 1 - dialogScrimOpacity.value
  return '#' + [1, 3, 5].map((offset) =>
    Math.round(parseInt(hex.slice(offset, offset + 2), 16) * remaining)
      .toString(16).padStart(2, '0')
  ).join('')
}
