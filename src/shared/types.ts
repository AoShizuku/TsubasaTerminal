/** 主机环境等级：非机密字段；审批矩阵/审计取值走主进程 SessionMeta 不信 renderer */
export type HostEnvLevel = 'none' | 'production' | 'experiment'

/**
 * 登录后身份切换（identity-design）：先只做 `sudo -i` 形态，
 * `su -` 留待需要时再加。登录时定死、全程不变——把"中途分叉"变成"没有分叉"。
 */
export type HostElevate = 'none' | 'sudo'

/** 身份切换降级原因（徽章带原因，消灭"用户以为自己是 root"的猜谜） */
export type ElevationFailReason =
  /** sudo 要密码但主机未配置 sudoPassword */
  | 'no-password'
  /** 密码被拒（pty 握手阶段第二次出现密码提示） */
  | 'password'
  /** sudo -i 后身份仍非 root（不在 sudoers / 策略拒绝） */
  | 'not-root'
  /** exec 通道探活全不通（requiretty 等——`-n` 与 `-S` 都被拒） */
  | 'no-exec-auth'
  /** sftp-server 二进制探不到（internal-sftp / 非常规路径），v0.11.2 */
  | 'no-sftp-server'
  /** root 版 SFTP 起不来（ssh2 内部 API 不匹配 / sudo 拒 / 超时），v0.11.2 */
  | 'sftp-init'
  /** pty 握手超时（提示匹配不到时的兜底，不永久挂起） */
  | 'timeout'
  /** 其他异常（版本解析失败/会话中断等） */
  | 'error'

/** 身份切换结果（渲染进程徽章消费；随 ssh:elevation 事件推送） */
export interface ElevationInfo {
  /** 主机配置勾选了"登录后以 root 运行" */
  requested: boolean
  /** 握手 + 探活全过：pty 与独立 exec 通道均以 root 运行（all-or-nothing） */
  active: boolean
  /** active=false 时的降级原因 */
  reason?: ElevationFailReason
}

/** 渲染进程可见的主机配置——不含任何机密字段，密码/口令只存在于主进程 */
export interface HostConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  privateKeyPath?: string
  /** 连接后装载 shell integration（OSC 133/7）；缺省视为开启 */
  shellIntegration?: boolean
  /** 环境等级；缺省 none */
  envLevel?: HostEnvLevel
  /** 断线保活：连接后自动 attach 到服务端 tmux 会话池（缺省关） */
  tmuxKeepalive?: boolean
  /**
   * 本机输入方式：覆盖全局 `terminalInputMode`；缺省 = 跟随全局。
   * 只此一级，不做标签级覆盖；无 SI 会话仍强制直通，与此无关。
   */
  inputMode?: TerminalInputMode
  /** 登录后以 root 运行：连接握手阶段 `sudo -i` 切换，缺省 none */
  elevate?: HostElevate
  /** sudo 密码已配置（机密本体 safeStorage 加密存主进程，明文永不跨 IPC） */
  hasSudoPassword?: boolean
  /**
   * sftp-server 二进制路径覆盖：留空则按发行版候选列表探测，
   * 再回落到 sshd_config 的 `Subsystem sftp` 行。非机密，可跨 IPC。
   */
  sftpServerPath?: string
  /**
   * 本机知识：人写人改的静态事实（拓扑/约定/禁忌/词汇表），
   * 直插 system prompt，Agent 只读——**指令通道只能人写**，故不给 Agent 写入工具。
   * 非机密面（可跨 IPC），上限 KNOWLEDGE_LIMIT 字符。
   */
  knowledge?: string
}

/** 知识块字符上限（全局块与 per-host 块同额）：它每轮都在 system 里，不能无界 */
export const KNOWLEDGE_LIMIT = 4000

/** 新建/编辑主机的表单载荷；编辑时密码/口令留空表示保持原值 */
export interface HostInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  privateKeyPath?: string
  shellIntegration?: boolean
  envLevel?: HostEnvLevel
  tmuxKeepalive?: boolean
  /** 缺省 = 跟随全局 */
  inputMode?: TerminalInputMode
  elevate?: HostElevate
  sftpServerPath?: string
  knowledge?: string
  password?: string
  passphrase?: string
  /** sudo 密码；编辑时留空表示保持原值 */
  sudoPassword?: string
}

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface HostKeyInfo {
  status: 'new' | 'match' | 'mismatch'
  fingerprint: string
  storedFingerprint?: string
}

export interface SshConnectResult {
  ok: boolean
  error?: string
  hostKey?: HostKeyInfo
}

export interface TerminalSize {
  cols: number
  rows: number
}

/** 独立 exec channel 的执行结果（Tab 补全实时查询；v0.6 L2 预取 / v0.7 Agent 复用） */
export interface SshExecResult {
  ok: boolean
  stdout?: string
  exitCode?: number
  error?: string
}

export interface SftpEntry {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  size: number
}

export interface SftpHomeResult {
  ok: boolean
  path?: string
  error?: string
}

export interface SftpListResult {
  ok: boolean
  entries?: SftpEntry[]
  error?: string
}

export interface SftpTransferResult {
  ok: boolean
  canceled?: boolean
  savedTo?: string
  uploaded?: string[]
  error?: string
}

/** ZMODEM 拦截桥方向：远端 sz = 下载到本地，远端 rz = 上传到远端 */
export type ZmodemKind = 'download' | 'upload'

export interface BridgeDownloadResult {
  ok: boolean
  canceled?: boolean
  /** 本地保存目录 */
  savedTo?: string
  /** 逐文件结果（解析为 POSIX 绝对路径后） */
  files?: Array<{ name: string; ok: boolean; error?: string }>
  error?: string
}

/** 渲染进程组装、上报主进程的原始转录单元（未净化未脱敏） */
export interface TranscriptUnitRaw {
  /** composer 整行发送时的精确命令文本；直打/pty 交互场景为 null */
  command: string | null
  /** B..C 段原始文本（prompt 后的输入回显，直打命令的近似来源） */
  echo: string
  /** C..D 段原始输出 */
  output: string
  outputTruncated: boolean
  exitCode: number | null
  cwd: string | null
  /** pty 身份：SI 脚本随 OSC 7 上报的 id -un，命令启动时的值；未上报为 null */
  ptyUser: string | null
  startedAt: number
  endedAt: number
}

