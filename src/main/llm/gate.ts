import type { AgentRisk } from '../../shared/types'
import { shellQuote } from '../../shared/shell'

/**
 * exec 闸门（security-design / agent-design）：argv 硬解析 + 只读白名单 + 规则风险分级。
 * 全部纯函数——不问 LLM"这条是不是只读"，被注入的 LLM 无降级权。
 *
 * 原则（agent-design 第六节）：
 * 1. 管道按段拆，每段 argv[0] 都在白名单才算只读；
 * 2. 重定向 / && / ; / $() / 反引号 / 换行 → 解析即 fail-closed；
 * 3. 无出站网络（DNS 也算）：curl/ping/dig 等永不进白名单——exfiltration 出口焊死；
 * 4. 无命令执行跳板：xargs/awk/sed/watch/find -exec 族排除；
 * 5. 白名单条目可带子命令约束与禁用参数表；初版从紧，放宽容易收紧难。
 */

// ---------- argv 解析（fail-closed） ----------

export type ParseResult =
  | { ok: true; segments: string[][]; hasGlob: boolean }
  | { ok: false; reason: string; hint?: string }

/**
 * 把命令解析为管道分段的 argv。支持单引号（字面）、双引号（内部 $ ` \ 视为
 * 展开风险直接 fail）、管道分段；任何其他 shell 元字符 fail-closed。
 *
 * 唯一放宽（agent-design 第六节）：`2>/dev/null` / `1>/dev/null` /
 * `>/dev/null` / `2>&1` 四个安全重定向整词形态判定时剥除——目标焊死在
 * /dev/null 或既有 fd，无写任意文件路径。约束：紧凑整词（到空白/管道/
 * ;/&/行尾——; & 本身仍在元字符层拒绝，收进边界只为报错指认真凶）、
 * fd 前缀必须是裸字符（'2'>/dev/null 在 shell 里 2 是参数不是 fd）；
 * 剥除只影响判定，执行仍发原始命令。其余 > < 形态照旧 fail-closed。
 */
