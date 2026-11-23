# CLI 通道设计

`tsubasa-ssh` 把 Tsubasa Terminal 的**执行平面**开放给外部 agent（Claude Code、Codex 等）：
复用已建成的会话、闸门、审批台、脱敏与审计——左边外部 agent 的 TUI，右边 Tsubasa Terminal 界面。
代码入口：CLI 本体 `src/cli/index.ts`，协议常量与退出码 `src/shared/cli.ts`，
主进程侧 `src/main/cli/`（`server.ts` 管道、`commands.ts` 子命令、`bindings.ts` 粘性绑定、
`briefing.ts` 建联包、`multiExec.ts` 多机、`jobs.ts` 异步、`autoOpen.ts` 自动开会话、
`install.ts` / `skill.ts` 安装面、`rules.ts` 规则摘要）。

相关文档：[agent-design.md](agent-design.md)（闸门与工具面）、
[composer-design.md](composer-design.md)（审批台形态）、
[security-design.md](security-design.md)（脱敏与注入防御）、
[knowledge-design.md](knowledge-design.md)（知识层与排障经验）、
[transfer-design.md](transfer-design.md)（终端内传输：trzsz 与 ZMODEM 桥）。

## 零、定位：一个大脑，一副身体

CLI 通道不是新功能，是把 Tsubasa Terminal 已有的"身体"开放出去：

- **已连接的 SSH 会话**（复用，不是每条命令重连）
- **闸门**（argv 硬解析、fail-closed）
- **审批台**（阻塞语义、提案原文主进程自存）
- **脱敏**（出口单点闸门）与**审计**（audit.jsonl）
- **用户可见的终端**（最后的监督兜底）

外部 agent 借这副身体干活，用户在右窗口看着、可随时手动介入。**外部 agent 是脑，Tsubasa Terminal 是手和眼。**

与内置 Agent 是分工而非替代：

| | 内置 Agent | CLI 通道 |
| --- | --- | --- |
| 服务谁 | 运维在 Tsubasa Terminal 里随手问 | 开发在外部 agent 里深度作业 |
| 编排 | 自研 ReAct loop | 外部 agent 自带 |
| 共享 | 闸门 / 审批 / 审计 / 脱敏 / 先验 | 同左 |

真正的风险不是功能重叠，是**两套 prompt 先验各自演化**——第四节的静态/动态切分是对策。

## 一、接缝：成为 `executeTool` 的第二个调用方

`llm/tools.ts` 的执行入口是 `executeTool(ctx: ToolContext, name, rawInput)`。闸门、审批台、
脱敏、审计、转录回流全挂在它下游，**不在 `loop.ts` 里**；`loop.ts` 只是第一个调用方。
CLI 是第二个调用方，`src/main/cli/commands.ts` **不实现任何安全逻辑**。

为 CLI 接入，`ToolContext` / `ToolExecution` 上有三处接缝：

- **`actor`**：审计记录发起方（第七节）。
- **`ToolContext.allowPty`**：控制是否允许走 pty 路径（提案 / `--bg` 等），各调用方显式给出。
- **`ToolExecution.raw`**：CLI 需要"纯 stdout + 真实退出码"，而 `content` 是喂 LLM 的
  JSON meta + nonce 定界符形态。让 CLI 解析 `content` 等于造第二份协议，必然漂移。

`sender` 传**主窗口的 `webContents`**：CLI 发起的命令照样写进用户可见的 pty、照样在右栏弹
提案卡、照样进审计。左右两个窗口是同一件事的两个视角。

## 二、形态与协议

### 2.1 为什么是 CLI 而不是 MCP

**审批权必须单一归属。** MCP 走外部 agent 自己的工具权限系统，形成两层审批；而本应用的
闸门是 argv 硬解析 fail-closed，比外部 agent 的 Bash 前缀匹配严格得多。正确姿势是外部 agent
侧把 `tsubasa-ssh` 整个放进 allowlist，**审批权唯一交给 Tsubasa Terminal**。CLI 形态天然支持
"我这边不管、下游管"。

命名与 `tsubasa-mysql` / `tsubasa-redis` 同一家族、同一哲学：低 token、机读输出、host 别名寻址、
默认只读带护栏。

### 2.2 传输层

**Windows 命名管道** `\\.\pipe\tsubasa-ssh`（`CLI_DEFAULT_PIPE`，`TSUBASA_SSH_PIPE` 可覆盖），
不开 localhost 端口，不给浏览器和杂进程留 CSRF 面。协议是**一问一答**：CLI 连上 → 写一行请求
JSON（`CliRequest`：`v` / `token` / `clientId` / `agent` / `cmd` / `args` / `flags`）→ 读若干 NDJSON
帧（`out` / `err` / `exit`）→ 收到 `exit` 帧即退出。服务端不持连接态；单请求体有上限
（`server.ts` 的 `REQUEST_LIMIT`）。握手 token 存在 userData 下的 `cli-token`，shim 把 userData
路径烘进 `TSUBASA_SSH_USERDATA`，手动调用时按 `%APPDATA%\TsubasaTerminal` 兜底。

这条管道就是"完全控制"的钥匙：同用户下任何进程连上它就能操纵所有已连会话。这是 CLI 引入的
**唯一新增攻击面**。凭据仍然不出主进程，但"能让主进程替我执行"被外放了。握手 token 只防误连
到别的实例，不防同用户恶意进程——**同用户即同权**是这个模型的底线。因此设置里的 CLI 总开关默认关。

应用未运行时管道不存在，连接 ENOENT——**报错退 106，不自动拉起，也不提供任何拉起应用的动词**：

- 刚启动的应用是零会话，拉起买不到任何东西（`use` 照样要等连接）；
- "应用没开"本身就是"用户不在运维状态"的信号，而这条通道的安全叙事押在"右窗口用户看着"上，
  无人看管时静默拉起应用与幽灵提案是同构的坏形态；
- 后台 CLI 调用弹 GUI 窗口是 surprising behavior。

`--help` / `--version` 由 CLI **本地**答、不连管道（帮助不该要求应用在跑）；`rules` 必须走管道
（白名单实况只有主进程有）。CLI 退出只设 `process.exitCode`、不调 `process.exit()`——后者在
stdout 指向管道时不保证冲刷，会截断输出。

### 2.3 命令面

```
tsubasa-ssh hosts                     # 配置面：用户配了哪些主机（别名 / user@host / 标记 / 有无会话）+ 全局知识
tsubasa-ssh hosts <别名>              # 某台的标记与本机知识（不连接它）
tsubasa-ssh sessions                  # 运行时面：句柄  别名  user@host  标记  状态
tsubasa-ssh use <别名|句柄>           # 绑定会话 + 返回建联包；无会话时自动开标签页（9.7）
tsubasa-ssh exec "<cmd>"              # 走闸门 → 白名单直执行 / 否则审批台
tsubasa-ssh exec --save "<cmd>"       # 大输出全量落远端文件，回规模 + 预览
tsubasa-ssh exec --bg "<cmd>"         # 常驻服务（nohup 后台化，一律审批）
tsubasa-ssh exec --async "<cmd>"      # 进审批台时立刻返回 proposalId，之后 job 轮询
tsubasa-ssh exec --hosts a,b "<cmd>"  # 多机并行（第九节）
tsubasa-ssh push <本地文件> <远端绝对路径> [--mode 755]   # 上传（别名 rz，第十一节）
tsubasa-ssh job <proposalId>          # 轮询异步结果（第八节）
tsubasa-ssh screen                    # read_screen（TUI 现场）
tsubasa-ssh log [--limit N]           # list_transcript
tsubasa-ssh log <unitId>              # read_output（unit id 带句柄前缀，与寻址自洽）
tsubasa-ssh exp <id>                  # 读一条排障经验正文（4.3）
tsubasa-ssh rules                     # 闸门规则摘要与退出码表（与 skill 同源生成）
```