/** 主进程出口的转录单元：已净化（ANSI/OSC 剥离、Unicode 归一）+ 已脱敏 */
export interface TranscriptUnit {
  id: number
  command: string
  output: string
  outputTruncated: boolean
  exitCode: number | null
  cwd: string | null
  /** pty 身份：执行该命令的 shell 上报的 id -un；SI 未上报为 null */
  ptyUser: string | null
  /** 本单元脱敏命中数 */
  redactions: number
  startedAt: number
  endedAt: number
}

/** 转录单元概要（勾选 picker 用，不含输出正文——正文不进 picker 的 IPC） */
export interface TranscriptUnitSummary {
  id: number
  command: string
  exitCode: number | null
  cwd: string | null
  endedAt: number
  outputBytes: number
  redactions: number
}

/** 脱敏明细（按类型聚合，不回传原文——自持凭据原文绝不出主进程） */
export interface RedactionSummaryEntry {
  type: string
  fingerprint: string
  count: number
}

/**
 * 终端输入载体（composer-design）：
 * - composer  固定增强输入栏——键先进本地 textarea，Enter 整行写 pty（默认）
 * - native    原生终端直通——键由 xterm 逐段直写 pty，编辑/历史/补全归远端 shell
 */
export type TerminalInputMode = 'composer' | 'native'

/**
 * 终端可写状态：渲染进程上报给主进程的 write-safe 事实。
 * 只有 `clean` 允许 Agent/CLI 把整行命令写进用户 pty；其余全是"不可写 + 原因"。
 * fail-closed：主进程从未收到上报时视为未知=不可写。
 * - clean            prompt 且输入行为空（固定模式恒空；native 靠 133;A 复位；
 *                    none 靠用户显式声明）
 * - dirty            native prompt 下用户已敲了半行
 * - running          命令运行中
 * - tui              备用屏幕（vim/htop）
 * - none-unverified  无 shell integration，无法确认输入行为空
 */
export type TerminalWriteStatus = 'clean' | 'dirty' | 'running' | 'tui' | 'none-unverified'

/** 应用全局设置（userData/settings.json，主进程持有） */
export interface AppSettings {
  /** 凭据脱敏闸门总开关；关闭后转录出口与命令历史保留原文（净化仍然执行） */
  redactionEnabled: boolean
  /**
   * 最后一次选择的 LLM profile。v0.13.14 起只是新会话的默认与非对话用途（L3 建议）
   * 的口径——各会话各自持有选择，活动对话锁定在自己的 profile 上
   */
  activeLlmProfileId: string | null
  /** 补全 L3：命令结束后用 LLM 预测下一条/修复建议（烧用户自己的 key，默认关） */
  completionLlmEnabled: boolean
  /** 终端配色方案 id（shared/terminalThemes.ts；未知 id 回退默认） */
  terminalTheme: string
  /** 终端字体（放在内置回退栈最前；空串 = 默认栈） */
  terminalFontFamily: string
  /** 终端字号（px） */
  terminalFontSize: number
  /** 终端选中即复制（PuTTY 传统）；关闭后走 Ctrl+Shift+C / composer 的 Ctrl+C 键盘路径 */
  terminalCopyOnSelect: boolean
  /**
   * 直通多行粘贴前确认：默认开。开着时也只在远端未开启 bracketed paste
   * 时才问——开启了的 shell 把整块粘贴放进行缓冲、回车才执行，本就不会逐行跑。
   */
  terminalConfirmMultilinePaste: boolean
  /**
   * 关闭忙碌会话前确认：默认开。"忙"只看终端输入路由状态——命令运行中
   * （含疑似卡住的 stalled）或全屏应用中；无 shell integration 的会话判断不了，不问。
   */
  terminalConfirmCloseBusy: boolean
  /**
   * 终端输入方式：composer=固定增强输入栏（默认），native=原生直通。
   * v0.13.19 起是"默认输入方式"：主机可用 `HostConfig.inputMode` 单独指定；
   * 无 SI 会话恒为直通，与此设置无关。
   */
  terminalInputMode: TerminalInputMode
  /**
   * 全局知识：适用于所有主机的人写事实（"我们公司日志都在 /data/logs"），
   * 与 per-host 的 HostConfig.knowledge 两级拼接，免得在 50 台机器上各写一遍。
   */
  globalKnowledge: string
  /**
   * CLI 通道总开关：开启后主进程监听命名管道并把 shim 三件套写进
   * `%LOCALAPPDATA%\tsubasa\bin`（每次启动自愈）。**默认关**——这条管道是
   * "能让主进程替我执行"的钥匙，同用户任何进程连上就能操纵所有已连会话，
   * 是引入 CLI 后唯一的新增攻击面，必须由人显式打开。
   */
  cliBridgeEnabled: boolean
  /** 装 Claude Code skill（~/.claude/skills/tsubasa-ssh/） */
  cliSkillClaude: boolean
  /**
   * 装 Codex skill（~/.agents/skills/tsubasa-ssh/，与 CC 逐字节同文件）。
   * v0.13.17 前落 ~/.codex/skills/tsubasa-ssh/，安装/卸载时按 manifest 迁移清理。
   */
  cliSkillCodex: boolean
  /**
   * 三栏布局记忆：显隐、宽度与右栏当前 tab。这五个字段是**直接操作
   * 留下的痕迹**（拖把手、点折叠、切 tab），只记不配——不进设置面板。运行期真值在
   * 渲染进程 `useUiStore`，这里只是持久化镜像，别的模块不要从 settings 读它们。
   * 宽度边界与默认值见 shared/layout.ts。
   */
  leftPaneOpen: boolean
  rightPaneOpen: boolean
  leftPaneWidth: number
  rightPaneWidth: number
  rightPanelTab: RightPanelTab
  /** 界面密度（同姊妹项目）：只改主机行、文件行与控件的高度，不改字号 */
  uiDensity: UiDensity
  /**
   * 界面字号：整张字号角色表同步抬 0 / 1 / 2px，角色之间的比例不变。
   * 终端网格字号是 terminalFontSize，与此无关
   */
  uiFontSize: UiFontSize
}

