import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANE_DEFAULT_WIDTH, PANE_MAX_WIDTH, PANE_MIN_WIDTH } from '../../../src/shared/layout'
import type { AppSettings } from '../../../src/shared/types'

type IpcHandler = (...args: any[]) => any

const state = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, IpcHandler>(),
  syncHandlers: new Map<string, IpcHandler>(),
  /** 每次 writeFile 的 [开始, 结束] 序号，断言串行化用 */
  writeLog: [] as Array<{ start: number; end: number }>,
  /** 下一次 writeFile 人为拖慢的毫秒数（队列，按调用顺序消费） */
  writeDelays: [] as number[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => state.handlers.set(channel, handler),
    on: (channel: string, handler: IpcHandler) => state.syncHandlers.set(channel, handler)
  }
}))

// 只包 promises.writeFile：记录起止顺序并可注入延迟，其余走真实 fs
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  let seq = 0
  return {
    ...actual,
    promises: {
      ...actual.promises,
      writeFile: async (...args: Parameters<typeof actual.promises.writeFile>) => {
        const entry = { start: ++seq, end: 0 }
        state.writeLog.push(entry)
        const delay = state.writeDelays.shift() ?? 0
        if (delay) await new Promise((r) => setTimeout(r, delay))
        await actual.promises.writeFile(...args)
        entry.end = ++seq
      }
    }
  }
})

let userDataDir: string

async function boot(seed?: Partial<AppSettings>): Promise<typeof import('../../../src/main/settings')> {
  if (seed) writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(seed), 'utf-8')
  const mod = await import('../../../src/main/settings')
  mod.registerSettingsHandlers()
  return mod
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf-8'))
}

function set(patch: Record<string, unknown>): Promise<AppSettings> {
  return state.handlers.get('settings:set')!({}, patch)
}

