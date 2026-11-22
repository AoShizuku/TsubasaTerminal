# Tsubasa Terminal 文档

应用介绍与安装见 [根 README](../README.md)，贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 从任务进入

| 要做什么 | 先读 |
| --- | --- |
| 使用终端、文件、Agent 或 CLI | [用户指南](user-guide.md) |
| 安装依赖、运行测试、真机 smoke、维护 CI/CD 与发布 | [开发手册](development.md) |
| 找代码入口、理解进程边界和当前合约 | [技术架构](architecture.md) |
| 查看后续规划 | [路线图](roadmap.md)；已发布变化见 [CHANGELOG](../CHANGELOG.md) |
| 修改某个功能的行为或边界 | 下方对应专题设计 |

## 专题设计

| 领域 | 文档 |
| --- | --- |
| Agent 接入、工具、exec 闸门与 ReAct | [agent-design](agent-design.md) |
| 读屏、转录与上下文三通道 | [agent-terminal-context](agent-terminal-context.md) |
| 对话接续、知识与排障经验 | [knowledge-design](knowledge-design.md) |
| CLI 协议、安装、审批、多机与上传 | [cli-bridge-design](cli-bridge-design.md) |
| 输入模式、审批台、中栏查看器 | [composer-design](composer-design.md) |
| 焦点、键盘、复制粘贴与 UI 实现接缝 | [focus-design](focus-design.md) |
| 脱敏与提示注入防御 | [security-design](security-design.md) |
| 提权与 PTY / exec / SFTP 身份一致性 | [identity-design](identity-design.md) |
| 文件栏、目录跟随与 Shell Integration | [file-panel-design](file-panel-design.md) |
| 命令补全 | [completion-design](completion-design.md) |
| trzsz / ZMODEM 与 SFTP 传输桥 | [transfer-design](transfer-design.md) |
| 主题派生、环境标识与固定色令牌 | [appearance-design](appearance-design.md) |
| Tsubasa 系列共享设计语言、控件层与许可清单 | [tsubasa-alignment](tsubasa-alignment.md) |

## 文档分工

- 根 README 维护产品介绍和安装入口；CLAUDE.md 维护跨任务规则与必读导航。
- architecture 维护当前模块职责和合约；development 维护测试、环境与发布操作。
- 专题设计只描述**当前**设计、约束与必要的理由，不记录演进过程；
  设计变化时直接改写对应章节，代码注释引用的章节号保持稳定。
- 用户可见的变化写进 CHANGELOG；面向用户的用法变化同步更新用户指南。

文档同级互链使用 `xxx.md`，链接到仓库根文件使用 `../xxx.md`。
