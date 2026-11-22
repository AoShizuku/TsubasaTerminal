// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import TitleBar from '../../src/renderer/src/components/TitleBar.vue'
import Dlg from '../../src/renderer/src/components/ui/Dlg.vue'
import {
  DIALOG_SCRIM_OPACITY,
  DIALOG_SCRIM_OPACITY_LIGHT,
  dialogScrimOpacity,
  setDialogScrimScheme
} from '../../src/renderer/src/composables/useDialogScrim'
import { deriveShell } from '../../src/shared/shellPalette'
import { themeById } from '../../src/shared/terminalThemes'

vi.mock('@/lib/focusManager', () => ({ focusHome: vi.fn() }))

enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())

it('遮罩 CSS 的兜底透明度与 DIALOG_SCRIM_OPACITY 同值', () => {
  // 兜底只防少带变量时遮罩静默变透明；真值仍只在 useDialogScrim 一处，这里守住不漂移
  const css = readFileSync('src/renderer/src/assets/overlay.css', 'utf8')
  expect(css).toContain(`rgb(0 0 0 / var(--scrim-opacity, ${DIALOG_SCRIM_OPACITY}))`)
})

it('原生配色更新失败有反馈，重试成功后清除', async () => {
  const setTitleBarTheme = vi.fn()
    .mockRejectedValueOnce(new Error('native failure'))
    .mockResolvedValue(undefined)
  vi.stubGlobal('api', { window: { platform: 'win32', setTitleBarTheme } })
  const wrapper = mount(TitleBar)
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toContain('未同步')
  await wrapper.get('[role="status"] button').trigger('click')
  await flushPromises()
  expect(setTitleBarTheme).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
})

it('实际遮罩挂载时变暗，多层关闭/卸载不提前恢复，最后一层消失后还原', async () => {
  const setTitleBarTheme = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { window: { platform: 'win32', setTitleBarTheme } })
  mount(TitleBar)
  const first = mount(Dlg, { props: { open: false, title: '第一层' }, attachTo: document.body })
  await flushPromises()
  const palette = deriveShell(themeById('tsubasaterminal').theme)
  const restored = { color: palette.subtle, symbolColor: palette.foreground2, background: palette.background }
  expect(setTitleBarTheme).toHaveBeenLastCalledWith(restored)

  await first.setProps({ open: true })
  await flushPromises()
  expect(document.querySelectorAll('.scrim')).toHaveLength(1)
  const oneLayer = setTitleBarTheme.mock.lastCall![0]
  expect(oneLayer).not.toEqual(restored)

  const second = mount(Dlg, { props: { open: true, title: '第二层' }, attachTo: document.body })
  await flushPromises()
  expect(document.querySelectorAll('.scrim')).toHaveLength(2)
  const twoLayers = setTitleBarTheme.mock.lastCall![0]
  expect(parseInt(twoLayers.color.slice(1), 16)).toBeLessThan(parseInt(oneLayer.color.slice(1), 16))
  expect(parseInt(twoLayers.symbolColor.slice(1), 16)).toBeLessThan(parseInt(oneLayer.symbolColor.slice(1), 16))

  second.unmount()
  await flushPromises()
  expect(document.querySelectorAll('.scrim')).toHaveLength(1)
  expect(setTitleBarTheme).toHaveBeenLastCalledWith(oneLayer)

  await first.setProps({ open: false })
  await flushPromises()
  expect(document.querySelectorAll('.scrim')).toHaveLength(0)
  expect(setTitleBarTheme).toHaveBeenLastCalledWith(restored)
})

it('亮色遮罩更淡：DOM 遮罩与原生按钮预合成取同一个亮色透明度', async () => {
  const setTitleBarTheme = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('api', { window: { platform: 'win32', setTitleBarTheme } })
  setDialogScrimScheme('light')
  try {
    mount(TitleBar)
    mount(Dlg, { props: { open: true, title: '亮色' }, attachTo: document.body })
    await flushPromises()
    const scrim = document.querySelector<HTMLElement>('.scrim')!
    expect(scrim.style.getPropertyValue('--scrim-opacity')).toBe(String(DIALOG_SCRIM_OPACITY_LIGHT))
    expect(dialogScrimOpacity.value).toBeCloseTo(DIALOG_SCRIM_OPACITY_LIGHT)
    // 原生按钮区按 0.34 压暗（不是暗色的 0.58）：取 subtle 的红通道验算
    const palette = deriveShell(themeById('tsubasaterminal').theme)
    const expected = Math.round(parseInt(palette.subtle.slice(1, 3), 16) * (1 - DIALOG_SCRIM_OPACITY_LIGHT))
    expect(parseInt(setTitleBarTheme.mock.lastCall![0].color.slice(1, 3), 16)).toBe(expected)
  } finally {
    setDialogScrimScheme('dark')
  }
})
