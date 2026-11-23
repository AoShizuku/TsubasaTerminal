import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORK_AREA_RATIO, type Rect } from '../../../src/main/windowPlacement'

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1032 }
const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1392 }

const env = vi.hoisted(() => ({
  userDataDir: '',
  workAreas: [] as Rect[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.userDataDir },
  screen: {
    getAllDisplays: () => env.workAreas.map((workArea) => ({ workArea })),
    getPrimaryDisplay: () => ({ workArea: env.workAreas[0] })
  }
}))

/** 只实现 trackWindowState 用到的那几个方法；状态由用例直接改 */
class FakeWindow extends EventEmitter {
  normal: Rect = { x: 100, y: 80, width: 1400, height: 900 }
  maximized = false
  minimized = false
  getNormalBounds(): Rect {
    return { ...this.normal }
  }
  isMaximized(): boolean {
    return this.maximized
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isDestroyed(): boolean {
    return false
  }
}

type WindowStateModule = typeof import('../../../src/main/windowState')

/** 每个用例一份新的模块状态，模拟一次进程启动 */
async function boot(): Promise<WindowStateModule> {
  vi.resetModules()
  const mod = await import('../../../src/main/windowState')
  await mod.loadWindowState()
  return mod
}

/** `requested` 缺省等于窗口落位后的测量值（整数缩放屏上二者一致） */
function track(mod: WindowStateModule, requested?: Rect): FakeWindow {
  const win = new FakeWindow()
  mod.trackWindowState(win as unknown as Electron.BrowserWindow, requested ?? win.getNormalBounds())
  return win
}

function stateFile(): string {
  return join(env.userDataDir, 'window-state.json')
}

function onDisk(): unknown {
  return JSON.parse(readFileSync(stateFile(), 'utf-8'))
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsubasaterminal-winstate-'))
  env.userDataDir = root
  env.workAreas = [primary, secondary]
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('startup placement', () => {
  it('uses the ratio of the primary work area when nothing is saved', async () => {
    const mod = await boot()
    expect(mod.initialWindowPlacement()).toMatchObject({
      width: Math.round(primary.width * DEFAULT_WORK_AREA_RATIO),
      height: Math.round(primary.height * DEFAULT_WORK_AREA_RATIO),
      maximized: false
    })
  })

  it('treats a corrupted file as first launch', async () => {
    writeFileSync(stateFile(), '{"x":1,', 'utf-8')
    const mod = await boot()
    expect(mod.initialWindowPlacement({ width: 1280, height: 800 })).toMatchObject({
      width: 1280,
      height: 800,
      maximized: false
    })
  })

  it('restores a saved record and ignores the default size', async () => {
    const record = { x: 2100, y: 60, width: 1700, height: 1100, maximized: true }
    writeFileSync(stateFile(), JSON.stringify(record), 'utf-8')
    const mod = await boot()
    expect(mod.initialWindowPlacement({ width: 1280, height: 800 })).toEqual(record)
  })

  it('brings the window back to the primary display after the secondary is unplugged', async () => {
    writeFileSync(
      stateFile(),
      JSON.stringify({ x: 2100, y: 60, width: 1600, height: 1000, maximized: false }),
      'utf-8'
    )
    env.workAreas = [primary]
    const mod = await boot()
    expect(mod.initialWindowPlacement()).toEqual({
      x: 160,
      y: 16,
      width: 1600,
      height: 1000,
      maximized: false
    })
  })
})

describe('tracking', () => {
  it('debounces move / resize bursts into one write of the latest bounds', async () => {
    vi.useFakeTimers()
    const mod = await boot()
    const win = track(mod)
    for (let i = 0; i < 5; i += 1) {
      win.normal = { ...win.normal, x: 100 + i * 10 }
      win.emit('move')
    }
    win.normal = { ...win.normal, width: 1500 }
    win.emit('resize')
    vi.advanceTimersByTime(499)
    expect(existsSync(stateFile())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(onDisk()).toEqual({ x: 140, y: 80, width: 1500, height: 900, maximized: false })
  })

  it('writes synchronously on close with the restore bounds of a maximized window', async () => {
    vi.useFakeTimers()
    const mod = await boot()
    const win = track(mod)
    win.maximized = true
    win.emit('maximize')
    // 关窗不等防抖：进程随即退出
    win.emit('close')
    expect(onDisk()).toEqual({ x: 100, y: 80, width: 1400, height: 900, maximized: true })
  })

  it('keeps the pre-minimize record while minimized', async () => {
    vi.useFakeTimers()
    const mod = await boot()
    const win = track(mod)
    win.maximized = true
    win.emit('maximize')
    vi.advanceTimersByTime(500)
    // 最小化态下 isMaximized 不可靠，Electron 仍会发 resize
    win.minimized = true
    win.maximized = false
    win.normal = { x: -32000, y: -32000, width: 160, height: 28 }
    win.emit('resize')
    win.emit('close')
    expect(onDisk()).toEqual({ x: 100, y: 80, width: 1400, height: 900, maximized: true })
  })

  it('saves the requested value for dimensions the user never touched', async () => {
    const mod = await boot()
    // 分数缩放屏：请求 1399×899，落位后测得 1400×900
    const win = track(mod, { x: 100, y: 80, width: 1399, height: 899 })
    win.emit('close')
    expect(onDisk()).toEqual({ x: 100, y: 80, width: 1399, height: 899, maximized: false })

    // 只移动：位置取测量值，尺寸仍存请求值，不随重启累积
    win.normal = { ...win.normal, x: 300 }
    win.emit('close')
    expect(onDisk()).toEqual({ x: 300, y: 80, width: 1399, height: 899, maximized: false })

    // 用户改了尺寸：存实际尺寸
    win.normal = { ...win.normal, width: 1600 }
    win.emit('close')
    expect(onDisk()).toEqual({ x: 300, y: 80, width: 1600, height: 899, maximized: false })
  })

  it('swallows write failures', async () => {
    const mod = await boot()
    const win = track(mod)
    env.userDataDir = join(env.userDataDir, 'missing', 'dir')
    expect(() => win.emit('close')).not.toThrow()
  })

  it('restores what the previous run saved on close', async () => {
    const first = await boot()
    const win = track(first)
    win.normal = { x: 2300, y: 120, width: 1800, height: 1000 }
    win.emit('close')
    const second = await boot()
    expect(second.initialWindowPlacement({ width: 1280, height: 800 })).toEqual({
      x: 2300,
      y: 120,
      width: 1800,
      height: 1000,
      maximized: false
    })
  })
})
