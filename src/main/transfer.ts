import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import type { SFTPWrapper } from 'ssh2'
import { TrzszFilter } from 'trzsz'
import type { BridgeDownloadResult, SftpTransferResult, ZmodemKind } from '../shared/types'
import { auditLog } from './audit'
import { describeSftpError } from './sftpError'
import { getSession, getSftp } from './ssh'

/**
 * 终端文件传输（见 doc/transfer-design.md）：
 * - trzsz 真通道：TrzszFilter 常驻主进程、卡在 ssh2 stream 与 IPC 之间的唯一数据出口。
 *   协议帧与文件字节不出主进程；传输中进度条走 transient 通道（写 xterm 不喂转录）。
 * - ZMODEM 拦截桥：检测 lrzsz 起始帧 → CAN 中止 → 抑制帧垃圾（OSC 透传保转录时序）
 *   → renderer 取 cwd/命令驱动 SFTP 下载/上传。
 * 剥离语义：Agent 全部上下文通道（转录/read_output/勾选）在 IPC 下游，
 * 传输数据在此处被消费即天然不可见。
 */

/** ZMODEM 帧起始特征 `**\x18B0`；后一位 hex 定方向（00=ZRQINIT/sz，01=ZRINIT/rz） */
const ZMODEM_MAGIC = '\x2a\x2a\x18\x42\x30'
/** lrzsz 惯例中止序列：8×CAN + 10×BS */
const ZMODEM_ABORT = '\x18'.repeat(8) + '\b'.repeat(10)
/** trzsz magic（明文行，方向 S=远端发→下载 / R=远端收→上传 / D=目录） */
const TRZSZ_MAGIC = /::TRZSZ:TRANSFER:([SRD]):/
/** 抑制模式保险：吞掉的字节上限 / 时间上限（133;D 永不到达的病态场景） */
const SUPPRESS_MAX_BYTES = 16 * 1024
const SUPPRESS_MAX_MS = 5000
/** 桥扣押保险：prompt 扣到桥完成，对话框可能开很久，参照审批窗口 */
const HOLD_MAX_BYTES = 256 * 1024
const HOLD_MAX_MS = 15 * 60 * 1000
/** 未闭合 OSC 的最大等待长度（与 renderer 转录扫描器同限） */
const PENDING_OSC_LIMIT = 4096

export interface TransferPipelineOptions {
  /** shell integration 关闭的会话不启用 transient（转录本就不组装，无污染可言） */
  transientEnabled: boolean
  terminalColumns: number
  getWindow: () => BrowserWindow | null
  sendOutput: (data: Buffer) => void
  sendTransient: (data: Buffer) => void
  onZmodem: (kind: ZmodemKind) => void
  onTrzszEnd: (info: {
    direction: ZmodemKind
    durationMs: number
    sentFiles?: string[]
    saveDir?: string
  }) => void
  writeToStream: (data: string | Uint8Array) => void
}

/** e2e 对话框 mock：TSUBASATERMINAL_E2E_SEND_FILES（';' 分隔，CANCEL=取消） */
export async function chooseSendFilesDialog(
  win: BrowserWindow | null,
  directory?: boolean
): Promise<string[] | undefined> {
  const env = process.env['TSUBASATERMINAL_E2E_SEND_FILES']
  if (env !== undefined) return env === 'CANCEL' ? undefined : env.split(';').filter(Boolean)
  const options = {
    properties: (directory
      ? ['openDirectory', 'multiSelections']
      : ['openFile', 'multiSelections']) as Array<'openFile' | 'openDirectory' | 'multiSelections'>
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths
}

/** e2e 对话框 mock：TSUBASATERMINAL_E2E_SAVE_DIR（CANCEL=取消） */
export async function chooseSaveDirectoryDialog(
  win: BrowserWindow | null
): Promise<string | undefined> {
  const env = process.env['TSUBASATERMINAL_E2E_SAVE_DIR']
  if (env !== undefined) return env === 'CANCEL' ? undefined : env
  const options = { properties: ['openDirectory'] as Array<'openDirectory'> }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0]
}

