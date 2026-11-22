import { app } from 'electron'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { join } from 'path'
import {
  CLI_EXIT,
  CLI_PROTOCOL_VERSION,
  CLI_TOKEN_FILE,
  cliPipeName,
  type CliFrame
} from '../../shared/cli'
import { handleCli, type CliIo } from './commands'
import { parseRequest } from './protocol'

/**
 * 命名管道服务端（cli-bridge-design 2.2）。
 *
 * 传输层选**命名管道**而非 localhost 端口：不给本机浏览器和杂进程留 CSRF 面。
 * 要清醒——这条管道就是"完全控制"的钥匙，同用户下任何进程连上它就能操纵所有已连会话，
 * 这是引入 CLI 后**唯一的新增攻击面**。凭据仍然不出主进程（安全铁律不破），但
 * "能让主进程替我执行"这件事本身被外放了。握手 token 只防误连到别的实例，
 * **不防同用户恶意进程**——同用户即同权是这个模型的底线，别自欺。
 * 故本开关默认关，由人在设置里显式打开。
 *
 * 协议：一连接一请求。CLI 写一行请求 JSON，服务端回若干 NDJSON 帧，
 * 以 `{"t":"exit"}` 收尾并关闭连接。
 */

/** 单个请求的输入上限：请求体只有命令行，64KB 绰绰有余，超了就是异常连接 */
const REQUEST_LIMIT = 64 * 1024
/** 挂住不发请求的连接的超时：读到完整请求前的等待窗口 */
const HEADER_TIMEOUT_MS = 5000

let server: Server | null = null
let token: string | null = null

export function pipeName(): string {
  return cliPipeName(process.env)
}

function tokenFile(): string {
  return join(app.getPath('userData'), CLI_TOKEN_FILE)
}

/**
 * 握手 token：每次起管道换一个新的，落 userData 下由 shim 传进来的路径读取。
 * 换新是有意的——上一次运行遗留的 token 不该还能用。
 */
async function ensureToken(): Promise<string> {
  const value = randomBytes(24).toString('hex')
  token = value
  await fs.writeFile(tokenFile(), value, { encoding: 'utf-8', mode: 0o600 })
  return value
}

export function isCliServerRunning(): boolean {
  return server !== null
}

function makeIo(socket: Socket): CliIo {
  const send = (frame: CliFrame): void => {
    if (socket.writableEnded || socket.destroyed) return
    socket.write(JSON.stringify(frame) + '\n')
  }
  return {
    out: (text) => send({ t: 'out', d: text }),
    err: (text) => send({ t: 'err', d: text })
  }
}

function finish(socket: Socket, code: number): void {
  if (!socket.writableEnded && !socket.destroyed) {
    socket.write(JSON.stringify({ t: 'exit', code } satisfies CliFrame) + '\n')
    socket.end()
  }
}

function onConnection(socket: Socket): void {
  socket.setEncoding('utf-8')
  let buffer = ''
  let handled = false
  // 连上却不说话的连接不留着占资源
  const headerTimer = setTimeout(() => {
    if (!handled) socket.destroy()
  }, HEADER_TIMEOUT_MS)

  // 请求执行期间对端断开（外部 agent 的超时窗口到了）→ abort 在跑的 exec channel
  const controller = new AbortController()
  socket.on('close', () => {
    clearTimeout(headerTimer)
    controller.abort()
  })
  socket.on('error', () => {
    controller.abort()
  })

  socket.on('data', (chunk: string) => {
    if (handled) return
    buffer += chunk
    if (buffer.length > REQUEST_LIMIT) {
      handled = true
      clearTimeout(headerTimer)
      socket.destroy()
      return
    }
    const nl = buffer.indexOf('\n')
    if (nl < 0) return
    handled = true
    clearTimeout(headerTimer)
    const io = makeIo(socket)
    const req = parseRequest(buffer.slice(0, nl))
    if (!req) {
      io.err('协议错误：请求不是合法的 JSON 行\n')
      finish(socket, CLI_EXIT.HANDSHAKE)
      return
    }
    if (req.v !== CLI_PROTOCOL_VERSION) {
      io.err(
        `协议版本不匹配（CLI ${req.v} / 应用 ${CLI_PROTOCOL_VERSION}）：` +
          `多半是应用更新后 shim 指向了旧的 CLI 产物，重启 Tsubasa Terminal 会自愈 shim。\n`
      )
      finish(socket, CLI_EXIT.HANDSHAKE)
      return
    }
    if (!token || req.token !== token) {
      io.err(
        `握手 token 不匹配：可能连到了另一个 Tsubasa Terminal 实例，或 token 文件是上次运行遗留的。` +
          `确认 Tsubasa Terminal 正在运行后重试（token 每次启动会换新）。\n`
      )
      finish(socket, CLI_EXIT.HANDSHAKE)
      return
    }
    void handleCli(req, io, controller.signal)
      .then((code) => finish(socket, code))
      .catch((err: unknown) => {
        io.err(`内部错误：${err instanceof Error ? err.message : String(err)}\n`)
        finish(socket, CLI_EXIT.FAILED)
      })
  })
}

export async function startCliServer(): Promise<boolean> {
  if (server) return true
  await ensureToken()
  const name = pipeName()
  return await new Promise<boolean>((resolve) => {
    const s = createServer(onConnection)
    s.on('error', () => {
      // 同名管道已被占用（多开了一个 Tsubasa Terminal）：不抢，安静降级——
      // 抢过来只会让另一个实例的 CLI 静默打到本实例的会话上，正是要防的形态
      server = null
      resolve(false)
    })
    s.listen(name, () => {
      server = s
      resolve(true)
    })
  })
}

export async function stopCliServer(): Promise<void> {
  const s = server
  server = null
  token = null
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  // token 文件跟着管道走：管道没了，遗留的 token 也不该还躺在盘上
  await fs.rm(tokenFile(), { force: true }).catch(() => {})
}