export function parseCommand(command: string): ParseResult {
  const segments: string[][] = []
  let argv: string[] = []
  let token = ''
  let hasToken = false
  let tokenQuoted = false
  let hasGlob = false
  let i = 0

  const pushToken = (): void => {
    if (hasToken) {
      argv.push(token)
      token = ''
      hasToken = false
    }
    tokenQuoted = false
  }

  while (i < command.length) {
    const ch = command[i]
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return { ok: false, reason: '未闭合的单引号' }
      token += command.slice(i + 1, end)
      hasToken = true
      tokenQuoted = true
      // shellQuote() 对内嵌单引号生成 `'\''`：先闭合单引号，再在未引用区
      // 用反斜杠写一个字面 `'`，随后重开单引号。这里只认这一种由本项目
      // 自己生成的拼接缝，不泛化支持任意反斜杠转义，避免扩大硬解析语法面。
      if (command.slice(end + 1, end + 3) === "\\'" && command[end + 3] === "'") {
        token += "'"
        i = end + 3
      } else {
        i = end + 1
      }
    } else if (ch === '"') {
      const end = command.indexOf('"', i + 1)
      if (end === -1) return { ok: false, reason: '未闭合的双引号' }
      const inner = command.slice(i + 1, end)
      if (/[$`\\]/.test(inner)) {
        // 单命令也会撞上（如 grep "a\|b"），通用"拆分"引导指错方向——给针对性出路
        return {
          ok: false,
          reason: '双引号内含展开字符（$ ` \\）',
          hint: '字面量参数请改用单引号包裹（单引号内不做任何展开）'
        }
      }
      token += inner
      hasToken = true
      tokenQuoted = true
      i = end + 1
    } else if (ch === '|') {
      if (command[i + 1] === '|') return { ok: false, reason: '含 || 复合结构' }
      pushToken()
      if (argv.length === 0) return { ok: false, reason: '空管道段' }
      segments.push(argv)
      argv = []
      i += 1
    } else if (ch === ' ' || ch === '\t') {
      pushToken()
      i += 1
    } else if (ch === '>') {
      const rest = command.slice(i)
      const form = rest.startsWith('>/dev/null') ? '>/dev/null' : rest.startsWith('>&1') ? '>&1' : null
      const fdOk =
        !tokenQuoted && (form === '>/dev/null' ? ['', '1', '2'].includes(token) : token === '2')
      const after = form ? command[i + form.length] : undefined
      // 边界含 ; 与 &：`2>&1;` 的死因是后面的 ;，剥除后让解析走到那里报真凶
      // （; 在元字符层、& 在后台执行符分支照旧拒绝，这里只修诊断标签的指认精度）
      const atBoundary =
        after === undefined ||
        after === ' ' ||
        after === '\t' ||
        after === '|' ||
        after === ';' ||
        after === '&'
      if (!form || !fdOk || !atBoundary) {
        return { ok: false, reason: `含 shell 元字符 ${JSON.stringify(ch)}` }
      }
      // 剥除：fd 数字不进 argv
      token = ''
      hasToken = false
      tokenQuoted = false
      i += form.length
    } else if (ch === '&') {
      // & 单列：`&&` 与后台 `&` 死因不同，混报"含 shell 元字符 &"会让
      // 人与 LLM 都误判成 `2>&1` 的锅。后台 & 有正门（exec 的 background 参数，
      // 主进程代拼），给针对性 hint 指路——照 || 与双引号两条的先例
      if (command[i + 1] === '&') return { ok: false, reason: '含 && 复合结构' }
      return {
        ok: false,
        reason: '含后台执行符 &',
        hint: '后台启动常驻服务请把 exec 的 background 参数设为 true（系统代为后台化并落日志），不要自己写 &'
      }
    } else if (ch === '*' || ch === '?' || ch === '[' || ch === ']') {
      // glob 放宽：危险性是**宿主命令**的属性，不是 glob 的——`rm *`
      // 是灾难而 `grep ERROR /var/log/*.log` 是零风险，差别全在动词。判定层已经
      // 知道每段是不是只读白名单，就在那个前提下放行；非白名单命令带 glob 仍在
      // gateCommand 里打回（见 hasGlob 分支）。这里只标记，不决策。
      //
      // flag 位置的 glob 不放行：`tail -*` 在存在名为 `-f` 的文件的目录里会展开成
      // `tail -f`，而 deniedShort 查的是字面 argv，拦不住——不给这条缝。
      if (token.startsWith('-')) {
        return {
          ok: false,
          reason: `flag 参数中含 glob（${ch}）`,
          hint: "通配符请写在路径位置；确需作为 flag 值时用单引号包成字面量（如 --include='*.log'）"
        }
      }
      hasGlob = true
      token += ch
      hasToken = true
      i += 1
    } else if (ch === '~') {
      // ~ 的正门是主进程按主机档案的 $HOME 机械展开（见 expandTilde）——
      // 走到这里说明展开没发生：档案未就绪，或 ~user/ 这类非首位形态
      return {
        ok: false,
        reason: '含未展开的 ~',
        hint: '请改用绝对路径（主机 home 目录尚未探测到，或用了 ~user/ 形态）'
      }
    } else if (/[;<`$(){}\n\r!#^]/.test(ch)) {
      return { ok: false, reason: `含 shell 元字符 ${JSON.stringify(ch)}` }
    } else {
      token += ch
      hasToken = true
      i += 1
    }
  }
  pushToken()
  if (argv.length === 0) return { ok: false, reason: segments.length ? '空管道段' : '空命令' }
  segments.push(argv)
  return { ok: true, segments, hasGlob }
}

/**
 * `~` 展开：主进程按主机档案的 $HOME 机械替换，展开后再进硬解析——
 * argv 里落的是绝对路径，什么都没放松（与 cwd 前缀拼接同模式）。
 *
 * 只认词首且后接 `/` 或词尾的 `~`：引号内的 `'~/x'` 前面是 `'` 不匹配（那是
 * 字面量，shell 里本就不展开），`a~b` 的 `~` 也不是展开位。`~user/` 不处理——
 * 要查别人的 home 得先解析 passwd，超出机械替换的范畴，留给 parseCommand 打回。
 * home 用 shellQuote 包裹：含空格的 home 不会把一个词裂成两个，而 `'/root'/logs`
 * 在 shell 与 parseCommand 两边都拼回同一个 token。
 */
export function expandTilde(command: string, home: string | undefined): string {
  if (!home || !home.startsWith('/')) return command
  return command.replace(/(^|\s)~(?=\/|\s|$)/g, (_m, lead: string) => lead + shellQuote(home))
}

// ---------- 只读白名单 ----------

interface WhitelistEntry {
  /** 首个非 flag 参数必须在此列表内（有列表时必须存在该参数） */
  subcommands?: string[]
  /** 禁用短 flag 字母（在 -xyz 组合中逐字符查） */
  deniedShort?: string[]
  /** 禁用长 flag 前缀（--follow / --vacuum-size=1G 均按前缀匹配） */
  deniedLong?: string[]
  /** 吃掉下一个 token 的全局 flag（见 positionalArgs） */
  valueFlags?: string[]
  /** 附加校验（返回 false 则不进白名单） */
  validate?: (argv: string[]) => boolean
}

/**
 * 位置参数序列（子命令判定的唯一取词口径）。
 *
 * `valueFlags` 是**分离写法**吃值的全局 flag：`kubectl -n prod logs x` 里的
 * `prod` 是 `-n` 的值不是子命令，不跳过就会把只读的 logs 判成"未知子命令"
 * ——而 `-n` 前置正是 k8s 日常写法（v0.9.8 发现）。`--namespace=prod` 自带值，
 * 不吃下一个。
 *
 * 表按动词逐个填，**不设全局默认**：docker 故意留空——填了 `-H` 之后
 * `docker -H tcp://远端 ps` 会被正确识别成只读 `ps` 而自动执行，那是连到
 * 任意远程 daemon，比"认不出子命令所以拒绝"糟得多。少填 = 保守 = 安全侧。
 */
function positionalArgs(argv: string[], valueFlags: string[] = []): string[] {
  const words: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.includes(arg)) i += 1
      continue
    }
    words.push(arg)
  }
  return words
}

function firstSubcommand(argv: string[], valueFlags?: string[]): string | null {
  return positionalArgs(argv, valueFlags)[0] ?? null
}

/**
 * kubectl 的分离写法吃值 flag。`-n prod` 这类前置全局 flag 在 k8s 日常写法里
 * 极常见，漏一个就把只读子命令判成"未知"。`--context/--kubeconfig/--server/--as`
 * 也列在这里：它们被 deniedLong 独立拦截，收进来只为让子命令取词不跑偏。
 */
const KUBECTL_VALUE_FLAGS = [
  '-n',
  '--namespace',
  '-c',
  '--container',
  '-l',
  '--selector',
  '-o',
  '--output',
  '--since',
  '--since-time',
  '--tail',
  '--field-selector',
  '--sort-by',
  '--template',
  '--limit-bytes',
  '--max-log-requests',
  '--chunk-size',
  '--request-timeout',
  '--context',
  '--kubeconfig',
  '--server',
  '--as',
  '--user',
  '--cluster',
  '--token',
  '-v'
]