/** writeToTerminal 回调载荷归一为 Buffer（Node 路径只会出现 string / Uint8Array / ArrayBuffer） */
function toBuffer(out: string | ArrayBuffer | Uint8Array | Blob): Buffer {
  if (typeof out === 'string') return Buffer.from(out, 'utf-8')
  if (out instanceof Uint8Array) return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
  if (out instanceof ArrayBuffer) return Buffer.from(out)
  return Buffer.alloc(0)
}

export class TransferPipeline {
  private filter: TrzszFilter
  private opts: TransferPipelineOptions
  /** ZMODEM 跨 chunk 检测尾缓冲（latin1，最长 5 字节特征 + 1 方向位） */
  private zmodemTail = ''
  /** ZMODEM 中止后的帧垃圾抑制模式 */
  private suppress = false
  private suppressStartedAt = 0
  private suppressedBytes = 0
  private suppressTail = ''
  /**
   * 桥扣押：被中止的命令 1 个 RTT 就回 prompt，而 ✓ 提示要等
   * 对话框 + SFTP——prompt 必然赢。133;D 起的输出全部扣押，桥收尾（成功/
   * 失败/取消都在 renderer 的 finally）发 release 才放行，视觉顺序恒定：
   * 检测提示 → ✓ 结果 → prompt 干净落底。
   */
  private bridgeActive = false
  private holding = false
  private holdBuf: Buffer[] = []
  private holdBytes = 0
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** trzsz 传输态跟踪（审计 + transient 进出） */
  private transferActive = false
  private transferStartedAt = 0
  private transferDirection: ZmodemKind = 'download'
  private transferSentFiles: string[] | undefined
  private transferSaveDir: string | undefined

  constructor(opts: TransferPipelineOptions) {
    this.opts = opts
    this.filter = new TrzszFilter({
      writeToTerminal: (out) => this.routeOutput(toBuffer(out)),
      sendToServer: (input) => this.opts.writeToStream(input),
      chooseSendFiles: async (directory) => {
        const files = await chooseSendFilesDialog(this.opts.getWindow(), directory)
        this.transferSentFiles = files
        return files
      },
      chooseSaveDirectory: async () => {
        const dir = await chooseSaveDirectoryDialog(this.opts.getWindow())
        this.transferSaveDir = dir
        return dir
      },
      terminalColumns: opts.terminalColumns,
      isWindowsShell: false
    })
  }

  /** ssh2 stream 输出入口（唯一） */
  feedServerOutput(data: Buffer): void {
    // 审计用方向探测：magic 在 filter 接管前以明文经过这里
    if (!this.filter.isTransferringFiles()) {
      const match = data.toString('latin1').match(TRZSZ_MAGIC)
      if (match) this.transferDirection = match[1] === 'S' ? 'download' : 'upload'
    }
    this.filter.processServerOutput(data)
  }

  /** 用户键入 / 审批批准写 pty / SI 脚本——统一入口（传输中 Ctrl+C 中止语义归 filter） */
  writeInput(data: string): void {
    this.filter.processTerminalInput(data)
  }

  setColumns(cols: number): void {
    this.filter.setTerminalColumns(cols)
  }

  dispose(): void {
    this.releaseBridgeHold()
    if (this.filter.isTransferringFiles()) this.filter.stopTransferringFiles()
  }

  /** 桥收尾释放扣押的 prompt；未在扣押则只清桥标记（release 先于 D 到达的竞态） */
  releaseBridgeHold(): void {
    this.bridgeActive = false
    if (!this.holding) return
    this.holding = false
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    const merged = Buffer.concat(this.holdBuf)
    this.holdBuf = []
    this.holdBytes = 0
    if (merged.length) this.opts.sendOutput(merged)
  }

  private startHold(initial: Buffer): void {
    this.holding = true
    this.holdBuf = [initial]
    this.holdBytes = initial.length
    this.holdTimer = setTimeout(() => this.releaseBridgeHold(), HOLD_MAX_MS)
  }

