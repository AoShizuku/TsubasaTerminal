# Composer 与 Agent 审批台设计

中栏底部的**底部坞（dock）**是人的命令、Agent 的提案、补全候选与审批决策交汇的表面。
关联 [completion-design.md](completion-design.md)、[agent-terminal-context.md](agent-terminal-context.md)、
[focus-design.md](focus-design.md)（焦点纪律与模式路由的无感验收）。

代码入口：`useComposerStore`（输入方式、终端状态、write-safe 派生）、`Composer.vue`、
`TerminalView.vue`、`src/main/llm/terminalState.ts`（主进程可写事实）、
`src/main/llm/approvals.ts`（提案、批准与写 pty）。

## 定位

底部坞钉在 xterm 视口底部，**占位而不覆盖终端**，有两个生产者：

- **人**：固定输入栏模式下在这里组稿命令；
- **Agent**：在这里挂出待批提案，人 y / N / 留言把关。

用户可在两种输入方式间选择；审批条在两种方式下都留在同一位置。切换的是人的命令输入
载体，不是审批位置，更不是审批闸门。

## 输入方式：固定输入栏 / 原生终端

选择的是**人在 shell 空闲时把键敲到哪里**：

- **固定增强输入栏（`composer`）**：键先进本地 DOM textarea，Enter 时整行写 pty；
- **原生终端（`native`）**：键由 xterm `onData` 逐段直接写 pty，命令行编辑、历史、
  Tab 补全全部归远端 shell。

"原生"只指 **xterm → pty 直通**，不是嵌 OS 原生终端控件；渲染内核仍是 xterm，主进程仍是
ssh2，同一条 pty 不变。

| 能力 | 固定增强输入栏 | 原生终端 |
| --- | --- | --- |
| 输入链路 | 本地组稿，Enter 后整行进 pty | xterm 每段 `onData` 直接进 pty |
| 高 RTT 手感 | 本地零延迟 | 依赖远端回显 |
| 中文 IME | 普通 textarea，Windows 下更稳 | 取决于 xterm / 系统输入法 |
| 补全与编辑 | Tsubasa Terminal L1/L2/L3、ghost、Ctrl+R | bash/readline、zsh/zle、fish 等原生能力 |
| 命令历史 | Tsubasa Terminal 精确记录 + 远端 shell | 远端 shell 为主；转录只能从屏幕近似 |
| 审批决策 | 与命令草稿共用输入框 | 底部坞的独立决策输入 |

这不是"高级 / 低级"两档：固定模式换来本地手感、IME 与补全；原生模式换回用户已有的
shell 配置、键位与补全生态。设置页文案必须把交换关系说清。

### 设置作用域

- 全局设置 `terminalInputMode: 'composer' | 'native'`（设置 → 外观 → 终端），默认 `composer`；
- 主机级覆盖 `HostConfig.inputMode`，缺省跟随全局。解析顺序：本机指定 → 全局 → `composer`。
  只此两级，不做 per-tab 覆盖，避免同一个人切标签时输入肌肉记忆漂移；
- 编辑主机即对该主机已开的全部标签生效；状态行在 prompt 文案前标「本机设置」，避免与设置页
  的默认值对不上；
- 无 SI 会话无论偏好如何都是 xterm 直通。

### 安全切换：effective / pending

设置即时生效，但"即时"不能以藏住半条命令为代价。每会话保留 effective 与 pending 两层
（`applyInputPreference`）：

| 现场 | 处理 |
| --- | --- |
| fixed prompt，草稿为空 → native | 立即切换并聚焦 xterm |
| fixed prompt，草稿非空 → native | 记 pending，提示先发送或清空草稿；草稿绝不静默丢弃 |
| native prompt，行 clean → fixed | 立即切换并聚焦 composer |
| native prompt，行 dirty → fixed | 记 pending，等下一次可信 `133;A` 后切换 |
| running / TUI 中切任一方向 | 立即记为 effective；当前本就直通，下一次 prompt 才显现差异 |
| `none` 且偏好 fixed | 仍为直通；SI 恢复后的下一次 prompt 再启用 fixed |

状态行如实显示"等待草稿清空后切换"或"等待当前终端行结束后切换"，不能让设置页显示已切、
实际焦点还在另一条路而无解释。未发送草稿与 pending 不持久化，只保存用户的偏好。
store 不负责落焦（不 import focusManager，避免成环）：设置变更由 App、模式切换由 Composer
的 watcher 各自落焦。

