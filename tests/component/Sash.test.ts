// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Sash from '../../src/renderer/src/components/ui/Sash.vue'

/**
 * 分栏把手：只验指针协议——start / move(dx) / end 的顺序与 dx、双击 reset、
 * pointerdown 被 preventDefault（焦点不动、不起选区）、幕布只在拖动中存在。
 * 几何夹值在 unit（shared/layout），真实的 flex 让位与一次拖拽一次 SIGWINCH 在 e2e。
 * jsdom 没有 pointer capture，setPointerCapture 桩掉并断言它被叫到。
 */

enableAutoUnmount(afterEach)

const capture = vi.fn()
beforeEach(() => {
  Element.prototype.setPointerCapture = capture
})

function pointer(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, ...init })
}

it('emits start → move(dx) → end with dx relative to the press point, capturing the pointer', async () => {
  const wrapper = mount(Sash, { props: { side: 'left' } })
  const hit = wrapper.get('.sash-hit')

  const down = pointer('pointerdown', { clientX: 240 })
  hit.element.dispatchEvent(down)
  expect(down.defaultPrevented).toBe(true)
  expect(capture).toHaveBeenCalledWith(7)
  expect(wrapper.emitted('start')).toHaveLength(1)

  await wrapper.vm.$nextTick()
  expect(wrapper.attributes('data-dragging')).toBe('true')
  expect(wrapper.find('.sash-veil').exists()).toBe(true)

  hit.element.dispatchEvent(pointer('pointermove', { clientX: 300 }))
  hit.element.dispatchEvent(pointer('pointermove', { clientX: 190 }))
  expect(wrapper.emitted('move')).toEqual([[60], [-50]])

  hit.element.dispatchEvent(pointer('pointerup', { clientX: 190 }))
  expect(wrapper.emitted('end')).toHaveLength(1)
  // lostpointercapture 随 pointerup 而来：靠 pointerId 幂等，不重复 end
  hit.element.dispatchEvent(pointer('lostpointercapture', { clientX: 190 }))
  expect(wrapper.emitted('end')).toHaveLength(1)

  await wrapper.vm.$nextTick()
  expect(wrapper.attributes('data-dragging')).toBeUndefined()
  expect(wrapper.find('.sash-veil').exists()).toBe(false)
})

it('ignores non-primary buttons and moves from other pointers', () => {
  const wrapper = mount(Sash, { props: { side: 'right' } })
  const hit = wrapper.get('.sash-hit')

  hit.element.dispatchEvent(pointer('pointerdown', { clientX: 10, button: 2 }))
  expect(wrapper.emitted('start')).toBeUndefined()

  hit.element.dispatchEvent(pointer('pointerdown', { clientX: 10 }))
  hit.element.dispatchEvent(pointer('pointermove', { clientX: 50, pointerId: 99 }))
  expect(wrapper.emitted('move')).toBeUndefined()
  hit.element.dispatchEvent(pointer('pointercancel', { clientX: 50 }))
  expect(wrapper.emitted('end')).toHaveLength(1)
})

it('double click emits reset and the root keeps focus where it was (data-keep-focus)', async () => {
  const wrapper = mount(Sash, { props: { side: 'left' } })
  expect(wrapper.attributes('data-keep-focus')).toBeDefined()
  expect(wrapper.attributes('data-testid')).toBe('sash-left')
  await wrapper.get('.sash-hit').trigger('dblclick')
  expect(wrapper.emitted('reset')).toHaveLength(1)
})