`hosts` 与 `sessions` 是两张表：前者回答"有哪些机器可选"（稳定，来自主机配置，标记按配置算），
后者回答"现在哪些会话开着"（易变，标记按会话实况）。多机链条是 `hosts → 逐台 use → exec --hosts`。
会话快照与当前配置的寻址字段或 `envLevel` 不一致时判为旧配置会话，不把旧句柄当成"这台已连接"。

全局参数：`-s/--session <句柄>`（逐条覆盖粘性绑定，3.4）；`--agent <名>`（自报家门，第七节）；
`--intent "<一句话>"`（意图，第七节）；`--timeout <秒>` / `--async`（审批路径，5.①）；
`--json`（结构化 stdout）；`--hosts`（多机）。

flag 解析规则：只有 `exec` 在第一个位置参数之后停止认 flag（`exec ls -la` 的 `-la` 归远端命令）；
其余子命令 flag 可随处写（`log 3f2a19c8:7 --limit 100`）。未知长选项当场 124 打回，不拼进命令文本；
命令本体以 `-` 开头时用 `--` 分隔。

### 2.4 退出码

LLM 读文本只能猜，外部 agent 能读退出码——这是 CLI 相对内置 Agent 的真实优势，因此**每个码的
补救动作必须互不相同**，动作不同就不合并。权威定义是 `src/shared/cli.ts` 的 `CLI_EXIT`：

| 码 | 含义 |
| --- | --- |
| `0..99` | 透传远端命令真实退出码 |
| `100` | 握手失败（协议版本 / token 对不上）——检查是否连到了别的实例 |
| `101` | 闸门结构性拒绝——**别重试同样写法** |
| `102` | 用户否决（stderr 带 comment，按留言改方案） |
| `103` | 无会话 / 未绑定 / 绑定的会话已断连；主机列表里没有这个别名 |
| `104` | 别名歧义：同主机多个会话（用 `use <句柄>` 指定），或主机列表里同名多台 |
| `105` | 会话忙（内置 Agent 在跑 / 终端非空闲 / 已有待决提案）——稍后重试 |
| `106` | Tsubasa Terminal 未运行（不自动拉起；启动后管道就绪约需数秒） |
| `107` | 命令未取得退出码（超时 / 通道错误 / 工具异常）——**不能报 1**，报 1 等于说"命令跑了且失败了" |
| `108` | 异步 job 未到终态，继续 `job <id>` 轮询 |
| `109` | 多机批量逐台结果不一致，逐台读 `--json` 的 `results` |
| `110` | push 同目标已有一笔传输在途，等那一笔落地再重试 |
| `124` | 用法错误（未知子命令 / 缺参数 / 失效的 unit 引用 / 命令需整体加引号 / `--agent` 清洗后为空） |
| `125` | 审批超时，提案已主动撤回（命令未执行） |

例如 103 与 106 不合并：103 的补救是"在应用里开会话 / 重新 `use`"，106 是"把应用启动起来"；
108 与 105 不合并：前者继续轮询同一个 job，后者是稍后重发本条命令。

## 三、会话寻址与粘性绑定

### 3.1 句柄：8hex

会话句柄就是 `unitRef.ts` 的 `unitPrefix`（sessionId 去横线截 8 位），已经印在 Agent 与转录
出口的每个 unit id 上（`3f2a19c8:7`）。`log` 输出里的 id 与句柄天生自洽，不引入第二套编号。
内部流转一律用完整 sessionId，8hex 只在出入口包装/解析——与 `parseUnitRef` 对 unit id 的纪律
同构：宁可响亮失败，不静默错会话。

### 3.2 clientId：粘性按谁隔离

CLI 每次调用都是一次性进程，粘性只能住在管道服务端（主进程**内存** Map，key = clientId）。
clientId 由 CLI 侧算好随每个请求带上：

```ts
const clientId =
  process.env.TSUBASA_CLIENT   // 显式覆盖，留给特殊场景
  ?? process.env.WT_SESSION    // Windows Terminal 每标签页注入的 GUID
  ?? 'global'                  // 兜底：退化为全局粘性（kubectl 模式）
```

`WT_SESSION` 从外部 agent 所在的标签页一路继承到它的每个子 shell——同一实例所有调用同值、不同
标签页的两个实例不同值，零配置。**必须隔离**：全局粘性下两个实例互相覆盖 `use`，前者下一条
exec 会静默打到另一台主机。取不到 `WT_SESSION` 时退化为全局一份，skill 教一手保险：多主机作业
每条命令带 `-s` 显式指定。

### 3.3 use：解析一次，绑具体句柄

`use` 是唯一写绑定的地方。参数形如 8hex（`/^[0-9a-f]{8}$/`）按句柄在活会话里精确匹配，否则按
主机别名匹配（先显示名后 host 字段，大小写不敏感）：

- 命中 **0** → 按主机配置找到该主机则自动开会话（9.7），找不到退 103；
- 命中 **1** → 绑定 + 返回建联包（第四节）；
- 命中 **N** → 退 104，列出候选句柄，**不挑、不猜**。

**绑定粘具体句柄（存完整 sessionId），不粘别名**——别名只是 `use` 那一刻的查找键。若粘别名、
每次重解析，用户中途多开一个同主机标签页，"当前会话"就静默漂移或突然歧义；粘句柄的代价只是
标签页关了要重新 `use`（响亮 103）。

### 3.4 每次调用 lazy 校验 + stderr 回显

活性校验做在**每次调用时**，不靠会话关闭事件清 Map（清只是卫生，不是护栏）：绑定不存在 → 103
"先 use"；绑定的会话已关闭 → 删除绑定并 103"已关闭，重新 use"。外部 agent 重新 `use` 拿到新句柄
与新建联包，转录前缀随之切换，不存在静默漂移窗口。

粘性状态**故意不落盘**：应用重启后会话全没了，绑定随内存消亡正是对的语义。`-s/--session` 逐条
覆盖：解析完即用，不读不写粘性。

最后一道纵深：每条命令的 **stderr 首行**回显当前作用的会话与本条身份
（`# session 3f2a19c8 · web1 · production · root`；stdout 保持纯净可管道）。任何环节的隔离失手
都在第一行暴露，约十个 token 换最恶劣故障形态的可见性。

### 3.5 同主机多标签：不禁止