  /** filter 放行/产出的终端数据统一路由 */
  private routeOutput(buf: Buffer): void {
    if (this.filter.isTransferringFiles()) {
      if (!this.transferActive) {
        this.transferActive = true
        this.transferStartedAt = Date.now()
        this.transferSentFiles = undefined
        this.transferSaveDir = undefined
      }
      // 传输中的输出只有进度条/提示：人屏可见，转录不可见
      if (this.opts.transientEnabled) this.opts.sendTransient(buf)
      else this.opts.sendOutput(buf)
      return
    }
    if (this.transferActive) {
      this.transferActive = false
      this.opts.onTrzszEnd({
        direction: this.transferDirection,
        durationMs: Date.now() - this.transferStartedAt,
        sentFiles: this.transferSentFiles,
        saveDir: this.transferSaveDir
      })
    }
    if (this.holding) {
      this.holdBuf.push(buf)
      this.holdBytes += buf.length
      if (this.holdBytes > HOLD_MAX_BYTES) this.releaseBridgeHold()
      return
    }
    if (this.suppress) {
      this.suppressChunk(buf)
      return
    }
    this.detectZmodem(buf)
  }

  /** 空闲态：扫 ZMODEM 起始帧；未命中原样放行 */
  private detectZmodem(buf: Buffer): void {
    const text = buf.toString('latin1')
    const combined = this.zmodemTail + text
    const at = combined.indexOf(ZMODEM_MAGIC)
    // 方向位在特征后一位；跨 chunk 未到齐则等下一 chunk（尾缓冲保留特征）
    if (at !== -1 && at + ZMODEM_MAGIC.length < combined.length) {
      const dirChar = combined[at + ZMODEM_MAGIC.length]
      const kind: ZmodemKind = dirChar === '1' ? 'upload' : 'download'
      // 放行本 chunk 中特征之前的新字节（尾缓冲部分上一轮已放行）
      const newStart = at - this.zmodemTail.length
      if (newStart > 0) this.opts.sendOutput(Buffer.from(text.slice(0, newStart), 'latin1'))
      this.zmodemTail = ''
      this.opts.writeToStream(ZMODEM_ABORT)
      this.suppress = true
      this.suppressStartedAt = Date.now()
      this.suppressedBytes = 0
      this.suppressTail = ''
      this.bridgeActive = true
      this.opts.onZmodem(kind)
      // 特征之后的残留（若有）直接进抑制扫描
      const rest = combined.slice(at)
      this.suppressChunk(Buffer.from(rest, 'latin1'), true)
      return
    }
    this.zmodemTail = combined.slice(-(ZMODEM_MAGIC.length + 1))
    this.opts.sendOutput(buf)
  }

  /**
   * 抑制模式：吞非 OSC 字节（帧垃圾/“Transfer incomplete”），OSC 序列透传
   * 保 133;D/7/A/B 时序（转录单元正常闭合、cwd 不失联）；见到 133;D 退出。
   */
  private suppressChunk(buf: Buffer, fresh = false): void {
    if (!fresh) this.suppressedBytes += buf.length
    if (
      this.suppressedBytes > SUPPRESS_MAX_BYTES ||
      Date.now() - this.suppressStartedAt > SUPPRESS_MAX_MS
    ) {
      this.suppress = false
      this.suppressTail = ''
      this.opts.sendOutput(buf)
      return
    }
    const text = this.suppressTail + buf.toString('latin1')
    this.suppressTail = ''
    let forward = ''
    let pos = 0
    while (pos < text.length) {
      const esc = text.indexOf('\x1b]', pos)
      if (esc === -1) {
        // 纯帧垃圾吞掉；尾部孤立 ESC 可能是被切断的 OSC 起始
        if (text.endsWith('\x1b')) this.suppressTail = '\x1b'
        break
      }
      const bel = text.indexOf('\x07', esc + 2)
      const st = text.indexOf('\x1b\\', esc + 2)
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (end === -1) {
        const rest = text.slice(esc)
        if (rest.length <= PENDING_OSC_LIMIT) this.suppressTail = rest
        break
      }
      const seqEnd = end + (end === bel ? 1 : 2)
      if (text.slice(esc + 2, end).startsWith('133;D')) {
        // 命令结束：抑制结束。桥进行中则连 D 带 prompt 一起扣押到桥收尾
        //（转录闭合与 composer 回 prompt 态随之延后——传输中本就不该是就绪态）
        this.suppress = false
        const rest = text.slice(esc)
        if (this.bridgeActive) {
          if (forward) this.opts.sendOutput(Buffer.from(forward, 'latin1'))
          this.startHold(Buffer.from(rest, 'latin1'))
          return
        }
        forward += rest
        break
      }
      forward += text.slice(esc, seqEnd)
      pos = seqEnd
    }
    if (forward) this.opts.sendOutput(Buffer.from(forward, 'latin1'))
  }
}