beforeEach(() => {
  vi.resetModules()
  state.handlers.clear()
  state.syncHandlers.clear()
  state.writeLog.length = 0
  state.writeDelays.length = 0
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-settings-test-'))
  state.userDataDir = userDataDir
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('layout fields in settings:set (v0.13.11)', () => {
  it('accepts booleans, clamps widths to shared bounds and persists the result', async () => {
    await boot()
    const next = await set({
      leftPaneOpen: false,
      rightPaneOpen: false,
      leftPaneWidth: 320.4,
      rightPaneWidth: 5,
      rightPanelTab: 'files'
    })
    expect(next.leftPaneOpen).toBe(false)
    expect(next.rightPaneOpen).toBe(false)
    expect(next.leftPaneWidth).toBe(320)
    expect(next.rightPaneWidth).toBe(PANE_MIN_WIDTH.right)
    expect(next.rightPanelTab).toBe('files')
    expect(onDisk()).toMatchObject({
      leftPaneOpen: false,
      rightPaneOpen: false,
      leftPaneWidth: 320,
      rightPaneWidth: PANE_MIN_WIDTH.right,
      rightPanelTab: 'files'
    })
  })

  it('ignores garbage and keeps the current value field by field', async () => {
    await boot({ leftPaneWidth: 300, rightPanelTab: 'files' })
    const next = await set({
      leftPaneOpen: 'no',
      leftPaneWidth: '999',
      rightPaneWidth: Number.NaN,
      rightPanelTab: 'settings'
    })
    expect(next.leftPaneOpen).toBe(true)
    expect(next.leftPaneWidth).toBe(300)
    expect(next.rightPaneWidth).toBe(PANE_DEFAULT_WIDTH.right)
    expect(next.rightPanelTab).toBe('files')
  })

  it('caps absurd widths at PANE_MAX_WIDTH', async () => {
    await boot()
    const next = await set({ leftPaneWidth: 1e9 })
    expect(next.leftPaneWidth).toBe(PANE_MAX_WIDTH)
  })
})

describe('terminalConfirmCloseBusy (v0.13.18)', () => {
  it('defaults to on for an old settings.json that lacks the field', async () => {
    const mod = await boot({ terminalTheme: 'dracula' })
    expect((await mod.loadSettings()).terminalConfirmCloseBusy).toBe(true)
  })

  it('persists a boolean and ignores non-boolean patches', async () => {
    await boot()
    expect((await set({ terminalConfirmCloseBusy: false })).terminalConfirmCloseBusy).toBe(false)
    expect(onDisk()).toMatchObject({ terminalConfirmCloseBusy: false })
    expect((await set({ terminalConfirmCloseBusy: 'yes' })).terminalConfirmCloseBusy).toBe(false)
  })
})

describe('retired terminal theme (v0.14.0)', () => {
  it('rewrites a stored solarized-dark to the default scheme on load and persists it on the next write', async () => {
    const mod = await boot({ terminalTheme: 'solarized-dark', leftPaneOpen: false })
    const loaded = await mod.loadSettings()
    expect(loaded.terminalTheme).toBe('tsubasaterminal')
    // 其他字段原样保留，只改那一个 id
    expect(loaded.leftPaneOpen).toBe(false)

    await set({ rightPaneOpen: false })
    expect(onDisk()).toMatchObject({ terminalTheme: 'tsubasaterminal', leftPaneOpen: false })
  })

  it('leaves a live scheme id untouched', async () => {
    const mod = await boot({ terminalTheme: 'nord' })
    expect((await mod.loadSettings()).terminalTheme).toBe('nord')
  })
})

describe('uiDensity (v0.14.2)', () => {
  it('defaults to standard for an old settings.json and rewrites an unknown stored value', async () => {
    const mod = await boot({ terminalTheme: 'nord' })
    expect((await mod.loadSettings()).uiDensity).toBe('standard')

    vi.resetModules()
    state.handlers.clear()
    const again = await boot({ uiDensity: 'huge' as never })
    expect((await again.loadSettings()).uiDensity).toBe('standard')
  })

  it('persists one of the three levels and ignores anything else', async () => {
    await boot()
    expect((await set({ uiDensity: 'compact' })).uiDensity).toBe('compact')
    expect(onDisk()).toMatchObject({ uiDensity: 'compact' })
    expect((await set({ uiDensity: 'tiny' })).uiDensity).toBe('compact')
    expect((await set({ uiDensity: 3 })).uiDensity).toBe('compact')
    expect((await set({ uiDensity: 'cozy' })).uiDensity).toBe('cozy')
  })
})

describe('uiFontSize (v0.14.5)', () => {
  it('defaults to standard for an old settings.json and rewrites an unknown stored value', async () => {
    const mod = await boot({ terminalTheme: 'nord' })
    expect((await mod.loadSettings()).uiFontSize).toBe('standard')

    vi.resetModules()
    state.handlers.clear()
    const again = await boot({ uiFontSize: 'huge' as never })
    expect((await again.loadSettings()).uiFontSize).toBe('standard')
  })

  it('persists one of the three levels independently of density and ignores anything else', async () => {
    await boot()
    expect((await set({ uiFontSize: 'large' })).uiFontSize).toBe('large')
    expect(onDisk()).toMatchObject({ uiFontSize: 'large', uiDensity: 'standard' })
    expect((await set({ uiFontSize: 'small' })).uiFontSize).toBe('large')
    expect((await set({ uiFontSize: 14 })).uiFontSize).toBe('large')
    expect((await set({ uiDensity: 'compact' })).uiFontSize).toBe('large')
    expect((await set({ uiFontSize: 'larger' })).uiFontSize).toBe('larger')
  })
})

describe('settings:get-sync bootstrap read', () => {
  it('returns persisted values merged over defaults once loadSettings has run', async () => {
    const mod = await boot({ leftPaneOpen: false, terminalTheme: 'dracula' })
    // index.ts 在 createWindow 前 await loadSettings——这里模拟同一时序
    await mod.loadSettings()
    const event = { returnValue: undefined as unknown }
    state.syncHandlers.get('settings:get-sync')!(event)
    expect(event.returnValue).toMatchObject({
      leftPaneOpen: false,
      rightPaneOpen: true,
      leftPaneWidth: PANE_DEFAULT_WIDTH.left,
      rightPaneWidth: PANE_DEFAULT_WIDTH.right,
      rightPanelTab: 'agent',
      terminalTheme: 'dracula'
    })
  })
})

describe('concurrent settings:set', () => {
  it('serializes disk writes and keeps both changes when the cache is warm', async () => {
    const mod = await boot()
    await mod.loadSettings()
    // 第一次写盘拖慢 40ms，第二次不拖——不串行的话第二次会先落盘、再被第一次盖回旧值
    state.writeDelays.push(40, 0)
    const first = set({ leftPaneWidth: 333 })
    const second = set({ rightPaneOpen: false })
    await Promise.all([first, second])

    expect(state.writeLog).toHaveLength(2)
    expect(state.writeLog[1].start).toBeGreaterThan(state.writeLog[0].end)
    // 后醒的 set 必须看到先醒那个刚写进缓存的字段（读-改-写同一个同步段）
    expect(onDisk()).toMatchObject({ leftPaneWidth: 333, rightPaneOpen: false })
    expect(mod.getSettingsSync()).toMatchObject({ leftPaneWidth: 333, rightPaneOpen: false })
  })

  it('keeps both changes even when the first set arrives before the initial disk read finished', async () => {
    // 不 await loadSettings：两个 handler 各自触发 load，必须共用同一次读盘
    await boot({ terminalTheme: 'dracula' })
    const first = set({ leftPaneWidth: 333 })
    const second = set({ rightPaneOpen: false })
    await Promise.all([first, second])
    expect(onDisk()).toMatchObject({
      leftPaneWidth: 333,
      rightPaneOpen: false,
      terminalTheme: 'dracula'
    })
  })

  it('a failed write does not block the next one', async () => {
    const mod = await boot()
    // 让第一次写失败：把 userData 指到不存在的目录，再指回来
    const good = state.userDataDir
    state.userDataDir = join(good, 'missing', 'deeper')
    await expect(set({ leftPaneWidth: 300 })).rejects.toThrow()
    state.userDataDir = good
    const next = await set({ rightPaneWidth: 400 })
    expect(next.rightPaneWidth).toBe(400)
    // 缓存里第一次的值仍在（内存先改、磁盘后到），第二次成功把它一并带到盘上
    expect(next.leftPaneWidth).toBe(300)
    expect(onDisk()).toMatchObject({ leftPaneWidth: 300, rightPaneWidth: 400 })
    expect(mod.getSettingsSync().leftPaneWidth).toBe(300)
  })
})
