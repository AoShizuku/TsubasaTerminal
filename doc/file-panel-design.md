# 文件栏与 Shell Integration 设计

关联 [agent-terminal-context.md](agent-terminal-context.md)、[identity-design.md](identity-design.md)。

## 定位

文件栏不是独立的文件管理器，而是 **shell 的实时上下文镜像**：默认跟随终端 cwd，
cwd 同时也是 Agent 与补全需要的上下文。代码入口：`src/main/sftp.ts`、`useFileStore`、
`components/panels/FilePanel.vue`。

## 性能三件套

高延迟链路（RTT 150-250ms）上首开文件页不能等串行 `realpath` + `readdir`：

1. **连接即预热**：SSH 连接成功后立即打开 SFTP 通道，把握手延迟藏进连接阶段。
2. **后台预取**：连上后预取 home 路径与首层目录（`prefetchSessionFiles`）。预热 / 预取失败
   静默吞掉（少数服务器关闭 SFTP subsystem），错误留到文件页可见时展示。
3. **状态入会话 store**：文件状态按 sessionId 缓存，tab 切换不重建、树展开状态保留。
   SFTP 无变更通知，陈旧是本质属性，靠手动刷新与命令结束自动刷新解决。

## cd 跟随

### cwd 获取方式

| 方案 | 结论 |
| --- | --- |
| 解析用户输入流中的 `cd` | 不做：alias / `cd -` / pushd / 脚本内 cd / `$VAR`，漏检误检不可救 |
| OSC 7（shell 上报 cwd） | cwd 的唯一来源，xterm OSC handler 直接接 |
| OSC 133 shell integration 注入 | 提供 OSC 7、命令边界与退出码，见下文基建 |

OSC 7 载荷须过合理性校验（`parseOsc7WithUser`）：必须是 POSIX 绝对路径、有长度上限、
无控制字符；userinfo 位形态非法即按无身份处理——伪造的 cwd 可误导跟随。

### UI 形态

- **跟随 / 浏览双模式**，磁铁图标切换；默认跟随，用户手动点了别的目录即自动暂停跟随
  （强制跟随会打断用户正在看的东西）；恢复跟随时跳回当前 cwd。
- 跟随模式 = **面包屑 + 当前目录平铺列表**（一个永远新鲜的 `ls`，面包屑可向上跳）；
  树形留给浏览模式——home 为根的树在 `cd /var/log/nginx` 时要展开三层，不适合跟随。
- OSC 133;D（命令结束）→ 跟随模式下防抖刷新当前目录（`tar -xzf` 跑完，右栏已显示解出的目录）。
- 文件栏是纯鼠标表面，不持键盘焦点，见 [focus-design.md](focus-design.md)。

### 边界情况

- cwd 无读权限：面板内一行错误提示，不弹窗；
- symlink：按 shell 上报的字面路径走，不做 realpath 纠正；
- 远端路径一律按 POSIX 拼接，不用本机 `path.join`。

## 文件打开：不经过终端

"点击文件 → 向终端注入 `cd && vi`"是被否决的方案，任何"在终端中打开"类功能都须避开它的问题：

1. shell 未必空闲（前台进程 / REPL / 已在 vim 中），盲注入行为不可控；
2. `cd` 是持久副作用且零收益（`vi -- '/绝对路径'` 不需要 cd）；
3. 远端文件名可含引号 / `$` / 换行，拼命令行即自带 shell 注入；
4. vi 是**编辑**不是预览，误触即改生产文件，且目标机未必有 vim。

因此文件操作只走 SFTP：当前提供下载 / 上传；将来的只读预览、本地编辑回传同样走 SFTP，
不经过终端。若将来提供
"在终端中打开"，只能作为右键次级动作：绝对路径 `vi --`、参数经 `shellQuote`、不 cd，
且只在终端可写判定（[composer-design.md](composer-design.md)）放行时写入。

## Shell Integration 基建

一份注入、多个消费者：

1. **Agent 结构化转录**：命令-输出-退出码三元组（[agent-terminal-context.md](agent-terminal-context.md)）；
2. **终端状态与可写判定**：prompt / running / TUI 路由与 Agent 写 pty 的安全前提；
3. **cd 跟随与命令结束自动刷新**；
4. **pty 身份上报**（OSC 7 userinfo，见 identity-design）。

注入方式（`ssh.ts` 的 `warmupSession`）：

- 连接后经 SFTP 普通身份写临时脚本 `/tmp/.tsubasaterminal-si-<sessionId 前 8 位>.sh`，再以首命令
  `. <脚本>` source（终端可见一行，坦诚展示）。文件名带会话随机段是安全必需——`/tmp`
  人人可建文件，固定名可被同机其他用户预先占坑。
- 脚本 source 后不删，`sudo su` 等换 shell 甩掉 SI 时要能重载（`lib/siReinject.ts` 识别身份
  切换命令后自动重载）；每次连接回收一天前的遗留脚本。
- 按主机可关闭（`HostConfig.shellIntegration`）；SFTP 不可用或写入失败自动降级为无 shell
  integration 的基础体验。tmux 保活开启时由 bootstrap 脚本把 SI source 进内层 shell。
