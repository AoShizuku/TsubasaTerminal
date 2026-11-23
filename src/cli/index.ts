import { readFileSync, statSync } from 'fs'
import { connect } from 'net'
import { join, resolve } from 'path'
import {
  APP_DATA_DIR_NAME,
  CLI_EXIT,
  CLI_PROTOCOL_VERSION,
  CLI_TOKEN_FILE,
  cliPipeName,
  type CliFlags,
  type CliFrame,
  type CliRequest
} from '../shared/cli'

/**
 * `tsubasa-ssh` 本体（cli-bridge-design 第六节）。
 *
 * 只干一件事：连管道、发请求、流转输出、带出退出码。因此只需 Node 的 `net`——
 * 不能假设运维机器装了 Node，但安装目录里本来就有一个：`ELECTRON_RUN_AS_NODE=1` 下
 * `TsubasaTerminal.exe` 就是纯 Node 进程（VS Code 的 `code` 命令同款）。
 *
 * **本文件只能 import node 内置模块与 `src/shared/cli.ts`**——它被 esbuild 打成
 * 单文件产物，拉进 electron / 主进程任何东西都会当场炸掉。
 */

/** 由 esbuild define 注入（scripts/build-cli.mjs 从 package.json 取） */
declare const __CLI_VERSION__: string

const SUBCOMMANDS = new Set([
  'hosts',
  'sessions',
  'use',
  'exec',
  'push',
  'rz', // push 的别名（sz/pull 不存在——设计裁决留档不开放，半套比没有更误导）
  'job',
  'screen',
  'log',
  'exp',
  'rules'
])

/**
 * `--help` / `--version` 在**本地**答，不连管道：一个连帮助都要求应用在跑的 CLI
 * 是坏 CLI，而这两样本来就不需要应用里的任何数据。需要闸门白名单实况的
 * `rules` 才走管道（那份数据只有主进程有，抄一份必然漂移）。
 */
const USAGE = `tsubasa-ssh v${__CLI_VERSION__} — 复用 Tsubasa Terminal 已连接的 SSH 会话、闸门、审批台、脱敏与审计

用法：
  tsubasa-ssh hosts                     列出用户配置的主机（别名 / user@host / 标记 / 有无会话）+ 全局知识
  tsubasa-ssh hosts <别名>              某台的标记与本机知识（不连接它）
  tsubasa-ssh sessions                  列出已连接会话（句柄 / 别名 / user@host / 标记 / 状态）
  tsubasa-ssh use <别名|句柄>           绑定会话并返回建联包（主机档案 + 知识 + 经验索引）；
                                        没有已连接会话时自动开标签页连接（约需数秒）
  tsubasa-ssh exec "<cmd>"              执行一条命令：只读白名单自动跑；其余弹审批卡给用户
  tsubasa-ssh exec --save "<cmd>"       大输出全量落远端文件，只回规模 + 前 30 行预览
  tsubasa-ssh exec --bg "<cmd>"         启动常驻服务（nohup 后台化，一律经用户审批）
  tsubasa-ssh exec --async "<cmd>"      进审批台时立刻返回 proposalId，之后 job 轮询
  tsubasa-ssh exec --hosts a,b "<cmd>"  多机并行（2..7 台）：白名单逐台自动跑；
                                        非白名单一张卡罩整批，stdout 为 JSON 聚合
  tsubasa-ssh push <本地文件> <远端绝对路径>
                                        上传一个本地文件（别名 rz；一律经用户审批；
                                        [--mode 755] 按八进制；大文件配 --async）
  tsubasa-ssh job <proposalId>          轮询 --async 的结果（108=未到终态，继续轮询）
  tsubasa-ssh screen                    读用户终端当前屏幕（TUI 现场）
  tsubasa-ssh log [--limit N]           最近命令概要
  tsubasa-ssh log <句柄:n> [--limit N]  读某条命令的输出正文
  tsubasa-ssh exp <id>                  读一条排障经验正文
  tsubasa-ssh rules                     打印闸门规则摘要与退出码表

全局参数：
  -s, --session <句柄>   逐条覆盖粘性绑定（不读不写粘性；与 --hosts 互斥）
      --hosts <a,b,c>    exec 多机目标（逗号分隔别名/句柄，显式列举，无 all）；
                         任一未命中/歧义整批失败（103/104），不自动开会话——先逐台 use
      --agent <名>       自报家门：审计记 cli:<名>。**每条命令都带上**；漏带该条记为匿名 cli
      --intent <一句话>  本条 exec / push 的意图：审批卡与界面 CLI 栏里给用户看的解释
      --timeout <秒>     exec 提案挂起窗口，缺省 90；超时主动撤回提案退 125（命令未执行）
      --json             exec 的 stdout 改为结构化 JSON（--hosts 时自动启用）
  -h, --help             本帮助
  -V, --version          版本

粘性绑定按 clientId 隔离（TSUBASA_CLIENT ?? WT_SESSION ?? global），只住内存、随应用
退出消亡；--agent 不粘，逐条生效。每条命令的 stderr 首行回显当前作用的会话与本条身份；
stdout 保持纯净可管道。需要人审的命令会在 Tsubasa Terminal 里弹审批卡（桌面通知 + 闪任务栏），
预计执行很久的命令用 --async + job，别让阻塞等待撞上你自己的超时。多机批量的退出码：
逐台全同则透传，不一致退 109（逐台读 stdout JSON 的 results）。
`