/** 右栏 tab（Agent / 文件 / CLI；CLI 只在 CLI 通道总开关开着时出现） */
export type RightPanelTab = 'agent' | 'files' | 'cli'

export type UiDensity = 'compact' | 'standard' | 'cozy'
export const UI_DENSITIES: readonly UiDensity[] = ['compact', 'standard', 'cozy']

export type UiFontSize = 'standard' | 'large' | 'larger'
export const UI_FONT_SIZES: readonly UiFontSize[] = ['standard', 'large', 'larger']

/** skill 安装目标：两家 skill 格式相同，同一份 SKILL.md 直落两个目录 */
export type CliSkillTarget = 'claude' | 'codex'

/**
 * skill 安装态：`modified` 是关键的一档——目标文件 hash 与原地标记
 * （`.tsubasa-ssh-install.json`）对不上 = 用户手工改过，**绝不静默覆盖**。
 * 这是"指令通道只能人写"纪律的镜像：我们写进别人指令通道的东西，也要尊重人后来的修改。
 */
export type CliSkillState = 'absent' | 'installed' | 'outdated' | 'modified'

export interface CliSkillStatus {
  target: CliSkillTarget
  /**
   * 宿主目录（~/.claude、~/.codex）是否存在——决定默认勾选态与状态文案。
   * Codex 的宿主仍按 ~/.codex 判断，与 skill 落点（~/.agents/skills）无关。
   */
  hostPresent: boolean
  state: CliSkillState
  /** 已装版本（来自原地标记）；未装为 null */
  installedVersion: string | null
  /** skill 落点 */
  dir: string
  /**
   * 仍存在的旧落点（仅 Codex 的 ~/.codex/skills/tsubasa-ssh/）。安装/卸载会清掉
   * manifest 记录且未改的文件，留下的是手工改过或非本安装器写入的内容，不删，由状态行
   * 提示用户处理；指向新落点的链接不算残留；无残留为 null
   */
  legacyDir: string | null
}

export interface CliInstallStatus {
  /** 设置里的总开关值（管道是否在监听看 listening） */
  enabled: boolean
  listening: boolean
  pipeName: string
  shimDir: string
  /** 三件套是否都在且内容为当前版本 */
  shimsInstalled: boolean
  /** shim 目录是否已在 HKCU PATH 里 */
  onPath: boolean
  /** 本进程被要求跳过 PATH 改动（e2e / 便携场景），UI 据此不报"未加入 PATH" */
  pathManaged: boolean
  /** CLI 单文件产物路径；缺失说明构建没产出（开发期忘了 build:cli） */
  cliScript: string
  cliScriptExists: boolean
  skills: CliSkillStatus[]
  version: string
}

/** LLM 服务 profile——apiKey 不在此结构（safeStorage 加密单独存，渲染进程只见 hasKey） */
/**
 * 思考档位：跨 provider 统一的深度旋钮，各分支映射到自家参数。
 * 数字预算（Anthropic budget_tokens）已被上游废弃——Claude 5 家族直接 400，
 * OpenAI 从来只有档位——故本地不再保留数字通道。
 *
 * - `inherit` 不发任何思考参数，跟随模型自身默认（BYOK 下 model 是用户自填的
 *   任意字符串，这是唯一保证不会因参数不被支持而 400 的选项，故为缺省）
 * - `none` 显式关闭（Anthropic `thinking.disabled` / OpenAI `effort:'none'`）
 * - 其余四档直接对应两边的 effort 取值
 *
 * 注意 `xhigh`/`max` 并非所有模型都支持（Anthropic 4.6 系无 xhigh，
 * OpenAI 按模型给子集），选错由上游 400 兜底并透到设置弹窗。
 */
export type ThinkingLevel = 'inherit' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LlmProfile {
  id: string
  name: string
  provider: 'anthropic' | 'openai-compatible'
  /** 仅 openai-compatible：wire format，缺省 chat.completions */
  wireFormat?: 'chat.completions' | 'responses'
  /** 空 = 官方端点 */
  baseURL?: string
  model: string
  /** 思考档位；缺省 inherit（不发参数） */
  thinking?: ThinkingLevel
  /** 上下文窗口（tokens）——token 用量圆环的分母；缺省按 200k 显示 */
  contextWindow?: number
  hasKey: boolean
}

/** 新建/编辑 profile 的表单载荷；编辑时 apiKey 留空表示保持原值 */
export interface LlmProfileInput {
  id?: string
  name: string
  provider: 'anthropic' | 'openai-compatible'
  wireFormat?: 'chat.completions' | 'responses'
  baseURL?: string
  model: string
  thinking?: ThinkingLevel
  contextWindow?: number
  apiKey?: string
}

/** exec 工具的风险档位（规则打底取 max，LLM 自报只能升不能降） */
export type AgentRisk = 'low' | 'mid' | 'high'

/** 排障经验作用域：host=仅归属主机；global=所有主机通用（跨机复用的因果经验） */
export type ExperienceScope = 'host' | 'global'

/** 梗概行上限（"症状 → 结论"一句话——列表与 system 索引里认得出就够，不是正文） */
export const EXPERIENCE_SUMMARY_LIMIT = 80
/** 正文字符上限（约 4KB）：正文按需读不常驻，但单条也不能膨胀成小文档库 */
export const EXPERIENCE_DETAIL_LIMIT = 4096
/** 注入上限：pinned 固定 + 其余按创建时间新者优先截断；淘汰 = 不注入，不是删除 */
export const EXPERIENCE_HOST_INJECT_LIMIT = 20
export const EXPERIENCE_GLOBAL_INJECT_LIMIT = 10

/**
 * 排障经验索引行（knowledge-design 第四节）。正文分文件存（<id>.md），
 * 列表与注入只读索引。lastReadAt/readCount 只作治理参考（帮人认僵尸条目），
 * **不参与淘汰**——可见性上的 LRU 有饿死反馈环，且淘汰顺序会被 Agent 读取行为驱动。
 */