同主机多标签是支持场景（tab1 人挂着 htop，tab2 外部 agent 干活）：两个独立 session 各有 pty 与
转录。真正的争抢——同一 session 里两个大脑抢一只手——由 105 互斥（5.③）与审批台单提案语义罩住。
"两个入口改同一台机器的状态"是人的编排问题，工具层硬拦是越位，审计合流让它可见即可。

## 四、先验切分：skill 静态 + 建联动态

### 4.1 按改动频率切

与 `systemPrompt.ts` 分节"按改动频率排"是同一把刀：

- **随 app 版本变的**（角色纪律、闸门规则摘要、用法、退出码表）→ **skill**，版本戳驱动更新（6.3）；
- **随主机与人变的**（全局/本机知识、主机档案、经验索引）→ **建联包**，`use` 时现算现返。

skill 因此是**主机无关的静态文件**，永不因某台主机的档案变了而重装；"两套先验漂移"被压缩到只剩
规则摘要一块，由版本戳管着。建联包是 `collectPromptInputs` 的**第二个渲染器**（`briefing.ts` 的
`renderBriefing`），内置 Agent 与外部 agent 拿到的是同一批事实。

### 4.2 建联包

挂在 `use` 上——绑定与知识交接同一时刻。形如：

```
session 3f2a19c8 · web1 (root@web1.example:22) · ⚠ production · ⚠ root
[主机档案] Ubuntu 22.04 / bash / $HOME=/root / sudo 1.9.9 …
[本机知识] （人写内容原样，过长截断）
[全局知识] （人写内容原样，过长截断）
[排障经验] ab12cd34  nginx 502 → 上游连接池满…（正文：tsubasa-ssh exp <id>）
提示：本会话转录 unit id 均为 3f2a19c8:<n> 形态
```

envLevel 与 root 标记**必须**在包里——否则外部 agent 理解不了它的 mid 档提案为什么被抬成 high。
root 标记读会话的 `elevated`（握手 + 探活全过才为真），如实反映握手结果。知识块按
`KNOWLEDGE_PREVIEW` 截断（`hosts <别名>` 的本机知识同档）。建联包不带内置 Agent 的 nonce 定界符
（CLI 输出要能管道）。刷新语义从简：重跑 `use` 即重取，不做推送。

### 4.3 排障经验：读给，写不给

**读，给。** 条目落盘时全过了人审，信任级别与内置 Agent 读到的一样，不存在外放降级；它恰是
"本机特有历史，侦察不出来"的知识；读取本地免审批。形态照搬 `read_experience`：索引进建联包
（同款筛选，单机 20 / 全局 10、pinned 优先），正文按需 `exp <id>`（只放行绑定主机可见条目、照记
readCount、照带"过去结论可能过期"提示语）。

**写，不给。** `save_experience` 的审批形态是**可编辑查看器**——用户要逐行读、可能动手改，耗时以
分钟计，装不进外部 agent 的 Bash 超时窗口，阻塞式 CLI 撑不住，做了就是幽灵提案高发地。外部 agent
排完障，结论让内置 Agent 起草保存，或用户自己写。

## 五、三个风险点与对策

### ① 幽灵提案

审批台本身是无限期阻塞的（`approvals.ts`），而外部 agent 的 Bash 工具有超时。用户没盯右窗口 →
外部 agent 超时放弃 → 提案还挂着 → 之后用户随手批准，执行一条早已被放弃的命令。对策：

- CLI 提案默认 `--timeout 90`（小于常见 Bash 工具的 120s），到点**主动撤回提案**并退 125；
  审批台 CLI 半边是 `proposalTimeoutMs` / `onProposalCreated` / `withdrawn`；
- 提案挂起瞬间发桌面通知 + `flashFrame`（`execShared.ts` 的 `grabAttention`），把注意力拽到右窗口；
  提案到终态即撤通知；
- `--async`：提案挂起即返回 proposalId，之后 `job` 轮询（第八节），适合批准后执行很久的命令。

### ② 先验缺失

闸门规则、主机档案、注入纪律原本只在内置 Agent 的 system prompt 里，外部 agent 一无所知，会反复
写出 `&&` 拼接、自由重定向、远端 sleep 然后撞墙。对策是第四节的静态/动态切分 + 第六节的 skill
自动安装，再加两件：`rules` 可打印（与 skill 规则摘要**同源生成**，不维护两份）；闸门 reject 时
stderr 给**可操作的修复建议**而非只报错（如"`&&` 不允许，拆成两条 exec"、远端 sleep 引导到 `wait`）。

skill 载体用 Claude Code 的 skill 格式（Codex 同格式，见 6.3）。

### ③ 抢终端

`writeToTerminal` 写用户 pty。用户正在敲字、内置 Agent 正在跑、终端在 TUI 里——写进去都是灾难。
pty 路径受 `isTerminalIdle` 守卫（终端写入 fail-closed，见 [composer-design.md](composer-design.md)），
另加互斥：**同会话内置 Agent 在跑、已有待决提案或有多机批次挂起时，CLI 的 pty 路径直接拒（105）**。
实现为 `execShared.ts` 的忙检查两层（后者用前者实现，不抄一份）：

```
approvalBusyReason  = isAgentRunning + hasMultiPendingProposal + hasPendingProposal
ptyBusyReason       = approvalBusyReason + 终端空闲检查
```

分层是天然的：白名单只读命令走旁路 exec channel、不碰用户终端，不受这套约束；只有写 pty 的路径
（提案批准后执行、`--bg`）才受管。不碰 pty 的写入口（push）只用 `approvalBusyReason`。

## 六、安装面

### 6.1 CLI 本体：Electron 当 Node 跑