const WHITELIST: Record<string, WhitelistEntry> = {
  // 文件/目录（只读）
  ls: {},
  cat: {},
  head: {},
  tail: { deniedShort: ['f', 'F'], deniedLong: ['--follow'] },
  stat: {},
  file: {},
  wc: {},
  du: {},
  df: {},
  grep: {},
  pwd: {},
  readlink: {},
  realpath: {},
  basename: {},
  dirname: {},
  find: {
    deniedLong: ['--'],
    validate: (argv) =>
      !argv.some((a) =>
        /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/.test(a)
      )
  },
  // 系统信息
  uname: {},
  hostname: {},
  uptime: {},
  date: { validate: (argv) => !argv.some((a) => /^--set/.test(a) || a === '-s') },
  whoami: {},
  id: {},
  w: {},
  who: {},
  last: {},
  free: {},
  dmesg: { deniedShort: ['C', 'c', 'w', 'W'], deniedLong: ['--clear', '--follow'] },
  lscpu: {},
  lsblk: {},
  lsof: {},
  vmstat: {},
  printenv: {},
  // 进程
  ps: {},
  pgrep: {},
  pstree: {},
  // 网络（本机视图，不发包）
  ss: {},
  netstat: {},
  ifconfig: { validate: (argv) => argv.length <= 2 },
  ip: {
    validate: (argv) => {
      const object = firstSubcommand(argv)
      if (!object) return false
      if (!['addr', 'address', 'a', 'link', 'l', 'route', 'r', 'neigh', 'n'].includes(object)) {
        return false
      }
      const rest = argv.slice(argv.indexOf(object) + 1).filter((a) => !a.startsWith('-'))
      // `ip addr` 默认 show；有动作时只放行只读动作
      return rest.length === 0 || ['show', 'list', 'ls', 'get'].includes(rest[0])
    }
  },
  // 服务/容器
  systemctl: {
    subcommands: [
      'status',
      'show',
      'cat',
      'list-units',
      'list-unit-files',
      'list-timers',
      'list-dependencies',
      'is-active',
      'is-enabled',
      'is-failed',
      'is-system-running'
    ]
  },
  journalctl: {
    deniedShort: ['f'],
    deniedLong: ['--follow', '--vacuum', '--rotate', '--flush', '--relinquish-var', '--sync']
  },
  docker: {
    subcommands: ['ps', 'logs', 'inspect', 'images', 'version', 'info', 'top', 'port', 'diff', 'stats'],
    validate: (argv) => {
      // 远程 daemon 明确拒绝：此前靠 firstSubcommand 认不出 `-H` 的值
      // 而意外落拒，改成明说——将来给 docker 填 valueFlags 也不会开出"自动连
      // 任意远端 daemon"的口子（与 segmentTrustable 的同名判定同源）
      if (argv.some((a) => /^(-H|--host|--context|--config)(=|$)/.test(a))) return false
      const sub = firstSubcommand(argv)
      if (sub === 'logs' && argv.some((a) => a === '-f' || a === '--follow')) return false
      // stats 不带 --no-stream 会持续刷新挂死独立 channel
      if (sub === 'stats' && !argv.includes('--no-stream')) return false
      return true
    }
  },
  kubectl: {
    // v0.9.8：白名单与 POLYMORPHIC.kubectl 的只读表是两回事——那张表定"风险档"
    // （logs 是 low），这张表定"能不能免审批自动执行"。此前只有前者，于是
    // `kubectl logs x | grep ERROR` 整条链被拖去审批台，ACK 拉日志每次都要人点。
    //
    // 收得比 POLYMORPHIC 窄两项，都不是笔误：
    // - `config view` 吐 kubeconfig（client-certificate-data / token）——只读但不该进上下文
    // - `auth` 不收：subcommands 只查第一级，收了 auth 等于连 `auth reconcile`（写）一起收
    subcommands: [
      'get',
      'describe',
      'logs',
      'top',
      'explain',
      'version',
      'cluster-info',
      'api-resources',
      'api-versions'
    ],
    deniedLong: ['--follow', '--watch', '--raw', '--kubeconfig', '--context', '--server', '--as', '--token'],
    valueFlags: KUBECTL_VALUE_FLAGS,
    validate: (argv) => {
      // 短 flag 精确匹配，不用 deniedShort——它逐字符查组合，会把 `-owide`
      // 里的 w 当成 --watch 误伤（kubectl 的 `-o` 是 flag+值紧凑写法）
      if (argv.some((a) => a === '-f' || a === '-w')) return false
      const positional = positionalArgs(argv, KUBECTL_VALUE_FLAGS)
      const [sub, ...rest] = positional
      // `cluster-info dump` 会把所有 namespace 的所有 pod 日志倒出来——只读，
      // 但量级是"把整个集群塞进上下文"，与本版省 token 的初衷正相反
      if (sub === 'cluster-info' && rest[0] === 'dump') return false
      // secret 只读也不放行：`get secret -o yaml` 吐的是 base64 凭据团，脱敏层
      // 按关键词+熵设计（security-design 三、四条）抓不住它。子串匹配是为了
      // 覆盖 `secret/foo`、`pods,secrets`、`sealedsecrets` 这些形态
      if ((sub === 'get' || sub === 'describe') && rest.some((a) => /secret/i.test(a))) return false
      return true
    }
  },
  // 杂项
  which: {},
  whereis: {},
  echo: {},
  md5sum: {},
  sha256sum: {},
  sort: {},
  uniq: {},
  cut: {},
  tr: {},
  column: {}
}

/** 供设置页/文档展示的白名单命令列表 */
export function whitelistCommands(): string[] {
  return Object.keys(WHITELIST).sort()
}

/** 白名单条目的只读子命令集（风险分级复用，单一来源不漂移） */
function whitelistSubcommands(verb: string): string[] {
  return WHITELIST[verb]?.subcommands ?? []
}

