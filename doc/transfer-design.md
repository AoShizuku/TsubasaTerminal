# 终端文件传输设计（trzsz + ZMODEM 拦截桥）

代码入口：主进程 `src/main/transfer.ts`（`TransferPipeline`），渲染进程 `src/renderer/src/lib/transferBridge.ts`。
关联 [agent-terminal-context.md](agent-terminal-context.md)（转录管线）、
[security-design.md](security-design.md)（Agent 上下文纪律）、
[file-panel-design.md](file-panel-design.md)（SFTP 通道）。

本文两条通道都是给**人**在终端里用的。外部 agent 经 CLI 的 `push` 是第三个入口，见
[cli-bridge-design.md](cli-bridge-design.md)——三个入口共用同一个 `getSftp`，互不知道对方存在。

## 背景与定位

- 运维的肌肉记忆是 `rz` / `sz`。它的真实价值场景是**终端能到、SFTP 到不了**的地方：跳板机后再 ssh 一层、
  `docker exec` 进容器——SFTP 只通到第一跳，终端字节流能穿到最里层。
- 直连场景里 SFTP 本可覆盖，缺的只是"打 rz/sz 就能用"的习惯入口。

| 方案 | 结论 |
| --- | --- |
| 自实现 ZMODEM（zmodem.js） | 不做：裸二进制协议混在终端流里，转义、8-bit clean、流控都要自己扛，会话边界判定很脏，生态无人维护 |
| trzsz（`TrzszFilter`） | 真通道：为 xterm/Electron 设计，帧是 base64 文本、magic 是明文 `::TRZSZ:TRANSFER:`，Node 下直接读写磁盘；穿嵌套 shell、兼容 tmux |
| ZMODEM→SFTP 拦截桥 | 习惯入口：检测 ZMODEM 起始帧 → 中止 → 转用现成 SFTP 通道。直连场景远端零安装、习惯零改变 |

**trzsz 不兼容 ZMODEM**：远端必须装 trzsz 并改打 `trz` / `tsz`。在装着 lrzsz 的机器上敲 `rz` 仍会得到乱码——
这就是拦截桥存在的理由。桥吃习惯（直连 + lrzsz 存量），trzsz 吃真需求（嵌套 / 穿透），两者在同一个主进程过滤位置实现。

## 数据管线与剥离语义

主进程 `sendData` 是终端输出的**唯一出口**，过滤器插在这里，下游所有消费者（xterm、转录、Agent 全部上下文通道）
天然看不见协议数据，不需要在任何消费者上打补丁。

```
ssh2 stream ──► TrzszFilter.processServerOutput
                  │（空闲：原样透传；传输中：吞协议帧，文件字节由 main 直写磁盘）
                  ▼ writeToTerminal 回调
                ZMODEM 检测器（跨 chunk 尾缓冲扫 `**\x18B0`）
                  │
                  ├─ 正常 ──► IPC ssh:data（xterm + 转录）
                  ├─ trzsz 传输中 ──► IPC ssh:data:transient（进度条）
                  └─ ZMODEM 抑制 / 扣押中 ──► 吞非 OSC 字节，OSC 透传；扣押则整体缓冲

输入向：ssh:input / 审批写入 / 注入脚本 ──► session.writeInput()
        ──► TrzszFilter.processTerminalInput ──► stream.write
        （传输中 Ctrl+C 的中止语义归 filter 处理）
resize：ssh:resize 同时喂 filter.setTerminalColumns（进度条宽度）
```

| 数据 | 去向 |
| --- | --- |
| trzsz 协议帧 / 文件字节 | **不出主进程**：不进 IPC、xterm、转录、主机记忆和 Agent 任何通道；文件由 main 直写磁盘 |
| 传输进度条 | `ssh:data:transient`：**写 xterm 不喂转录**。`read_screen` 是"人屏所见"语义，能看到进度快照，无害 |
| 传输命令的转录单元 | 只含命令文本 + 退出码，输出体近空，`read_output` 拿到干净单元 |
| ZMODEM 帧垃圾、中止后的 "Transfer incomplete" | 抑制模式吞掉，不上屏不进转录；桥的 hint 行由渲染进程本地写 xterm（不经 pty、不进转录） |

transient 路由：`TrzszFilter.isTransferringFiles()` 在每次 writeToTerminal 回调时按当下状态决定走 transient 还是正常通道，
不自维护状态机、不需要超时保险（filter 的 finally 保证复位，含取消与协议出错）。raw 流仍扫 `::TRZSZ:TRANSFER:([SRD]):`
magic，只为审计记方向。

- magic 行本身在 filter 接管（约 10ms 异步检测）前已透传，转录与屏幕会留这一行明文——无害且可辨识。
- shell integration 关闭的会话**不启用 transient**（转录本就不组装），全走正常通道。

## trzsz 集成

- `TrzszFilter` 常驻主进程，每会话一个实例，随会话销毁。
- `chooseSendFiles` / `chooseSaveDirectory` 接 Electron `dialog.showOpenDialog`。文件字节在主进程直接落盘，
  **不过 IPC**——这也是 filter 放主进程的原因之一：大文件不挤占 IPC 与渲染进程。
- `isWindowsShell: false`：远端是 POSIX shell，"Windows 优先"指的是客户端。
- 目录传输（`trz -d` / `tsz -d`）跟随 filter 原生能力，UI 不做特殊处理。

## ZMODEM 拦截桥

### 检测、中止、抑制（主进程）

