// @vitest-environment jsdom

import { nextTick, type Ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliActivity } from '@shared/types'

/**
 * 右栏 CLI 栏的渲染半边（cli-bridge-design 第七节）：主进程按 id 多次推送同一条，
 * 这里守"原位推进不重复开卡、匿名与多机标题如实、空态分清没连接和没记录、
 * 新条目在别的栏时留未读点、看过即清、总开关关掉时栏随之收起"。
 * 主进程推送的序列由 integration 的 cliActivity 守，跨进程接线由 e2e 守。
 */

const ui = vi.hoisted(() => ({}) as { rightPanelTab: Ref<string>; rightPaneOpen: Ref<boolean> })
const app = vi.hoisted(() => ({}) as { activeSessionId: Ref<string | null>; activeSession: Ref<unknown> })
const store = vi.hoisted(() => ({}) as { settings: Ref<{ cliBridgeEnabled: boolean } | null> })

vi.mock('@/composables/useUiStore', async () => {
  const { ref } = await import('vue')
  ui.rightPanelTab = ref('agent')
  ui.rightPaneOpen = ref(true)
  return { useUiStore: () => ui }
})

vi.mock('@/composables/useAppStore', async () => {
  const { computed, ref } = await import('vue')
  app.activeSessionId = ref<string | null>('s1')
  app.activeSession = computed(() => (app.activeSessionId.value ? { id: app.activeSessionId.value } : null))
  return { useAppStore: () => app }
})

vi.mock('@/composables/useSettingsStore', async () => {
  const { ref } = await import('vue')
  store.settings = ref({ cliBridgeEnabled: true })
  return { useSettingsStore: () => store }
})

// 右栏另两栏与本用例无关，换成空壳（它们各自拖着一整串 store）
vi.mock('@/components/panels/AgentPanel.vue', () => ({ default: { name: 'AgentPanel', render: () => null } }))
vi.mock('@/components/panels/FilePanel.vue', () => ({ default: { name: 'FilePanel', render: () => null } }))

enableAutoUnmount(afterEach)

beforeEach(() => {
  vi.resetModules()
  // jsdom 不做布局，也不实现元素滚动；滚底行为留给 e2e
  Element.prototype.scrollTo = () => {}
})

function activity(patch: Partial<CliActivity> = {}): CliActivity {
  return {
    id: 'a1',
    agent: 'cc',
    verb: 'exec',
    detail: 'journalctl -u nginx --since "10 min ago" --no-pager | tail -n 200',
    intent: '看 nginx 最近的报错',
    status: 'running',
    summary: '',
    startedAt: Date.UTC(2026, 10, 23, 6, 0, 0),
    ...patch
  }
}

async function setup() {
  const cli = await import('@/composables/useCliStore')
  const { default: CliPanel } = await import('@/components/panels/CliPanel.vue')
  ui.rightPanelTab.value = 'cli'
  ui.rightPaneOpen.value = true
  app.activeSessionId.value = 's1'
  return { cli, CliPanel }
}