type Parsed =
  | { ok: true; local: 'help' | 'version' }
  | { ok: true; request: Omit<CliRequest, 'token'> }
  | { ok: false; message: string }

/**
 * 粘性绑定的隔离键（3.2）。`WT_SESSION` 是 Windows Terminal 给每个标签页注入的 GUID，
 * 从外部 agent 所在的 tab 一路继承到它的每个子 shell——同一实例的所有调用天然同值、
 * 不同 tab 的两个实例天然不同值，零配置。
 *
 * **为什么必须隔离**：全局粘性下两个实例互相覆盖 `use`，前者下一条 exec 静默打到
 * 另一台主机——最恶劣的错误形态。取不到时退化为全局一份，多主机作业请每条命令带 `-s`。
 */
function clientId(): string {
  return (process.env.TSUBASA_CLIENT?.trim() || process.env.WT_SESSION?.trim() || 'global').slice(
    0,
    128
  )
}

function parseArgs(argv: string[]): Parsed {
  const flags: CliFlags = {}
  let agent: string | undefined
  let cmd: string | null = null
  const args: string[] = []
  let sawPositional = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // 只有 exec 在第一个位置参数之后停止认 flag（`ssh -v host cmd args` 的老规矩）——
    // 否则 `exec ls -la` 里的 `-la` 会被当成本 CLI 的参数。其余子命令位置参数固定一个，
    // 允许 `log 3f2a19c8:7 --limit 100` 这种自然写法
    const flagsAllowed = cmd !== 'exec' || !sawPositional
    if (flagsAllowed && (a === '-h' || a === '--help')) return { ok: true, local: 'help' }
    if (flagsAllowed && (a === '-V' || a === '--version')) return { ok: true, local: 'version' }
    if (flagsAllowed && (a === '-s' || a === '--session')) {
      const v = argv[++i]
      if (!v) return { ok: false, message: '-s/--session 需要一个句柄或别名' }
      flags.session = v
      continue
    }
    if (flagsAllowed && a === '--agent') {
      const v = argv[++i]
      if (!v) return { ok: false, message: '--agent 需要一个名字' }
      agent = v
      continue
    }
    if (flagsAllowed && a === '--limit') {
      const v = argv[++i]
      if (!v) return { ok: false, message: '--limit 需要一个数字' }
      flags.limit = Number(v)
      continue
    }
    if (flagsAllowed && a === '--save') {
      flags.save = true
      continue
    }
    if (flagsAllowed && a === '--bg') {
      flags.bg = true
      continue
    }
    if (flagsAllowed && a === '--async') {
      flags.async = true
      continue
    }
    if (flagsAllowed && a === '--json') {
      flags.json = true
      continue
    }
    if (flagsAllowed && a === '--hosts') {
      const v = argv[++i]
      if (!v) return { ok: false, message: '--hosts 需要逗号分隔的目标列表（如 --hosts web1,web2）' }
      flags.hosts = v
      continue
    }
    if (flagsAllowed && a === '--intent') {
      const v = argv[++i]
      if (!v) return { ok: false, message: '--intent 需要一句话说明（请加引号）' }
      flags.intent = v
      continue
    }
    if (flagsAllowed && a === '--mode') {
      const v = argv[++i]
      // 必须按八进制解析（cli-bridge-design 11.3）：Number('755') 是十进制的怪权限位
      if (!v || !/^[0-7]{1,4}$/.test(v)) {
        return { ok: false, message: '--mode 需要八进制权限位（如 --mode 755 / --mode 644）' }
      }
      flags.mode = parseInt(v, 8)
      continue
    }
    if (flagsAllowed && a === '--timeout') {
      const v = argv[++i]
      const n = Number(v)
      if (!v || !Number.isFinite(n) || n < 1) {
        return { ok: false, message: '--timeout 需要一个正整数秒数（如 --timeout 90）' }
      }
      flags.timeout = Math.floor(n)
      continue
    }
    if (flagsAllowed && a === '--') {
      args.push(...argv.slice(i + 1))
      sawPositional = true
      break
    }
    // 未知长选项在这里就打回：不然 `exec --oops "ls"` 会把 `--oops` 拼进命令文本，
    // 变成一次莫名其妙的闸门拒绝。命令本体确实要以 - 开头时用 `--` 分隔
    if (flagsAllowed && a.startsWith('-') && a !== '-') {
      return { ok: false, message: `未知参数 "${a}"，看 tsubasa-ssh --help；命令本体请整体加引号` }
    }
    if (cmd === null) {
      cmd = a
      continue
    }
    args.push(a)
    sawPositional = true
  }

  if (cmd === null || cmd === 'help') return { ok: true, local: 'help' }
  if (cmd === 'version') return { ok: true, local: 'version' }
  if (!SUBCOMMANDS.has(cmd)) {
    return { ok: false, message: `未知子命令 "${cmd}"，看 tsubasa-ssh --help` }
  }
  if (cmd === 'rz') cmd = 'push'
  if (cmd === 'push') {
    if (args.length !== 2) {
      return { ok: false, message: '用法：tsubasa-ssh push <本地文件> <远端绝对路径> [--mode 755]' }
    }
    // 本地路径在 CLI 侧 resolve 成绝对路径（11.2）：外部 agent 的 cwd 只有这里知道
    args[0] = resolve(args[0])
  }
  return {
    ok: true,
    request: { v: CLI_PROTOCOL_VERSION, clientId: clientId(), agent, cmd, args, flags }
  }
}