export interface ExperienceMeta {
  id: string
  scope: ExperienceScope
  /** scope='host' 时的归属主机 */
  hostId?: string
  /** 梗概：须为"症状 → 结论"形态（触发词是 Agent 一定会撞上的症状词，不是真因） */
  summary: string
  /** 固定注入（计入上限），不被 createdAt 截断挤出 */
  pinned: boolean
  createdAt: number
  /**
   * 最后一次人工编辑；从未改过则缺席（老索引行天然如此，无需迁移）。
   * **只用于展示**——注入排序恒按 createdAt，编辑是"修正"不是"重新记一条"，
   * 若编辑刷新排序键，改一条老经验就会把它顶到队首、把别人挤出注入上限。
   */
  updatedAt?: number
  lastReadAt: number | null
  readCount: number
  /** 来源对话（可回跳看当时的完整上下文）；对话被清理后悬空但保留 */
  sourceConvId?: string
  /** 正文字节数 */
  bytes: number
  /** 运行时注入（list 出口按查询主机计算，即"下一个对话"的口径）；不落盘 */
  injected?: boolean
}

/** 保存经验（补录 UI 与工具审批通过后共用同一入口） */
export interface ExperienceSaveInput {
  scope: ExperienceScope
  hostId?: string
  summary: string
  detail: string
  sourceConvId?: string
}

/**
 * 编辑已存经验。**补丁语义，不是全量覆盖**：hostId 缺省沿用旧值。
 * 若按"传什么写什么"覆盖，一次漏传就写出 `scope:'host'` 而 hostId 空的孤儿——
 * 注入侧 hostId 永不匹配、管理面板也筛不出来，成为看不见又删不掉的幽灵条目。
 */
export interface ExperienceUpdateInput {
  id: string
  summary: string
  detail: string
  scope: ExperienceScope
  /** scope='host' 时的归属主机；不传则沿用旧值（改不动归属，只改内容/作用域） */
  hostId?: string
}

/**
 * 经验写入结果：此前校验不过是**静默丢弃**（照常返回列表，UI 看不出
 * 没存上）。开了编辑之后长文粘贴就会撞上，故写入口一律回执成败与原因。
 */
export interface ExperienceWriteResult {
  ok: boolean
  /** ok=false 时的人话原因（直接显示给用户） */
  reason?: string
  /** 写后的最新列表（成败都给，UI 单点刷新） */
  list: ExperienceMeta[]
}

/** 补录路径的 Agent 草稿（LLM 失败/无 key 时给空模板，fallback=true） */
export interface ExperienceDraft {
  summary: string
  detail: string
  fallback: boolean
}

/** save_experience 审批中用户的修改（人写即指令通道，主进程仅做长度/非空校验） */
export interface ExperienceEdits {
  summary: string
  detail: string
  scope: ExperienceScope
}

/** 审批台提案（渲染展示副本；执行永远以主进程自存原文为准。
 *  save_experience 例外：用户在查看器里改过的内容随批准回传——人写即指令通道，
 *  这正是"Agent 可起草、落盘必须过人眼"的实现形态） */
export interface AgentProposal {
  id: string
  /** exec=命令执行；write_file=文件写入；save_experience=存排障经验；
   *  transfer=CLI push 文件上传；continue=轮数熔断续跑确认 */
  kind: 'exec' | 'write_file' | 'save_experience' | 'transfer' | 'continue'
  /** exec 的命令原文；其余 kind 为空串 */
  command: string
  risk: AgentRisk
  /** LLM 自报的解释文案（只管解释，不参与定罪） */
  reason: string
  /** 高危确认词：exec=剥包装词后的真动词（sudo rm → rm），write_file=目标文件名 */
  verb: string
  createdAt: number
  /** write_file / transfer：远端目标绝对路径（transfer 为 canonical 形态，父目录已 realpath） */
  path?: string
  /** write_file：写入内容全文（只读查看器逐行展示，不截断——工具层已限 256KB） */
  content?: string
  /** write_file / transfer：目标是否已存在（覆盖警示）；undefined=stat 失败无法确认 */
  exists?: boolean
  /** write_file / transfer：覆盖时原文件字节数 */
  oldSize?: number
  /** transfer：本机源文件绝对路径——卡上完整显示不截断（来路可辨是仅有的缓解） */
  localPath?: string
  /** transfer：源文件字节数（提案时 stat；实际以传输时读到的为准） */
  size?: number
  /** transfer：显式 --mode（八进制字符串如 "755"）；空 = 新建随 umask / 覆盖接原 mode */
  modeStr?: string
  /** transfer：覆盖时原文件属主标注（root / uid N）——rename 换 inode 会换走属主 */
  owner?: string
  /** transfer：超过大文件阈值（100MB），卡上显眼标注 */
  large?: boolean
  /** exec：本命令的动词可否进 `a` 信任集（跨机/跳板动词与 high 档不可） */
  trustable?: boolean
  /** 空 Ctrl+Enter 即批准（v0.9.2 摩擦阶梯：low 档、非生产机、非 continue） */
  blankApprove?: boolean
  /** save_experience：梗概（"症状 → 结论"；查看器中可改） */
  summary?: string
  /** save_experience：正文（查看器中可改；工具层已限 4KB） */
  detail?: string
  /** save_experience：作用域（查看器中可改） */
  scope?: ExperienceScope
}

/** withdrawn：CLI 提案超时主动撤回——不是用户拒绝，渲染侧只清卡不进运行态 */
export type ProposalDecision = 'approved' | 'denied' | 'withdrawn'

/**
 * 多机批量提案（cli-bridge-design 第九节）：CLI `--hosts` 的"一卡罩 N 台"。
 * 渲染为跨会话单例的批次浮层，不进 per-会话审批台（approvalStore）——审批输入语义
 * 全局唯一由 Composer 的 Ctrl+Enter 拦截保证。执行仍以主进程自存的逐台原文为准。
 */
