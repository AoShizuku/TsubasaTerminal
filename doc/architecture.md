# Tsubasa Terminal 技术架构

本文维护当前进程边界、模块职责与关键合约。依赖版本以 [package.json](../package.json) 为准；
各专题设计见 [文档索引](README.md)。

## 进程与入口

| 边界 | 代码入口 | 职责 |
| --- | --- | --- |
| Electron 主进程 | [src/main](../src/main/) | SSH 会话、凭据、存储、模型调用、闸门、审批、审计、CLI 服务 |
| preload | [src/preload](../src/preload/) | contextBridge 暴露类型化 `window.api` |
| Vue 渲染进程 | [src/renderer/src](../src/renderer/src/) | xterm 终端、三栏 UI、composable 状态、读屏与人机交互 |
| 共享契约 | [types.ts](../src/shared/types.ts)、[cli.ts](../src/shared/cli.ts)、[shell.ts](../src/shared/shell.ts)、[layout.ts](../src/shared/layout.ts)、[url.ts](../src/shared/url.ts) | IPC 类型、CLI 协议、shell 参数转义、三栏几何常量与夹值及外开链接白名单 |
| 外部 CLI | [src/cli/index.ts](../src/cli/index.ts) | 单文件入口，经命名管道请求主进程；只能 import Node 内置模块与 shared/cli |
| 构建 | [electron.vite.config.ts](../electron.vite.config.ts)、[build-cli.mjs](../scripts/build-cli.mjs) | 应用三端构建、版本注入与 CLI 单独打包 |

技术栈为 Electron / electron-vite、Vue / TypeScript、Tailwind CSS v4、reka-ui 自有封装、
xterm.js 与 ssh2。UI 控件为 `components/ui/{Dlg,ConfirmDlg,Btn,Sel,Sw,Cbx,Sash}`，配合
`assets/{controls,overlay}.css`。
确认框由 App 挂唯一的 `ConfirmDlg`，调用方经 `lib/confirm` 的 `confirmDialog` 异步提问；
主进程只用系统文件选择器，不弹原生消息框。

主机连接按 hostId 发起，主进程读取并解密凭据。终端原始字节经 preload 送到 xterm，
由 xterm 流式解码，不能先按数据块转字符串破坏多字节字符。IPC 的具体签名以 shared/types
和 preload 为准；Vue 响应式对象跨 IPC 前先用 `JSON.parse(JSON.stringify(...))` 去代理。

## SSH、终端与文件通路

| 模块（相对 src/main） | 职责与接缝 |
| --- | --- |
| `hosts.ts` / `hostkeys.ts` | safeStorage 加密凭据、旧明文迁移；TOFU 指纹校验 |
| `ssh.ts` | 会话 Map、PTY、独立 exec channel、SFTP 预热缓存与 shell integration 装载 |
| `elevation.ts` | sudo PTY 握手与 exec / SFTP 探活；IO 用回调注入，不持有会话状态 |
| `elevatedSftp.ts` | 提权 SFTP 的 channel 认证与 sftp-server 探测；唯一接触 ssh2 私有 API 的模块，保留存在性检查 |
| `sftp.ts` / `transfer.ts` | 文件操作；trzsz 通道与 ZMODEM → SFTP 传输桥 |
| `transcript.ts` | 结构化转录存储与主机历史出口 |
| `sanitize.ts` / `redaction.ts` | ANSI/OSC 剥离、Unicode 归一与脱敏；人屏不脱敏，脱敏开关不关闭净化 |
| `llm/terminalState.ts` | 主进程终端可写事实与统一忙因，供 SSH、审批和 CLI 共用 |

提权会话先等待 `runElevation` 收口再 `warmupSession`，PTY、exec、SFTP 按同一身份结果工作。
`execOnSession` 提供超时、输出上限、abort 及 stdin / sudoAuth 选项。
协议与降级细节见 [identity-design](identity-design.md)；远端路径用 POSIX 拼接。

Shell Integration 提供 OSC 133 A/B/C/D 与 OSC 7：A 让 composer 回到 prompt，C 让它进入
running（含原生输入的直接回车），D 驱动文件栏刷新。渲染层 `lib/transcript.ts` 自行扫描
B/C/D 切单元，但在 xterm 解析完同一块字节后才喂入：直打命令的文本取 `lib/commandLine.ts`
在 C 时刻读出的屏幕终态（B 记起点），须是回显子序列，否则退回回显近似。
主进程入库时剥 zsh PROMPT_SP 尾巴（`sanitize.ts`）。
`lib/oscGuard.ts` 对 A 的 D→A 时序及频率设守卫。
补全由 `specCompletion` → `remoteContext` → compgen 实查兜底，语料由
[extract-specs.mjs](../scripts/extract-specs.mjs) 生成。见
[file-panel-design](file-panel-design.md)、[completion-design](completion-design.md)。