CLI 只干一件事：连管道、发请求、流转输出、带出退出码——只需 Node 的 `net`。不能假设运维机器装了
Node，但安装目录里本来就有一个：`ELECTRON_RUN_AS_NODE=1` 下 `TsubasaTerminal.exe` 就是纯 Node 进程，
无窗口、冷启动一两百毫秒（VS Code `code` 命令同款）。CLI 本体由 esbuild 打成单文件 `tsubasa-ssh.js`
（`npm run build:cli`），经 electron-builder `extraResources` 落 `resources\cli\`（**放 asar 外**，
不依赖 RUN_AS_NODE 模式下的 asar 补丁行为）。

约束：
- `src/cli/index.ts` **只能 import Node 内置模块与 `src/shared/cli.ts`**，拉进 electron / 主进程代码
  会让单文件产物当场失效；
- electron-builder 的 fuses 中 **`runAsNode` 必须保持开启**，关了 CLI 就死了。

### 6.2 shim 三件套与 PATH：应用自管，不交给 NSIS

用户 PATH 上放 shim 目录 `%LOCALAPPDATA%\tsubasa\bin`（与 `tsubasa-mysql` / `tsubasa-redis` 家族
共用），按 npm 的方式发三个包装：`.cmd`（cmd / PowerShell）、**无扩展名 sh 脚本**（Git Bash）、`.ps1`。

**sh 版是命根子**：Claude Code 在 Windows 上的 Bash 工具是 Git Bash，按名字只解析 `.exe` 与无扩展名
脚本，**不解析 `.cmd`**。shim 内写**绝对路径**，不做 `%~dp0` 相对定位（shim 不住在安装目录里）；
sh 版路径用 `C:/x/y` 形态而非 `/c/x/y`——后者作为参数传给 Windows 程序时依赖 MSYS 的路径转换
启发式。

PowerShell shim 的宿主合约：直接调用 GUI 子系统的 Electron 时用输出管道保证等待完成，UTF-8 文本进入
PowerShell 输出流，退出码在结束后读取；脚本临时设置的编码和环境变量在退出前恢复。参数经 JSON/Base64
送给固定启动片段后还原 `process.argv`，避免 PS 5.1 的旧式拼参破坏引号与空串，不交给 cmd 解析。
文本管道按宿主规则处理换行，不承诺字节保真；命令行长度仍受 Windows 限制，Base64 会增加长度。启动
失败反馈并返回 107。三件套的安装检测与启动自愈共用同一生成函数。

主进程负责两件事（`install.ts`）：

1. **每次启动自愈**：用当前 `process.execPath` 重写三个 shim。应用更新、安装位置变动后自动指回正确的
   exe，PATH 条目永远不用变。
2. **勾选时注册**：`HKCU\Environment` 的 `Path` 追加 shim 目录 + 广播 `WM_SETTINGCHANGE`。per-user
   安装 + HKCU，全程无 UAC。PATH 读写走 PowerShell 直接操作注册表键（`-EncodedCommand` 绕开转义）：
   `DoNotExpandEnvironmentNames` 保住 `%VAR%` 原样、`GetValueKind` 保住 `REG_EXPAND_SZ`。
   不用 `[Environment]::SetEnvironmentVariable`——它会把整条降级成 `REG_SZ`。

不在 NSIS 里注册 PATH：社区常用的 `EnvVarUpdate` 在 PATH 超 1024 字符时会**静默截断整条 PATH**，
且安装器写死的路径没人自愈。NSIS 只做卸载卫生（`build/installer.nsh` 的 `customUnInstall`）：删三个
shim、目录空则摘 PATH 条目（家族里还有其他工具时不动）。改 HKCU PATH 对**已开着的终端不生效**，UI
提示"重启终端后可用"（正在跑的外部 agent 会话同理要重开）。

### 6.3 skill 自动安装

设置弹窗"CLI 通道"一节：

```
[x] 安装命令行工具 tsubasa-ssh（加入 PATH）    已安装 · 重启终端后生效
[x] Claude Code skill                           已安装 v3
[ ] Codex skill                                 检测到 ~/.codex，未安装
```

宿主检测探 `~/.claude`、`~/.codex` 目录，决定默认勾选态与状态文案；宿主检测与 skill 落点分开。

装载照 `tsubasa-mysql` 的范式：同一份 SKILL.md（YAML frontmatter + 正文，`skill.ts` 渲染）渲染一次，
直落 `~/.claude/skills/tsubasa-ssh/` 与 `~/.agents/skills/tsubasa-ssh/`（Codex 现行通用 skill 目录），
两处逐字节同文件；旁放 `.tsubasa-ssh-install.json`（version + 逐文件 sha256）做**原地安装标记**——
自包含、跟文件走，改版检测与卸载都在原地完成，不在 settings.json 里留中央状态。

旧落点迁移：安装、更新、卸载 Codex skill（含开关开着时的每次启动自愈）都会清理
`~/.codex/skills/tsubasa-ssh/`——只删 manifest 记录且 hash 未变的文件；记录的文件全部清掉才删
manifest，目录空了才删目录。手工改过的文件（连同 manifest）、manifest 之外的文件、没有 manifest 的
整个目录原样保留，状态行提示用户自行处理。旧落点是链接（或经链接与新落点同一处）时不进去删；只动这
一个目录，`~/.codex/skills/.system` 与其他 skill 不在视野内。新落点里已有带 manifest 的副本按同一套
标记规则接管：hash 吻合即视为本安装器产物，版本不同就重渲染。

更新纪律：重渲染前先比对目标文件 hash 与标记——对不上 = 用户手工改过，**绝不静默覆盖**，状态行显示
"已被手工修改"待用户确认。这是"指令通道只能人写"的镜像：写进别人指令通道的东西也要尊重人后来的修改。
版本戳驱动随 app 更新重渲染（规则摘要与 `rules` 同源）。取消勾选 = 删目录。改 skill / rules / 建联包
任一处新增动词时，三处（`skill.ts` / `rules.ts` / `briefing.ts`）要同步。

skill 正文写明：**遇 106 让用户启动 Tsubasa Terminal，不要自己拉起应用**。这是软约束——外部 agent
拿 Bash 本来就能启动 exe，同用户即同权拦不住也不必拦；它划清的是"拉起应用是用户的决定"这条责任边界，
不是安全边界。skill 示例每条命令都带 `--agent`。

明确不做：**不代写外部 agent 的 allowlist**（`Bash(tsubasa-ssh:*)` 写进 skill 正文由人加，改别家配置
文件的 merge 风险不值得）；**不做 per-project 安装**（运维工具是全局的，全部落 user 级路径）。

## 七、审计合流与 CLI 栏

**审计 `actor`**：`AuditEntry.actor` 记发起方——`agent`（内置 Agent）或 `cli:<名>`（`--agent` 自报），
未带 `--agent` 记为匿名 cli。`user`（人敲的命令）在类型上预留，当前不记录。

**`--agent` 是每请求参数，不按 clientId 粘性。** 绑定值得粘，因为它缓存的是**查询结果**（别名 → 句柄，
会歧义、会失效，失效有响亮 103 自愈）；名字是调用方自己永远知道的常量，粘住只省几个 token，却会在共用
clientId 时（同一标签页先后跑两个 agent、无 `WT_SESSION` 时整体退化到 global）让后来者**继承别人的
名字**——审计从"缺名"变"错名"，错名没人起疑、永不自愈，比诚实的匿名更糟。因此：漏带不拦，但 exec /
push 在 stderr 提醒一行"记为匿名 cli"；名字清洗后为空响亮 124，不静默变匿名。

**意图**：`--intent` 复用提案卡的 `reason` 槽位，署名 `[cli:<名>] <意图>`。

**CLI 栏**：白名单命令经旁路 channel 自动执行时用户终端完全不可见，而这条通道的安全叙事押在"用户在右窗口
看着"上，所以右栏在 CLI 总开关开着时多出一个 CLI 栏，逐条列出外部 agent 在当前会话发起的 exec / push：

- **每条一张卡，外观与 Agent 工具卡同一份**（`ToolCard.vue`）：agent 名与动词、完整命令（等宽、换行不截断）、
  意图、时间、状态徽标与一句话结局。push 写明"本地 → 远端"与 mode；多机批次逐台各一张，标出总台数。
- **审批路径一并列入**，否则列表只讲了一半：状态按真实进度推进——执行中 → 待审批 → 批准后执行中 →
  已执行 / 已批准 / 已拒绝 / 超时撤回 / 会话忙 / 已取消 / 被拒绝 / 出错。撤回、会话忙、中止都不是
  "被闸门拒绝"，分流与退出码同口径（`execShared.ts` 的 `activityOutcome`）。多机整批未执行（某台被拒或
  会话忙）时，肇事台写自己的原因，其余台写明被谁连带。
- **主进程推、渲染侧原位覆盖**：`trackActivity` 为每次 exec / push 生成 id，开始、挂审批
  （`onProposalCreated`）、批准（`ToolContext.onProposalDecided`）、终态各发一次 `cli-activity` 事件，
  走 `agent:event` 但不进对话流、不落盘。执行抛异常也收场为"出错"，卡片不会永远停在执行中。
  只在请求真正进入执行层后开卡：CLI 本体或参数校验阶段就打回的（124 等）不留卡。
- **只读投影**：栏里没有任何操作，审批仍在 composer 的审批台做。贴底时跟随新条目，用户上翻时不拽回；
  切到本栏或切会话时落到最新一条。新条目到达而用户停在别的栏时，栏标签亮一个未读点，**不替用户切栏**；
  已有条目的状态推进不算新消息。
- **渲染进程内存**（`useCliStore.ts`）：按会话分列，每会话留最近 200 条，关会话即清；完整记录在 audit.jsonl。
- 栏随总开关出现与收起；收起时停在 CLI 栏的退回 Agent，持久化的栏位在总开关关着时启动也回落到 Agent。

## 八、异步 job

`exec --async` / `push --async` 在提案挂起的瞬间返回 proposalId（stdout），之后 `job <id>` 轮询；
未到终态退 108。`jobs.ts` 只是**结果暂存柜**：提案生命周期仍在 `approvals.ts`（超时撤回照常生效，
撤回结果也存进来供轮询读到 125），执行仍在 `executeTool`，这里不实现安全逻辑。

- 终态结果保留 10 分钟、可重复读取（管道抖动重查不该丢结果），到点清理；登记簿有硬上限兜底；
- 只住内存，随应用退出消亡（与粘性绑定同语义）；
- 请求未进审批（校验失败或会话忙）时 `--async` 不生效，stderr 说明后返回同步结果；
- 同步与轮询共用同一份结果渲染（`renderExecOutcome`；多机为 `MultiOutcome`），不写两套；
- job 取消暂不支持。

## 九、多机并行（`exec --hosts`）

### 9.1 价值：一卡罩 N 台

白名单只读命令走旁路 channel 不碰 pty，外部 agent 开 N 个 Bash 并发调 `exec -s <句柄>` 本来就是并行的。
`--hosts` 不可替代的是另一半：**一次审批罩住 N 台**——外部 agent 并发调用只会得到 N 张卡，那才是真不可用。

### 9.2 分界线：执行耗时是否累加

- 计划审批 = M 条命令 × 1 台 = **串行** = M 倍耗时 → 装不进外部 agent 的 Bash 窗口 → 不做（第十节）；
- 多机 = 1 条命令 × N 台 = **并行** = 1 倍耗时 → 装得进 → 做。

用户心智里的决策单元是"这条命令要不要在这批机器上跑"——一个决策、一张卡、卡上列 N 台。

### 9.3 七条纪律

1. **审批单元 = 整批，不拆。** 只要有一台需要审批，白名单的那几台也一并列进卡、一并等批准。**必须先算完
   N 台 verdict 再决定路径**，否则 auto 的台在卡弹出前就跑掉了。接缝是 `tools.ts` 的 **`planExec`**
   （`~` 展开 / cwd / `awaitElevation` / `gateCommand` / `applyEnvShift`，只算不执行）：`multiExec.ts`
   N 次 planExec → 合并决策 → N 次执行。安全逻辑仍只有一份。
2. **风险 = max(逐台 `applyEnvShift` 后的档位)**，不因台数额外抬档（台数在卡上写着）；`blankApprove`
   （空 Ctrl+Enter 免问）**一律关**——多机永远要显式动作。
3. **确认词不用主机名**（N 个候选、"手打这台机器的名字"在多台上不成立），改用动词；生产机 / root 台在卡上
   单独成组高亮。
4. **不给部分批准，不给 `--stop-on-error`。** 想拆就 deny + comment，外部 agent 读 comment 改 `--hosts`
   重发。**编排归脑，工具只提供原子的批量执行。**
5. **不给 `--hosts all`，2..7 台，超限退 124。** 目标集必须显式列举，与闸门 fail-closed 同构；单台走
   `use` / `-s`，不给单机开出第二个审批表面。上限撞到时 stderr 说明代价：分批 = 两次审批，且第二次审批时
   集群处在中间态——所以上限取在"卡片一屏读得完 + 批完能挨个切 tab 看"的上沿（`MAX_HOSTS = 7`）。
6. **不给 `a` 免问**：`isTrusted` 是 per-session 的，一次点击授 N 台免问权语义太重。
7. **目标解析 fail-closed**：逐个 `resolveRef`，任一命中 0 → 整批 103，任一歧义 → 整批 104，不做"跑得通
   的先跑"。`--hosts` 不自动开会话（9.7），与 `-s` 同款不读不写粘性绑定；两者同时给退 124。

### 9.4 实现要点

1. **提案结构是多目标**：`approvals.ts` 的提案带 targets；`hasPendingProposal` / `hasCliProposal` /
   `disposeProposals` / `resolveApprove` 都按目标遍历，非 approved 分支（拒绝 / 撤回 / 取消）必须全兜。
2. **逐台实际执行的命令文本不同**：auto 路径按各台 cwd / root 模板拼，`--bg` / `--save` 的落点由
   `generatedLogPath(sessionId, …)` 逐台生成。卡上显示原命令 + 标注"各台按自身 cwd 执行"；`waitForUnit`
   配对用各台自己的 effective 文本。
3. **批准瞬间重查 N 台**，**all-or-nothing**：任一台变忙则整批不执行。渲染侧按与单机 `canExecuteExec` 同一
   份 write-safe 口径（渲染层经 `agent:terminal-write-state` 上报）逐台显示，某台变忙即该行标红 + 批准键
   变灰。重查与写入之间的微小竞态以 `writeFailures` 随 approved 决策返回，逐台如实标"未执行"。
4. **批准写入用 `trusted-exec` 事件形态**递渲染侧：处理与"批准"相同（记精确命令文本供转录配对 + 进运行态
   + 执行中指示）且不进对话流，不新增事件 kind。
5. **挂起期间冻住 N 台**：内置 `agent:send` 被 `hasCliProposal` 挡住；且多机挂起期间**其他 CLI 提案全局
   105**（`hasMultiPendingProposal`）——用户反正批不了，不让外部 agent 白烧超时窗口。多机检查排在单机提案
   检查**之前**，否则"每会话一张卡"的报错会把调用方引向错误的等待对象。卡片与 stderr 说清"本批锁住 N 台"。
6. **聚合退出码**：全同则透传；混合退 **109**；整批同命运的（101 / 102 / 105 / 125）沿用。
7. **`--json`**：`--hosts` 出现即切结构化（N 台纯 stdout 分不清谁是谁）；单机默认纯 stdout 透传（可管道，
   与 `ssh` 一致），`--json` 可选，结构与多机同构（`results` 单元素）。
8. **`--async` + 多机**：一批一个 job（key = proposalId），终态为 `MultiOutcome`，与同步路径共用渲染。
9. **stderr 首行**列出全部目标句柄，保住"隔离失手第一行暴露"。
10. **审计带 `batchId`**，N 条记录可关联为同一次批量。
11. 批次事件走独立单向 IPC `cli:multi`，不并进 `agent:event`。

### 9.5 UI：批次浮层 + 目标 tab 呼吸 + 审批输入全局唯一

**位置**：`MultiApprovalOverlay.vue` 浮在终端栏顶部，不占 composer 位——终端注意力在底部，顶部是看过的
历史，盖那里代价最小。挂在**终端的外层包裹 div**（absolute），绝不碰 `term.open` 的元素：FitAddon 按
border-box 算行数，改动它会导致网格溢出、TUI 底行被裁。浮层不得改变终端网格。

**全 tab 可见，跟活动 tab 走**（与 Composer 同为跨会话单例）：批准多台之前用户多半要挨个切过去看各台现状，
卡只在目标 tab 上等于逼人盲批；切到非目标机卡仍浮着，也强调了"这不一定跑在本机"。

**生命周期三阶段**：单机卡批准即消失，多机批完用户只看得到一台 pty，需要全局视图：

```
[审批]  ⚠ 3 台待审批 · systemctl restart nginx
        web1  3f2a19c8                        mid
        web2  a1b2c3d4  ⚠ production ⚠ root   high
        …
