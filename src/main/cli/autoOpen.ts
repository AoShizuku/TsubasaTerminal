import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'

/**
 * `use` 自动开会话（cli-bridge-design 9.7）：目标主机没有已连接会话时，
 * 主进程请求渲染进程开一个标签页连接——"CC 说要连 db1，右边自己长出 tab"。
 *
 * 连接本身仍走渲染进程既有的 ssh:connect 流程（TerminalView 挂载即连），这里只做
 * 请求-应答：渲染进程盯连接状态，成败经 `cli:open-session-result` 回来——失败原因
 * （含 TOFU mismatch 的"主机密钥已改变"）借此穿透到 CLI stderr，安全相关的失败
 * 不能只在 UI 里冒个泡。TOFU **首连**是静默记录并放行（hostkeys.ts），不需要交互。
 *
 * 只挂 `use`、不进 `--hosts`（9.7）：exec 是执行动词，不该有"建立连接"的副作用。
 */

export type OpenOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; error: string }

/** 等待窗口（9.7）：连接 + SI 装载 + elevation 握手 + 档案探测，首连新机 10s 打不住。
 *  渲染侧 29s 先自答，这里 31s 兜底（渲染进程无响应时也不挂死 CLI） */
const OPEN_TIMEOUT_MS = 31_000

const waiters = new Map<string, { resolve: (o: OpenOutcome) => void; timer: NodeJS.Timeout }>()
/** 同主机并发 use 去重：共享同一次开标签页，别开出两个 */
const inflight = new Map<string, Promise<OpenOutcome>>()

export function registerAutoOpenHandlers(): void {
  ipcMain.on(
    'cli:open-session-result',
    (_event, requestId: string, sessionId: string, ok: boolean, error?: string) => {
      const waiter = waiters.get(String(requestId))
      if (!waiter) return
      waiters.delete(String(requestId))
      clearTimeout(waiter.timer)
      waiter.resolve(
        ok === true
          ? { ok: true, sessionId: String(sessionId) }
          : { ok: false, error: String(error ?? '连接失败') }
      )
    }
  )
}

export function requestOpenSession(hostId: string): Promise<OpenOutcome> {
  const existing = inflight.get(hostId)
  if (existing) return existing
  const promise = new Promise<OpenOutcome>((resolve) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) {
      resolve({ ok: false, error: '应用窗口不可用' })
      return
    }
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      waiters.delete(requestId)
      resolve({
        ok: false,
        error: '连接仍在进行（超过等待窗口）——标签页已打开，稍后重跑 use 即可绑定'
      })
    }, OPEN_TIMEOUT_MS)
    waiters.set(requestId, { resolve, timer })
    win.webContents.send('cli:open-session', requestId, hostId)
  }).finally(() => inflight.delete(hostId))
  inflight.set(hostId, promise)
  return promise
}