写入链以 `useComposerStore.computeWriteStatus` 上报的结构化状态为依据：
clean / dirty / running / tui / none-unverified；未上报即不可写。
人工输入经 `sendHumanInput`，主进程 `ssh:input` 先标记再转发；
自动化写入经过 `writeToTerminal` 最后一跳守卫，返回 written / gone / busy。
见 [composer-design](composer-design.md)。

## Agent、审批与知识

代码位于 [src/main/llm](../src/main/llm/)，模型循环始终在主进程。

| 模块 | 职责与关键合约 |
| --- | --- |
| `loop.ts` | per-session ReAct、停止/续跑、工具与事件编排；按 convId 管对话身份 |
| `providers.ts` / `profiles.ts` | Anthropic / Chat Completions / Responses 适配与 BYOK 配置；apiKey 不回传 UI |
| `systemPrompt.ts` / `hostprofile.ts` | prompt 输入采集、分节与会话级旁路探测；未配模型的会话不探测 |
| `gate.ts` | argv 硬解析、白名单、路径与风险判定、受控输出包装 |
| `tools.ts` | 读屏、转录、命令、等待、文件与经验工具；出口净化、脱敏与 nonce 定界 |
| `approvals.ts` | 保存提案原文、等待决策、高危确认词硬校验、等待真实执行结果与续跑决策 |
| `conversations.ts` | provider 原生快照、回溯事件与索引持久化；接续、迁移及保留策略 |
| `experience.ts` | 经验索引与正文、注入筛选、人审落盘及编辑回执 |
| `suggest.ts` | 命令结束后的 L3 建议，默认关闭 |

闸门风险取 max(规则, LLM 自报)，但结构性否决只看规则档。
白名单与 `POLYMORPHIC` 风险表分工不同，低风险不等于自动放行：
例如 kubectl 的凭据相关读取仍不能进白名单。参数解析、glob 与敏感路径规则见
[agent-design](agent-design.md) 和 [security-design](security-design.md)。

`wrapBackground` / `wrapSaveOutput` 是仅有的受控后台与自由重定向生成点：
命令先过硬解析，模板固定，落点路径由主进程生成。
background 只供常驻服务，强制审批；一次性长任务前台执行以拿到真实退出码。
save_to_file 全量落远端文件，只回规模与预览，遵循原命令闸门且与 background 互斥。
`detectInjection` 必须检测包装前文本，不能对带 nonce 定界符的成品检测。

provider 原生消息直接作为对话状态；Anthropic thinking signature 原样回传，
Chat Completions 的 reasoning_content 只渲染、不回传。
Anthropic 原始流监听 `stream.on('streamEvent', ...)`，不能挂不存在的 contentBlockDelta 事件。
思考档位映射、推理摘要显式 opt-in 与稳定的 prompt_cache_key 见
[agent-design](agent-design.md)；修改适配器时同时核对请求体与流式响应。

system prompt 按变化频率切六节，ContextBreakdown 按用户可编辑性归五行。
新增分节须同时更新两端展示。知识与经验索引在对话开始时快照，改动不重写当前 system。
指令通道只能由人写；save_experience 仅起草，落盘必须经过人审。
见 [knowledge-design](knowledge-design.md)。

对话落盘保留原生 messages 快照、events 回溯与 index。写操作串行；
活动对话不清理、不允许被重新捞出，活动标记通过浅拷贝注入列表，不写回索引对象。
同主机接续复用存档 system 与 nonce，跨主机重建；工具转录单元引用必须带会话前缀，
拒绝陌生前缀或裸数字。活动 convId 集合由上层注入，避免循环 import。
渲染端 `foldEvent` 将纯拼装与副作用分离，回放不能触碰审批台。

经验按 pinned + createdAt 筛选注入，淘汰仅指不注入，不删除正文；不使用可见性 LRU。
编辑保留 id、createdAt、来源与统计，updatedAt 只展示、不排序；
编辑按 hostId 补丁语义改作用域，写盘失败回滚内存并向调用方回报真实失败，
详见 [knowledge-design](knowledge-design.md)。编辑器是全局模态弹窗，
`useExperienceStore.epoch` 防在途草稿或回执写入另一份稿子。