[执行]  3 台执行中   web1 ✓0   web2 ⏳   db1 ✗1
[终态]  完成 2/3（db1 退 1）—— 停留到用户关掉
```

拒绝 / 撤回 / 取消直接退场、不留终态视图（什么都没发生，解释在 CLI 侧 stderr）。

**折叠**：默认展开（防盲批）；可临时收起（收起 ≠ 放弃决策，卡与 composer 路标都还在），收起态不持久化；
当前 tab 在 TUI 里时自动折叠成一行。

**tab 指示：只有目标 tab 呼吸，非目标 tab 不动。** 复用待审批徽章位（`hasPendingApproval` 只读探询；
动画对 `prefers-reduced-motion` 静态降级）。浮层说"有一批要批"，tab 呼吸说"打的是这几台"。执行阶段换运行态，
终态 ✓/✗ 短暂停留。提案出现时**不夺焦点**（浮层 + 呼吸 + 桌面通知是拽注意力，抢焦点会让正在打字的用户丢字）；
`cli:focus-session` 在多机下切到第一个目标 tab。

**键盘：Ctrl+Enter 在 composer 里拦下并提示，不放行任何审批。** 审批语义住在输入框内容里（空 / `y` / `n` /
确认词 / 留言），多机浮层有自己的输入框，于是：

- **防盲批**：Ctrl+Enter 是肌肉记忆键，让它在 composer 里批掉浮层的卡，就是"以为在批这台、实际批了 N 台"；
- **归属由位置定，不由优先级定**；
- **同一时刻能提交审批语义的输入框全局唯一**。

连带：composer 位留路标 `↑ 3 台多机审批待决（剩余 62s） · Ctrl+Shift+Enter 前往`（倒计时来自
`proposalTimeoutMs` + `createdAt`）；拦截不看当前 tab 有没有单机卡；浮层内 Ctrl+Enter 才真提交，Esc 按
focusManager 纪律**回家而非拒绝**（拒绝要输 `n`）；**两个草稿绝不共用**；浮层提示文案天然短一截（无 `a`、
无空批）；e2e testid 用 `multi-approval-*`，不复用 `approval-approve` / `approval-deny`。

**副作用**：多机挂起期间当前 tab 的单机卡也批不了（冻结只在渲染层，主进程不硬拦——这是误操作防护不是安全
边界）。多机卡最多挂到超时就自撤，内置 Agent 的单机卡无限期等得起，让有时限的先走是对的顺序。

### 9.6 不提供 `launch`

不提供拉起应用的子命令：它与 2.2"应用没开 = 用户不在运维状态"的叙事冲突，与 6.3 skill"遇 106 不要自己拉起"
的纪律自相矛盾；增值近乎为零（外部 agent 有 Bash，`start` 一行就够，106 的 stderr 已写明"启动后重试"）；
拉起来也是零会话。

### 9.7 `use` 自动开会话

`use` 的目标没有已连接会话、但主机配置里能找到时，主进程请求渲染进程开一个标签页连接（`autoOpen.ts`，
连接仍走既有 `ssh:connect` 流程），成败经 `cli:open-session-result` 回来。

- **TOFU 首连静默记录并放行**（`hostkeys.ts`），不需要交互；只有指纹 mismatch 拒绝连接，且失败原因必须
  **穿透到 CLI stderr**——安全相关的失败不能只在 UI 里冒个泡。
- **只挂 `use`，不进 `--hosts`**：exec 是执行动词，不该有"建立连接"的副作用，失败处理还会污染 exec 的退出码
  语义。正确姿势是逐台 `use`（各自拿建联包，补齐先验，免得在 CentOS 上发 `apt`），再 `exec --hosts`。
- **等待窗口显式**：连接 + SI 装载 + elevation 握手 + 档案探测，首连新机可能超 10s。渲染侧约 29s 先自答、
  主进程 31s 兜底；到点明说"连接仍在进行，标签页已打开，稍后重跑 use"，不拿外部 agent 的 Bash 窗口去赌。
- **同主机并发 `use` 去重**：共享同一次开标签页。

## 十、不做 / 待定

- **不做 MCP**：审批权不能分裂（2.1），且 MCP 的工具描述常驻上下文，token 开销大。
- **不做远程访问**：管道只服务本机当前用户，不做跨机开放。
- **不做计划审批**：整组命令的执行耗时装不进外部 agent 的 Bash 超时窗口，阻塞式 CLI 撑不住；单条逐个执行，
  长命令用 `--async`。pty 串行执行不是缺陷——apt conffile 类交互必须占用户可见终端由人应答，这正是审批命令
  走 pty 的原因。
- **不做 pair-ops 推送**：拉取式已覆盖——`log` / `log <id>` 就是"想看才看"。
- **不做 CLI 侧经验写入**：见 4.3。
- **不做 per-project skill / 不代写 allowlist**：见 6.3。
- **不做内置 Agent 的并行工具调用**：`loop.ts` 对一批 toolCalls 逐条 await 是架构必然——审批/信任路径写**同一个
  pty**、`collectTerminalResult` 靠 `waitForUnit` 按命令文本 + 时间配对、审批台单提案语义（`approvals.ts` 与
  `useApprovalStore` 皆如此假定）、交互式命令必须独占人屏。能并行的只有不碰 pty 的旁路只读子集，收益很小；
  外部 agent 经 CLI 并发调用天然获得并行，105 兜争抢。
- **降级候补：反向通道**。外部 agent 没有"运行中注入上下文"的 API，推送形态不可行；拉取式变体（选中 → 会话级
  inbox → 下次 CLI 调用 stderr 提示读取）等有真实需求再定。
- **待定**：Opencode 等其他宿主的 skill 装载点；job 取消。

## 十一、文件上传（`push`）

CLI 通道有 `exec` 却没有文件写入动词时，外部 agent 编译出的二进制产物送不上去，只能让用户切到 Tsubasa
Terminal 手敲 `rz` 再勾选——自动链路被截断在人身上。`push` 补这一环，复用 SFTP 通道，与 `write_file` 并列而非
替代：两者内容来源不同，审批语义因此不同（11.4）。

### 11.1 为什么不是 `write_file`

| 障碍 | 位置 |
| --- | --- |
| `content` 是 UTF-8 字符串全文语义，二进制无法表达 | `tools.ts` 的 schema + `sftp.writeFile(path, content)` |
| 内容上限 256KB | `gate.ts` 的 `WRITE_FILE_CONTENT_LIMIT` |
| 管道单请求体上限 | `cli/server.ts` 的 `REQUEST_LIMIT` |
| Windows 命令行 8191 字符（走 `exec` 参数同样不行） | OS 限制 |

另外 `runWriteFile` 结构上不设 `timeoutMs`，CLI 挂上去就是无限期挂起的提案。所以 push 是一个新动词。

### 11.2 形态：传路径，不传字节

管道里只流 `local_path` / `remote_path` / `mode`，**文件字节不进管道**：CLI 与主进程同机同用户，主进程直接从
磁盘读（与 transfer-design 一致：文件字节不在进程之间搬）。本地路径由 **CLI 侧 `resolve()`** 成绝对路径再发
（外部 agent 的 cwd 只有 CLI 知道）；CLI 侧的存在性预检只为快速失败（124）与好的错误信息。

复用面：

- **`getSftp` 是全应用唯一 SFTP 入口**（`ssh.ts`），root 会话自动返回 root 实例，push 跟随同一身份平面。错误提示
  照抄 `write_file`："SFTP 以 SSH 登录用户身份进行，终端里的 sudo/su 切换不影响本工具"——EACCES 是身份问题，
  不点破的话 LLM 会在错误方向上反复重试。
- **`executeTool` 的 switch 与 `TOOL_SPECS` 分离**：`push` 是只给 CLI、**不进 LLM 工具面**的 case（`tools.ts` 的
  `runPush` 编排，`pushEngine.ts` 只做机械搬运），闸门/审批/审计仍在 `executeTool` 下游。
- 审批台 CLI 半边（超时撤回）、`--async` + `job`、`applyEnvShift(..., 'write')` 档位位移全部复用。

### 11.3 命令面

```
tsubasa-ssh push <本地路径> <远端绝对路径> [--mode 755]     # 别名：rz
```

全局参数复用 `-s`、`--agent`、`--intent`、`--timeout`、`--async`；`--bg` / `--save` / `--hosts` 当场 124 打回，
不静默忽略。位置参数固定两个，flag 随处可写。

不支持：目录递归、多文件、通配符、`--hosts` 多机分发——传目录树就打 tar 包，审批面永远只有一个文件。

`--mode` 不传就不设（覆盖时沿用原 mode，见 11.6；新建跟随远端 umask，同 `scp` 不带 `-p`）；要可执行位显式写。
**mode 必须上审批卡**（可执行位是安全相关信息）。**按八进制解析**（`/^[0-7]{1,4}$/` + `parseInt(v, 8)`），
不能照抄 `--limit` 的 `Number(v)`，否则 755 会变成十进制的怪权限位。

`sz` / `pull` 不注册：半套 rz/sz 比完全没有更容易让人（和 LLM）搞错方向（11.7）。

### 11.4 审批：`transfer` kind，审动作不审字节

提案 kind 为 `'transfer'`，不复用 `write_file`（`WriteFileViewer` 要铺 `content` 全文，push 没有 content）。

**审批卡不展示文件内容，也不做防盲批。** `write_file` 的"逐行审阅 + 未查看不能批"来自它的字节由 **LLM 生成**，
不过人眼就没有第二道防线；push 搬的是**用户机器上已存在的文件**，想看内容在本地用任何工具都看得到。这张卡
审的是**搬运动作**，决策依据要写全：

```
push  D:\project\dist\app.exe  →  /opt/myapp/app.exe
      4.2 MB · 覆盖（原 4.1 MB · root）· mode 755
