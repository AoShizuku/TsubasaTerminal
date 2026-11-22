# 路线图

已发布版本的变化见 [CHANGELOG](../CHANGELOG.md)。本文只列后续方向，不承诺排期；
条目按优先级粗排，欢迎在 Issue 中讨论。

## 近期

- [ ] **全局禁止文本选中**：`user-select: none` + `.selectable` 白名单，对齐 Tsubasa 系列
      其他应用。剪贴板整条链都挂在选中行为上，单独一版完成（约束见
      [tsubasa-alignment](tsubasa-alignment.md)）。

## Skill 系统

先看日用暴露的真实痛点再定形态。已有判断：偏 prompt 式 markdown 而非声明式 YAML
（环境异质性靠 LLM 适配、传播门槛更低）；**skill 不豁免闸门**，体验出路在“把审批粒度从
命令升到计划”而非放权。载体沿用 CLI 通道已采用的 skill 格式（见
[cli-bridge-design](cli-bridge-design.md)），内置 Agent 复用同一批文件。

- [ ] skill 机制：声明式步骤 + 幂等检查，Agent 执行并逐步验证
- [ ] VPS 初始化 skill 包：SSH 加固 / BBR / Docker / 测速回程
- [ ] 终端美化 skill：starship + 配色一键装好

## 功能池（未排期）

- [ ] 多机输入广播（Agent 侧的多机执行已由 CLI `--hosts` 提供）
- [ ] 隧道管理 UI：本地 / 远程 / 动态端口转发、ProxyJump 跳板链
- [ ] 文件本地编辑回传（WinSCP 模式）、只读预览（SFTP 读前 64KB）
- [ ] 文件“在终端中打开”：`vi -- 绝对路径` 只填充不回车（依赖 OSC 133 空闲检测，
      见 [file-panel-design](file-panel-design.md)）
- [ ] 会话录制与回放（asciinema 格式）：合规审计 + Agent 评估数据
- [ ] 脱敏占位符回填：Agent 写占位符、主进程执行边界替换真值
      （见 [security-design](security-design.md)）
- [ ] 熵检测脱敏层
- [ ] ssh config 导入识别 `# tsubasa:env=prod` 注释约定，自动带环境等级
- [ ] 对话压缩：阈值触发的一次性压缩（`/compact` 形态），只压 tool_result 正文、
      保留审批状态与最后一张屏幕快照，在用户轮边界执行并在 UI 明示——
      不做每轮滚动瘦身，那会让 prompt cache 每轮失效
- [ ] 终端内转录单元勾选（xterm decoration，OSC 133 锚定），替代 Agent 面板的 picker
- [ ] macOS / Linux 支持（当前 CLI 通道依赖 Windows 命名管道）