/** 远端是 POSIX 路径，不能用 path.join（与 sftp.ts 同约定） */
function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

function posixBasename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? p : p.slice(idx + 1)
}

/** 桥的远端路径解析：绝对路径原样；~ 展开 home；相对路径拼 cwd（缺省 home） */
function resolveRemote(p: string, cwd: string | null, home: string): string {
  if (p.startsWith('/')) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return joinRemote(home, p.slice(2))
  return joinRemote(cwd || home, p)
}

/** 桥的错误出口带 errno 分流：不存在才提 trzsz 出路，权限问题说身份不足 */
function errMsg(err: unknown): string {
  return describeSftpError(err, { transferHint: true })
}

function sftpRealpath(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) =>
    sftp.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved)))
  )
}

export function registerTransferHandlers(): void {
  // 桥收尾：释放扣押的 prompt（renderer 在 handleZmodemDetected 的 finally 里发）
  ipcMain.on('transfer:bridge-release', (_event, sessionId: string) => {
    getSession(sessionId)?.transfer.releaseBridgeHold()
  })

  // ZMODEM 桥下载：远端跑了 sz，renderer 解析出文件参数后驱动
  ipcMain.handle(
    'transfer:bridge-download',
    async (
      event,
      sessionId: string,
      paths: string[],
      cwd: string | null
    ): Promise<BridgeDownloadResult> => {
      try {
        const sftp = await getSftp(sessionId)
        const home = await sftpRealpath(sftp, '.')
        const win = BrowserWindow.fromWebContents(event.sender)
        const dir = await chooseSaveDirectoryDialog(win)
        if (!dir) return { ok: false, canceled: true }
        const files: Array<{ name: string; ok: boolean; error?: string }> = []
        let bytes = 0
        for (const raw of paths) {
          const remote = resolveRemote(raw, cwd, home)
          const name = posixBasename(remote)
          const local = join(dir, name)
          try {
            await new Promise<void>((resolve, reject) =>
              sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()))
            )
            bytes += (await fs.stat(local)).size
            files.push({ name, ok: true })
          } catch (err) {
            files.push({ name, ok: false, error: errMsg(err) })
          }
        }
        void auditLog(sessionId, {
          kind: 'transfer',
          command: `(zmodem-bridge) sz ${paths.join(' ')}`,
          via: 'bridge',
          direction: 'download',
          files: files.map((f) => f.name),
          savedTo: dir,
          bytes
        })
        return { ok: files.some((f) => f.ok), savedTo: dir, files }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  )

  // ZMODEM 桥上传：远端跑了 rz，传到当前目录（cwd 未知则 home）
  ipcMain.handle(
    'transfer:bridge-upload',
    async (event, sessionId: string, remoteDir: string | null): Promise<SftpTransferResult> => {
      try {
        const sftp = await getSftp(sessionId)
        const dir = remoteDir || (await sftpRealpath(sftp, '.'))
        const win = BrowserWindow.fromWebContents(event.sender)
        const localPaths = await chooseSendFilesDialog(win, false)
        if (!localPaths?.length) return { ok: false, canceled: true }
        const uploaded: string[] = []
        let bytes = 0
        for (const localPath of localPaths) {
          const name = basename(localPath)
          await new Promise<void>((resolve, reject) =>
            sftp.fastPut(localPath, joinRemote(dir, name), (err) => (err ? reject(err) : resolve()))
          )
          bytes += (await fs.stat(localPath)).size
          uploaded.push(name)
        }
        void auditLog(sessionId, {
          kind: 'transfer',
          command: `(zmodem-bridge) rz → ${dir}`,
          via: 'bridge',
          direction: 'upload',
          files: uploaded,
          savedTo: dir,
          bytes
        })
        return { ok: true, uploaded }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  )
}