```

本机路径（**完整显示不截断**）、大小、canonical 远端目标（11.5）、覆盖状态与原大小、原 owner（与登录用户不同
时显眼标注——rename 换 inode 会换走属主，11.6）、mode；超过 100MB 卡上显眼标注、stderr 警告（不设硬上限）。

代价如实记：用户批准时不知道那些字节是什么，agent 在本地写一个恶意脚本再 push，卡上看不出来。这与"外部 agent
本来就能在本地写任意文件"是同一条信任边界，Tsubasa Terminal 不假装能审本地发生了什么；事后追踪落在审计的
sha256 上（11.8），二者配套。

由此改动面很窄：不新增中栏占用方；`useApprovalStore` 的 `viewed` 对本 kind 直接为真（同 `exec`）；Composer 只加
一支 kind 分支（摘要行 + 按钮文案）。**执行中指示**带上传百分比（批准到落地可能有几十秒）。

**档位与信任**：基线 `mid`（同 `write_file`），root 与生产机位移叠加取 max；`trustable: false`、无 `blankApprove`
——文件出入境一律人批，不留"目标目录信任"之类的口子。

**忙检查只用 `approvalBusyReason`**（5.③）：push 不碰 pty，终端非空闲不挡；但每会话一张卡要守，内置 Agent 在跑
也要挡（它随时可能提出自己的提案）。

**同目标互斥**：`--async` 下第一笔还在传，第二笔可能获批写同一目标，最终内容取决于谁后 rename 而非审批顺序。
故按 `(sessionId, canonical 远端路径)` 做 in-flight 登记，从批准持有到 rename + 清理 + 审计落笔才释放，占用中的
目标直接拒（110）。互斥按目标粒度，不进 `approvalBusyReason`——不同目标的并行传输合法。每会话并发上限 2
（`MAX_TRANSFERS_PER_SESSION`），防多路大传输挤死与文件栏、ZMODEM 桥共用的 SFTP 通道。

### 11.5 闸门与路径

- **远端路径**：`gate.ts` 的 `gateRemotePath`（与 `gateWriteFile` 共用一份）——绝对路径、规范化（拒 `.` `..`
  连续斜杠，非规范形态会让高危路径模式失配降档，fail-closed）、非目录、长度与非法字符。不复用 content 校验。
- **目标路径不猜**：只认指向文件的完整绝对路径，不做"尾斜杠 = 目录 + basename"启发式。
- **分险**：取 `HIGH_RISK_WRITE_PATTERNS`（`.ssh/` 全目录、`/etc/`、`/usr/`、shell 启动文件、cron）∪
  `SENSITIVE_PATH_PATTERNS` 字面命中（补上 `.aws/credentials` 等写云凭据文件），命中即 high。不用
  `findSensitivePath`——它管的是"读泄密"，`authorized_keys`、`/etc/cron.d/*` 都不命中。
- **父目录 realpath**：纯词法规范化挡不住父目录 symlink（`/tmp/x/authorized_keys` 而 `/tmp/x → ~/.ssh`）。提案前对
  远端父目录做一次 `sftp.realpath`，卡上展示 canonical 落点并以它分险；realpath 失败（父目录不存在等）即拒。
  **不做**"提交前复查 realpath"——竞态窗口只能缩不能闭，且 exec 闸门同样纯词法，单给 push 无限加固不对称。
- **本地路径主进程 fail-closed 再查一遍**，不信 CLI 预检：必须存在、必须是 regular file（fifo / device 会让上传
  循环挂住）、必须可读，大小从 stat 取。

### 11.6 覆盖写：同目录临时文件 + rename

直接写目标会撞三个坑：**ETXTBSY**（覆盖正在运行的二进制失败，而这正是部署的主场景）、**中途失败留半个文件**、
**SFTP v3 的 `RENAME` 目标已存在即失败**（不是 POSIX 覆盖语义）。

上传不用 `fastPut`（目标以 `'w'` 打开不带 EXCL；fchmod 失败降级 chmod 时吞掉错误），由 `pushEngine.ts` 手写流式循环：

```
本地 createReadStream ─┬─ sha256 边传边算（审计记的就是这份字节）
                       └─ sftp open('wx') <dir>/<basename>.tsubasa-<16hex>.part
                          逐块 write（进度回调 → 审批卡百分比；60s 无字节推进即失败）
        ↓ rename 前 fstat 验证 size / mode（mode 被服务端 umask 掩掉就补显式 chmod）
        ↓ ext_openssh_rename（posix-rename@openssh.com，原子覆盖）
        ↓ 仅在未宣告扩展时降级：backup-rename 三步
      <dir>/<basename>
```

- 临时文件**必须落目标同目录**（rename 不跨文件系统）；`'wx'` 独占创建 + 16 hex 随机名：预置同名文件或 symlink
  直接 EEXIST 失败，不会跟着 symlink 写到别处。
- **上传前后各 stat 本地文件一次（size + mtimeMs），变了就失败**并提示重跑——防"push 的同时又触发了构建"的撕裂，
  定位是 correctness 护栏而非安全机制（卡本就不审字节）。
- **降级判据只认"未宣告扩展"**：ssh2 的 `ext_openssh_rename` 在服务端未宣告 `posix-rename@openssh.com` 时**同步
  throw**，真实执行失败走回调错误——公开 API 层天然可分，不碰 ssh2 私有字段（只有 `elevatedSftp.ts` 允许摸私有
  API）。同步 throw → 降级；回调错误（断线、权限、目录变化）→ **原样终止，目标文件不碰**。瞬态失败绝不能先删
  健康目标。
- **降级是 backup-rename 三步，不是 unlink**：`target → target.tsubasa-<16hex>.bak`（rename 保 inode）→
  `temp → target` → 成功删 backup；第二步失败则 `backup → target` 还原，不存在"新旧全丢"的窗口。目标本不存在时
  直接 rename。
- **失败尽力清理**：断线时通道已死，unlink 发不出去；清不掉的 `.part` / `.bak` 在 stderr 与审计里如实报路径
  （`.tsubasa-*` 命名可辨识）。不做跨连接的延迟清扫。
- **覆盖且未显式 `--mode` 时，用原 mode 建临时文件**——rename 换 inode，不接原权限的话覆盖一个 755 的二进制会得到
  umask 默认的 644，服务起不来。
- **已知边界**：rename 换 inode，同时换 owner/group、丢 ACL / xattr / capabilities / SELinux 上下文与 hard-link 关系。
  POSIX rename 看的是**目录**权限，用户可写目录里的 root 属主文件会被换成自己的——审批卡展示原 owner 让人看见这一点；
  ACL / SELinux 记边界不处理。

### 11.7 `pull`：不开放

`pull` 不是 push 的镜像，它引入新的安全语义：**绕过脱敏闸门**。`redact` 守的是"流向 LLM 的出口"；pull 把远端字节落
本地磁盘，外部 agent 之后在自己的 harness 里读那个文件，闸门不起作用（`pull /etc/shadow` 再本地读）。人在环审批 +
敏感路径强制 high 能兜住大部分，但当前没有真实痛点推动（看远端内容用 `exec cat` 走脱敏就够）。

真要开放时需一并决定：本地落点路径谁定（调用方给 vs 限制在受控目录）、是否需要不同于 push 的档位基线、审计里本地
路径怎么记。

### 11.8 审计

复用 `AuditKind` 的 `'transfer'`（`direction` / `files` / `bytes` / `savedTo` / `durationMs`），`via` 为 `'cli'`
（另两值 `'trzsz'` / `'bridge'` 属于终端内传输）。`actor` 为 `cli:<名>`，`proposalId` / `decision` 沿用审批台链路。

- **`sha256` 语义钉死为"实际写进远端临时文件的字节"**——上传循环边传边算。提案时对本地文件预算的 hash 证明不了
  批准后传的是什么（源文件在执行时才按路径打开）。
- **失败也落审计**：`outcome` 记成功 / 失败原因、是否走降级路径、清不掉的 `.part` / `.bak` 残留路径。
- `auditLog` 是 best-effort、写盘失败静默（"审计不能反过来阻断主链路"），所以它是**事后追踪**而不是强凭据；transfer
  条目写盘失败时在 CLI stderr 明示一行警告。

### 11.9 测试要点

fake server 的 SFTP 需要：`written` 能保存二进制字节（不能只存 utf-8 字符串，否则"二进制原样落盘"断言写不出来）；
`RENAME` 实现**目标已存在即失败**的真实 v3 语义（照 POSIX 写成静默覆盖会让降级路径永远测不到）；fixture **不宣告**
`posix-rename@openssh.com`，使降级路径成为 e2e 主路径，扩展路径由 OpenSSH 真机验证。

关键断言：批准后落盘字节一致（含二进制）、覆盖警示与原 mode 保持、backup-rename 成功后不留 `.bak`、拒绝 102、
超时撤回 125、敏感远端路径（如 `authorized_keys`）升 high、本地文件不存在 / 非 regular file 退 124、远端相对路径退
101、`--mode` 按八进制生效、失败路径不留 `.part`、忙检查只挡审批三因不挡终端非空闲。

### 11.10 边界

- **不做**：目录递归 / 多文件 / 通配符（打 tar）、`--hosts` 多机分发（N 台各自的覆盖状态与原 mode 不同，一张卡说不清，
  审批语义要重想）、断点续传、信任快车道、内置 Agent 工具面。
- **无总时长上限，有无进度超时**：`--timeout` 只管审批挂起段；传输 60s 无字节推进即失败，不让卡死的通道无限占着同目标
  互斥。大文件用 `--async` + `job`。
- push 内容不经 LLM 通道，**不涉脱敏闸门**；不碰凭据，机密不跨 IPC 的铁律不受影响。
- 与 transfer-design 的 trzsz / ZMODEM 桥**不重叠**：那两条给**人**在终端里用（能穿嵌套 shell / 容器），这条给
  **外部 agent** 用、只通到第一跳。同一个 `getSftp` 通道，入口互不知晓。
