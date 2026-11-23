/**
 * CLI 通道协议（cli-bridge-design 第二节）。
 *
 * 命名管道上的**一问一答**：CLI 连上 → 写一行请求 JSON → 读若干帧 → 收到 exit 帧即退出。
 * 每次调用一个连接、一个请求，服务端不持连接态——粘性绑定住在服务端内存 Map（按 clientId），
 * 不落盘（应用重启后会话全没了，绑定随内存消亡正是对的语义）。
 *
 * 本文件被 **CLI 单文件产物**与主进程同时引用，因此**只放常量与类型**，
 * 不得 import electron / node 之外的任何东西。
 */

export const CLI_PROTOCOL_VERSION = 1

/** 默认管道名；两侧同读 TSUBASA_SSH_PIPE 覆盖（e2e 每个应用实例一条独立管道） */
export const CLI_DEFAULT_PIPE = '\\\\.\\pipe\\tsubasa-ssh'

/** 握手 token 文件名（userData 下）：只防误连到别的实例，不防同用户恶意进程 */
export const CLI_TOKEN_FILE = 'cli-token'

/**
 * userData 目录名（%APPDATA% 下）。与显示名 "Tsubasa Terminal" 解耦：
 * 目录不含空格，主进程启动时显式设定，CLI 手动调用时按它兜底找 token。
 */
export const APP_DATA_DIR_NAME = 'TsubasaTerminal'

export function cliPipeName(env: Record<string, string | undefined>): string {
  const override = env.TSUBASA_SSH_PIPE?.trim()
  return override ? override : CLI_DEFAULT_PIPE
}

export interface CliFlags {
  /** -s/--session：逐条覆盖粘性绑定（解析完即用，不读不写粘性） */
  session?: string
  /** log --limit N */
  limit?: number
  /** exec --save：大输出全量落远端文件，只回规模 + 预览 */
  save?: boolean
  /** exec --bg：常驻服务后台化（nohup 包装主进程拼），一律进审批台 */
  bg?: boolean
  /** exec / push --intent：一句话意图——提案卡 reason 复用 + 右栏 CLI 栏卡片上显示 */
  intent?: string
  /** exec --timeout：提案挂起窗口秒数，缺省 90（小于 CC Bash 的 120s）；
   *  到点**主动撤回提案**退 125——幽灵提案（用户批准一条早已被放弃的命令）的正解 */
  timeout?: number
  /** exec --async：提案挂起时立刻返回 proposalId，之后 `job <id>` 轮询 */
  async?: boolean
  /** exec --hosts：逗号分隔的目标列表（别名/句柄，2..7 台）。多机并行：
   *  白名单逐台旁路直执行；非白名单**一卡罩 N 台**。目标解析 fail-closed，
   *  不读不写粘性绑定，与 -s 互斥 */
  hosts?: string
  /** exec --json：stdout 改为结构化 JSON（--hosts 时自动启用——
   *  N 台的纯 stdout 分不清谁是谁） */
  json?: boolean
  /** push --mode：目标权限位。CLI 侧**按八进制**解析（parseInt(v,8)）
   *  后的数值——755 是 0o755 不是十进制 755 */
  mode?: number
}

export interface CliRequest {
  v: number
  token: string
  /** 粘性绑定的隔离键：TSUBASA_CLIENT ?? WT_SESSION ?? 'global'（CLI 侧算好带上） */
  clientId: string
  /** 自报家门（--agent）：审计 actor 记 `cli:<名>` */
  agent?: string
  cmd: string
  args: string[]
  flags: CliFlags
}

/** 服务端 → CLI 的流式帧（NDJSON）。exit 帧后服务端关闭连接 */
export type CliFrame =
  | { t: 'out'; d: string }
  | { t: 'err'; d: string }
  | { t: 'exit'; code: number }

/**
 * 退出码（cli-bridge-design 2.4）。LLM 读文本只能猜，外部 agent 能读退出码——
 * 这是 CLI 相对内置 Agent 的真实优势，故每个码的**补救动作必须互不相同**。
 *
 * 设计定稿之外补了两个（都落在 100/107 这两个空位，不与远端码 0..99 相混）：
 * - 100：握手失败（协议版本/token 对不上）——补救是"检查是不是连到了别的实例"；
 * - 107：命令未取得退出码（通道超时/异常）——**不能报 1**，报 1 等于告诉对方
 *   "命令跑了且失败了"，而真相是根本没跑完。
 */
export const CLI_EXIT = {
  /** 远端命令真实退出码占 0..99 */
  OK: 0,
  HANDSHAKE: 100,
  /** 闸门结构性拒绝——别重试同样写法 */
  GATE: 101,
  /** 用户否决（stderr 带 comment，按留言改方案） */
  DENIED: 102,
  /** 无会话 / 未绑定 / 绑定的会话已断连；v0.13.6 起也含"主机列表里没有这个别名 /
   *  列表为空"——补救同族（跑 hosts 看有哪些机器，或请用户添加），不另开码 */
  NO_SESSION: 103,
  /** 别名歧义：同主机多个会话（用 use <句柄> 指定），或主机列表里同名多台 */
  AMBIGUOUS: 104,
  /** 会话忙（内置 Agent 在跑 / 终端非空闲 / 已有待决提案）：稍后重试 */
  BUSY: 105,
  /** Tsubasa Terminal 未运行（不自动拉起） */
  NOT_RUNNING: 106,
  /** 执行失败：命令未取得退出码（超时 / 通道错误 / 工具异常） */
  FAILED: 107,
  /** 异步 job 未到终态（提案待决 / 命令执行中）：继续 `job <id>` 轮询。
   *  与 105"稍后重试同一条命令"是两个动作，故不合并 */
  PENDING: 108,
  /** 多机批量逐台结果不一致：逐台读 stdout JSON 的 results 分别处理。
   *  补救动作（逐台看、分别处理）与现有任何码都不同，故不合并 */
  MIXED: 109,
  /** push 同目标已有一笔传输在途：补救是等**那一笔**落地（--async 的
   *  用 job 轮询它）再重试——与 105"稍后重试本条"是两个等待对象，故不合并 */
  TRANSFER_BUSY: 110,
  /** 用法错误（未知子命令 / 缺参数 / 失效的 unit 引用 / 命令需整体加引号） */
  USAGE: 124,
  /** 审批超时，提案已主动撤回（命令未执行，可重发或改用 --async） */
  TIMEOUT: 125
} as const
