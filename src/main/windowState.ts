import { app, screen, type BrowserWindow } from 'electron'
import { promises as fs, writeFileSync } from 'fs'
import { join } from 'path'
import {
  parseWindowState,
  resolveWindowPlacement,
  type Rect,
  type Size,
  type WindowState
} from './windowPlacement'

/**
 * 主窗口位置、尺寸与最大化记忆：userData/window-state.json。
 *
 * 不进 settings.json：只有主进程用、移动缩放时高频写，也不该和 settings:set 的
 * 读-改-写排同一条写盘队列。尽力而为：读坏按首次启动处理，写失败不打扰用户——
 * 后果只是下次启动的落位不对，不值得一个弹窗。
 */

/** 拖动、缩放过程中 move / resize 连发，停手后再落盘 */
const SAVE_DEBOUNCE_MS = 500

let state: WindowState | null = null

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 建窗前读一次；macOS 重新激活建窗时用内存里最新的一份，不再读盘 */
export async function loadWindowState(): Promise<void> {
  try {
    state = parseWindowState(JSON.parse(await fs.readFile(stateFile(), 'utf-8')))
  } catch {
    state = null
  }
}

/** 本次建窗的落位；`defaultSize` 只在没有记录时生效 */
export function initialWindowPlacement(defaultSize?: Size): WindowState {
  return resolveWindowPlacement(
    state,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
    defaultSize
  )
}

/**
 * 跟踪窗口状态并落盘；须在窗口已按 `requested` 落位后调用。
 *
 * 分数缩放（如 175%）的屏上，DIP ↔ 物理像素往返向外取整，测回来的尺寸比请求值大
 * 一两个像素。若照测量值存盘，每次重启都会再涨一点。因此以落位后的测量值为锚：
 * 某一维与锚相同就说明用户没动过它，存回请求值，误差不随重启累积。
 *
 * 写盘用同步 API：文件不到百字节、防抖后至多每半秒一次；关窗那一次必须在进程
 * 退出前写完，异步写可能被 app.quit 截断，而防抖写若是异步的，还可能晚于关窗写
 * 落盘、把最终状态盖回旧值。
 */
export function trackWindowState(win: BrowserWindow, requested: Rect): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let written = ''
  const anchor = win.getNormalBounds()
  const keep = (key: keyof Rect, now: Rect): number =>
    now[key] === anchor[key] ? requested[key] : now[key]

  const capture = (): void => {
    // 最小化态不采样：最大化标志此时不可靠，保留最小化前的那一份
    if (win.isDestroyed() || win.isMinimized()) return
    const now = win.getNormalBounds()
    state = {
      x: keep('x', now),
      y: keep('y', now),
      width: keep('width', now),
      height: keep('height', now),
      maximized: win.isMaximized()
    }
  }
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (!state) return
    const json = JSON.stringify(state)
    if (json === written) return
    try {
      writeFileSync(stateFile(), json, 'utf-8')
      written = json
    } catch {
      // 尽力而为，见文件头
    }
  }
  const schedule = (): void => {
    capture()
    clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    capture()
    flush()
  })
}
