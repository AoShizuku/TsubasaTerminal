# Tsubasa Terminal 开发手册

本文记录环境、测试运行与发布维护方法。贡献流程与提交约定见
[CONTRIBUTING.md](../CONTRIBUTING.md)，协作硬约束见 [CLAUDE.md](../CLAUDE.md)。

## 本地开发

仓库根就是代码根。依赖与脚本以 [package.json](../package.json) 为准。

```bash
npm ci
npm run build:cli   # 首次使用 CLI 前构建；dev 不包含 CLI 产物
npm run dev        # Electron + Vue 热更新
```

`npm run build` 构建应用与 CLI 到 `out/`；`npm run build:win` 再打包 Windows NSIS
安装程序到 `dist/`。修改 CLI 源码后须更新 CLI 产物，单跑 dev 不会更新它。

Electron 与 electron-builder 二进制默认从 GitHub 下载。直连 GitHub 不稳定的网络
（如中国大陆）可在**用户级** `~/.npmrc` 配置镜像，不要提交到仓库：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

若报 Electron 安装不完整或“Electron uninstall”，可运行
`node node_modules/electron/install.js` 补装。
开发期 DevTools 用 F12。应用已移除 Electron 默认菜单，以免 Ctrl+W / Ctrl+R
被菜单加速键截走；`autoHideMenuBar` 不能替代 `Menu.setApplicationMenu(null)`。

## 测试运行

| 命令 | 边界 / 用途 |
| --- | --- |
| `npm test` | 全部快速测试，不启动 Electron |
| `npm run test:unit` | 纯逻辑 |
| `npm run test:integration` | 主进程合约：本地 HTTP、临时文件系统、状态机与 IPC handler |
| `npm run test:component` | jsdom + Vue Test Utils 的组件状态与交互 |
| `npm run typecheck` | 主进程、渲染进程、测试类型检查、循环依赖守卫与第三方许可清单守卫 |
| `npm run check:cycles` | 只跑循环依赖守卫；追加 `-- --list` 只列出 |
| `npm run check:notices` | 只跑许可清单守卫；`npm run gen:notices` 重新生成 |
| `npm run test:e2e:daily` | 构建 + 日常跨层代表集 |
| `npm run test:e2e` | 构建 + 全量 Electron 回归 |
| `npm run test:smoke` | 构建 + 独立真机 smoke，需配置目标 |

e2e 验证 Electron / preload / IPC / xterm / 焦点 / PTY / ssh2 / Windows 命名管道等
真实接线；普通回归连接本地测试服务器，真机 smoke 独立放在 `e2e/smoke/`。
e2e 和 smoke 都有 `:nobuild` 变体，只能在 `out/` 对应当前源码时使用。

### 定点筛选与车道

```bash
npm run test:e2e -- e2e/cli.spec.ts --grep "push"
npm run test:e2e:daily -- --list
```

[run-e2e.mjs](../scripts/run-e2e.mjs) 顺序运行“后台渲染”和“桌面边界”两条车道。
daily 与 `@daily` 取交集；桌面车道取 `@headed`，后台取其补集。
用户文件、grep 筛选继续与这些条件取交集，`--list`、`--repeat-each` 等参数会转发。
一条车道无匹配可跳过，两条都无匹配默认失败，避免筛错却报告全绿。

默认 daily 两条车道各用 2 workers；full 后台用 5、桌面用 2。
后台窗口移出桌面并透明渲染，默认可见窗口最多 2 个；直接调用 Playwright 默认也是 2 workers。
`TSUBASATERMINAL_E2E_HIDDEN_WORKERS` / `TSUBASATERMINAL_E2E_HEADED_WORKERS` 分别覆盖两条车道，
`TSUBASATERMINAL_E2E_WORKERS` 统一覆盖；只采纳正整数，车道专用值优先于通用值。

### Fixture 与断言接缝

- [launch.ts](../e2e/fixtures/launch.ts) 用 `TSUBASATERMINAL_USER_DATA` 隔离 userData，
  模型配置预置用 `plain:` 测试密钥，免 safeStorage 环境差异。
- CLI 安装测试用 `TSUBASATERMINAL_CLI_HOME` / `TSUBASATERMINAL_CLI_SKIP_PATH` 将落点改到沙盒，
  **绝不能修改开发机真实 PATH**。
- PowerShell shim 回归要求 PATH 上同时有 `powershell.exe`（5.1）和 `pwsh.exe`（7），
  缺宿主会失败，不静默跳过。`e2e/cli-shim.spec.ts` 可用 `TSUBASATERMINAL_SHIM_TEST_EXE`
  指定打包或从 NSIS 包解出的 `TsubasaTerminal.exe`，验证实际 GUI 子系统产物；只在产物对应
  当前源码时用 `npm run test:e2e:nobuild -- e2e/cli-shim.spec.ts`，结束后移除覆盖变量。