function segmentAllowed(argv: string[]): boolean {
  const entry = WHITELIST[argv[0]]
  if (!entry) return false
  if (entry.subcommands) {
    const sub = firstSubcommand(argv, entry.valueFlags)
    if (!sub || !entry.subcommands.includes(sub)) return false
  }
  for (const arg of argv.slice(1)) {
    if (entry.deniedLong && arg.startsWith('--')) {
      if (entry.deniedLong.some((d) => arg.startsWith(d))) return false
    } else if (entry.deniedShort && /^-[^-]/.test(arg)) {
      if (entry.deniedShort.some((c) => arg.slice(1).includes(c))) return false
    }
  }
  if (entry.validate && !entry.validate(argv)) return false
  return true
}

// ---------- 风险分级（规则打底，LLM 无降级权） ----------

const RISK_ORDER: Record<AgentRisk, number> = { low: 0, mid: 1, high: 2 }

/** 包装词：风险分级找"真动词"时剥掉（白名单判定不剥——自动执行绝不切身份） */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'timeout', 'nice', 'time', 'doas'])

const HIGH_RISK_COMMANDS = new Set([
  'rm',
  'dd',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'iptables',
  'ip6tables',
  'nft',
  'ufw',
  'firewall-cmd',
  'userdel',
  'groupdel',
  'useradd',
  'usermod',
  'passwd',
  'chpasswd',
  'mkswap',
  'parted',
  'fdisk',
  'sfdisk',
  'wipefs',
  'shred',
  'crontab',
  // v0.9.2 补洞（三）破坏性整体提 high——文件系统
  'mke2fs',
  'mkdosfs',
  'mkntfs',
  'blkdiscard',
  'hdparm',
  'tune2fs',
  'resize2fs',
  'growpart',
  'fsck',
  'e2fsck',
  // 卷/阵列
  'lvremove',
  'vgremove',
  'pvremove',
  'lvresize',
  'mdadm',
  'zpool',
  'zfs',
  'btrfs',
  // 设备/交换
  'swapoff',
  'swapon',
  'losetup',
  'cryptsetup',
  // 身份/权限（su 同时是身份切换入口）
  'su',
  'visudo',
  'deluser',
  'adduser',
  'gpasswd',
  'chage',
  'setfacl',
  'chattr',
  // 内核模块
  'insmod',
  'rmmod',
  'modprobe'
])

/**
 * 带后缀变体的破坏性族——Set 精确匹配漏得掉（v0.9.2 补洞的起点正是
 * `mkswap` 在表内而 `mkfs.ext4` 判 low）。
 */
const HIGH_RISK_PATTERNS = [/^mkfs(\..+)?$/]

/**
 * 跳板动词（v0.9.2 补洞（二））：能执行任意代码，没有高频只读形态
 * （`python3 --version` 之类多打个 y 无所谓，`python3 -c` 的危险性不能赌）。
 * 同时是信任集的排除表——信任一个跳板等于信任它能跑的一切。
 */
const TRAMPOLINE_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'perl',
  'ruby',
  'node',
  'deno',
  'bun',
  'lua',
  'make',
  'cmake',
  'gcc',
  'cc',
  'g++',
  'clang',
  'xargs',
  'awk',
  'gawk',
  'mawk',
  'nsenter',
  'chroot',
  'unshare',
  'systemd-run',
  'at',
  'batch',
  'setsid',
  'screen',
  'tmux',
  'socat',
  'expect'
])

/** 跳板的版本后缀变体：python3.11 / php8.2 / gcc-12 */
const TRAMPOLINE_PATTERNS = [/^python[\d.]*$/, /^php[\d.]*$/, /^(gcc|g\+\+|clang)-[\d.]+$/]

/**
 * 跨机/跨集群动词：作用域超出"这台主机"——实验机的"实验"属性不传递给它能
 * 触达的资源（agent-design 矩阵节）。永不进信任集；风险档至少 mid。
 */
const CROSS_HOST_COMMANDS = new Set([
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'kubectl',
  'helm',
  'kubeadm',
  'terraform',
  'tofu',
  'ansible',
  'ansible-playbook',
  'aws',
  'gcloud',
  'az',
  'doctl'
])

const MID_RISK_COMMANDS = new Set([
  'mv',
  'cp',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'pkill',
  'killall',
  'mount',
  'umount',
  'tee',
  'truncate',
  'ln',
  'sed',
  'sysctl',
  'curl',
  'wget',
  'nc',
  'ncat',
  'git',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'npm',
  'pip',
  'pip3',
  // v0.9.2：跨机与跳板动词同样至少 mid（ssh/scp/rsync 原本就在表内）
  ...CROSS_HOST_COMMANDS,
  ...TRAMPOLINE_COMMANDS
])

/**
 * 多态动词（v0.9.2 补洞（一））：白名单认得的子命令 = 只读 = low，
 * 其余子命令 ≥ mid。这不是新机制，是把 v0.8 的 systemctl 特判泛化。
 * 判定**看子命令本身，不看参数形态过不过 validate**——`docker logs -f`
 * 因 -f 挂死独立 channel 进不了白名单，但它确实是只读，留在 low
 * （否则生产机上 `docker image ls` 要打主机别名，荒谬）。
 */
interface PolymorphicEntry {
  /** 只读子命令路径：单词或"两词"（`image ls`）；白名单 subcommands 自动并入 */
  readonly: string[]
  /** 直接判 high 的子命令路径 */
  high?: string[]
  /** 参数形态提级到 high（docker run --privileged 等价宿主 root） */
  highArgs?: (argv: string[], path: string[]) => boolean
  /** 吃掉下一个 token 的全局 flag（见 positionalArgs），子命令取词用 */
  valueFlags?: string[]
}

/** flag 的两种写法：`--pid=host` 与 `--pid host` */
function hasFlagValue(argv: string[], flags: string[], value: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    for (const flag of flags) {
      if (argv[i] === `${flag}=${value}`) return true
      if (argv[i] === flag && argv[i + 1] === value) return true
    }
  }
  return false
}