## 终端状态：两条正交的轴

- `TerminalMode = none | prompt | running | tui`：**远端终端阶段**，由 OSC 133 与备用屏幕驱动；
- `TerminalInputMode = composer | native`：**prompt 阶段的输入载体**。

两者必须正交：不能把 `native` 冒充第五个 TerminalMode，也不能用"切回直通模式"实现输入方式
切换——后者会清掉 `integrationSeen`，而原生模式照样需要 OSC 133 提供空闲、cwd、转录、身份
与 TUI 时序。

| 远端阶段 | 判定信号 | 固定模式 | 原生模式 |
| --- | --- | --- | --- |
| `prompt` | 收到有效 `133;A` | 焦点在 composer，键本地组稿 | 焦点在 xterm，键逐段进 pty |
| `running` | 发送回车后至下一个 `133;A` | composer 置灰，xterm 直通（sudo 密码、apt y/n 天然覆盖） | xterm 直通 |
| `tui` | 备用屏幕缓冲区激活 | 底部坞整体隐藏，xterm 直通 | 同左 |
| `none` | 从未收到 133 / SI 已不可信 | 降级为 xterm 直通 | xterm 直通 |

xterm 数据链只有一条：`term.onData → ssh:input` 就是原生路径；两种模式的差别只在 prompt
态的按键拦截、焦点归属与粘贴分流。

- 回到 normal buffer 时先按 running 处理（有 SI）或 none（无 SI），等下一个 `133;A`；
- 主进程写入批准命令时，composer 同步进入 running，避免执行期间仍显示"就绪"、
  诱使用户把交互应答（dpkg 的 y/N、sudo 密码）当新命令发送；
- **断链检测**：`sudo su` 等起的新 shell 甩掉 SI，running 可能永远等不到 `133;A`。
  静默超过阈值且光标行像 prompt 时只标 `stalled` 并提示，处置权交给用户（「切回直通模式」
  `resetToPassthrough`）；不自动降级——running 卡住也可能是命令真在跑，自动降级会连带放开写入。
  明确的身份切换命令由 `lib/siReinject.ts` 自动重载 SI。

## 终端可写判定（不变量）

**"shell 没在跑命令"与"pty 可以安全注入一整行"不是同一个事实。**

固定模式下人的草稿住在本地 textarea，`133;A` 后 pty 的 readline 缓冲为空。原生模式下用户
可能已在远端输入了 `kubectl get po -n pro█`，此时 TerminalMode 仍是 `prompt`，若 Agent 把
命令写入同一 pty，实际执行的是两段文本的拼接。

### 渲染侧：`lineDirty` 与结构化状态

每会话一个保守标志 `lineDirty`（初始 `true` = 未知即不可写）：

1. 有效 `133;A` 到达时置 `false`（唯一的自动复位点；输出里伪造的 A 已被 `lib/oscGuard.ts`
   拦在上游）；
2. 原生 prompt 或 `none` 下人的第一段 pty 输入，在字节写 pty **之前**置 `true`；
3. backspace / Ctrl+U 即使看似删空也不猜，保持 dirty——readline / zle 的自定义键绑定
   不是客户端能可靠模拟的；用户 Ctrl+C 或提交后，下一次 `133;A` 自然复位；
4. 会话断开 / 出错时回到 `true`。

人的 pty 输入统一走 `sendHumanInput`（TerminalView onData 与 App 的 stray-key 兜底共用），
先标记再发送，不得直接调 `window.api.ssh.input`。

`computeWriteStatus` 是 write-safe 事实的唯一计算点，输出
`TerminalWriteStatus = clean | dirty | running | tui | none-unverified`，经
`noteTerminalWriteState` 去抖上报主进程。渲染层所有"能不能批 exec"的判定（单机审批按钮、
`MultiApprovalOverlay` 逐台忙碌行经 `peekWriteStatus`）都从这里出，不在组件里另抄口径。

### 主进程侧：fail-closed 最后一跳

`terminalState.ts` 持有主进程的同一份事实：

- **fail-closed**：只有明确上报过 `clean` 才可写；从未上报（会话刚建、渲染层状态丢失、
  tmux 保活重连回 TUI 现场收不到 133）一律不可写；
- `ssh:input` 收到人的输入时先把 clean 降为 dirty 再转发字节，关掉"上报还在路上、写入已经
  发生"的竞态；
