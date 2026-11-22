import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { initialWindowChrome, registerWindowChromeHandlers } from '../../../src/main/windowChrome'
import { deriveShell } from '../../../src/shared/shellPalette'
import { themeById } from '../../../src/shared/terminalThemes'
import { TITLE_BAR_HEIGHT } from '../../../src/shared/types'

const state = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  setTitleBarOverlay: vi.fn(),
  setBackgroundColor: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: state.handle },
  BrowserWindow: { fromWebContents: state.fromWebContents }
}))

type Handler = (event: { sender: object }, theme: unknown) => void
let handler: Handler

const VALID = { color: '#25272f', symbolColor: '#A3A8B2', background: '#1c1e25' }

// 真实 ipcMain 对同一 channel 重复 handle 会抛错，这里只注册一次；
// vitest 的 clearMocks 会清空 mock.calls，所以把 handler 引用抓出来而不是每次从 calls 取
beforeAll(() => {
  registerWindowChromeHandlers()
  expect(state.handle).toHaveBeenCalledWith('window:title-bar-theme', expect.any(Function))
  handler = state.handle.mock.calls[0][1]
})

beforeEach(() => {
  state.fromWebContents.mockReturnValue({
    isDestroyed: () => false,
    setTitleBarOverlay: state.setTitleBarOverlay,
    setBackgroundColor: state.setBackgroundColor
  })
})

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

it('合法配色写到 sender 所属窗口，高度取 shared 的单一定义', () => {
  const sender = {}
  withPlatform('win32', () => handler({ sender }, VALID))
  expect(state.fromWebContents).toHaveBeenCalledWith(sender)
  expect(state.setTitleBarOverlay).toHaveBeenCalledTimes(1)
  expect(state.setTitleBarOverlay).toHaveBeenCalledWith({
    color: '#25272f',
    symbolColor: '#A3A8B2',
    height: TITLE_BAR_HEIGHT
  })
  expect(state.setBackgroundColor).toHaveBeenCalledWith('#1c1e25')
})

it('macOS 没有 overlay 配色接口：校验照做、窗口底色照改、不调 overlay', () => {
  withPlatform('darwin', () => {
    expect(() => handler({ sender: {} }, VALID)).not.toThrow()
    expect(() => handler({ sender: {} }, { ...VALID, color: 'red' })).toThrow('标题栏颜色无效')
  })
  expect(state.setTitleBarOverlay).not.toHaveBeenCalled()
  expect(state.setBackgroundColor).toHaveBeenCalledTimes(1)
})

it.each([
  null,
  {},
  { color: 'red', symbolColor: '#ffffff', background: '#000000' },
  { color: '#fff', symbolColor: '#ffffff', background: '#000000' },
  { color: '#000000', symbolColor: 1, background: '#000000' },
  // v0.14.3 起窗口底色同走校验，缺了或格式不对都拒
  { color: '#000000', symbolColor: '#ffffff' },
  { color: '#000000', symbolColor: '#ffffff', background: 'white' }
])('拒绝无效配色 %j，不调用原生窗口接口', (theme) => {
  expect(() => handler({ sender: {} }, theme)).toThrow('标题栏颜色无效')
  expect(state.setTitleBarOverlay).not.toHaveBeenCalled()
  expect(state.setBackgroundColor).not.toHaveBeenCalled()
})

it('调用窗口已关闭时返回失败', () => {
  state.fromWebContents.mockReturnValue(null)
  expect(() => handler({ sender: {} }, VALID)).toThrow('窗口已关闭')
  expect(state.setTitleBarOverlay).not.toHaveBeenCalled()
})

it('窗口已销毁时返回失败', () => {
  state.fromWebContents.mockReturnValue({
    isDestroyed: () => true,
    setTitleBarOverlay: state.setTitleBarOverlay,
    setBackgroundColor: state.setBackgroundColor
  })
  expect(() => handler({ sender: {} }, VALID)).toThrow('窗口已关闭')
  expect(state.setTitleBarOverlay).not.toHaveBeenCalled()
  expect(state.setBackgroundColor).not.toHaveBeenCalled()
})

it('建窗配色按已存方案派生，与渲染层同一套（未知 id 回落默认）', () => {
  const nord = deriveShell(themeById('nord').theme)
  expect(initialWindowChrome('nord')).toEqual({
    backgroundColor: nord.background,
    titleBarOverlay: { color: nord.subtle, symbolColor: nord.foreground2 }
  })
  expect(initialWindowChrome('no-such-scheme').backgroundColor).toBe(
    deriveShell(themeById('tsubasaterminal').theme).background
  )
})