/** 容器等价宿主 root 的形态：特权、宿主命名空间、根挂载、SYS_ADMIN */
function containerEscapesSandbox(argv: string[]): boolean {
  if (argv.includes('--privileged')) return true
  if (hasFlagValue(argv, ['--pid'], 'host')) return true
  if (hasFlagValue(argv, ['--net', '--network'], 'host')) return true
  if (hasFlagValue(argv, ['--ipc'], 'host')) return true
  // `-v /:/host` 的挂载源在下一个 argv；`--volume=/:/host` 在同一个
  if (argv.some((a) => a.startsWith('/:') || a.startsWith('--volume=/:'))) return true
  if (argv.some((a) => /^--cap-add(=|$)/.test(a))) return true
  return false
}

const CONTAINER_ENTRY: PolymorphicEntry = {
  readonly: [
    'events',
    'history',
    'image ls',
    'image inspect',
    'image history',
    'container ls',
    'container inspect',
    'container logs',
    'container top',
    'volume ls',
    'volume inspect',
    'network ls',
    'network inspect',
    'context ls',
    'system df',
    'system info',
    'compose ps',
    'compose logs',
    'compose config'
  ],
  high: ['system prune'],
  highArgs: (argv, path) =>
    (path[0] === 'run' || path[0] === 'create') && containerEscapesSandbox(argv)
}

const POLYMORPHIC: Record<string, PolymorphicEntry> = {
  systemctl: {
    readonly: [],
    high: ['poweroff', 'reboot', 'halt', 'kexec', 'emergency', 'rescue']
  },
  docker: CONTAINER_ENTRY,
  podman: CONTAINER_ENTRY,
  kubectl: {
    readonly: [
      'get',
      'describe',
      'logs',
      'top',
      'explain',
      'version',
      'cluster-info',
      'api-resources',
      'api-versions',
      'config view',
      'auth can-i'
    ],
    // 没有这张表，`kubectl -n prod logs x` 的子命令会取到 `prod`，只读的 logs
    // 被判成 mid——生产机上再位移成 high，要求打主机别名才能看日志
    valueFlags: KUBECTL_VALUE_FLAGS
  },
  helm: { readonly: ['list', 'get', 'status', 'show', 'history', 'version'] }
}

/** 前两个位置参数（子命令路径），用于两级子命令判定 */
function subcommandPath(argv: string[], valueFlags?: string[]): string[] {
  return positionalArgs(argv, valueFlags).slice(0, 2)
}

/** 剥包装词后的真动词（sudo rm → rm）；v0.8 高危确认词也取这里 */
export function effectiveVerb(argv: string[]): string {
  let i = 0
  while (i < argv.length && WRAPPERS.has(argv[i])) {
    i += 1
    if (argv[i - 1] === 'env') {
      while (i < argv.length && (argv[i].includes('=') || argv[i].startsWith('-'))) i += 1
    } else if (argv[i - 1] === 'timeout') {
      while (i < argv.length && (/^\d/.test(argv[i]) || argv[i].startsWith('-'))) i += 1
    } else {
      while (i < argv.length && argv[i].startsWith('-')) i += 1
    }
  }
  return argv[i] ?? argv[0] ?? ''
}

function isTrampoline(verb: string): boolean {
  return TRAMPOLINE_COMMANDS.has(verb) || TRAMPOLINE_PATTERNS.some((re) => re.test(verb))
}

/** 单段风险：多态动词走子命令表，其余按动词表 + 参数形态 */
function segmentRisk(argv: string[]): AgentRisk {
  const verb = effectiveVerb(argv)
  const poly = POLYMORPHIC[verb]
  if (poly) {
    // effectiveVerb 剥过包装词（sudo docker …），子命令路径从真动词位置起算
    const rest = argv.slice(Math.max(argv.indexOf(verb), 0))
    const path = subcommandPath(rest, poly.valueFlags)
    const [one, two] = [path[0] ?? '', path.slice(0, 2).join(' ')]
    if (poly.high?.includes(one) || poly.high?.includes(two)) return 'high'
    if (poly.highArgs?.(rest, path)) return 'high'
    const readonly = [...poly.readonly, ...whitelistSubcommands(verb)]
    if (readonly.includes(one) || readonly.includes(two)) return 'low'
    return 'mid'
  }
  // 参数形态：find -delete 等价 rm -r；-exec 族是跳板
  if (verb === 'find') {
    if (argv.includes('-delete')) return 'high'
    return argv.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)) ? 'mid' : 'low'
  }
  // journalctl 无子命令概念（纯 flag）：只有写形态提级，其余照旧只读
  if (verb === 'journalctl') {
    return argv.some((a) => /^--(vacuum|rotate|flush|relinquish-var|sync)/.test(a)) ? 'mid' : 'low'
  }
  if (HIGH_RISK_COMMANDS.has(verb) || HIGH_RISK_PATTERNS.some((re) => re.test(verb))) return 'high'
  if (MID_RISK_COMMANDS.has(verb) || isTrampoline(verb)) return 'mid'
  return 'low'
}

/** 规则风险：解析成功按段取 max；解析失败按文本模式判（管道到 sh 等硬性高危） */
export function ruleRisk(command: string, parsed: ParseResult): AgentRisk {
  if (parsed.ok) {
    let risk: AgentRisk = 'low'
    for (const argv of parsed.segments) {
      const r = segmentRisk(argv)
      if (RISK_ORDER[r] > RISK_ORDER[risk]) risk = r
    }
    return risk
  }
  // 解析失败（复合/元字符）：管道到 shell、rm 等模式硬性判高，其余至少 mid
  if (/\|\s*(ba|z|da|k)?sh\b/.test(command) || /\brm\s+-[a-z]*r/.test(command)) return 'high'
  const verbs = command.match(/[a-z][\w.+-]*/gi) ?? []
  let risk: AgentRisk = 'mid'
  for (const v of verbs) {
    if (HIGH_RISK_COMMANDS.has(v) || HIGH_RISK_PATTERNS.some((re) => re.test(v))) risk = 'high'
  }
  return risk
}