- [fake-ssh-server.ts](../e2e/fixtures/fake-ssh-server.ts) 提供密码认证、行回显 shell、
  cd / OSC 模拟和最小 SFTP；`tui` 进入 alternate screen，`q` 退出；`bpon` 打开
  bracketed paste（此后 prompt 带 `CSI ?2004h`，粘贴块进行缓冲、回车才执行）。
- 系统剪贴板整机共享，并行 worker 互相覆盖；只测粘贴落点时替换主进程
  `clipboard.readText`（见 `input-mode.spec.ts` 的 `seedClipboard`），测复制写入才用真剪贴板。
  [fake-llm-server.ts](../e2e/fixtures/fake-llm-server.ts) 按用户文本选择模型响应剧本，
  工具结果轮回显 `tool-result:` 供断言。
- fixture 的 `close()` 必须主动断开存活连接，否则 `server.close` 会挂起。
- 会阻塞的提案不要用等待 assistant 消息增加的 `askAgent`，直接 fill + Enter；
  确认框是应用内 `ui/ConfirmDlg`（没有 `window.confirm` 可 stub），按
  `confirm-message` / `confirm-ok` / `confirm-cancel` 断言与点击；断言"没弹"用
  `input-mode.spec` 的 `installConfirmProbe`（DOM 探针）。外开链接替换主进程
  `shell.openExternal` 记录调用（见 `agent.spec`）。
- 设置或主机表单的非当前分节不在 DOM 中，操作控件前用
  `openSettings(page, section)` / `hostFormTab(page, tab)` 切到正确位置。
- xterm 使用 DOM 渲染器；终端内容通过 `window.__tsubasaterminal.getActiveTerminalText()`
  或 fixture 的 `activeTerminalText` 断言，与 Agent 共用读屏入口。

循环依赖守卫 [check-cycles.mjs](../scripts/check-cycles.mjs) 只计算 value import，
用 `KNOWN_CYCLES` 棘轮放行存量，不允许新增环；不要通过扩大基线掩盖新依赖问题。

### 第三方许可清单

根目录的 `THIRD_PARTY_NOTICES.md`（清单）与 `THIRD_PARTY_LICENSES.txt`（全文）由
[gen-notices.mjs](../scripts/gen-notices.mjs) 生成，不要手改。**增删、升级依赖后跑
`npm run gen:notices` 并随依赖改动一起提交**；不同步时 `check:notices`（typecheck 与 CI
都会跑）失败。口径：

- 分发集合 = `dependencies` 沿 dependencies / optionalDependencies 边的闭包，**不走 peer 边**
  （lockfile 的“非 dev”标记会把 `@electron-toolkit/utils` 的 peer `electron` 本体算进来，
  而安装包里并没有它）。该口径与打好的 `app.asar` 逐包核对一致。
- dev 依赖的内容若被打进产物（Vite 编进渲染层 bundle，或像 `fig-specs.json` 那样从 dev
  依赖提取后提交），须登记在脚本的 `BUNDLED_DEV` 并写明随包分发的是什么。守卫会扫描
  `src/` 的运行时 import，解析到未登记的 dev 依赖即失败；`import type` 不计。
- Electron / Chromium 的许可由 electron-builder 自带的 `LICENSE.electron.txt` 与
  `LICENSES.chromium.html` 承担，不进清单。配色方案色值来源、语料来源等生成器看不到的事项
  写在脚本的 `MANUAL_NOTES`，改配色、改语料或改打包配置时一并复核。

## 真机验证

fake server 与真机互不替代：SSH / sudo / SFTP 协议、shell integration 等行为变化，
须在自备的 Linux 测试机上按本次改动验证，不能从旧记录外推。建议用一次性 VPS 或虚拟机，
不要对生产机跑 smoke。

可将 [smoke.config.example.json](../scripts/smoke.config.example.json) 复制为同目录
`smoke.config.json`（不入库），填写目标后运行：

```powershell
./scripts/nightly-smoke.ps1
```

该脚本读取配置后运行 `npm run test:smoke`，日志写到 `test-results-smoke/nightly.log`。
也可自行设置 `TSUBASATERMINAL_SMOKE_HOST`、`TSUBASATERMINAL_SMOKE_USER`、`TSUBASATERMINAL_SMOKE_PORT`、
`TSUBASATERMINAL_SMOKE_KEY` 后运行 smoke；HOST 需要地址，测试不解析 SSH config 别名。
未设置 HOST 时用例会跳过，**跳过不算真机通过**。tmux 扩展用例还需显式设置
`TSUBASATERMINAL_SMOKE_TMUX=1` 并满足测试声明的远端前提。