- 检测点在 writeToTerminal 输出（即 trzsz 空闲时透传的数据），跨 chunk 尾缓冲。
- 特征 `**\x18B0`（`2A 2A 18 42 30`），后续 hex 定方向：`00` = ZRQINIT（远端 `sz` → **下载**）；
  `01` = ZRINIT（远端 `rz` → **上传**）。
- 中止：立即向 pty 写 8×CAN + 10×BS（lrzsz 惯例），远端打印 "Transfer incomplete" 退出、回 prompt。
- 进入**抑制模式**：吞非 OSC 输出，OSC 透传（保住 133;D/7/A/B 时序，转录单元正常闭合、文件栏 cwd 不失联），
  直到 133;D；保险上限 16KB / 5s（D 永不到达时）。

### 桥驱动（渲染进程）

主进程只管"检测 + 中止 + 抑制"，随后发 `ssh:zmodem` 事件 `{sessionId, kind}`。业务驱动放渲染进程，
因为 cwd 与命令文本都在渲染进程的转录状态里（OSC 7 cwd + composer 的精确命令文本），不在主进程重复扫描。

- **下载**（远端 sz）：取当前命令文本（composer 精确文本优先，直打场景用回显剥 ANSI 近似）→ 引号感知分词、
  跳过 `-` 开头的 flag → 相对路径按 cwd 拼 POSIX 绝对路径 → `transfer:bridge-download`：单文件走保存对话框，
  多文件选一次目录后逐个 fastGet。
- **上传**（远端 rz）：`transfer:bridge-upload` 弹多选对话框，传到当前目录，完成后手动触发文件栏刷新
  （传输不经 shell，命令结束信号不会来）。
- 开始、成功、失败、取消都在 xterm 本地写一行带色 hint（`[Tsubasa Terminal] …`），不经 pty、不进转录。
- 失败按 errno 分流诊断：路径不存在才提示"嵌套场景请远端装 trzsz 用 trz/tsz"，权限问题说身份不足，不能一律归为嵌套。

### prompt 扣押

被中止的 sz/rz 一个 RTT 就回 prompt，而结果 hint 要等对话框 + SFTP，prompt 必然插在两行 hint 中间。因此：

- 抑制模式在 133;D 后不立即放行，转入**扣押**：D 起的输出（含 OSC 时序与 prompt）整体缓冲；渲染进程桥收尾
  （成功 / 失败 / 取消都在 finally）发 `transfer:bridge-release`，主进程才 flush。视觉顺序恒定：
  检测提示 → 结果 → prompt 干净落底，不用多按 Enter。
- hint 行整行纪律（行尾换行），放行的 prompt 从新行 0 列起笔。
- 护栏：15min 超时兜底 flush（对话框可能开很久）、256KB 扣押上限、会话销毁无条件 flush、release 先于 D 到达也安全。
- 有意的副作用：桥期间 composer 保持 running 态（A 随 prompt 被扣押）——传输中本就不该是就绪态；
  转录单元的闭合时间含桥时长。

### 桥的已知边界

- 通配符不展开（`sz *.log`）：跳过并提示改用文件栏或 tsz。
- 嵌套 ssh / `docker exec` 里的 rz/sz：SFTP 够不着最里层，"是否嵌套"无法可靠检测，以 SFTP 路径不存在作为判据给出 trzsz 提示。
- `~` 只展开 `~/` 前缀，`~user` 不处理。
- 输出流中偶现 `**\x18B0`（如 cat 二进制文件）会误触发：中止序列对 shell 无害，多弹一次对话框可取消，接受。

## 安全与审计

- `trz` / `tsz` / `rz` / `sz` **不进 exec 只读白名单**：Agent 提案这些命令照走审批，文件出入境永远人批。
- 传输事件进 `audit.jsonl` 的 `transfer` 类目（方向、文件名、字节数、成败、经由 trzsz 还是桥），与 `write_file` 同级。
- 文件内容是人与磁盘直传，不经 LLM 通道、不涉脱敏闸门；传输不碰凭据，机密不跨 IPC 的约束不受影响。

## 测试

- e2e 用 fake SSH server：fake SFTP 支持读路径；fake shell 提供 `sz <name>` / `rz` 吐 ZMODEM 起始帧、`tsz <name>` 吐 trzsz magic。
- 原生对话框经环境变量 mock：`TSUBASATERMINAL_E2E_SEND_FILES`（`;` 分隔，`CANCEL` 表示取消）、`TSUBASATERMINAL_E2E_SAVE_DIR`。
- 剥离是断言重点：中止序列到达 server、屏幕无帧垃圾、转录单元干净、传输期间 `ssh:data` 正常通道无进度条字节、
  fastGet / fastPut 真被触发、hint 行可见。trzsz 协议无正式文档，完整 happy path 以真机验证为准。

## 边界

- **tmux 内**：trzsz 双向正常（协议自带 tmux 杂讯容忍）；桥按设计降级——tmux 吞 OSC 133/7，没有 D 信号，
  抑制走 5s 保险退出（prompt 最多停顿 5s，不会挂死），sz 无法解析参数、rz 传到 home，扣押不生效。
- **无 shell integration 的会话**：桥可用但 cwd / 命令文本未知——sz 退化为提示，rz 上传到 home；transient 不启用。
- 大量小文件逐个 fastGet，无并行优化；超大文件无断点续传（trzsz 协议本身不支持 resume）。
- 拖拽上传（filter 的 `uploadFiles`）未接入。
- 不设开关：桥与 trzsz 常开。真正的 ZMODEM 客户端本就不存在，"关掉桥回到乱码"没有使用者。