/**
 * 信任集资格（v0.9.2 `a` 免问）：跨机跨集群与跳板动词永不可信任——
 * 前者的作用域超出"这台主机"，后者的粒度在"动词"上失去意义。
 * 与风险档正交：低风险的 `ssh` 形态同样不可信任。
 */
function segmentTrustable(argv: string[]): boolean {
  const verb = effectiveVerb(argv)
  if (CROSS_HOST_COMMANDS.has(verb) || isTrampoline(verb)) return false
  // 远程守护进程 = 另一台机器上的容器引擎
  if ((verb === 'docker' || verb === 'podman') && argv.some((a) => /^(-H|--host|--context)(=|$)/.test(a))) {
    return false
  }
  if (verb === 'find' && argv.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a))) return false
  return true
}

// ---------- 路径敏感度（identity-design）----------

/**
 * 与白名单、POLYMORPHIC 正交的第三个维度：白名单管"这个动词会不会改系统"，
 * 风险表管"同一命令的不同写法危险程度不同"，这里管"**这次读会不会泄密**"。
 * root 会话把"只读命令的破坏上限由 OS 权限位兜底"这层前提拆了（白名单里的 cat
 * 仍然只读、仍然自动执行，但 root 下能读全盘），脱敏是启发式不是权限，顶不了这个位置。
 *
 * **always-on，不按会话身份做条件分支**：SSH 私钥（.ssh/id_ 族）、~/.aws/credentials
 * 对登录用户同样可读、同样敏感——这层收紧由 root 会话逼出来，但生效不限于 root 会话。
 * 命中即取消自动执行资格（auto → propose）+ 档位至少 mid + 不可信任（免问通道全收）。
 */

/** POSIX 路径机械归一（仅供敏感度匹配，不改执行文本）：解析 ./ ../、压缩连续斜杠 */
function normalizePosix(path: string): string {
  const abs = path.startsWith('/')
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

const SENSITIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/^\/etc\/(shadow|gshadow)/, '系统口令散列'],
  [/^\/etc\/sudoers/, 'sudoers 配置'],
  [/\/\.ssh\/id_[^/]*$/, 'SSH 私钥'],
  [/^\/proc\/[^/]+\/environ$/, '进程环境变量（/proc/*/environ）'],
  [/^\/root\/\.[^/]*_history$/, 'root 命令历史'],
  [/\/\.aws\/credentials$/, '云凭据（AWS）'],
  [/\/\.kube\/config$/, '云凭据（kubeconfig）'],
  [/\/\.config\/gcloud\//, '云凭据（gcloud）'],
  [/\/\.docker\/config\.json$/, '容器 registry 凭据']
]

/**
 * glob 命中敏感区域同样取消资格：`cat /etc/shad*` 逐字面匹配不到 /etc/shadow，
 * glob 是绕过字面匹配的现成缝。宁可让 `ls /etc/*.conf` 多问一次，不给这条缝
 * ——放宽容易收紧难。
 */
const SENSITIVE_GLOB_AREAS: RegExp[] = [
  /^\/etc\//,
  /^\/root(\/|$)/,
  /^\/proc\//,
  /\/\.(ssh|aws|kube|docker)(\/|$)/,
  /\/\.config\/gcloud(\/|$)/
]

/**
 * 扫描全部管道段的路径样参数。相对路径按 cwd 解析——调用方必须传**命令实际执行
 * 时的 cwd**（与机械 cd 前缀恒等，identity-design 存量兜底节）；cwd 未知时按
 * 伪根解析，锚定根目录的模式（/etc /proc /root）自然失配、按 home 后缀写的模式
 * （.ssh/.aws 等）仍然命中。
 */