export interface MultiProposalTarget {
  sessionId: string
  /** 8hex 会话句柄 */
  handle: string
  /** 主机显示别名 */
  name: string
  /** applyEnvShift 后的逐台档位（生产机/root 位移已计入） */
  risk: AgentRisk
  envLevel: HostEnvLevel
  elevated: boolean
}

export interface MultiProposalView {
  id: string
  /** 命令原文（各台按自身 cwd/包装执行，效果文本逐台不同——卡上标注即可） */
  command: string
  /** 整批档位 = max(逐台)；high 确认词用动词不用主机名 */
  risk: AgentRisk
  verb: string
  reason: string
  createdAt: number
  /** 挂起窗口（撤回倒计时的分母；--async 长窗口同样如实显示） */
  timeoutMs: number
  /** --bg 后台化批次 */
  background: boolean
  targets: MultiProposalTarget[]
}

/**
 * 多机批次事件：独立单向 IPC `cli:multi`，**不并进 agent:event**——
 * 那条流要过 foldEvent 进对话回放，批次浮层是跨会话 UI 不是会话事件。
 */
export type CliMultiEvent =
  | { kind: 'new'; proposal: MultiProposalView }
  | {
      kind: 'resolved'
      proposalId: string
      decision: 'approved' | 'denied' | 'withdrawn' | 'aborted'
    }
  /** 某台的执行结果已回流（approved 后逐台推进） */
  | { kind: 'host-done'; proposalId: string; sessionId: string; exitCode: number | null }
  /** 整批到终态（浮层转入完成态，停留到用户关掉） */
  | { kind: 'batch-done'; proposalId: string }

/**
 * CLI 活动条目的状态。running 有两段：白名单旁路执行中，或提案批准后等执行结果；
 * busy = 会话忙 / 同目标传输在途，命令未执行；aborted = 请求方断连或会话中止，提案取消。
 */
export type CliActivityStatus =
  | 'running'
  | 'proposed'
  | 'executed'
  | 'approved'
  | 'denied'
  | 'rejected'
  | 'withdrawn'
  | 'busy'
  | 'aborted'
  | 'error'

/**
 * 右栏 CLI 栏的一条（cli-bridge-design 第七节）：外部 agent 经 tsubasa-ssh 在本会话发起的
 * exec / push。同一 id 随进度多次推送，渲染侧按 id 覆盖。只住渲染进程内存，权威记录是 audit.jsonl。
 */
export interface CliActivity {
  id: string
  /** --agent 自报名；未带为 null（匿名 cli） */
  agent: string | null
  verb: 'exec' | 'push'
  /** exec 为命令原文；push 为「本地路径 → 远端路径」 */
  detail: string
  intent?: string
  status: CliActivityStatus
  /** 结局一句话（执行结果 / 拒绝或撤回原因）；进行中为空串 */
  summary: string
  /** 多机批次的总台数；单机不带 */
  hosts?: number
  startedAt: number
}

/** Agent 对话渲染事件流（主进程 loop → 渲染进程，增量推送） */
export type AgentEvent =
  | { kind: 'user'; text: string; attachedUnits: number[] }
  | { kind: 'turn-start' }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool-start'; toolUseId: string; name: string; detail: string }
  | {
      kind: 'tool-end'
      toolUseId: string
      status: 'ok' | 'executed' | 'proposed' | 'approved' | 'denied' | 'rejected' | 'error'
      summary: string
    }
  | { kind: 'advisory'; text: string }
  | {
      kind: 'usage'
      /** 上轮请求输入侧 token 总量（含缓存命中/写入）——即当前上下文体积 */
      inputTokens: number
      outputTokens: number
      /** 前缀缓存命中量；provider 不报则 null */
      cacheReadTokens: number | null
    }
  | { kind: 'proposal-new'; proposal: AgentProposal }
  | { kind: 'proposal-resolved'; proposalId: string; command: string; decision: ProposalDecision }
  /** 信任集变化（v0.9.2 `a` 免问）：当前生效的免问动词全量 */
  | { kind: 'trust'; verbs: string[] }
  /** 已信任动词免审批直接写入用户终端执行——渲染侧与"批准"走同一套运行态处理 */
  | { kind: 'trusted-exec'; command: string }
  /**
   * CLI 活动（右栏 CLI 栏）：外部 agent 的 exec / push 开始、挂审批、批准、终态各推一次，
   * 渲染侧按 activity.id 覆盖。白名单命令经旁路 channel 执行时终端完全不可见，这是它
   * 在界面上的落点。不进对话流、不落盘。
   */
  | { kind: 'cli-activity'; activity: CliActivity }
  /**
   * CLI bridge 写入用户终端的命令，本次请求已不再等它（拿到转录结果，或等待窗口
   * 超时/请求方断连）——清理 composer 的执行中指示。CLI 没有 turn-end，这是它的
   * 等价物；命令是否还在跑由 composer 的 running 态（OSC 133）如实反映。
   */
  | { kind: 'cli-exec-end'; command: string }
  /**
   * transfer 传输进度（v0.13.2 CLI push）：批准到 rename 落地之间可能几十秒，
   * composer 状态行显示"已批准 · 执行中 · N%"。percent=null 表示传输结束（成功或
   * 失败都清指示）。不进对话流、不落盘（与 cli-activity 同款瞬态）。
   */
  | { kind: 'transfer-progress'; label: string; percent: number | null }
  | { kind: 'notice'; text: string }
  | { kind: 'turn-end'; reason: 'done' | 'stopped' | 'round-limit' | 'error'; error?: string }

/**
 * system prompt 的一节（v0.10.0 分段可视，knowledge-design 第五节）。
 * 六节三来源，往后每加一层都要能说清"涨在哪一节、谁写的"——
 * token 圆环只报总量，说不出这个。
 */
export interface SystemPromptSection {
  key: string
  title: string
  /** code=版本内固定的代码文本；human=用户手写；probe=连接后自动探测 */
  source: 'code' | 'human' | 'probe'
  /** 本节全文（空串 = 该节无内容，不进 prompt） */
  text: string
  chars: number
  /** 估算 token（CJK 按 1 字 1 token、其余按 4 字符 1 token；非官方计数） */
  estTokens: number
}

