# Agent 如何读取终端上下文（含 TUI）

关联 [agent-design.md](agent-design.md)（工具接口、Agent loop、BYOK）、
[security-design.md](security-design.md)（脱敏与净化闸门）。

## 问题

普通命令的 stdout 是一份"文档"：prompt、命令、输出线性排列，天然是 LLM 友好的上下文。
但 TUI 应用（vim / htop / less / tmux …）的字节流不是文档，是"绘画指令"：切换备用屏幕缓冲区、
光标定位、局部重绘、用反色表达选中。htop 每 2 秒全屏重绘一次——原始流既读不懂又烧 token。

## 核心思路：读屏，不读流

终端仿真器本身是状态机：把所有转义序列应用完，得到的是二维字符网格——这正是人眼看到的东西。
所以喂给 Agent 的可读产物不是流，而是**仿真器的屏幕状态快照**
（同 `tmux capture-pane` 驱动 agent 的思路）。

## 三通道模型

| 通道 | 内容 | 场景 |
| --- | --- | --- |
| 转录 | normal 缓冲区的"命令-输出-退出码"单元（OSC 133 shell integration 结构化） | 日常命令，Agent 的主上下文 |
| 快照 | `read_screen` 工具：当前可视区网格 + 光标 + buffer 类型 | TUI 场景、"看用户在干嘛" |
| 旁路 | Agent 私有的 ssh2 exec channel | Agent 自主收集信息/执行，不打扰用户终端 |

一句话：**转录喂日常，快照喂 TUI，旁路 channel 喂 Agent 自己。**
三个通道的内容进 LLM 前都必须过主进程的净化（ANSI/OSC 剥离、Unicode 归一）与脱敏闸门，
并包在来源定界符内——这是 Agent 读取终端数据的前置门槛。

## 实现要点

- **快照几乎零成本**：xterm.js 已维护状态机，`term.buffer.active` 逐行
  `translateToString()` + 光标行列即可（`useAgentStore.ts` 的 read_screen 应答）。
  快照由渲染进程应答主进程请求，净化脱敏在主进程出口做。
- **模式判定免费**：TUI 会切备用缓冲区（`CSI ?1049h`），xterm 暴露 buffer type
  （`normal` / `alternate`）。normal → 读转录；alternate → 读快照。
- **多 channel 是现成的**：ssh2 一条连接支持多 channel，用户 shell 与 Agent exec 互不干扰。
- 未实现、留作扩展方向：
  - 属性标注：选中行靠反色、vim 模式在状态栏，序列化时标注反色/高亮区域（如选中行加 `»` 前缀）；
  - 静默判定的操作回路："发按键 → 等屏幕稳定（约 300ms 无新输出）→ 截屏 → 决策"；
  - 主进程影子屏幕（`@xterm/headless` 对同一 PTY 流维护镜像），让后台会话不依赖渲染进程也可读；
  - btop 这类盲文图表 TUI 文本语义差，可将画面渲染为图片走多模态——只作少数场景的 fallback。

## 策略：能不用 TUI 就不用

比"读得好"更本质：Agent 自主干活时几乎所有 TUI 都有非交互等价物——
htop → `ps aux --sort=-%cpu | head`；vim 改文件 → `write_file`；less → cat / 分页 `read_output`。
默认走非交互路径，只在两种情况下面对 TUI：任务本身是交互的；或用户开着 TUI 求助
（此时快照就是完美上下文）。