- `approvals.ts` 的 `writeToTerminal()` 是所有 Agent / CLI 写用户 pty 的最后一跳，返回
  `'written' | 'gone' | 'busy'`，区分会话断开与终端此刻不可写；写入同步标记 running，
  check-and-mark 在主进程同一同步段完成，信任免问与多机批准不会互踩；
- 信任免问在真正写 pty 的最后一刻复核；单机批准在删提案、发 resolved 事件、写命令之前复核，
  忙则保留提案并返回原因——不能只靠渲染层禁用按钮，直接伪造 approve IPC 也会被挡；
- 多机批准逐台复核同一事实；CLI pty 路口同样消费它；忙因文案只由 `terminalBusyText` 生成一份；
- 白名单旁路走独立 exec channel，不写用户 pty，不受此限制；write_file / transfer /
  save_experience / continue 同样不碰 pty，照常可批。

`terminalState.ts` 独立成文件而不并入 `approvals.ts`：`ssh.ts` 要在转发前标记会话，而
`approvals.ts` import 了 `ssh.ts`，反向 import 即成环。

### 无 Shell Integration：不伪造自动恢复

`none` 没有下一次可信的 `133;A`，客户端无法自动知道命令何时结束、输入行是否重新为空：

- 初始一律 `none-unverified`（连接初期 rc / motd 可能还在跑，tmux 恢复现场时 pty 更可能
  正对着全屏程序）；
- 状态条给显式恢复动作：在终端按 Ctrl+C 清空后点「已回到空提示符」（`declareLineClean`），
  只有这个人的现场判断能把本会话声明为 clean；人再输入后重新置 dirty；
- 「切回直通模式」只是模式判断，不等于解锁——"输入行为空"是另一个事实，两个声明不合并；
- 不用"光标行以 `$/#/>/%` 结尾"或静默时间做安全判定——输出完全可以长成 prompt，远端内容也
  可以伪造它。

### tmux：自家保活照常，裸 tmux 不兼容

**Tsubasa Terminal 自己的 tmux 保活**（per-host 可选）：SI 经 DCS passthrough 穿透 tmux、
`terminal-overrides` 禁 smcup/rmcup 使外层不进 alternate screen、attach 后延迟空回车制造新
prompt。133 信号链完整，状态机、审批卡、write-safe 判定照常，`lineDirty` 的复位信号同样到达。
断线重连回到 TUI 现场时 pane 不在 shell，收不到任何 133——由 fail-closed 兜底：不解锁、
不写入，直到真实 prompt 出现或用户显式声明。

**用户自配的裸 tmux**（`.bashrc` auto-attach）：外层进 alternate screen → 永久 `tui`，SI 未
注入内层 shell → 无 133。写 pty 的动手链路整条不可用；只读白名单旁路、read_screen、
write_file（SFTP）仍可用。不为它做兼容工程（send-keys / tmux 控制模式是另一项独立设计），
产品答案是引导用户改用本主机的 tmux 保活。可见性止血：**提案 pending 且审批面不可见（TUI）
时，活动 tab 也出角标**（TabBar），别让 Agent 无声卡死。

## 固定输入栏的输入模型（Warp 式）

输入不是 pty 流的一部分：本地组稿，回车才把整行发给 shell，回显自然出现在上方终端流里。

1. **打字零延迟**：本地组稿回车才走网络，不做 mosh 式预测就获得本地手感；
2. **中文 IME**：本地输入框是普通 DOM，避开 xterm 的输入法问题；
3. **补全宿主简单**：不需要从屏幕 buffer 逆向 shell 行缓冲，composer 里就是一个字符串，
   补全三层直接以此为宿主；
4. **与审批台同体**：同一个组件，不做第二个输入表面。

### 按键语义

审批与命令草稿**同一个输入框共存**（提案不阻塞会话），用 Enter / Ctrl+Enter 分流：

| 按键 | 无提案 | 有提案 | 运行态 |
| --- | --- | --- | --- |
| Enter | 发送整行到 pty | **仍发送到 pty**（肌肉记忆不因提案改变） | 直通 |
| Ctrl+Enter | 等同 Enter | **提交审批**：y=批准 · n=拒绝 · 高危输确认词 · 其它文字=留言拒绝 · 空输入=无操作（无"回车默认拒绝"） | 直通 |
| Tab / ↑↓ / Ctrl+R / → | 补全 / 历史 / 搜索 / 接受 ghost | 同左 | 直通 |
| Ctrl+C | 有内容清空，无内容不发送；页面有选区时让位原生复制 | 同左 | SIGINT 直通 |

