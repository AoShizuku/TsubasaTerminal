# Tsubasa Terminal

AI 驱动的 Electron SSH 客户端，Windows 优先。当前版本以 [package.json](package.json) 为准。
仓库根就是代码根，所有 `npm run` 在此执行。目录导航见 [architecture](doc/architecture.md)。
本文件是协作入口；`AGENTS.md` 符号链接指向本文件，修改正文请编辑 `CLAUDE.md`。

## 当前方向

1.0 起作为 Tsubasa 系列的开源项目维护（GitHub 公开仓库为唯一上游）。后续方向见
[roadmap](doc/roadmap.md)，不从功能池自行扩充版本目标；全局选中行为（`user-select: none`）
须单独一版。仓库公开：提交内容不得含个人真实信息、私有主机地址 / 别名、私有域名或凭据，
示例主机用 `web1` / `db1` 一类中性别名、示例地址用 `203.0.113.0/24` 文档网段。

## 安全与跨模块约束

- **机密只在主进程解密**：主机连接按 hostId 发起，渲染进程只见脱敏 HostConfig；
  已保存的 SSH 凭据和 LLM apiKey 不回传渲染进程，Agent loop 在主进程运行。
- **闸门由代码硬判**：exec 白名单是纯函数硬解析，LLM 无降低规则风险的权限。
  CLI 复用 Agent 的闸门、审批与审计，`src/main/cli/commands.ts` 不另写安全逻辑。
- **终端写入 fail-closed**：未上报可写状态即不可写，保留 `writeToTerminal` 最后一跳守卫；
  渲染层人工输入统一走 `sendHumanInput`，不能绕过脏行标记。
- **持久知识须经人确认**：Agent 可以起草经验，不能自动落盘或改写、删除知识。
  审批查看器实际渲染后才能记为已查看，不能用“点过打开”代替防盲批。
- **CLI 总开关默认关**：命名管道是完整控制入口，同用户即同权，握手 token 不隔离同用户进程。
- **写入口必须回执**：校验失败、写盘失败都须反馈；内存已修改时必须能够回滚。
- **公共语义只留一份实现**：跨进程 API 类型在 `src/shared/types.ts`；远端命令参数
  复用 `src/shared/shell.ts` 的 `shellQuote`；远端路径按 POSIX 处理，不能用本机 `path.join`。
  经验表单复用 `ExperienceFields.vue` 及其 limit；CLI 闸门摘要取 `gate.ts`，不抄白名单。
- **避免新增循环依赖**：下层留注入口、上层装配依赖，别反向 import；`check:cycles` 禁止新环。
- 源码不要嵌入零宽/RTL 等不可见字符字面量，用 `String.fromCharCode` 等显式构造。

## UI 高频约定

- 新弹窗使用 `src/renderer/src/components/ui/Dlg.vue`，复用键盘豁免与关闭回焦；
  尺寸给上界，不给固定高度，须适配最小窗口 960×600。新下拉框使用同目录 `Sel.vue`。
  确认与告知用 `lib/confirm` 的 `confirmDialog`，不用 `window.confirm` / `alert`；
  主进程只保留系统文件选择器，不弹原生消息框。
- 自写 CSS 类放 `@layer components`，否则会压过 Tailwind utilities；
  定宽助手用 `wf-`，不占用 Tailwind 可生成的 `w-<n>` 类名。
- 字号写角色类（`text-badge/meta/list/body/title`，等宽 `text-code/code-body`），
  图标用 `.i-12` / `.i-16`（空状态 `.i-20`），不写像素；新增字号角色须同步登记到
  `lib/utils.ts` 的 `TEXT_ROLES`，否则 `cn()` 会把它当颜色吞掉。
  `tests/unit/designTokens` 守着，规则见 [tsubasa-alignment](doc/tsubasa-alignment.md)。
- 中栏用于只读投影；独立编辑任务做模态弹窗。修改占位、TUI 让位或审批决策输入前，
  先读 [composer-design](doc/composer-design.md)。
- 焦点、粘贴、终端挂载与可见性时序统一遵守 [focus-design](doc/focus-design.md)
  的“实现接缝”一节，复用 `focusManager`、`clipboard`，不能另起输入通路。

## 开发与验证

```bash
npm run dev              # 热更新；首次使用 CLI 前另跑 build:cli
npm run build:cli        # CLI 单文件产物；完整 build 已包含它
npm test                 # unit + integration + component，不启动 Electron
npm run typecheck        # 主进程、渲染进程、测试类型检查 + 循环依赖与许可清单守卫
npm run gen:notices      # 增删、升级依赖后重新生成第三方许可清单，随依赖改动一起提交
npm run test:e2e:daily    # 构建 + 日常跨层代表集
npm run test:e2e          # 构建 + 全量 Electron 回归
```

1. 开工先写清本次目标的成功行为、失败行为和真实边界，按下表阅读相关文档。
   SSH 内部接管、sudo stdin 等协议不确定性高的任务，先写独立 spike 直连真机验协议，
   再动产品代码；fake server 与真机互不替代。复用旧约束前检查它的前提是否仍成立。
2. 按边界放测试：纯逻辑用 unit；主进程协议、存储、IPC handler 用 integration；
   组件状态与反馈用 component；Electron / preload / xterm / PTY 等接线用 e2e。
   真实缺陷的回归测试必须经过缺陷发生的边界，不能只在两端分别 mock 成功或失败。
3. 每个目标提交前 `npm test` 和 `npm run typecheck` 必须全绿。涉及跨层接线时，
   同步补齐并跑对应 e2e，不能拖到版本末。迭代先跑相关快速测试和定点 e2e，
   再用 daily 检查外围回归；daily 不能代替新功能自己的相关用例。