export interface SystemPromptBreakdown {
  /** true = 当前对话正在用的快照；false = 尚无对话，展示的是下一个对话将用的内容 */
  live: boolean
  sections: SystemPromptSection[]
  totalChars: number
  totalEstTokens: number
  /**
   * live 快照里的人写知识与磁盘上的当前值已经不一致（v0.10.0 UI 改版）。
   * "改完下一个对话才生效"只在真改过时才是有用信息，常驻着就只是噪音。
   */
  pendingKnowledgeChange: boolean
}

/** 对话标题来源：llm 自动总结 / 降级首句截断 / 用户手改（改后不再被自动覆盖） */
export type ConversationTitleSource = 'llm' | 'fallback' | 'manual'

/**
 * 对话索引行（v0.10.1 对话持久化，knowledge-design 第二节）。
 * **主键是 convId，不是 sessionId**——一个会话可以先后有多个对话（新建），
 * 一个对话可以先后属于多个会话（v0.10.2 迁移），拿 sessionId 当主键两件事都会撞。
 */
export interface ConversationMeta {
  convId: string
  title: string
  titleSource: ConversationTitleSource
  createdAt: number
  updatedAt: number
  /** 存储子目录（创建日 yyyymmdd，固定不动——跨天接续不移动文件） */
  dateDir: string
  /** 涉及的主机（v0.10.2 迁移时追加）；回溯与导出时一眼看出这次排障跨了哪几台机 */
  hostIds: string[]
  profileId: string
  /** 对话实际使用的模型（v0.13.14 起写入；存量缺省，按 profile 名显示） */
  model?: string
  /** 用户消息轮数 */
  turnCount: number
  /** 两份落盘文件（messages.json + events.jsonl）字节和，容量治理显示用 */
  bytes: number
  /** 运行时注入（list 出口）：正被某个活会话持有——不可删除；不落盘 */
  active?: boolean
}

export interface ConversationExportResult {
  ok: boolean
  canceled?: boolean
  savedTo?: string
  error?: string
}

/** 补全 L3 建议（agent:suggest 应答；null = 无建议/未启用） */
export interface AgentSuggestion {
  /** predict = 预测下一条；fix = 非零退出码修复建议 */
  kind: 'predict' | 'fix'
  command: string
  explanation?: string
}

/** read_screen 的渲染进程应答（xterm 状态机在渲染进程；出口净化脱敏在主进程） */
export interface AgentScreenPayload {
  text: string
  cursorRow: number
  cursorCol: number
  bufferType: 'normal' | 'alternate'
}

export interface AgentSendResult {
  ok: boolean
  error?: string
  /**
   * agent:send 因模型与活动对话不符被拒时带回对话实际绑定的 profile，
   * 渲染层据此把选择器拨回去——换模型只能显式新建对话
   */
  boundProfileId?: string
}

/**
 * 接续前的模型确认：存档记录的 model 与即将使用的 profile 不一致
 * （profile 被改过模型），或原 profile 已删、改用同模型的替身 profile。
 * 两者都会改变计价或端点，不静默接续；人确认后带 accept 重发。
 */
export interface AgentResumeConfirm {
  profileId: string
  profileName: string
  /** 存档里原对话实际用的模型 */
  fromModel: string
  /** 本次接续将使用的模型 */
  toModel: string
  /** true = 原 profile 已删，profileId 是同模型的替身 */
  substitute: boolean
}

/** 接续/迁移的应答 */
export interface AgentResumeResult {
  ok: boolean
  error?: string
  /** 接续使用的 profile（renderer 把本会话的选择器锁到它，否则下次发送会被判为换模型） */
  profileId?: string
  /** true = 换了主机（迁移，system prompt 已重建）；false = 同主机接续 */
  migrated?: boolean
  /** 需要人确认模型变化才能接续（ok=false 时） */
  confirm?: AgentResumeConfirm
}

/** ~/.ssh/config 解析出的可导入主机（只取无通配符的 Host 块） */
export interface SshConfigEntry {
  /** Host 别名 */
  alias: string
  host: string
  port: number
  username: string
  identityFile?: string
}

export interface SshConfigLoadResult {
  ok: boolean
  entries?: SshConfigEntry[]
  /** 文件不存在/解析失败的提示 */
  error?: string
}
/** 自绘标题栏与原生窗口控制共用的逻辑像素高度。 */
export const TITLE_BAR_HEIGHT = 38

export interface TitleBarTheme {
  color: string
  symbolColor: string
  /**
   * 原生窗口底色：页面还没画出来时露出的那块（启动、最小化恢复）。
   * 跟着方案走，亮色用户才不会先闪一下暗底。
   */
  background: string
}

