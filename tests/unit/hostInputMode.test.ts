import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostConfig, HostInput, TerminalInputMode } from '../../src/shared/types'

/**
 * 本机输入方式。真实 app store 下发 + 真实 composer store 解析与 pending 表；
 * 只替换设置、主机 IPC 与各 store 的 dispose 副作用。
 */

const state = vi.hoisted(() => ({
  settings: { value: { terminalInputMode: 'composer' } as Record<string, unknown> | null },
  hosts: [] as HostConfig[]
}))

vi.mock('@/lib/confirm', () => ({ confirmDialog: vi.fn() }))
vi.mock('@/composables/useSettingsStore', () => ({
  useSettingsStore: () => ({ settings: state.settings })
}))
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

import {
  applyInputPreferenceAll,
  composerState,
  inputOverrideRevision,
  inputPreferenceFromHost
} from '../../src/renderer/src/composables/useComposerStore'
import { useAppStore } from '../../src/renderer/src/composables/useAppStore'

const store = useAppStore()

function host(id: string, inputMode?: TerminalInputMode): HostConfig {
  return { id, name: id, host: '10.0.0.1', port: 22, username: 'root', authType: 'password', inputMode }
}

/** 模拟主进程 hosts:update：替换同 id 的那台，返回整张表 */
function editHost(id: string, inputMode?: TerminalInputMode): Promise<void> {
  return store.updateHost({ ...host(id, inputMode) } as HostInput)
}

/** 会话进入 prompt（effectiveInput 已在首次 composerState 时按偏好起步） */
function openAtPrompt(h: HostConfig): string {
  const id = store.openSession(h)
  const composer = composerState(id)
  composer.mode = 'prompt'
  composer.lineDirty = false
  return id
}

beforeEach(() => {
  state.settings.value = { terminalInputMode: 'composer' }
  state.hosts = [host('a', 'native'), host('b')]
  store.hosts.value = state.hosts.map((h) => ({ ...h }))
  vi.stubGlobal('window', {
    api: {
      ssh: { disconnect: vi.fn(), input: vi.fn() },
      agent: { noteTerminalWriteState: vi.fn() },
      hosts: {
        update: vi.fn(async (input: HostInput) => {
          state.hosts = state.hosts.map((h) =>
            h.id === input.id ? { ...h, inputMode: input.inputMode } : h
          )
          return state.hosts.map((h) => ({ ...h }))
        })
      }
    }
  })
})

afterEach(() => {
  for (const s of [...store.sessions.value]) store.closeSession(s.id)
  vi.unstubAllGlobals()
})

describe('本机输入方式解析', () => {
  it('本机指定优先于全局，开标签首个 effectiveInput 即按本机起步', () => {
    const a = openAtPrompt(store.hosts.value[0])
    const b = openAtPrompt(store.hosts.value[1])
    expect(composerState(a).effectiveInput).toBe('native')
    expect(inputPreferenceFromHost(a)).toBe(true)
    expect(composerState(b).effectiveInput).toBe('composer')
    expect(inputPreferenceFromHost(b)).toBe(false)
  })

  it('改全局只影响跟随全局的会话', () => {
    const a = openAtPrompt(store.hosts.value[0])
    const b = openAtPrompt(store.hosts.value[1])
    state.settings.value = { terminalInputMode: 'native' }
    applyInputPreferenceAll()
    expect(composerState(b).effectiveInput).toBe('native')
    state.settings.value = { terminalInputMode: 'composer' }
    applyInputPreferenceAll()
    expect(composerState(a).effectiveInput).toBe('native')
    expect(composerState(b).effectiveInput).toBe('composer')
  })
})

describe('编辑主机立即下发到已开标签', () => {
  it('同主机的所有标签都换新值，并推动 revision 让 App 重放 pending 表', async () => {
    const a1 = openAtPrompt(store.hosts.value[0])
    const a2 = openAtPrompt(store.hosts.value[0])
    const b = openAtPrompt(store.hosts.value[1])
    const before = inputOverrideRevision()

    await editHost('a', undefined)
    expect(inputOverrideRevision()).toBeGreaterThan(before)
    expect(inputPreferenceFromHost(a1)).toBe(false)
    applyInputPreferenceAll()
    expect(composerState(a1).effectiveInput).toBe('composer')
    expect(composerState(a2).effectiveInput).toBe('composer')
    expect(composerState(b).effectiveInput).toBe('composer')
  })

  it('改的不是输入方式（值没变）不推 revision，App 不会无故落焦', async () => {
    openAtPrompt(store.hosts.value[0])
    const before = inputOverrideRevision()
    await editHost('a', 'native')
    expect(inputOverrideRevision()).toBe(before)
  })

  it('开标签的首次下发不推 revision', () => {
    const before = inputOverrideRevision()
    openAtPrompt(store.hosts.value[0])
    expect(inputOverrideRevision()).toBe(before)
  })

  it('仍守 pending 表：固定栏草稿非空时改成 native 不切、不丢字', async () => {
    const b = openAtPrompt(store.hosts.value[1])
    composerState(b).draft = 'echo half'
    await editHost('b', 'native')
    applyInputPreferenceAll()
    expect(composerState(b).effectiveInput).toBe('composer')
    expect(composerState(b).draft).toBe('echo half')
    expect(composerState(b).inputPendingReason).toContain('原生')
  })

  it('仍守 pending 表：native 半行未提交时改回固定栏不切', async () => {
    const a = openAtPrompt(store.hosts.value[0])
    composerState(a).lineDirty = true
    await editHost('a', 'composer')
    applyInputPreferenceAll()
    expect(composerState(a).effectiveInput).toBe('native')
    expect(composerState(a).inputPendingReason).toContain('固定输入栏')
  })

  it('关标签清掉覆盖，不留残值', () => {
    const a = openAtPrompt(store.hosts.value[0])
    store.closeSession(a)
    expect(inputPreferenceFromHost(a)).toBe(false)
  })
})
