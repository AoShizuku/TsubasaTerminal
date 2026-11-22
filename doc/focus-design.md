# 焦点纪律与无感交互设计

目标：运维在终端 active 时持续输入，其它表面的交互尽量无感。关联
[composer-design.md](composer-design.md)（模式路由与输入方式）。代码入口：
`lib/focusManager.ts`、`lib/clipboard.ts`、`App.vue` 的 `catchStrayKey`。

## 三条公理

1. **焦点有且只有一个家**：终端表面——固定输入栏模式 + prompt 阶段为 composer，
   其余阶段及原生终端模式为 xterm。运维的手感来自确定性预期："我随时敲键，键一定落在终端"。
2. **只有用户显式动作能转移焦点**（点击、快捷键）。系统事件——Agent 回复到达、
   审批提案到达、文件栏刷新、cd 跟随、断线重连——一律不抢焦点，只允许角标 / 状态点提醒。
3. **每次离家都自带回程票**：借用焦点的表面必须定义"什么动作把焦点送回家"，并调用
   `focusHome()`。

## 回程票矩阵

| 表面 | 去（显式动作） | 回家 |
| --- | --- | --- |
| Agent 输入框 | 点击 / Ctrl+Shift+A | Enter 发送并留守，Esc 回家并保留草稿 |
| 审批决策 | 固定模式无需去——决策就在家（composer 同体，Ctrl+Enter 提交）；原生模式 Ctrl+Shift+Y 借焦点给决策输入 | 提交 / Esc 后自动回 |
| 弹窗（主机表单、设置等） | 用户主动打开 | 保存 / 取消后回家，不回触发按钮 |
| 文件栏 | 点击 | 不持键盘焦点——纯鼠标表面，点完立即回家 |
| 复制按钮（消息 / 代码块） | 点击 | 同上，不停在按钮上吃键 |

快捷键全走 **Ctrl+Shift 层**：Ctrl+C/R/W/L/D 等是 shell 命根子，一个不占。
会话切换用 Ctrl+1..9（终端应用惯例）。

## 焦点不动，路由动

vim / htop 等场景的"无感切换"是把焦点问题降维成路由问题：用户没有"聚焦"动作可做错，
由 OSC 133 + 备用屏幕状态机决定按键流向（路由表见 composer-design）：

- 固定模式 prompt 空闲 → composer；
- 命令运行中 → 直通 pty（sudo 密码、apt y/n 天然覆盖）；
- 备用屏幕激活（vim/htop）→ 底部坞隐藏，直通 pty；退出 TUI 后复位。

实现上是**两个接收器 + 状态机自动移焦**：composer 需要真实 DOM 输入框（IME 是核心收益，
无法用 xterm 隐藏 textarea 承载），故固定模式 prompt 态焦点在 composer、其余在 xterm。
模式切换时 focusManager 只在焦点本就在"家"（composer / xterm / body）时才移，绝不从
Agent 框等处抢。兜底：固定模式 prompt 态落在 xterm 上的可打印字符回流 composer 草稿，不丢键。

已知边界：TUI 退出瞬间（输出解析切状态 vs 在途按键）存在毫秒级错向窗口，当前即时切换。

## 不抢焦点清单

| 系统事件 | 允许的提醒方式 |
| --- | --- |
| Agent 回复完成 | 右栏更新 + 角标 |
| 审批提案到达 | 卡片出现 + 角标 + 快捷键提示 |
| 断线 / 连接错误 | 状态点变红 + 终端内红字，**不弹 modal** |
| 文件栏 cd 跟随 / 刷新 | 纯展示，不涉焦点 |
| 新会话连接成功 | 终端获焦（视为用户打开主机这一显式动作的延续） |

modal 是焦点小偷的极端形态：只允许用户主动召唤，系统事件永不弹。

## 易忘细节

1. **点空白 = 回家**：点击任何非交互表面，焦点立即回终端，避免焦点掉到 body 后打字全丢。
2. **窗口失焦恢复**：Alt+Tab 回来时焦点回到离开时的家，而不是浏览器默认的"上一个元素"。
3. **显性焦点信号**：终端持焦时光标闪烁 + 边框微亮；Agent 框持焦时 ring 高亮。
   焦点规则是隐形的，信号必须显性，用户才能自我纠正。

## 选区不是焦点

拖选文本的收尾也是一次 click，而 Chromium 的 selection 归属于 focused element——若此时
回家 focus 输入框，页面选区当场归零，只读文本就无法用鼠标复制。规则两条，缺一不可：

1. **有选区就不回家**——选择是用户的显式动作。
2. **键仍然要落在家**——焦点此时停在非输入元素上（body，或 Chromium 隐式可聚焦的
   `overflow-y-auto` 滚动容器），可打印字符由 `catchStrayKey` 回流到家并回家。
   **焦点可以不在家，键不能不在家。**