export interface Api {
  window: {
    platform: string
    setTitleBarTheme: (theme: TitleBarTheme) => Promise<void>
  }
  hosts: {
    list: () => Promise<HostConfig[]>
    add: (input: HostInput) => Promise<HostConfig[]>
    update: (input: HostInput) => Promise<HostConfig[]>
    remove: (id: string) => Promise<HostConfig[]>
    getFingerprint: (host: string, port: number) => Promise<string | null>
    forgetFingerprint: (host: string, port: number) => Promise<void>
  }
  ssh: {
    connect: (sessionId: string, hostId: string, size: TerminalSize) => Promise<SshConnectResult>
    input: (sessionId: string, data: string) => void
    /** 独立 exec：与 input 同权限级别（渲染进程本就能向 pty 写任意命令）；
     *  Agent 使用此通道须过主进程白名单闸门 */
    exec: (sessionId: string, command: string) => Promise<SshExecResult>
    /** 重载 shell integration：sudo su 等换 shell 后 OSC 133 断链，
     *  往 pty 写一行 source 让新 shell 重新挂上。false = 会话不存在或未启用 SI */
    reinjectSi: (sessionId: string) => Promise<boolean>
    resize: (sessionId: string, cols: number, rows: number) => void
    disconnect: (sessionId: string) => Promise<void>
    onData: (cb: (sessionId: string, data: Uint8Array) => void) => () => void
    /** trzsz 传输期间的进度输出：写 xterm 但不喂转录（Agent 上下文剥离） */
    onDataTransient: (cb: (sessionId: string, data: Uint8Array) => void) => () => void
    /** 主进程检测到 ZMODEM 起始帧并已中止，renderer 驱动 SFTP 桥 */
    onZmodem: (cb: (sessionId: string, kind: ZmodemKind) => void) => () => void
    /** clean=远端 shell 正常退出（exit/logout）；false=网络断开等异常关闭，是自动重连的触发条件 */
    onExit: (cb: (sessionId: string, clean: boolean) => void) => () => void
    onError: (cb: (sessionId: string, message: string) => void) => () => void
    /** 身份切换结果：握手 + 探活收口后推送一次；降级带原因，绝不静默 */
    onElevation: (cb: (sessionId: string, info: ElevationInfo) => void) => () => void
  }
  sshconfig: {
    /** 解析 ~/.ssh/config（e2e 可用 TSUBASATERMINAL_SSH_CONFIG 覆盖路径） */
    load: () => Promise<SshConfigLoadResult>
  }
  transfer: {
    /** ZMODEM 桥下载：主进程解析 ~ 与相对路径、目录选择对话框、逐个 fastGet */
    bridgeDownload: (
      sessionId: string,
      paths: string[],
      cwd: string | null
    ) => Promise<BridgeDownloadResult>
    /** ZMODEM 桥上传：文件选择对话框、fastPut 到 remoteDir（空则 home） */
    bridgeUpload: (sessionId: string, remoteDir: string | null) => Promise<SftpTransferResult>
    /** 桥收尾：释放主进程扣押的 prompt（成功/失败/取消都必须调，v0.8.5） */
    bridgeRelease: (sessionId: string) => void
  }
  sftp: {
    home: (sessionId: string) => Promise<SftpHomeResult>
    list: (sessionId: string, path: string) => Promise<SftpListResult>
    download: (sessionId: string, remotePath: string, fileName: string) => Promise<SftpTransferResult>
    upload: (sessionId: string, remoteDir: string) => Promise<SftpTransferResult>
  }
  transcript: {
    /** 渲染进程组装器上报原始单元（hostId 供历史入库定位主机） */
    report: (sessionId: string, hostId: string, unit: TranscriptUnitRaw) => void
    /** pty 身份变化上报：OSC 7 userinfo 位解析出的当前 shell 用户；
     *  丢失（无 user 的 OSC 7）时报 null——身份未知宁可标 unknown 不沿用旧值 */
    identity: (sessionId: string, user: string | null) => void
    /** 会话关闭时清理主进程侧转录 */
    dispose: (sessionId: string) => void
    /** 机器消费者出口：净化 + 脱敏后的结构化转录 */
    get: (sessionId: string) => Promise<TranscriptUnit[]>
    /** 勾选 picker 的轻量概要（不含输出正文） */
    summaries: (sessionId: string) => Promise<TranscriptUnitSummary[]>
    /** 会话累计脱敏计数（角标） */
    onRedactions: (cb: (sessionId: string, total: number) => void) => () => void
    redactionSummary: (sessionId: string) => Promise<RedactionSummaryEntry[]>
  }
  history: {
    /** 主机记忆：脱敏后的命令历史，倒序（最新在前） */
    list: (hostId: string, limit?: number) => Promise<string[]>
  }
  settings: {
    get: () => Promise<AppSettings>
    /**
     * 同步引导读：首帧之前拿到已落盘的布局与外观，避免"先按默认渲染一帧
     * 再跳"。主进程在建窗前已 await 过 loadSettings，这一跳只是读缓存，不碰磁盘。
     * 只给启动引导用，运行期一律走 get / set。
     */
    getSync: () => AppSettings
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
  }
  llm: {
    profiles: () => Promise<LlmProfile[]>
    saveProfile: (input: LlmProfileInput) => Promise<LlmProfile[]>
    deleteProfile: (id: string) => Promise<LlmProfile[]>
  }
  conversations: {
    /** 对话索引（updatedAt 倒序）；列表页只读索引，不扫目录 */
    list: () => Promise<ConversationMeta[]>
    /** 回溯渲染的事件流（events.jsonl）；对话不存在返回 null */
    events: (convId: string) => Promise<AgentEvent[] | null>
    /** 手动改标题（titleSource 记 manual，此后不再被自动覆盖）；返回新列表 */
    rename: (convId: string, title: string) => Promise<ConversationMeta[]>
    /** 删除单条（活动对话拒删）；返回新列表 */
    remove: (convId: string) => Promise<ConversationMeta[]>
    /** 清空全部非活动对话；返回新列表 */
    clear: () => Promise<ConversationMeta[]>
    /** markdown 导出：渲染进程拼好全文，主进程弹保存框写盘 */
    exportMarkdown: (convId: string, markdown: string) => Promise<ConversationExportResult>
  }
  agent: {
    send: (
      sessionId: string,
      text: string,
      opts: {
        profileId: string
        attachUnitIds: number[]
        hostLabel: string
        /** shell integration 是否已确认（133;A 见过）——主机档案注入的转录可用性提示 */
        integrationSeen?: boolean
      }
    ) => Promise<AgentSendResult>
    /**
     * 新建对话：把会话的当前对话指针指向新对话，旧对话已随每轮落盘。
     * 第一诉求是清场（别带着上午的上下文问新问题），一键无对话框；
     * 也是"知识改动下一对话生效"的显式触发器。对话进行中拒绝。
     */
    newConversation: (sessionId: string) => Promise<AgentSendResult>
    /**
     * 接续/迁移：把历史对话的原生消息回灌进当前会话继续聊。
     * 同主机 = 接续（system 原样复用，user 前缀明示档案漂移与转录引用失效）；
     * 换主机 = 迁移（**一律重建 system prompt**——本机知识/主机档案换新，
     * 不重建则旧主机知识跨机残留）。活动对话不可被捞出（主进程硬校验）。
     */
    resumeConversation: (
      sessionId: string,
      convId: string,
      opts: {
        hostLabel: string
        integrationSeen?: boolean
        /** 人已确认的模型变化：与主进程当下判定的 profile/model 一致才放行 */
        accept?: { profileId: string; model: string }
      }
    ) => Promise<AgentResumeResult>
    stop: (sessionId: string) => void
    /** 会话关闭时清理主进程侧对话状态 */
    dispose: (sessionId: string) => void
    onEvent: (cb: (sessionId: string, event: AgentEvent) => void) => () => void
    /** read_screen：主进程请求 → 渲染进程从 xterm 取屏幕应答 */
    onScreenRequest: (cb: (requestId: string, sessionId: string) => void) => () => void
    screenResponse: (requestId: string, payload: AgentScreenPayload | null) => void
    /** 审批：渲染进程只回传意图（proposalId），主进程执行自存的提案原文；
     *  high 档须附确认词（命令真动词），主进程校验。
     *  trust=true（`a` 键）额外把该动词记入信任集——档位/环境/动词资格全在主进程校验。
     *  edits 仅 save_experience 有效：用户在查看器里改过的内容（人写即指令通道） */
    approve: (
      sessionId: string,
      proposalId: string,
      confirmText?: string,
      trust?: boolean,
      edits?: ExperienceEdits
    ) => Promise<AgentSendResult>
    deny: (sessionId: string, proposalId: string, comment?: string) => Promise<AgentSendResult>
    /** 本会话当前生效的免问动词（连接后拉一次，之后靠 agent:event 的 trust 事件同步） */
    trustList: (sessionId: string) => Promise<string[]>
    trustClear: (sessionId: string) => Promise<string[]>
    /** 终端可写状态上报（v0.13.4 结构化）：信任免问/批准/CLI 写 pty 前都消费它；
     *  fail-closed——主进程未收到上报视为不可写 */
    noteTerminalWriteState: (sessionId: string, status: TerminalWriteStatus) => void
    /** 补全 L3：命令结束时刻的 LLM 预测/修复建议（主进程自取转录上下文） */
    suggest: (sessionId: string) => Promise<AgentSuggestion | null>
    /**
     * system prompt 分段明细：有对话时给当前快照，无对话时给
     * "下一个对话将用的内容"——知识改动下一对话才生效，这个区分要一眼可见
     */
    systemPrompt: (
      sessionId: string,
      opts: { hostLabel: string; integrationSeen?: boolean }
    ) => Promise<SystemPromptBreakdown>
  }
  experience: {
    /** 全量索引（createdAt 倒序）；injected 按传入 hostId 计算（"下一个对话"口径） */
    list: (hostId?: string) => Promise<ExperienceMeta[]>
    /** 读正文（管理 UI 查看用，不记 readCount——治理字段只统计 Agent 的读取） */
    body: (id: string) => Promise<string | null>
    /** 补录保存（提炼 UI；人写即指令通道，不走审批台）；返回成败 + 新列表 */
    save: (input: ExperienceSaveInput) => Promise<ExperienceWriteResult>
    /**
     * 编辑已存条目（人的动作，与 pin/删同级，不经审批台——
     * Agent 依然没有改写路径）。id/createdAt/pinned/readCount/来源对话全部保留。
     * viewHostId 只决定返回列表的 injected 口径（当前会话的主机），
     * 与 input.hostId（经验的归属主机）是两回事
     */
    update: (
      input: ExperienceUpdateInput,
      viewHostId?: string
    ) => Promise<ExperienceWriteResult>
    /** pin/unpin（pinned 固定注入，计入上限）；返回新列表 */
    setPinned: (id: string, pinned: boolean, hostId?: string) => Promise<ExperienceMeta[]>
    /** 删除（唯一的移除手段——自动淘汰只是不注入）；返回新列表 */
    remove: (id: string, hostId?: string) => Promise<ExperienceMeta[]>
    /** 补录草稿：Agent 从对话事件流提炼 summary/detail（失败降级空模板） */
    draft: (convId: string) => Promise<ExperienceDraft>
  }
  audit: {
    /** 在文件管理器中显示审计日志文件 */
    reveal: () => void
  }
  cli: {
    /** CLI 通道安装态（管道/shim/PATH/skill 四块，设置弹窗每次打开现探） */
    status: () => Promise<CliInstallStatus>
    /** 总开关：开=起管道 + 写 shim + 注册 PATH；关=停管道 + 删 shim + 摘 PATH */
    setBridge: (enabled: boolean) => Promise<CliInstallStatus>
    /** 装/卸某家 skill；`modified` 态下装载会被拒（返回态里如实反映） */
    setSkill: (target: CliSkillTarget, enabled: boolean) => Promise<CliInstallStatus>
    /**
     * 审批通知被点开 → 把提案所在会话切到前台（v0.12.1 fix）。纯 UI 导航请求，
     * 故不并进 `agent:event`——那条流要被 foldEvent 拼装、进对话回放，
     * 混入"切 tab"就是往事件流里塞非事件。
     */
    onFocusSession: (cb: (sessionId: string) => void) => () => void
    /** 多机批次事件流：批次浮层的唯一数据源 */
    onMulti: (cb: (event: CliMultiEvent) => void) => () => void
    /** 批准多机提案（高危须附确认词=动词；主进程批准瞬间重查 N 台 idle，all-or-nothing） */
    multiApprove: (proposalId: string, confirmText?: string) => Promise<AgentSendResult>
    multiDeny: (proposalId: string, comment?: string) => Promise<AgentSendResult>
    /**
     * `use` 自动开会话：主进程请求渲染进程开标签页连接目标主机。
     * 渲染进程开 tab 后盯连接状态，经 openSessionResult 把结果（含 TOFU mismatch
     * 等失败原因）回给主进程穿透到 CLI stderr。
     */
    onOpenSession: (cb: (requestId: string, hostId: string) => void) => () => void
    openSessionResult: (requestId: string, sessionId: string, ok: boolean, error?: string) => void
  }
  clipboard: {
    /** 读系统剪贴板纯文本（粘贴路径）；写仍留在渲染进程的 navigator.clipboard */
    readText: () => Promise<string>
  }
}
