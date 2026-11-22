// @vitest-environment jsdom

import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import { DlgStub } from './stubs'
import ConfirmDlg from '@/components/ui/ConfirmDlg.vue'
import { confirmDialog, settleConfirm } from '@/lib/confirm'

/**
 * 确认框的内容与回执。Dlg 的焦点陷阱 / ESC / 叠放回焦属于真 reka-ui 的
 * 行为，由 e2e 守；这里只看 ConfirmDlg 自己的契约：渲染什么、按钮兑现什么、默认焦点挑谁。
 */

let wrapper: VueWrapper | undefined

function mountDlg(): VueWrapper {
  wrapper = mount(ConfirmDlg, {
    attachTo: document.body,
    global: { stubs: { Dlg: DlgStub } }
  })
  return wrapper
}

/** 模拟 reka-ui 打开时的自动落焦事件，返回它是否被 ConfirmDlg 接管 */
function fireOpenAutoFocus(view: VueWrapper): boolean {
  const ev = new Event('focus.autoFocusOnMount', { cancelable: true })
  view.findComponent(DlgStub).vm.$emit('openAutoFocus', ev)
  return ev.defaultPrevented
}

afterEach(() => {
  settleConfirm(false)
  wrapper?.unmount()
  wrapper = undefined
})

describe('ConfirmDlg', () => {
  it('stays closed until a request arrives, then shows message, detail and custom labels', async () => {
    const view = mountDlg()
    expect(view.find('[data-testid="confirm-dialog"]').exists()).toBe(false)

    void confirmDialog({
      title: '打开外部链接',
      message: '在外部浏览器打开该链接？',
      detail: 'https://example.com/a-very-long-path',
      confirmText: '打开'
    })
    await nextTick()

    expect(view.get('h2').text()).toBe('打开外部链接')
    expect(view.get('[data-testid="confirm-message"]').text()).toBe('在外部浏览器打开该链接？')
    expect(view.get('[data-testid="confirm-detail"]').text()).toBe(
      'https://example.com/a-very-long-path'
    )
    expect(view.get('[data-testid="confirm-ok"]').text()).toBe('打开')
    expect(view.get('[data-testid="confirm-cancel"]').text()).toBe('取消')
  })

  it.each([
    ['confirm-ok', true],
    ['confirm-cancel', false],
    ['confirm-close', false]
  ])('resolves the request through %s and closes', async (testid, expected) => {
    const view = mountDlg()
    const answer = confirmDialog({ title: '清空历史对话', message: '清空？' })
    await nextTick()

    await view.get(`[data-testid="${testid}"]`).trigger('click')
    await expect(answer).resolves.toBe(expected)
    await nextTick()
    expect(view.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('focuses cancel for a dangerous action and confirm otherwise', async () => {
    const view = mountDlg()
    void confirmDialog({ title: '删除主机', message: '删除？', danger: true })
    await nextTick()
    expect(fireOpenAutoFocus(view)).toBe(true)
    expect(document.activeElement).toBe(view.get('[data-testid="confirm-cancel"]').element)
    settleConfirm(false)
    await nextTick()

    void confirmDialog({ title: '确认多行粘贴', message: '粘贴？' })
    await nextTick()
    expect(fireOpenAutoFocus(view)).toBe(true)
    expect(document.activeElement).toBe(view.get('[data-testid="confirm-ok"]').element)
  })

  it('renders a single-button notice when cancelText is null', async () => {
    const view = mountDlg()
    const answer = confirmDialog({
      title: '无法打开链接',
      message: '只支持 http / https 链接。',
      confirmText: '知道了',
      cancelText: null,
      danger: true
    })
    await nextTick()

    expect(view.find('[data-testid="confirm-cancel"]').exists()).toBe(false)
    // 唯一的按钮就是落焦点，danger 也不能把焦点指向不存在的取消
    fireOpenAutoFocus(view)
    expect(document.activeElement).toBe(view.get('[data-testid="confirm-ok"]').element)
    await view.get('[data-testid="confirm-ok"]').trigger('click')
    await expect(answer).resolves.toBe(true)
  })
})
