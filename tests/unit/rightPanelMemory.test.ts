import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostConfig } from '../../src/shared/types'

/**
 * 右栏按标签页记忆栏位（useUiStore）：每个会话各记各的、新标签页沿用当前栏、
 * 关会话清记忆、`use` 开的标签页落 CLI 栏、总开关关掉一并退回 Agent，
 * 以及 settings.json 镜像只在显示栏真变时写。
 * App 里跟随活动会话的同步 watch 与 reka-ui 的接线由 e2e（layout / cli）守。
 */

const updateSettings = vi.hoisted(() => vi.fn(async (_patch: Record<string, unknown>) => ({})))
const disconnect = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useSettingsStore', () => ({
  updateSettings,
  useSettingsStore: () => ({ settings: { value: null } })
}))
// closeSession 的其余清理与本用例无关
vi.mock('@/composables/useFileStore', () => ({
  disposeSessionFiles: vi.fn(),
  prefetchSessionFiles: vi.fn()
}))
vi.mock('@/composables/useAgentStore', () => ({ disposeAgentSession: vi.fn() }))
vi.mock('@/composables/useSuggestStore', () => ({
  disposeSuggest: vi.fn(),
  clearSuggestion: vi.fn()
}))
vi.mock('@/lib/remoteContext', () => ({
  disposeRemoteContext: vi.fn(),
  prefetchRemoteContext: vi.fn()
}))
vi.mock('@/lib/transcript', () => ({ noteComposerCommand: vi.fn() }))
vi.mock('@/lib/terminalRegistry', () => ({ getTerminal: () => undefined }))
vi.mock('@/lib/confirm', () => ({ confirmDialog: vi.fn() }))

type UiStoreModule = typeof import('../../src/renderer/src/composables/useUiStore')

let ui: UiStoreModule
let tab: ReturnType<UiStoreModule['useUiStore']>['rightPanelTab']

beforeEach(async () => {
  // 记忆住在模块级：每条用例换一份新模块
  vi.resetModules()
  ui = await import('../../src/renderer/src/composables/useUiStore')
  tab = ui.useUiStore().rightPanelTab
  vi.stubGlobal('window', { api: { ssh: { disconnect } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('右栏按标签页记忆栏位', () => {
  it('新标签页沿用当前栏；各标签页各记各的，切回恢复', () => {
    ui.bindRightPanelSession('A')
    tab.value = 'files'

    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('files')
    tab.value = 'cli'

    ui.bindRightPanelSession('A')
    expect(tab.value).toBe('files')
    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('cli')
  })

  it('程序化切栏（Ctrl+Shift+A）同样记进当前标签页', () => {
    ui.bindRightPanelSession('A')
    tab.value = 'files'
    ui.bindRightPanelSession('B')
    tab.value = 'agent'

    ui.bindRightPanelSession('A')
    expect(tab.value).toBe('files')
  })

  it('没有会话时保持当前栏；忘掉的会话再出现按新标签页处理', () => {
    ui.bindRightPanelSession('A')
    tab.value = 'cli'
    ui.bindRightPanelSession('B')
    tab.value = 'agent'

    ui.forgetRightPanelSession('A')
    ui.bindRightPanelSession(null)
    expect(tab.value).toBe('agent')
    // 无会话时照样能切栏，只是不记在谁名下
    tab.value = 'files'

    ui.bindRightPanelSession('A')
    expect(tab.value).toBe('files')
    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('agent')
  })

  it('指定某标签页的栏：已绑定当场切，未绑定先记、绑定时恢复', () => {
    ui.bindRightPanelSession('A')
    ui.setRightPanelTabFor('B', 'cli')
    expect(tab.value).toBe('agent')

    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('cli')

    ui.setRightPanelTabFor('B', 'files')
    expect(tab.value).toBe('files')
    ui.bindRightPanelSession('A')
    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('files')
  })

  it('CLI 总开关关掉：当前栏与各标签页记着的 CLI 栏一并退回 Agent', () => {
    ui.bindRightPanelSession('A')
    tab.value = 'cli'
    ui.bindRightPanelSession('B')
    tab.value = 'files'
    ui.bindRightPanelSession('C')
    tab.value = 'cli'

    ui.retreatFromCliTab()
    expect(tab.value).toBe('agent')
    ui.bindRightPanelSession('A')
    expect(tab.value).toBe('agent')
    ui.bindRightPanelSession('B')
    expect(tab.value).toBe('files')
  })

  it('settings.json 镜像只在显示栏真变时写', () => {
    ui.bindRightPanelSession('A')
    tab.value = 'files'
    ui.bindRightPanelSession('B')
    tab.value = 'agent'
    updateSettings.mockClear()

    ui.bindRightPanelSession('A')
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings.mock.calls[0][0]).toMatchObject({ rightPanelTab: 'files' })

    // 新标签页沿用、恢复成同一栏、无会话：都不写
    updateSettings.mockClear()
    ui.bindRightPanelSession('C')
    ui.bindRightPanelSession('A')
    ui.bindRightPanelSession(null)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('关闭标签页即清掉它的记忆（closeSession 的清理接线）', async () => {
    const { useAppStore } = await import('../../src/renderer/src/composables/useAppStore')
    const app = useAppStore()
    const id = app.openSession({
      id: 'h1',
      name: 'web1',
      host: '203.0.113.10',
      port: 22,
      username: 'root'
    } as unknown as HostConfig)
    ui.bindRightPanelSession(id)
    tab.value = 'cli'

    app.closeSession(id)
    ui.bindRightPanelSession(null)
    tab.value = 'files'

    // 记忆还在的话这里会恢复成 cli
    ui.bindRightPanelSession(id)
    expect(tab.value).toBe('files')
  })
})