### 输入行视觉

原则：**决策依据不截断，状态提示可截断**。

- **输入行动态伸缩**：默认 1 行，多行草稿（Shift+Enter / 粘贴）时长高，约 6 行封顶后内部
  滚动。实现走 mirror 驱动：ghost mirror 与 textarea 同字体同边距渲染 `draft + ghost`，
  mirror 在文档流内撑高、textarea absolute 铺满，零 JS 测量，草稿为空时的长 L3 建议也被容纳。
  两侧统一 `break-all`；mirror 尾部补占位处理尾随换行；超高后同步 scrollTop；
- **按钮同行横排**：`[y 执行][N 拒绝]` 在输入行右侧、底对齐，不垂直堆叠。

## Agent 审批台

### 固定模式：与 composer 同体

composer 在有提案时长高（**占位，不覆盖终端**——常驻的东西不能浮，浮层只留给瞬态的补全 /
搜索面板）：

```
[ 人类输入框（家，焦点不动）              ] [y 执行] [N 拒绝]
rm -f config.example.yaml                          ← Agent 提案（等宽、风险色）
【中风险】删除配置文件，不可恢复 · y/n/留言 Ctrl+Enter 提交
```

- **留言是对话轮**：拒绝理由（"先备份再删"）作为 exec 工具结果直接回流 Agent 修订方案；
- **阻塞语义**：exec 工具调用阻塞等待决策，批准后继续等到命令执行完毕，退出码与输出随工具
  结果返回（一批 tool_use 的 tool_result 须一次配齐）。上一条不跑完 Agent 提不出下一条——
  串行天然成立，无队列、无 pending 超时、无迟到决策；
- **焦点纪律**：提案到达不抢焦点、不重排屏幕；决策就在"家"，零鼠标零焦点跳转；
  running / TUI 时输入框直通 pty，靠 y/N 按钮兜底；
- **执行位置**：批准的命令写入用户可见终端执行（进转录、可审计）；只读白名单命令走 Agent
  旁路 channel 免审批；
- **轮数熔断共用此决策面**（费用护栏，非安全护栏，故 y 一键放行是恰当摩擦）：每满
  `ROUND_LIMIT`（15）轮，在下一批工具执行前问 y/N——y 零注入续跑，N 把未执行的调用回为
  "用户显式暂停"工具结果（数据通道，不伪造用户消息）。

### 原生模式：独立决策输入

原生 shell 行不能兼任审批输入：xterm 只暴露按键流和屏幕网格，不拥有 readline / ZLE 的逻辑
缓冲；从屏幕底行反推会被 prompt、软折行、方向键、Ctrl+W、远端 Tab 补全、vi 编辑模式与宽字符
逐一击穿。因此原生模式有提案时，底部坞长成：

```text
[ 审批决策输入（仅提案存在时出现）        ] [y 执行] [N 拒绝]
[ Agent 提案全文 / 风险 / 原因；位置与固定模式审批卡相同             ]
```

- 决策输入只承载 `y / n / a / 高危确认词 / 留言`，绝不发送到 pty；决策草稿 `approvalDraft`
  与命令草稿分槽，提案解决、撤回、会话切换时清空；
- low 档空 Ctrl+Enter、mid 档 y、high 档确认词、a 信任与留言语义与固定模式一致，不降级摩擦；
- `Ctrl+Enter` 只在决策输入持焦时提交；xterm 持焦时不截胡；
- `Ctrl+Shift+Y` 显式把焦点借给决策输入，提交 / Esc 后 `focusHome()` 回 xterm；鼠标可直接点按钮；
- 提案到达不抢焦点。用户正在原生行里输入时卡片只占位出现，exec 批准按钮因 dirty 禁用，
  拒绝 / 留言及不写 pty 的提案仍可处理；
- high 档按钮从决策草稿取确认词，不偷读 terminal buffer。

两种模式共享审批判定函数与卡片，不共享 DOM input；固定模式不为统一代码形态长出第二输入框。
多机批次浮层（`MultiApprovalOverlay`）有自己的输入框，逐台忙碌说明消费同一 write-safe 事实。

### 提案卡视觉

- **提案命令永不截断**（决策依据）：全量 `break-all` 换行，约 8 行 max-h 后内部滚动兜底；
  脚本级长命令的正路是引导 Agent 走 write_file；