## 发布与构建维护

CI 配置在 [ci.yml](../.github/workflows/ci.yml)，分支推送与 PR 执行静态检查和三层快速测试
（GitHub Actions `ubuntu-latest`）。e2e 不进 CI：它启动 Electron，且 CLI 回归依赖
Windows 命名管道，由本地跑。工作流 YAML 由 [.gitattributes](../.gitattributes) 固定 LF，
避免 Linux `run:` 块混入 CR。

CD 配置在 [release.yml](../.github/workflows/release.yml)：在 main 上推送 `v*` tag 触发。
guard 校验 tag 被 main 包含、名称等于 `v<package.json 版本>`，且 CHANGELOG 有该版本的
非空小节；再在 `windows-latest` 上原生构建 NSIS 安装包，挂为 GitHub Release 附件，
同时保存 Actions 制品兜底。Release 说明由 [release-notes.mjs](../scripts/release-notes.mjs)
从 CHANGELOG 截取该版小节，后附未签名提示；重推同名 tag 时替换附件并刷新说明。

分支模型：`main` 只承载已发布状态，每次发版从 `develop` 快进；`develop` 是集成分支，
须随时可发布，外部 PR 以它为目标。新功能在 `feat/<主题>` 上开发，全量 e2e 全绿后
rebase 并快进合入 develop；bugfix 直接提交 develop，提交前跑快速测试、相关 e2e 与 daily。
不从 main 拉 hotfix，否则 main 与 develop 分叉，下次发版无法快进。

发布步骤：

1. 在 develop 上做 release 提交：按 `Unreleased` 内容定版本号（有新功能升 minor，
   只有修复升 patch），bump `package.json`（版本号唯一来源，UI 由 `__APP_VERSION__` 注入）；
   在 [CHANGELOG.md](../CHANGELOG.md) 把 `Unreleased` 下的条目归入 `## [X.Y.Z] - YYYY-MM-DD`，
   其上留一个空的 `## [Unreleased]`，文末补 `[X.Y.Z]:` Release 链接；
2. 对该提交跑 `npm test`、`npm run typecheck` 和含构建的全量 e2e；
3. main 快进到该提交，在 main 上打 `v<版本>` tag，推送 develop、main 与 tag。

改构建配置时，保留下列接缝；原因详见相应配置旁注释：

- guard 与 build-win 分为两个 job，不合规的 tag 不启动 Windows runner。
- CHANGELOG 版本标题 `## [X.Y.Z]` 是 Release 说明的截取锚点，改格式须同步改
  `release-notes.mjs`。仓库内 CHANGELOG 须始终含当前 `package.json` 版本的小节，
  由 integration 测试守着，漏写在打 tag 前就会被 CI 发现。
- [electron-builder.yml](../electron-builder.yml) 的 `publish: null` 与
  `build:win` 的 `--publish never` 缺一不可，分别关闭发布目标猜测与上传策略；
  Release 由工作流用 `gh release` 上传。
- CLI 产物通过 extraResources 放在 asar 外，shim 依赖 `ELECTRON_RUN_AS_NODE`；
  runAsNode fuse 必须保持开启。
- userData 目录固定为 `%APPDATA%\TsubasaTerminal`（`APP_DATA_DIR_NAME`，主进程启动时显式设定），
  与显示名 / `productName`（"Tsubasa Terminal"）解耦；CLI 手动调用时按同一常量兜底找握手 token。
- `electron-builder.yml` 的 `files` 是**白名单**：只收 `out/{main,preload,renderer}`
  与 `package.json`，生产依赖由 electron-builder 按依赖树另收。新增运行时要读的仓库文件必须
  显式加进白名单或走 extraResources；改动后打 `--dir` 包，用 `@electron/asar` 列一遍
  `app.asar` 根目录，确认没有 `doc/`、`tests/`、`.claude/` 之类混入。
- `LICENSE`、`THIRD_PARTY_NOTICES.md`、`THIRD_PARTY_LICENSES.txt` 同样经 extraResources
  落在安装目录 `resources/`，设置→关于按这个位置指引用户，挪位置须同步改文案。
- 修改 shim、PATH 或安装/卸载逻辑时，检查真实宿主和安装产物的行为，
  断言 stdout/stderr 与退出码，不能只检查文件存在或内容。