4. 默认用含构建的 e2e 命令；只有确认 `out/` 对应当前源码才用 `:nobuild`。
   类型检查与 Vitest 不更新 `out/`。筛选、fixture、真机配置见 [development](doc/development.md)。
5. 版本最终验收前 bump `package.json`（版本号唯一来源，UI 由 `__APP_VERSION__` 注入），
   对最终待合并代码跑 `npm test`、`npm run typecheck` 和含构建的全量 e2e。
   验收后改代码须重验受影响部分；rebase、冲突解决或公共接线改动后重跑全量，
   记录验证对应的提交。**合回 main 的分支必须全量 e2e 全绿。**
6. SSH / sudo / SFTP 协议变化须补真机 smoke；shim、PATH、安装行为变化须经过真实宿主
   和安装产物验证，断言 stdout/stderr 与退出码，不能只检查文件存在或内容。
   视觉调整须经真人观察，指标达标只算候选结果。

## 分支、提交与发布

- 新版本从 main 开 `feat/vX.Y.Z`，开工即定版本号，代码和文档在同一分支。
  一版多个目标逐个完成，通过验证后各自提交，不攒成一个大提交。
- 提交信息中文，Conventional Commits 风格：`feat:` / `fix(...)` / `test(...)` / `docs(...)`；
  仓库、文档整理或工具链变更用 `chore:`，无需为此 bump 产品版本。
- CI（GitHub Actions）跑静态检查与三层快速测试，e2e 在本地验收。**提交、合并和发版后
  默认不轮询、不等待 CI/CD 状态**；仅在用户要求查询或排查已知失败时检查。
- **合回 main 由用户授权**，已有明确授权无须重复确认。合并前 fetch origin；
  main 是功能分支祖先时快进，有分叉先 rebase 并重新验证，保持线性历史。
  合并并推送后删除本地与远程功能分支。
- **是否发布由用户定**，已有发布授权就完成全链路。仅在 main 上打 tag，
  tag 必须等于 `v<package.json 版本>`；推 tag 后由 CD 异步产包，不自动等待发布完成。
  报告时区分“已推送发布 tag”和“安装包已发布”；用户要求确认产物时再检查 Release 附件。
  改动打包或工作流前阅读 [development 的发布说明](doc/development.md#发布与构建维护)
  及配置旁注释，保留 CLI 依赖的 runAsNode fuse。

## 按任务查阅

下表文档在修改对应行为前阅读；完整目录见 [doc/README](doc/README.md)。
当前模块职责与关键合约见 [architecture](doc/architecture.md)。

| 本次任务 | 代码入口 | 必读文档 |
| --- | --- | --- |
| 连接、提权、SFTP 身份 | `src/main/{ssh,elevation,elevatedSftp,sftp}.ts` | [identity-design](doc/identity-design.md) |
| 输入、审批、终端状态 | `useComposerStore`、`terminalState.ts`、`approvals.ts` | [composer-design](doc/composer-design.md)、[focus-design](doc/focus-design.md) |
| Agent 执行、闸门、脱敏 | `src/main/llm/{loop,tools,gate}.ts`、`redaction.ts` | [agent-design](doc/agent-design.md)、[security-design](doc/security-design.md) |
| 模型协议与思考参数 | `src/main/llm/providers.ts` | [agent-design](doc/agent-design.md) |
| 对话、知识、经验 | `conversations.ts`、`systemPrompt.ts`、`experience.ts` | [knowledge-design](doc/knowledge-design.md) |
| CLI、安装与命令提示词 | `src/cli/`、`src/main/cli/`、`commandGuidance.ts` | [cli-bridge-design](doc/cli-bridge-design.md) |
| 文件栏、shell integration、补全 | `sftp.ts`、`useFileStore`、`lib/{transcript,oscGuard,completion}.ts` | [file-panel-design](doc/file-panel-design.md)、[completion-design](doc/completion-design.md) |
| 终端文件传输 | `src/main/transfer.ts` | [transfer-design](doc/transfer-design.md) |
| 控件、布局、配色 | `components/ui/`、`assets/`、`lib/appTheme.ts`、`shared/{terminalThemes,shellPalette}.ts` | [tsubasa-alignment](doc/tsubasa-alignment.md)、[focus-design](doc/focus-design.md)、[appearance-design](doc/appearance-design.md) |
| 读屏、转录上下文 | `terminalRegistry`、`transcript.ts` | [agent-terminal-context](doc/agent-terminal-context.md) |
| 测试、CI/CD、真机环境 | `tests/`、`e2e/`、`scripts/`、`.github/workflows/` | [development](doc/development.md) |

## 文档维护

- 用户可见的变化写进 [CHANGELOG](CHANGELOG.md)（先记在 `Unreleased`，发版时归入版本号）；
  [roadmap](doc/roadmap.md) 只列后续方向，完成的条目移除。
- 专题设计只描述**当前**设计、约束与必要理由：设计变化时直接改写对应章节，
  不写版本标注、演进过程、踩坑故事或验证流水；代码注释引用的章节号保持稳定。
  面向运维的用法变化同步更新 [user-guide](doc/user-guide.md)。
- 代码注释同理：写当前约束与理由，不加版本号括注。
- 删除或下沉 e2e 时，在提交说明中记录断言去向、保留的真实接线和明确不再覆盖的范围。
- 文档与代码同仓库提交；`doc/` 同级互链用 `xxx.md`，链接仓库根文件用 `../xxx.md`。
- 只有新增长期约束或改变工作流才改本文件；常驻入口不加版本流水账、测试数量或返工故事。