describe('CLI 栏', () => {
  it('同一 id 原位推进，不重复开卡；完整命令与意图都在卡上', async () => {
    const { cli, CliPanel } = await setup()
    const wrapper = mount(CliPanel)
    cli.onCliActivity('s1', activity())
    await nextTick()

    const cards = () => wrapper.findAll('[data-testid="cli-activity-card"]')
    expect(cards()).toHaveLength(1)
    expect(cards()[0].attributes('data-status')).toBe('running')
    expect(cards()[0].text()).toContain('cc · exec')
    expect(cards()[0].text()).toContain('journalctl -u nginx --since "10 min ago" --no-pager | tail -n 200')
    expect(cards()[0].get('[data-testid="cli-activity-intent"]').text()).toBe('看 nginx 最近的报错')

    cli.onCliActivity('s1', activity({ status: 'proposed' }))
    cli.onCliActivity('s1', activity({ status: 'approved', summary: '已批准执行（exit 0）' }))
    await nextTick()
    expect(cards()).toHaveLength(1)
    expect(cards()[0].attributes('data-status')).toBe('approved')
    expect(cards()[0].text()).toContain('已批准')
    expect(cards()[0].text()).toContain('已批准执行（exit 0）')
  })

  it('匿名调用与多机批次的标题如实标注；各会话分列', async () => {
    const { cli, CliPanel } = await setup()
    const wrapper = mount(CliPanel)
    cli.onCliActivity('s1', activity({ id: 'x', agent: null, intent: undefined, status: 'executed' }))
    cli.onCliActivity('s1', activity({ id: 'y', hosts: 3, status: 'withdrawn' }))
    cli.onCliActivity('s2', activity({ id: 'z', detail: 'only-on-s2' }))
    await nextTick()

    const cards = wrapper.findAll('[data-testid="cli-activity-card"]')
    expect(cards.map((c) => c.attributes('data-status'))).toEqual(['executed', 'withdrawn'])
    expect(cards[0].text()).toContain('cli（匿名） · exec')
    expect(cards[0].find('[data-testid="cli-activity-intent"]').exists()).toBe(false)
    expect(cards[1].text()).toContain('cc · exec · 3 台')
    expect(cards[1].text()).toContain('超时撤回')
    expect(wrapper.text()).not.toContain('only-on-s2')

    app.activeSessionId.value = 's2'
    await nextTick()
    expect(wrapper.text()).toContain('only-on-s2')
  })

  it('空态分清"没连接"与"还没有记录"', async () => {
    const { CliPanel } = await setup()
    const wrapper = mount(CliPanel)
    expect(wrapper.get('[data-testid="cli-panel-empty"]').text()).toContain('tsubasa-ssh')

    app.activeSessionId.value = null
    await nextTick()
    expect(wrapper.get('[data-testid="cli-panel-empty"]').text()).toContain('先连接一台主机')
  })

  it('每会话只留最近 CLI_ACTIVITY_LIMIT 条，关会话即清', async () => {
    const { cli } = await setup()
    for (let i = 0; i < cli.CLI_ACTIVITY_LIMIT + 5; i++) {
      cli.onCliActivity('s1', activity({ id: `a${i}` }))
    }
    const list = cli.cliActivities('s1')
    expect(list).toHaveLength(cli.CLI_ACTIVITY_LIMIT)
    expect(list[0].id).toBe('a5')

    cli.disposeCliActivity('s1')
    expect(cli.cliActivities('s1')).toHaveLength(0)
  })
})

describe('右栏的 CLI 标签', () => {
  async function mountRightPanel() {
    const cli = await import('@/composables/useCliStore')
    const { default: RightPanel } = await import('@/components/RightPanel.vue')
    ui.rightPanelTab.value = 'agent'
    ui.rightPaneOpen.value = true
    app.activeSessionId.value = 's1'
    store.settings.value = { cliBridgeEnabled: true }
    return { cli, wrapper: mount(RightPanel) }
  }

  it('跟随 CLI 通道总开关出现与收起；停在 CLI 栏时关掉总开关退回 Agent', async () => {
    const { wrapper } = await mountRightPanel()
    expect(wrapper.find('[data-testid="cli-tab"]').exists()).toBe(true)

    ui.rightPanelTab.value = 'cli'
    store.settings.value = { cliBridgeEnabled: false }
    await nextTick()
    expect(wrapper.find('[data-testid="cli-tab"]').exists()).toBe(false)
    expect(ui.rightPanelTab.value).toBe('agent')
  })

  it('停在别的栏时新条目亮未读点，不替用户切栏；切过去看过即清', async () => {
    const { cli, wrapper } = await mountRightPanel()
    cli.onCliActivity('s1', activity())
    await nextTick()
    expect(wrapper.find('[data-testid="cli-tab-unread"]').exists()).toBe(true)
    expect(ui.rightPanelTab.value).toBe('agent')

    // 已有条目的状态推进不算新消息
    ui.rightPanelTab.value = 'cli'
    await nextTick()
    ui.rightPanelTab.value = 'agent'
    cli.onCliActivity('s1', activity({ status: 'executed' }))
    await nextTick()
    expect(cli.cliUnread('s1')).toBe(false)
    expect(wrapper.find('[data-testid="cli-tab-unread"]').exists()).toBe(false)
  })
})
