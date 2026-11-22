import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmOptions } from '../../src/renderer/src/lib/confirm'
import type { HostConfig } from '../../src/shared/types'

/**
 * 关闭忙碌会话前确认。
 * 忙碌判定用真实 composer store（mode / stalled 的口径就在那里），
 * 关闭入口用真实 app store；只替换确认框、设置与各 store 的 dispose 副作用。
 */

const state = vi.hoisted(() => ({
  settings: { value: { terminalConfirmCloseBusy: true } as Record<string, unknown> | null }
}))

const confirm = vi.hoisted(() => vi.fn<(options: ConfirmOptions) => Promise<boolean>>())
const disconnect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/confirm', () => ({
  confirmDialog: (options: ConfirmOptions) => confirm(options)
}))
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
  composerState,
  peekCloseBusyReason,
  type TerminalMode
} from '../../src/renderer/src/composables/useComposerStore'
import { useAppStore } from '../../src/renderer/src/composables/useAppStore'

const store = useAppStore()

const HOST = {
  id: 'h1',
  name: 'web-1',
  host: '10.0.0.1',
  port: 22,
  username: 'root'
} as unknown as HostConfig

function openConnected(mode: TerminalMode, stalled = false): string {
  const id = store.openSession(HOST)
  store.sessions.value.find((s) => s.id === id)!.status = 'connected'
  const composer = composerState(id)
  composer.mode = mode
  composer.stalled = stalled
  return id
}

function isOpen(id: string): boolean {
  return store.sessions.value.some((s) => s.id === id)
}

beforeEach(() => {
  confirm.mockReset()
  confirm.mockResolvedValue(true)
  disconnect.mockReset()
  state.settings.value = { terminalConfirmCloseBusy: true }
  vi.stubGlobal('window', { api: { ssh: { disconnect } } })
})

afterEach(() => {
  for (const s of [...store.sessions.value]) store.closeSession(s.id)
  vi.unstubAllGlobals()
})

describe('peekCloseBusyReason', () => {
  it.each([
    ['tui', false, '全屏应用'],
    ['running', false, '有命令正在运行'],
    // stalled 多半已空闲，但关闭不可撤销：照样算忙，文案写"可能"
    ['running', true, '可能有命令仍在运行']
  ] as const)('%s (stalled=%s) is busy', (mode, stalled, text) => {
    const id = openConnected(mode, stalled)
    expect(peekCloseBusyReason(id)).toContain(text)
  })

  it.each(['prompt', 'none'] as const)('%s is not busy (none cannot be judged, so never asks)', (mode) => {
    const id = openConnected(mode)
    expect(peekCloseBusyReason(id)).toBeNull()
  })

  it('does not create composer state for an unknown session', () => {
    expect(peekCloseBusyReason('ghost')).toBeNull()
  })
})

describe('requestCloseSession', () => {
  it('asks before closing a busy session; cancel keeps it connected', async () => {
    const id = openConnected('running')
    confirm.mockResolvedValueOnce(false)

    await store.requestCloseSession(id)

    expect(confirm).toHaveBeenCalledOnce()
    const options = confirm.mock.calls[0][0]
    expect(options.message).toContain('「web-1」有命令正在运行')
    expect(options.danger).toBe(true)
    expect(isOpen(id)).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('closes a busy session after confirming', async () => {
    const id = openConnected('tui')
    await store.requestCloseSession(id)
    expect(confirm).toHaveBeenCalledOnce()
    expect(isOpen(id)).toBe(false)
    expect(disconnect).toHaveBeenCalledWith(id)
  })

  it.each(['prompt', 'none'] as const)('closes an idle (%s) session without asking', async (mode) => {
    const id = openConnected(mode)
    await store.requestCloseSession(id)
    expect(confirm).not.toHaveBeenCalled()
    expect(isOpen(id)).toBe(false)
  })

  it.each(['connecting', 'closed', 'error'] as const)(
    'does not ask for a %s session even if the last mode was running',
    async (status) => {
      const id = openConnected('running')
      store.sessions.value.find((s) => s.id === id)!.status = status
      await store.requestCloseSession(id)
      expect(confirm).not.toHaveBeenCalled()
      expect(isOpen(id)).toBe(false)
    }
  )

  it('closes without asking when the setting is off', async () => {
    state.settings.value = { terminalConfirmCloseBusy: false }
    const id = openConnected('running')
    await store.requestCloseSession(id)
    expect(confirm).not.toHaveBeenCalled()
    expect(isOpen(id)).toBe(false)
  })

  it('keeps asking when settings have not loaded yet (fail toward the guard)', async () => {
    state.settings.value = null
    const id = openConnected('running')
    confirm.mockResolvedValueOnce(false)
    await store.requestCloseSession(id)
    expect(confirm).toHaveBeenCalledOnce()
    expect(isOpen(id)).toBe(true)
  })

  it('is a no-op when the session was already closed while the dialog was open', async () => {
    const id = openConnected('running')
    const other = openConnected('prompt')
    confirm.mockImplementationOnce(async () => {
      store.closeSession(id)
      return true
    })
    await store.requestCloseSession(id)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(isOpen(other)).toBe(true)
  })
})
