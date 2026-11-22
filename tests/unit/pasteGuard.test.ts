import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmOptions } from '../../src/renderer/src/lib/confirm'

/**
 * 直通多行粘贴护栏（v0.13.4 引入，v0.13.12 加设置开关与 bracketed paste 放行，
 * v0.13.13 改为应用内确认框）。
 * 判定只看四件事：设置开关、远端 bracketed paste 模式、composer 模式、内容是否含换行。
 */

const state = vi.hoisted(() => ({
  composer: { mode: 'prompt', effectiveInput: 'native' } as {
    mode: string
    effectiveInput: string
  },
  settings: { value: { terminalConfirmMultilinePaste: true } as Record<string, unknown> | null },
  term: {
    modes: { bracketedPasteMode: false },
    paste: vi.fn()
  },
  /** 模拟确认框挂起期间会话被关掉 */
  terminalGone: false
}))

const confirm = vi.hoisted(() => vi.fn<(options: ConfirmOptions) => Promise<boolean>>())

vi.mock('@/composables/useComposerStore', () => ({
  composerState: () => state.composer
}))
vi.mock('@/composables/useSettingsStore', () => ({
  useSettingsStore: () => ({ settings: state.settings })
}))
vi.mock('@/lib/confirm', () => ({
  confirmDialog: (options: ConfirmOptions) => confirm(options)
}))
vi.mock('@/lib/focusManager', () => ({
  focusHome: vi.fn(),
  insertIntoComposer: vi.fn()
}))
vi.mock('@/lib/terminalRegistry', () => ({
  getTerminal: () => (state.terminalGone ? undefined : state.term)
}))

import { pasteToSession } from '../../src/renderer/src/lib/clipboard'

const MULTI = 'echo a\necho b\n'
let clipboardText = MULTI

beforeEach(() => {
  confirm.mockResolvedValue(true)
  clipboardText = MULTI
  state.composer = { mode: 'prompt', effectiveInput: 'native' }
  state.settings.value = { terminalConfirmMultilinePaste: true }
  state.term.modes.bracketedPasteMode = false
  state.terminalGone = false
  vi.stubGlobal('window', {
    api: { clipboard: { readText: async () => clipboardText } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pasteToSession multiline guard', () => {
  it('asks before a multiline paste at a shell line without bracketed paste; cancel writes nothing', async () => {
    confirm.mockResolvedValueOnce(false)
    expect(await pasteToSession('s1')).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].message).toContain('2 行')
    expect(confirm.mock.calls[0][0].detail).toBe('echo a\necho b')
    expect(state.term.paste).not.toHaveBeenCalled()
  })

  it('also asks at none (no shell integration) and pastes after confirming', async () => {
    state.composer.mode = 'none'
    expect(await pasteToSession('s1')).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(state.term.paste).toHaveBeenCalledWith(MULTI)
  })

  it('previews only the first lines and reports how many more follow', async () => {
    clipboardText = Array.from({ length: 7 }, (_, i) => `echo ${i + 1}`).join('\n')
    await pasteToSession('s1')
    expect(confirm.mock.calls[0][0].message).toContain('7 行')
    expect(confirm.mock.calls[0][0].detail).toBe(
      'echo 1\necho 2\necho 3\necho 4\necho 5\n…… 另有 2 行'
    )
  })

  it('writes nothing when the session closed while the confirmation was pending', async () => {
    confirm.mockImplementationOnce(async () => {
      state.terminalGone = true
      return true
    })
    expect(await pasteToSession('s1')).toBe(false)
    expect(state.term.paste).not.toHaveBeenCalled()
  })

  it('skips the question when the remote shell enabled bracketed paste', async () => {
    state.term.modes.bracketedPasteMode = true
    expect(await pasteToSession('s1')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(state.term.paste).toHaveBeenCalledWith(MULTI)
  })

  it('skips the question when the setting is turned off', async () => {
    state.settings.value = { terminalConfirmMultilinePaste: false }
    expect(await pasteToSession('s1')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(state.term.paste).toHaveBeenCalledWith(MULTI)
  })

  it('keeps asking when settings have not loaded yet (fail toward the guard)', async () => {
    state.settings.value = null
    await pasteToSession('s1')
    expect(confirm).toHaveBeenCalledOnce()
  })

  it.each(['running', 'tui'])('never asks while %s (REPL / editor paste is routine)', async (mode) => {
    state.composer.mode = mode
    expect(await pasteToSession('s1')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('never asks for a single line', async () => {
    clipboardText = 'echo single'
    expect(await pasteToSession('s1')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})