export function findSensitivePath(segments: string[][], cwd: string | null): string | null {
  for (const argv of segments) {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      // 裸 flag 跳过；--flag=value 查值的部分
      let candidate = arg
      if (arg.startsWith('-')) {
        const eq = arg.indexOf('=')
        if (eq === -1) continue
        candidate = arg.slice(eq + 1)
      }
      if (!candidate) continue
      // cwd 已知时每个参数都按相对文件名解析（`cd /etc && cat shadow` 的 shadow）；
      // cwd 未知时只查路径样参数（含 / 通配 或点前缀），裸词（子命令、关键词）不当路径查
      if (!cwd && !/[/*?[\]]|^\./.test(candidate)) continue
      const resolved = candidate.startsWith('/')
        ? normalizePosix(candidate)
        : normalizePosix(`${cwd ?? ''}/${candidate}`)
      if (/[*?[\]]/.test(resolved)) {
        if (SENSITIVE_GLOB_AREAS.some((re) => re.test(resolved))) {
          return `敏感区域内的通配符（${resolved}）`
        }
        continue
      }
      for (const [re, label] of SENSITIVE_PATH_PATTERNS) {
        if (re.test(resolved)) return `${label}：${resolved}`
      }
    }
  }
  return null
}

// ---------- 闸门总入口 ----------

export interface GateResult {
  action: 'auto' | 'propose' | 'reject'
  /** reject 时给 LLM 的引导文案 */
  reason?: string
  /** max(规则档, LLM 自报档)——LLM 只能升不能降 */
  risk: AgentRisk
  /** 首段剥包装词后的真动词（sudo rm → rm）；high 档审批确认词 */
  verb: string
  /** 本命令的动词是否可进 `a` 信任集；propose 路径才有意义 */
  trustable: boolean
  /** 命中的敏感路径说明：非空即已取消自动执行资格，审批卡片如实展示 */
  sensitive?: string
}

export interface GateOptions {
  /** 命令实际执行时的 cwd（白名单直通的 cd 前缀目录）；敏感度解析相对路径用 */
  cwd?: string | null
}

export function gateCommand(command: string, llmRisk: AgentRisk, opts?: GateOptions): GateResult {
  const trimmed = command.trim()
  const maxRisk = (rule: AgentRisk): AgentRisk =>
    RISK_ORDER[llmRisk] > RISK_ORDER[rule] ? llmRisk : rule

  if (!trimmed) {
    return { action: 'reject', reason: '命令为空', risk: llmRisk, verb: '', trustable: false }
  }
  if (trimmed.length > 4096) {
    return {
      action: 'reject',
      reason: '命令过长（>4096 字符）',
      risk: maxRisk('mid'),
      verb: '',
      trustable: false
    }
  }

  const parsed = parseCommand(trimmed)
  const ruleOnly = ruleRisk(trimmed, parsed)
  const risk = maxRisk(ruleOnly)
  const verb = parsed.ok ? effectiveVerb(parsed.segments[0]) : (trimmed.match(/[\w./-]+/)?.[0] ?? '')
  const trustable = parsed.ok && parsed.segments.every(segmentTrustable)

  if (!parsed.ok) {
    // 复合结构/元字符：mid 及以上打回要求拆分；解析器给了针对性 hint 时优先用
    return {
      action: 'reject',
      reason: `命令${parsed.reason}，未通过硬解析。${
        parsed.hint ?? '请拆分为单条简单命令（一条命令做一件事），复杂操作交由用户手动执行'
      }`,
      risk,
      verb,
      trustable: false
    }
  }

  // 等待类命令封偏门：远端 sleep/watch 占用用户终端且烧审批，
  // 等待的正门是 wait 工具（本地定时、免审批）——reject 并引导
  for (const argv of parsed.segments) {
    const waitVerb = effectiveVerb(argv)
    if (waitVerb === 'sleep' || waitVerb === 'watch') {
      return {
        action: 'reject',
        reason: `远端 ${waitVerb} 会占用用户终端，不是等待的正道。请改用 wait 工具本地等待（免审批），醒来后用只读命令复查状态`,
        risk,
        verb: waitVerb,
        trustable: false
      }
    }
  }

  // 路径敏感度：命中即取消自动执行资格。白名单判定不受影响（命令仍是
  // 只读），收的是"读什么"——凭据类文件进上下文要过人，免问快车道（auto/信任/空批）全关
  const sensitive = findSensitivePath(parsed.segments, opts?.cwd ?? null)
  const bumpMid = (r: AgentRisk): AgentRisk => (RISK_ORDER[r] < RISK_ORDER.mid ? 'mid' : r)

  if (parsed.segments.every(segmentAllowed)) {
    if (sensitive) {
      return { action: 'propose', risk: bumpMid(risk), verb, trustable: false, sensitive }
    }
    return { action: 'auto', risk, verb, trustable }
  }

  // glob 只在全段只读白名单的前提下放行——走到这里说明前提不成立，
  // `*` 展开成什么不该由审批台上那行看不出结果的文本决定
  if (parsed.hasGlob) {
    return {
      action: 'reject',
      reason:
        '通配符只在全部命令段都是只读白名单命令时放行；本命令不满足该前提。请改用明确路径，或先用 ls 列出再逐个处理',
      risk,
      verb,
      trustable: false
    }
  }

  // 白名单外：多段管道且**规则档** ≥ mid 打回拆分；其余进审批台交人定夺。
  // 用 ruleOnly 而非 max 档：自报只能升审批档位，不该有结构性否决权——
  // 否则 LLM 给 `kubectl logs x | grep ERROR` 自报 mid 就把一条纯只读管道打成
  // reject，它转头去拆分、去全量拉，越保守越费 token。
  if (parsed.segments.length > 1 && RISK_ORDER[ruleOnly] >= RISK_ORDER.mid) {
    return {
      action: 'reject',
      reason: '含写操作的管道命令请拆分为单条命令逐一提案',
      risk,
      verb,
      trustable: false
    }
  }
  // 单命令才可信任：多段管道每段动词不同，按首段动词记信任会漏掉后续段
  if (sensitive) {
    return { action: 'propose', risk: bumpMid(risk), verb, trustable: false, sensitive }
  }
  return { action: 'propose', risk, verb, trustable: trustable && parsed.segments.length === 1 }
}

/** 信任档位上限：high 永不进信任集（agent-design 摩擦阶梯） */
export function trustableRisk(risk: AgentRisk): boolean {
  return RISK_ORDER[risk] <= RISK_ORDER.mid
}

/**
 * 后台化包装：本文件是**唯一**被允许生成 `&` 与自由重定向的地方。
 *
 * 安全性同参数化 SQL——模板固定，插进去的 command 已过 parseCommand 消毒
 * （不含 & ; $() 反引号换行），改不了模板结构；logPath 由主进程生成，LLM 不能
 * 指定（否则 `>` 的目标回到 LLM 手里，等于绕开 gateWriteFile 的路径分险）。
 * 调用方铁律：先过闸门再包装，且包装后的原文即审批台展示原文即写进 pty 的文本。
 *
 * `</dev/null` 不能省（真机三档对比）：裸 `cat &` 读 tty 收 SIGTTIN 停住
 * （STAT=T，症状是"起来了又莫名其妙不动"）；`nohup cat &` 靠 GNU nohup 把终端
 * stdin 换成不可读 fd 挡住了 SIGTTIN，但读 stdin 的程序直接 exit 1；只有显式
 * `</dev/null` 给到可读的空输入、读操作拿干净 EOF。非 GNU 的 nohup（BusyBox/
 * Alpine）不做那层替换，在那里它是唯一防线。
 * 开头的 nohup 剥重——LLM 自带 nohup 时不叠第二层。
 */
export function wrapBackground(command: string, logPath: string): string {
  const body = command.trim().replace(/^nohup\s+/, '')
  return `nohup ${body} </dev/null >${logPath} 2>&1 &`
}

/**
 * 输出转存包装：`wrapBackground` 之外第二个被允许生成重定向的地方，
 * 安全性同源——模板固定、command 已过 parseCommand 消毒、path 主进程生成。
 *
 * 由来：大日志点查（"从一堆 INFO 里捞某个 request id"）此前只有两条路——全量拉
 * 回上下文烧几万 token，或者不查。正解是让输出落在**远端**文件，再用白名单
 * grep/tail 点查，上下文里只进捞出来的那几行。不设输出上界正是为了这个场景：
 * 转存不截断任何东西，贵的是"进上下文"而不是"跑出来"。
 *
 * 一次往返把四件事拿全（rc/行数/字节数/前 N 行预览）：预览让 LLM 立刻看清日志
 * 长什么样、该 grep 什么，省掉一轮盲试。`wc -lc <path` 用重定向读而非传文件名，
 * 输出里就不带文件名，解析少一种形态。
 */
export const SAVE_OUTPUT_SEP = '__TSUBASATERMINAL_SAVE__'

export function wrapSaveOutput(command: string, path: string, previewLines: number): string {
  const body = command.trim()
  return (
    `${body} >${path} 2>&1; echo "${SAVE_OUTPUT_SEP}$?"; wc -lc <${path}; ` +
    `echo ${SAVE_OUTPUT_SEP}; head -n ${previewLines} ${path}`
  )
}

export interface SavedOutput {
  exitCode: number | null
  lines: number | null
  bytes: number | null
  preview: string
}

/** wrapSaveOutput 的 stdout 解析；任何一段缺失都降级为 null，不抛 */
export function parseSaveOutput(stdout: string): SavedOutput {
  const parts = stdout.split(SAVE_OUTPUT_SEP)
  const head = parts[1] ?? ''
  const num = (raw: string | undefined): number | null => {
    const trimmed = raw?.trim()
    if (!trimmed) return null
    const value = Number(trimmed)
    return Number.isFinite(value) ? value : null
  }
  const [rcLine, wcLine] = head.split('\n')
  const wc = (wcLine ?? '').trim().split(/\s+/)
  return {
    exitCode: num(rcLine?.trim()),
    lines: num(wc[0]),
    bytes: num(wc[1]),
    preview: (parts[2] ?? '').replace(/^\n/, '')
  }
}

// ---------- write_file 闸门----------

export interface WriteGateResult {
  ok: boolean
  reason?: string
  /** 纯规则分险（write_file 无 LLM 自报档）：系统路径/凭据/启动文件 high，其余 mid，永不 low */
  risk: AgentRisk
  /** 高危确认词 = 目标文件名（与 exec 首词确认同构：看清你在批哪个文件） */
  confirmWord: string
}

/** 写入即高危的路径形态：系统目录、SSH 凭据、shell 启动文件、cron */
const HIGH_RISK_WRITE_PATTERNS = [
  /^\/(etc|boot|usr|lib|lib64|bin|sbin|sys|proc)\//,
  /^\/root\//,
  /\/\.ssh\//,
  /(^|\/)\.(bashrc|bash_profile|profile|zshrc|zshenv|zprofile)$/,
  /^\/var\/spool\/cron\b/
]

export const WRITE_FILE_CONTENT_LIMIT = 256 * 1024

/**
 * 远端写入目标的路径纪律 + 分险（v0.13.2 自 gateWriteFile 抽出，write_file 与
 * CLI push 共用一份——两处重复即两处漂移）。
 *
 * 分险取 **HIGH_RISK_WRITE_PATTERNS ∪ SENSITIVE_PATH_PATTERNS 字面命中**：前者管
 * "写坏系统"（/etc、/usr、.ssh/、shell 启动文件、cron），后者管"读泄密"——但写一个
 * 读敏感的文件（~/.aws/credentials 这类凭据文件恰好不在写入表里）就是凭据注入，
 * 同样得 high。两张表正交，写入场景取并集。
 */
export interface RemotePathGate {
  ok: boolean
  reason?: string
  /** 纯规则分险（无 LLM 自报档）：并集命中 high，其余 mid，永不 low */
  risk: AgentRisk
  /** 高危确认词 = 目标文件名（与 exec 首词确认同构：看清你在批哪个文件） */
  confirmWord: string
}

export function gateRemotePath(path: string): RemotePathGate {
  const confirmWord = path.split('/').filter(Boolean).pop() ?? ''
  const fail = (reason: string): RemotePathGate => ({ ok: false, reason, risk: 'mid', confirmWord })
  if (!path.startsWith('/')) return fail('路径必须是绝对路径')
  if (path.length > 1024 || /[\0\n\r]/.test(path)) return fail('路径过长或含非法字符')
  if (path.endsWith('/') || !confirmWord) return fail('路径必须指向文件而非目录')
  // 非规范形态（/../ /./ //）会让高危路径模式失配降档，fail-closed
  if (path.slice(1).split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return fail('路径含 . / .. / 连续斜杠，请提交规范化的绝对路径')
  }
  const high =
    HIGH_RISK_WRITE_PATTERNS.some((re) => re.test(path)) ||
    SENSITIVE_PATH_PATTERNS.some(([re]) => re.test(path))
  return { ok: true, risk: high ? 'high' : 'mid', confirmWord }
}

export function gateWriteFile(path: string, content: string): WriteGateResult {
  const pathGate = gateRemotePath(path)
  if (!pathGate.ok) {
    return { ok: false, reason: pathGate.reason, risk: 'mid', confirmWord: pathGate.confirmWord }
  }
  if (content.length > WRITE_FILE_CONTENT_LIMIT) {
    return {
      ok: false,
      reason: '内容过大（>256KB），请拆分为多个文件或交由用户手动处理',
      risk: 'mid',
      confirmWord: pathGate.confirmWord
    }
  }
  return { ok: true, risk: pathGate.risk, confirmWord: pathGate.confirmWord }
}
