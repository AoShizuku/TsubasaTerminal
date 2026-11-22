# 参与贡献

感谢你愿意改进 Tsubasa Terminal！提交前请花几分钟读完本文。

## 开始之前

- **Bug**：请附上复现步骤、期望与实际行为、版本号（设置 → 关于）、远端系统与 shell。
  日志或截图中请先去掉主机地址、用户名、密钥等敏感信息。
- **功能**：较大的改动请先开 Issue 讨论方向，避免做完才发现与设计冲突。
- **安全问题**：不要公开提 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

需要 Windows 10 / 11 与 Node.js 22。

```bash
npm ci
npm run build:cli   # 首次使用 CLI 前构建
npm run dev         # 开发模式，热更新
```

网络环境、测试筛选、真机 smoke 与发布流程见 [开发手册](doc/development.md)；
模块职责与关键合约见 [技术架构](doc/architecture.md)；修改某个功能前先读
[文档索引](doc/README.md) 中对应的专题设计。

## 测试

按边界放测试：

| 层 | 放什么 | 命令 |
| --- | --- | --- |
| unit | 纯逻辑 | `npm run test:unit` |
| integration | 主进程协议、存储、IPC handler | `npm run test:integration` |
| component | 组件状态与反馈 | `npm run test:component` |
| e2e | Electron / preload / xterm / PTY / 命名管道等真实接线 | `npm run test:e2e` |

- 修 Bug 的回归测试必须经过缺陷发生的那一层边界，不能只在两端分别 mock。
- PR 前请确保 `npm test` 与 `npm run typecheck` 全绿；涉及跨层接线时补充并运行对应 e2e。
  CI 只跑静态检查与快速测试，e2e 需在本地 Windows 上运行。
- SSH / sudo / SFTP 协议相关改动，fake server 不能代替真机，请说明你在什么环境验证过。
- 增删或升级依赖后运行 `npm run gen:notices`，随依赖改动一起提交。

## 不可破坏的约束

这些是项目的安全底线，PR 不应削弱它们（详见 [CLAUDE.md](CLAUDE.md)「安全与跨模块约束」）：

- 机密只在主进程解密，已保存的凭据和 API Key 不回传渲染进程。
- 命令闸门由代码硬判，模型无权降低规则风险；CLI 复用 Agent 的闸门与审批，不另写安全逻辑。
- 终端写入 fail-closed；渲染层人工输入统一走 `sendHumanInput`。
- 持久知识须经人确认，Agent 不能自动落盘或改写。
- 跨进程 API 类型只在 `src/shared/types.ts` 定义一份；`npm run check:cycles` 禁止新增循环依赖。

## 代码与界面约定

- TypeScript + Vue 3 `<script setup>`；新弹窗用 `components/ui/Dlg.vue`，下拉用 `Sel.vue`，
  确认框用 `lib/confirm` 的 `confirmDialog`。
- 字号、图标、颜色使用设计令牌与角色类，不写像素和散色号，`tests/unit/designTokens` 会检查。
- 源码不要嵌入零宽 / RTL 等不可见字符字面量。

## 提交与 PR

- 一个 PR 做一件事；提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)
  风格，如 `feat: …`、`fix(sftp): …`、`docs: …`、`test: …`、`chore: …`，中英文均可。
- 用户可见的变化请在 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased` 小节补一行。
- 界面改动请附截图；视觉调整最终需要真人观察确认。

提交即表示你同意以 [MIT 许可](LICENSE) 发布你的贡献。