- **执行中只显状态**："已批准 · 执行中"不重复命令文本——回显已在终端完整呈现；
- **分级风险圈**：审批卡是圆角框卡片，ring 色随风险分级（低=淡绿 / 中=黄 / 高=红且加重），
  标记"这一块是 Agent 的话"的来源边界；低中高不同色是"对抗狼来了"的视觉对应。风险色是
  renderer 共享 token（`lib/risk.ts`），write_file 查看器同色延伸。

### write_file 审批（效果级审查）

exec 闸门禁止重定向写文件，write_file 是唯一写入正门，审批审的是**效果本身**：

- 提案行显示 `write_file <路径> · 新建/覆盖（原 N 字节）· L 行`，hint 行徽标提示待审批文件；
- 点击徽标 / 提案行在**中栏展开只读查看器**（终端与 composer 之间，占位、终端 refit 让位、
  `max-h-[45%]`）：行号 + 等宽 + 独立滚动，**全文永不截断**（内容上限 256KB 在工具层拒绝）；
  提案到达时默认收起，不重排用户正在看的终端；
- **防盲批**：查看器从未实际渲染过就不能批准——exec 所见即所批，write_file 的"所见"在内容里。
  只有真正渲染出来才记为已查看，不能用"点过打开"代替；
- 高危路径（/etc、/root、~/.ssh、shell rc、cron）确认词 = **目标文件名**；
- 查看器是纯显示面，决策仍在底部坞；SFTP 通道写入，不碰 pty，不受终端忙碌限制；
- 展开 / 收起均 `focusHome()`：阅读靠滚轮不需要焦点，看完直接 y + Ctrl+Enter；composer 的
  Esc 在查看器开着时收起它。

`save_experience` 审批复用同一形态（`ExperienceViewer`）。

### 中栏只读位是独占资源

终端与底部坞之间的位置**同时只能有一个占用方**，否则两个 45% 查看器叠加会把终端压到只剩
一行。优先级只有一档：

```
write_file / save_experience 待审批（要逐行审阅，决定要不要写）
  > 上下文原文查看器（ContextViewer，纯参考，随时可再打开）
```

- 低优先级方在高优先级占位时**真关掉而不是暂时藏起来**——冲突解除时用户注意力早已不在
  它上面，自己冒回来只是惊吓；期间不打开，并在原入口如实说明原因。审批串行，同一时刻至多
  一个提案，两类审批查看器天然互斥；
- **TUI 全屏不是这条链上的一档**：它不占插槽，而是整个中栏区暂时归全屏应用。TUI 时中栏
  面板全部隐藏、退出后原样恢复，不论优先级，与底部坞自身的隐藏 / 恢复同一语义；"真关掉"
  只发生在被提案顶掉时。每个占用方不必、也不应自己检查 TUI；
- **新增占用方之前先问它是不是"任务"**。链上成员都是**只读投影**：内容住在别处（提案、
  上下文 state），面板只是显示，所以可以随便关、随便让位。有自己的输入、与终端会话弱相关、
  完成后就走的是**任务**，做模态弹窗（`ui/Dlg.vue`），不进这条链。经验编辑器即属此类：
  审批必须在中栏是因为"内容与决策同屏"是硬约束，事后编辑经验没有这个约束——形态相似 ≠
  语境相同。引入"暂时藏起来"这种第二让位语义会打破防盲批不变量（未渲染的查看器被记成已查看）。

### 安全边界

- **审批闸门在主进程**：提案状态、批准记录存在持有 exec channel 的主进程，UI 只是显示层；
  渲染进程只回传 `approve(proposalId)` 意图，**主进程执行自己存的提案原文**，绝不执行渲染
  进程回传的字符串；
- **风险分级规则打底**：`rm -rf` / `dd` / `mkfs` / `shutdown` / 写系统路径 / 管道到 sh 等模式
  硬性判高危，LLM 只负责解释文案，不拥有降级权；
- **对抗"狼来了"**：高危审批要求输入命令首词而非敲 y，防止 y 成为肌肉记忆；
- 每次审批决策（谁 / 何时 / 批了什么 / 结果）进审计日志。

## 焦点、粘贴与布局

`focusHome()`：

```text
fixed + prompt  → composer textarea
native（任意阶段）/ fixed + running|tui|none → xterm
```

审批决策输入是"借走焦点的任务面"，不算 home；模式事件不得从它抢焦点，它自己的
Ctrl+Enter / Esc / 按钮处理完成后负责回程。以下各处必须同按 effective input mode 分流，
缺一处就会出现"看着切了，键却落到旧地方"：