配套：composer 的 Ctrl+C 见到页面选区必须让位给浏览器原生复制，不能按"无选区"去清草稿。

复制因此有三条路：终端鼠标（选中即复制）、终端键盘（Ctrl+Shift+C，任何焦点下可用）、
只读文本的原生选区（Ctrl+C）。终端不复用 Ctrl+C——那是 SIGINT。

## 验收标准：闭眼测试

运维不看屏幕连续操作——敲命令 → Ctrl+Shift+A 问 Agent → Enter 发送、Esc 回家 →
继续敲命令 → 进 htop → q 退出 → 继续敲 → 审批到达 y 掉——**零丢键、零错向**。
e2e `focus.spec` 断言 `document.activeElement` 与每次击键落点，把焦点纪律变成回归可保。

## 实现接缝

修改焦点、可见性、弹窗、复制粘贴或终端布局时先检查这些接缝。

- **显隐与落焦时序**：`v-show` 的 display 更新是 post-render effect，可能晚于已入队的
  post watcher；需要显示后立即 focus 的表面用 class 绑定 `hidden`，让 render 同步 patch。
  保留挂载，不能换成 v-if 丢失终端、输入注册或全局弹窗。
- **分栏把手不动焦点**：`ui/Sash.vue` 在 pointerdown 上 `preventDefault()`（阻止 mousedown
  把焦点从 Agent 输入框踢到 body、阻止起选区），根元素标 `data-keep-focus` 让收尾的 click
  不触发回家。两半缺一焦点都会跑。拖动中的光标由 fixed 幕布定形，幕布不接事件（指针已被捕获）。
- **弹窗键盘边界**：`ui/Dlg.vue` 的 DialogContent 保留 `data-modal`，供 `catchStrayKey`
  豁免；拦截 `close-auto-focus` 后调用 `focusHome()`，不回到触发按钮。document 冒泡阶段
  拦住弹层打开时的 Esc，避免同时触发底层回家动作。叠放例外：关闭时仍有别的 Dlg 开着就不拦，
  交还 reka-ui 默认行为，让焦点回到下层弹窗——回家会把焦点送进被遮住的终端。
- **确认框**：一律 `confirmDialog`（`lib/confirm`，App 挂唯一的 `ui/ConfirmDlg`），不用
  `window.confirm`（单测守卫）。它是异步的：同一时刻只问一件事，第二个请求回 false；
  调用方 await 后须重新校验依赖的状态（如粘贴确认后重新取终端，会话已关则不写）。
  危险操作默认落焦取消。弹窗开着时全局 Ctrl+V 不接管——焦点在弹窗按钮上不算输入接收器。
- **标题栏**：空白区域属于原生窗口拖动区，不依赖 DOM click 回家；交互按钮排除拖动。
  标题栏按钮持焦时 Enter / Space 留给按钮激活，不能被 `catchStrayKey` 写进终端。
  设置弹窗挂在 App，关闭后仍走 `focusHome()`，不回到标题栏齿轮。
- **原生下拉的可控显示**：`ui/Sel.vue` 自带 `<button><selectedcontent>`，避免
  base-select 匿名文本盒无法用 CSS 控制；调用方复用封装，不直接写 `<select class="input">`。
- **复制回执与选区**：统一走 `lib/clipboard`，只有 `writeText` 兑现才显示"已复制"。
  页面有选区时不回家，配合 `catchStrayKey` 保住后续键路由，不能只留其中一半。
- **粘贴通路**：读剪贴板走主进程；固定模式 prompt 进命令草稿，其余走 `term.paste()`，
  由 xterm 做换行归一和 bracketed paste 包裹，不能自行拼 `ssh.input`。
  prompt / none 的多行直通须确认（远端已开 bracketed paste 或设置关闭时免问，见 composer-design）；
  running / TUI 不拦截编辑器或 REPL 粘贴。
  右键默认粘贴，关闭选中即复制后恢复 Windows Terminal 二合一行为；Shift+右键出菜单，
  TUI 开鼠标上报时右键让位给应用。
- **人的 pty 输入**：一律经 `sendHumanInput`（TerminalView onData 与 stray-key 兜底共用），
  先标脏行再发送，不直接调 `window.api.ssh.input`。
- **终端几何**：`term.open` 目标元素不能带 padding，留白放外层。FitAddon 按 border-box
  高度计算行数，内层 padding 会导致网格溢出及 TUI 底行裁切，`layout.spec` 有几何断言。
- **审批查看与编辑归属**：只有实际渲染的审批查看器能记为 viewed。独立编辑任务用弹窗，
  不加进中栏占位链；占位与 TUI 暂时隐藏的区别见 [composer-design.md](composer-design.md)。
