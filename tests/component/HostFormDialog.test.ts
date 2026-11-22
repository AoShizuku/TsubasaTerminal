// @vitest-environment jsdom

import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DlgStub, SelStub, SwStub } from './stubs'
import HostFormDialog from '../../src/renderer/src/components/HostFormDialog.vue'

enableAutoUnmount(afterEach)

// global stub 负责本例的 select 行为；模块 mock 避免无关的 customizable-select 模板
// 在测试编译期产生已知的 HTML 嵌套告警。
vi.mock('@/components/ui/Sel.vue', () => ({ default: { name: 'Sel' } }))

async function mountDialog(): Promise<VueWrapper> {
  const wrapper = mount(HostFormDialog, {
    props: { open: false, host: null },
    global: {
      stubs: {
        Dlg: DlgStub,
        Sel: SelStub,
        Sw: SwStub
      }
    }
  })
  // HostFormDialog 的初始化在 false → true 的 watcher 中，复刻应用里的真实打开路径。
  await wrapper.setProps({ open: true })
  return wrapper
}

describe('HostFormDialog', () => {
  test('三页字段互不串台，footer 校验在切页后仍常驻', async () => {
    const wrapper = await mountDialog()

    // 默认常规页：空表单立即说明第一处问题。
    expect(wrapper.find('[data-testid="form-name"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="form-problem"]').text()).toContain('主机地址必填')
    expect(wrapper.get('[data-testid="form-save"]').attributes('disabled')).toBeDefined()

    // 切到会话页，常规字段退出，但 footer 的跨页问题不能消失。
    await wrapper.get('[data-testid="form-tab-session"]').trigger('click')
    expect(wrapper.find('[data-testid="form-name"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-shell-integration"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="form-problem"]').text()).toContain('主机地址必填')

    await wrapper.get('[data-testid="form-elevate"]').setValue(true)
    expect(wrapper.find('[data-testid="form-sudo-password"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="form-tab-session"]').text()).toContain('root')

    // 知识页同样独立；填入内容后 tab 给出状态徽标，footer 仍在原位。
    await wrapper.get('[data-testid="form-tab-knowledge"]').trigger('click')
    expect(wrapper.find('[data-testid="form-shell-integration"]').exists()).toBe(false)
    const knowledge = wrapper.get('[data-testid="form-knowledge"]')
    await knowledge.setValue('日志在 /data/logs')
    expect(wrapper.get('[data-testid="form-tab-knowledge"]').text()).toContain('已写')
    expect(wrapper.get('[data-testid="form-problem"]').text()).toContain('主机地址必填')

    // 回常规页补齐必填项后，问题与禁用态一起解除；其他页的值没有丢。
    await wrapper.get('[data-testid="form-tab-general"]').trigger('click')
    await wrapper.get('[data-testid="form-host"]').setValue('10.9.9.9')
    expect(wrapper.get('[data-testid="form-problem"]').text()).toContain('用户名必填')
    await wrapper.get('[data-testid="form-username"]').setValue('ops')
    expect(wrapper.find('[data-testid="form-problem"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="form-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="form-tab-session"]').trigger('click')
    expect((wrapper.get('[data-testid="form-elevate"]').element as HTMLInputElement).checked).toBe(
      true
    )
    await wrapper.get('[data-testid="form-tab-knowledge"]').trigger('click')
    expect((wrapper.get('[data-testid="form-knowledge"]').element as HTMLTextAreaElement).value).toBe(
      '日志在 /data/logs'
    )
  })

  test('本机输入方式：编辑时回显，跟随全局保存为 undefined、指定值原样带出', async () => {
    const wrapper = mount(HostFormDialog, {
      props: {
        open: false,
        host: {
          id: 'h1',
          name: 'web-1',
          host: '10.0.0.1',
          port: 22,
          username: 'ops',
          authType: 'password',
          inputMode: 'native'
        }
      },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub } }
    })
    await wrapper.setProps({ open: true })
    await wrapper.get('[data-testid="form-tab-session"]').trigger('click')
    const select = wrapper.get('[data-testid="form-input-mode"]')
    expect((select.element as HTMLSelectElement).value).toBe('native')

    await wrapper.get('[data-testid="form-save"]').trigger('click')
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ id: 'h1', inputMode: 'native' })

    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await wrapper.get('[data-testid="form-tab-session"]').trigger('click')
    await wrapper.get('[data-testid="form-input-mode"]').setValue('global')
    await wrapper.get('[data-testid="form-save"]').trigger('click')
    const saved = wrapper.emitted('save')?.[1]?.[0] as Record<string, unknown>
    expect(saved.inputMode).toBeUndefined()
  })

  test('新建主机的输入方式默认跟随全局', async () => {
    const wrapper = await mountDialog()
    await wrapper.get('[data-testid="form-tab-session"]').trigger('click')
    expect((wrapper.get('[data-testid="form-input-mode"]').element as HTMLSelectElement).value).toBe(
      'global'
    )
  })

  test('生产机拒绝空别名、IP 与照抄 host，短别名可以保存', async () => {
    const wrapper = await mountDialog()

    await wrapper.get('[data-testid="form-host"]').setValue('10.1.2.3')
    await wrapper.get('[data-testid="form-username"]').setValue('root')
    await wrapper.get('[data-testid="form-env-level"]').setValue('production')

    expect(wrapper.get('[data-testid="form-alias-problem"]').text()).toContain('必须有一个短别名')
    expect(wrapper.get('[data-testid="form-save"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="form-name"]').setValue('10.9.8.7')
    expect(wrapper.get('[data-testid="form-alias-problem"]').text()).toContain('不能是 IP 地址')

    await wrapper.get('[data-testid="form-name"]').setValue('10.1.2.3')
    expect(wrapper.get('[data-testid="form-alias-problem"]').text()).toContain('不能照抄主机地址')

    await wrapper.get('[data-testid="form-name"]').setValue('cn-prod')
    expect(wrapper.find('[data-testid="form-alias-problem"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="form-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="form-save"]').trigger('click')
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({
      name: 'cn-prod',
      host: '10.1.2.3',
      username: 'root',
      envLevel: 'production'
    })
  })
})