- TerminalView 的 prompt 可打印键 / Enter 回流只在 fixed 生效，native 全部放行；
- 点击 xterm 后，fixed + prompt 才把焦点送回 composer，native 自持；
- App 的 stray-key 兜底按 effective input mode 选择追加草稿或送 xterm，不能只看 `mode === prompt`；
- 右键与 Ctrl+V 粘贴：fixed + prompt 进本地草稿，其余走 `term.paste()`，保住 bracketed paste、
  换行归一和 shell 原生落点；
- **直通 pty 的多行粘贴先确认**：多行粘贴在 root shell 逐行即刻执行是运维经典事故。范围限
  `prompt / none`（落点是 shell 行）；`running / tui` 不拦（粘进 REPL / 编辑器是常态）；
  fixed + prompt 粘进草稿本就可见可改，不需确认。远端已开 bracketed paste（xterm
  `modes.bracketedPasteMode`，即远端自己发了 `CSI ?2004h`）时整块进行缓冲、回车才执行，免问；
  设置「多行粘贴前确认」（`terminalConfirmMultilinePaste`，默认开）关闭后一律免问。确认框
  （`confirmDialog`）给行数与前 5 行预览，确认后重新取终端、会话已关则不写，取消则 pty 零字节；
- Ctrl+Shift+C、选中即复制、TUI 鼠标上报规则见 focus-design。

布局不新造浮层。TerminalWorkspace 是"可伸缩 xterm 区 + 中栏查看器 + 底部坞"：

- native 无提案时隐藏命令输入行，只留一条薄状态行（模式、脱敏、断链提示）；
- 有提案时决策行和审批卡在文档流中长高，终端区随之变矮；
- ResizeObserver / FitAddon 负责 refit，切输入模式后额外 `nextTick + fit` 兜底一次；
- 不把审批卡 overlay 到 xterm 底部——那里恰好是 shell prompt、sudo 密码与安装器 y/n 所在位置。

## 转录、历史与补全的边界

- 原生模式下不在前端重建 shell 行，不新增"捕获每个 xterm 按键并模拟 readline"的解析器；
- 直打命令在 **133;C 时刻读屏幕终态**（B 记起点、C 读到光标前，`lib/commandLine.ts`）：
  zle 重绘、行中插入、autosuggestions 与语法高亮都已由 xterm 执行完毕，读出的就是 shell
  接受的那一行。这不是"从屏幕反推输入行"——那指输入过程中的实时推断；这里只读终态、起点精确。
  读数须是 B..C 回显的子序列，否则退回回显近似。已知边界：非 transient 的 RPROMPT 会被一并
  读入；tmux 内的读数靠子序列校验兜底；
- 人手原生命令不写 Tsubasa Terminal 的持久命令历史（主进程只落 `raw.command`），历史归远端 shell；
- Agent 批准 / 信任免问命令由主进程事件提前注入精确文本，结果配对与审计不退化；
- L1/L2 补全、ghost、Ctrl+R 面板在 native 隐藏；连接时的 `compgen -c` 命令表预取保留
  （会话级一次、量小，为切回 fixed 备着）；L3 在 native 与 TUI 时不发请求；
- 不扩 shell integration 让 preexec 回传完整命令——那涉及转义、控制字符伪造、敏感命令内容
  与 bash / zsh / fish 差异，是另一项独立设计。

## 已知怪癖

- **空 prompt 双光标**：固定模式组稿时终端里 shell 的空 prompt 杵在原地（Warp 靠接管 PS1
  解决），当前接受；
- fish 等未注入 SI 的 shell 走 `none` 降级路径；
- 固定模式替换了远端原生 Tab 补全语义，依赖远端自定义补全脚本的用户可改用原生终端模式。

## 明确不做

- 不嵌 OS 原生终端控件，不换 xterm；
- 不让审批复用 xterm 当前 shell 行，不从屏幕 buffer 猜确认词；
- 不在 native 上叠 ghost / 补全面板，避免两个编辑状态机争一行；
- 不做 per-tab 输入方式覆盖；
- 不为裸 tmux（用户自配 auto-attach）做兼容工程；
- 不通过发送 Ctrl+U / Ctrl+C 后立刻拼 Agent 命令来"自动清行"——那可能中断前台任务；
- 不以提示符正则、静默超时或光标位置作为 pty 可写的安全依据；
- 输入方式切换不改变审批风险分级、确认词、信任集与审计语义。