## CLI 与审计

[src/main/cli](../src/main/cli/) 是应用内服务，[src/cli](../src/cli/) 是外部调用端；
协议、安装与多机行为见 [cli-bridge-design](cli-bridge-design.md)。

- `server.ts`：命名管道 NDJSON 一问一答与 token 握手；管道被占用不抢占。
- `commands.ts`：寻址并把工具结果翻译成 stdout 与真实退出码；安全逻辑复用 Agent。
  `hosts` 标记取主机配置，`sessions` 标记取会话实况，不能合并两种语义；
  旧配置会话必须标出，`hosts` 与 `use` 共用别名匹配。
- `bindings.ts` / `jobs.ts`：会话句柄、clientId 粘性与活性校验；异步结果仅在内存暂存。
- `briefing.ts`：`collectPromptInputs` 的第二渲染器，不另采一套知识。
  `rules.ts` / `skill.ts` 共用闸门摘要；非交互及禁分页纪律取 `llm/commandGuidance.ts`。
- `install.ts` / `index.ts`：shim、HKCU PATH、skill hash 更新、IPC 与启动自愈。
  测试隔离和 runAsNode 约束见 [development](development.md)。
- 外部入口的 `--help` / `--version` 本地响应；仅 `exec` 在首个位置参数后停止识别 flag。
  Git Bash / MSYS 的本机路径转换纪律见 [cli-bridge-design](cli-bridge-design.md)。
- `src/main/audit.ts`：按主进程 SessionMeta 记录脱敏后的提案、决策、执行与结果，
  区分 agent / cli actor。桌面通知跳会话须检查存活并兜住事件回调异常。

## 渲染层与交互

[src/renderer/src/composables](../src/renderer/src/composables/) 用共享 composable 管理状态：
App / File 按会话组织主机和文件；Composer / Approval 管输入与决策；
Agent / Conversation 管实时事件与回溯；Experience 管经验编辑；Ui 管弹窗与三栏布局；
Cli 按会话存外部 agent 的活动条目，供右栏 CLI 栏只读展示（与 Agent 工具卡共用 `ToolCard.vue`）。
侧栏显隐、宽度与右栏 tab 的运行期真值在 `useUiStore`，settings.json 的同名字段只是
持久化镜像：启动由 `bootstrapSettings`（同步 `settings:get-sync`）回填，提交点全量写回；
其他模块不从 settings 读布局。隐藏保挂载；宽度是偏好值，窄窗口由 flex 收缩让位；
拖拽期间 `paneDragging` 抑制 TerminalView 的 fit，松手补一次。
几何常量与夹值见 `shared/layout.ts`，把手是 `ui/Sash.vue`。

`TitleBar.vue` 位于三栏之上，复用主题派生并经 preload → `windowChrome.ts` 更新
原生窗口按钮颜色；主进程仅接受六位 hex，并只修改请求所属窗口。窗口控制保留系统实现，
安全区取 Window Controls Overlay 的 CSS env，macOS 为交通灯留位。设置弹窗挂在 App，
与左栏显隐无关；标题栏按钮的 Enter / Space 激活由全局兜底输入路由豁免。
`Dlg` 的遮罩 DOM 通过 `useDialogScrim` 登记/释放实际层数，`TitleBar` 同步合成原生
按钮背景与符号色；不从单个设置弹窗的 open 状态推断全局遮罩，也不把右键菜单当遮罩。

命令草稿与审批决策草稿分槽，Enter 归终端、Ctrl+Enter 归审批；
native 模式收起固定命令行，以 Ctrl+Shift+Y 借焦点给独立决策输入。
待审批 WriteFileViewer / ExperienceViewer 高于 ContextViewer，被顶掉的上下文查看器真关闭；
TUI 暂时隐藏整组面板，退出恢复。经验编辑器不参加中栏占位链。
完整状态与让位规则见 [composer-design](composer-design.md)。

焦点、复制粘贴、弹窗接缝与 xterm 几何约束见 [focus-design](focus-design.md)；
控件令牌见 [tsubasa-alignment](tsubasa-alignment.md)，主题与 OLED 例外见
[appearance-design](appearance-design.md)。Agent Markdown 使用 html:false，
外链确认后打开；`terminalRegistry` 与 `window.__tsubasaterminal` 为 Agent 和 e2e 共用读屏入口。