/**
 * 握手 token 的位置：shim 把 userData 目录烘进环境变量（应用每次启动重写 shim，
 * 路径永远是对的）；手动调用时按打包版的默认 userData 兜底。
 */
function readToken(): { ok: true; token: string } | { ok: false; message: string } {
  const dir =
    process.env.TSUBASA_SSH_USERDATA?.trim() ||
    (process.env.APPDATA ? join(process.env.APPDATA, APP_DATA_DIR_NAME) : '')
  if (!dir) {
    return { ok: false, message: '找不到 Tsubasa Terminal 的数据目录（TSUBASA_SSH_USERDATA 未设置）' }
  }
  const file = join(dir, CLI_TOKEN_FILE)
  try {
    const token = readFileSync(file, 'utf-8').trim()
    if (!token) throw new Error('empty')
    return { ok: true, token }
  } catch {
    return {
      ok: false,
      message:
        `读不到握手 token（${file}）。Tsubasa Terminal 未运行，或未在设置里打开 "CLI 通道"。` +
        '请让用户启动 Tsubasa Terminal 并勾选该项后重试——不要自己去拉起应用。'
    }
  }
}

function writeOut(text: string): void {
  process.stdout.write(Buffer.from(text, 'utf-8'))
}

function writeErr(text: string): void {
  process.stderr.write(Buffer.from(text, 'utf-8'))
}

/**
 * 退出：只设 exitCode，让事件循环自然排空后结束。
 * **不能用 `process.exit()`**——stdout 指向管道时它不保证冲刷，输出会被截断，
 * 而外部 agent 读到的正是这段被截断的内容。
 */
function exitWith(code: number): void {
  process.exitCode = code
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    writeErr(parsed.message + '\n')
    exitWith(CLI_EXIT.USAGE)
    return
  }
  if ('local' in parsed) {
    writeOut(parsed.local === 'help' ? USAGE : __CLI_VERSION__ + '\n')
    exitWith(CLI_EXIT.OK)
    return
  }
  // push 的本地预检（快速失败 + 好的错误信息；主进程会 fail-closed 再查一遍）
  if (parsed.request.cmd === 'push') {
    const local = parsed.request.args[0]
    try {
      if (!statSync(local).isFile()) throw new Error('not a file')
    } catch {
      writeErr(`本地文件不存在或不是普通文件：${local}\n`)
      exitWith(CLI_EXIT.USAGE)
      return
    }
  }
  const token = readToken()
  if (!token.ok) {
    writeErr(token.message + '\n')
    exitWith(CLI_EXIT.NOT_RUNNING)
    return
  }
  const request: CliRequest = { ...parsed.request, token: token.token }

  const socket = connect(cliPipeName(process.env))
  let buffer = ''
  let exited = false

  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (exited) return
    exited = true
    // 应用整体未运行 → 管道不存在 → ENOENT。**默认报错退 106，不自动拉起**：
    // 刚启动的应用是零会话，拉起买不到任何东西；"应用没开"本身就是"用户不在
    // 运维状态"的信号，而这条通道的安全叙事押在"右窗口用户看着"上。
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      writeErr(
        'Tsubasa Terminal 未运行（命名管道不存在）。请让用户启动 Tsubasa Terminal 并在设置里勾选 "CLI 通道"，' +
          '几秒后重试——不要自己去拉起应用。\n'
      )
      exitWith(CLI_EXIT.NOT_RUNNING)
      return
    }
    writeErr(`连接 Tsubasa Terminal 失败：${err.message}\n`)
    exitWith(CLI_EXIT.FAILED)
  })

  socket.on('connect', () => {
    socket.write(JSON.stringify(request) + '\n')
  })

  socket.setEncoding('utf-8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim()) {
        let frame: CliFrame | null = null
        try {
          frame = JSON.parse(line) as CliFrame
        } catch {
          frame = null
        }
        if (frame?.t === 'out') writeOut(frame.d)
        else if (frame?.t === 'err') writeErr(frame.d)
        else if (frame?.t === 'exit') {
          exited = true
          exitWith(frame.code)
          socket.end()
          return
        }
      }
      nl = buffer.indexOf('\n')
    }
  })

  socket.on('close', () => {
    if (exited) return
    exited = true
    writeErr('与 Tsubasa Terminal 的连接意外中断（未收到退出码）\n')
    exitWith(CLI_EXIT.FAILED)
  })
}

main()
