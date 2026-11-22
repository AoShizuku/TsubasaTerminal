# 身份平面一致性设计（登录后以 root 运行 + 三通道对齐）

代码入口：`src/main/{ssh,elevation,elevatedSftp,sftp,sftpError}.ts`，
身份相关的闸门见 `src/main/llm/{gate,tools,trust}.ts`，审计见 `audit.ts`。

关联 [security-design.md](security-design.md)（闸门与脱敏纪律）、
[transfer-design.md](transfer-design.md)（ZMODEM 桥与 SFTP 通道）、
[file-panel-design.md](file-panel-design.md)（文件栏）、
[agent-design.md](agent-design.md)（exec 闸门与工具）。

## 问题定义：三个身份平面

运维常见习惯是以普通用户登录再 `sudo su`，然后在 root 下操作。但 `sudo su` 只改了
三个身份平面中的一个：

| 平面 | 载体 | 身份来源 | `sudo su` 后 |
| --- | --- | --- | --- |
| 人屏 | pty shell（`conn.shell`） | 跟随 su/sudo | **root** |
| Agent 独立 exec | `conn.exec` 一次性 channel | SSH 登录用户 | 仍是登录用户 |
| 文件栏 / 传输 / `write_file` | SFTP subsystem | SSH 登录用户 | 仍是登录用户 |

后两者由 sshd 直接 fork，协议层面不存在继承 pty 内 sudo 进程身份的途径。
**这部分是结构，不是 bug；系统不能把这个差异藏起来，让用户和 Agent 各自去猜。**

不处理时的典型症状：

- **exec**：普通会话的 exec 会加 `cd -- <latestCwd> &&` 前缀，`latestCwd` 来自 pty 的
  OSC 7——那是人屏平面的 cwd（`/root`），登录用户 cd 被拒，命令根本没跑。
- **文件栏**：SFTP 以登录用户 opendir `/root`，EACCES。
- **rz/sz**：ZMODEM 桥转 SFTP `fastGet`/`fastPut`，同样是登录用户身份。
- **审计**：若身份取主机配置的登录用户，`sudo su` 后经审批台在 pty 里跑的 root 命令
  会被记错身份。

本设计分两层：**登录时定死身份**（主线，消灭分叉）+ **存量兜底**（用户仍会手动
`sudo su`，必须如实暴露错位）。

## 路线取舍

| 路线 | 结论 |
| --- | --- |
| 中途对齐（检测到 `sudo su` 后设法把 exec 也切到 root） | ❌ 时机不可靠、状态机复杂，且 SFTP 那条腿对不齐 |
| **登录时定死**（连接握手阶段确定身份，全程不变） | ✅ 把"中途分叉"变成"没有分叉" |
| exec 自由切换（Agent 想用 root 就自己 `sudo`） | ❌ 安全模型不允许（见下节） |

不能指望"改用 root 直登"：云厂商镜像与等保基线普遍 `PermitRootLogin no`，
**`sudo su` 常常是唯一路径**。

登录时定死还拿到一个手动 `sudo su` 结构上拿不到的时序：「连接 → 身份切换握手 +
exec 探活 → 装载 SI → 探主机档案」。转录从第一条命令起就是 root 的，cwd 不停更，
主机档案探到的 `id -un` 与 `$HOME` 与人屏一致。

用 `sudo -i` 而非 `sudo su`：login shell、加载 root profile、cwd 落 `/root`、环境干净，
语义最接近 root 直登；`sudo su` 那种"身份是 root、cwd 还在登录用户家目录"的半吊子状态
本身就是错位源。`su -` 形态目前不做。

## 安全前提：每一处身份变化都捆绑对应的闸门收紧

`gate.ts` 白名单 + 自动执行快车道的隐含前提是：**"只读命令"的破坏上限由 OS 权限位兜底**。
登录用户身份下，`cat` 即使被注入诱导也读不到 `/etc/shadow`。root 身份拆掉了这层兜底；
脱敏闸门是启发式，不是权限，不能顶这个位置。

> **身份变化与闸门收紧必须捆绑，不能单独上线其中一侧。**

| 变化点 | 捆绑的闸门改造 |
| --- | --- |
| exec 通道以 root 运行 | 路径敏感度维度 + root 会话风险档位位移 + 跨会话信任冻结 + 审计 `elevated` |
| SFTP（含 `write_file`）以 root 运行 | `write_file` 分档在 root 会话整体上抬（mid→high） |

**路径敏感度**是与白名单正交的第三个维度：白名单管"这个动词会不会改系统"，
`POLYMORPHIC` 风险表管"同一命令不同写法的危险程度"，路径敏感度管"这次读会不会泄密"
（`gate.ts` 的 `SENSITIVE_PATH_PATTERNS` / `SENSITIVE_GLOB_AREAS`：`/etc/shadow`、
`/etc/sudoers*`、`*/.ssh/id_*`、`/proc/*/environ`、root 的 shell history、云厂商凭据
如 `~/.aws/credentials`、`~/.kube/config` 等）。它 **always-on，不按会话身份分支**：
`*/.ssh/id_*`、`~/.aws/credentials` 对登录用户同样可读、同样敏感。相对路径按命令实际
执行的 cwd 解析，因此这个 cwd 必须与机械 cd 前缀 / `-D` 一致。

**免问通道不止白名单一条**，root 会话里另两条低摩擦通道一起收：

- **root 会话风险档位位移**：与生产机位移同机制——只升不降、与环境位移叠加取 max、
  主进程硬校验。exec 提案 low→mid，因此 low 档空 Ctrl+Enter 的资格随之消失。
  是否 root 是登录时定死的会话级属性，位移在会话建立时即确定。
- **跨会话信任冻结**：`a` 信任集在实验机 trust.json 跨会话持久。普通会话里授予的 verb
  信任不能在 root 会话里变成 root 免问，因此 root 会话**不读不写 trust.json**
  （清空也是写，只清会话级）；会话级 `a` 照常，授予发生在该 root 会话内、按位移后的档位。

## 身份切换握手

### 主机配置

- `elevate: 'none' | 'sudo'`（`HostElevate`）。
- `sudoPassword`：机密项。公钥登录 + sudo 要密码是最常见组合，不能指望 NOPASSWD。
  经 `hosts.ts` 的 safeStorage 加密，渲染进程只见 `hasSudoPassword`，明文永不跨 IPC。
- `sftpServerPath`：sftp-server 路径覆盖，留空则探测。

### 流程：pty 握手 → exec 探活 → 全过才装载 SI（all-or-nothing）

shell 打开后：pty `sudo -i` 握手 → exec 探活套件（含 root 版 SFTP 建立）→
**任一步失败，pty 已到 root 的给 pty 写 `exit` 退回登录 shell，整会话退回普通身份 +
徽章带原因**；全过才装载 SI、探主机档案（`runElevation`）。

降级只有这一种形态。三平面各自可独立失败（密码错 / `requiretty` 挡 exec /
sftp-server 探不到），若各自局部回退，就会造出"pty 是 root、exec 仍是登录用户"这类
身份分裂——正是本设计要消灭的错位，组合态也无法各自表述。

pty 侧要点（`ptyHandshake`）：

- 发 `sudo -p '<哨兵>' -i`：自设提示哨兵 `TSUBASATERMINAL_PW:` 覆盖多语言与自定义
  `Defaults passprompt`；输入里的哨兵用 `''` 拆开写，回显不会被误认为提示。
- 见哨兵即写密码；**哨兵第二次出现 = 存储的密码被拒**（确定性错误，不重试）。
  无密码配置时见哨兵即降级 `no-password`。
- 身份靠探针 `echo __TSUBASATERMINAL_ELEV__$(id -un)` 验证真到了 root；探到非 root
  （不在 sudoers 等）降级 `not-root`。静默一小段时间没见哨兵（NOPASSWD）就直接发探针。
- 匹配不到时有总超时兜底（`timeout`），不永久挂起；失败收口时补发 `^C`，
  别让挂着的密码提示把后续输入吃掉。
- **握手窗口内的输入输出不进记录管线**：不进转录、审计、命令历史。不指望 redaction
  兜底——它是启发式，而这里明确知道哪一段是密码。握手不产生转录单元，因此也不会
  误触发基于转录命令文本的 SI 自动重载。

exec 探活套件全在 exec channel 上，每条几十毫秒；判别一律靠**行为（退出码）**，
不靠 stderr 文本——sudo 走 gettext，报错随 locale 变。

| # | 探什么 | 怎么探 | 结果 |
| --- | --- | --- | --- |
| 1 | 认证模式 | `sudo -n true`；不通再 `sudo -S -p '' true`（写密码） | 通① = `-n` 模式；通② = `-S` 模式；都不通（`requiretty` 等）= 降级 `no-exec-auth` |
| 2 | cwd 机制 | `sudo <auth> -D /root true` | 通 = chdir 模式；不通 = 模板模式（不降级，见下） |
| 3 | SFTP 链路 | 探 sftp-server 路径，完整起一次 `sudo <auth> -- <sftp-server>`（接管 + 延迟 INIT） | 成功的 channel 直接留作 root 版 SFTP 实例；失败 = 降级 `no-sftp-server` / `sftp-init` |

`sudo --version` 只作主机档案展示，不参与判定。

### 认证模式：每个 channel 自带认证，不依赖 sudo timestamp

不能"pty 输一次密码、exec 通道凭票据 `sudo -n` 免输"：sudo 票据默认
`timestamp_type=tty`，绑认证终端，**无 tty 时退化为绑 sudo 的父进程 PID**。sshd 对每个
exec / SFTP channel 都新 fork 进程跑 `$SHELL -c`，channel 之间父进程互不相同，
pty 握手的票、某个 channel 里 `sudo -v` 刷的票，别的 channel 的 `sudo -n` 全都查不到。
除非 NOPASSWD 或管理员配了 `timestamp_type=global`，这条路在主流默认配置下必失败。

密码本就在主进程手里（safeStorage），因此**每个 exec channel 自带认证**：

- **`-n` 模式**（探 1 直通：NOPASSWD / global 票据）：全会话走 `sudo -n`，密码零发送。
- **`-S` 模式**：每个 exec channel 跑 `sudo -S -p '' --`，打开即写 `密码\n`。
- **两种模式不混**：`-n` 模式绝不写密码——NOPASSWD 下 sudo 不读 stdin，
  写进去的密码字节会被命令自己继承读走（`sudoAuthArgs`）。
- 无过期状态机：探测一次定死全会话；会话中途 sudoers 变更不感知，重连生效。

### exec 通道平面

主进程模板拼装（`buildElevatedExec`），闸门判定跟随 Agent 原文，模板不经 LLM——
与 `wrapBackground` 的关系相同。`-S` 模式写密码后**立刻 EOF**：exec 命令不消费
stdin，万一密码错 sudo 二次读到 EOF 直接失败，而不是挂到超时。主进程自己的多命令
脚本（主机档案探测等）走 `buildElevatedScript` 整串 `sh -c`，否则 `a; b; c` 只有
`a` 在 sudo 下跑。

**cwd 二态**（探 2 定死）。不能沿用 `cd -- <cwd> && sudo -n -- <cmd>`：cd 跑在登录用户
身份，`cd /root` 被拒。

- **chdir 模式**：`sudo <auth> -D <cwd> -- <cmd>`（需 sudo ≥ 1.9.3 且策略放行）。
- **模板模式**：`sudo <auth> -- bash -c 'cd -- <cwd> && <cmd>'`，整串过 `shellQuote`。
  这是继 `wrapBackground` / `wrapSaveOutput` 之后**第三处登记在案的模板豁免**：
  模板固定 + command 已过硬解析 + 全串转义，不构成给 LLM 的执行跳板。
- **`-D` 被拒一律回退模板、不降级**：stock sudoers 默认就拒 `-D`（需
  `Defaults runcwd=*` 或 CWD 标签才放行，云镜像基本不配；Ubuntu 22.04 / sudo 1.9.9
  真机如此），"版本够但被拒"是常态而非管理员意图信号。且 `sudo -i` 一旦获准，
  用户在 root shell 里本就能任意 cd，exec 通道的 cwd 限制不构成真实边界。
- cwd 取 pty 的 OSC 7 上报：root 会话三平面同为 root，借 pty cwd 合法
  （身份错位会话不借，见存量兜底）。

普通会话的 `cd -- <cwd> &&` 前缀不变。主机档案探测跟随认证模式走 root 包装，
否则档案里的 `user`/`home` 与人屏又成了一对新的错位。

## 以 root 身份运行的 SFTP

SFTP subsystem 由 sshd fork，没有切到 root 的入口。方案是**在 exec channel 上跑
`sudo sftp-server`**（`elevatedSftp.ts`）。

`getSftp`（`ssh.ts`）是全应用唯一的 SFTP 入口，root 会话返回 root 实例即可对齐全部消费者，
不必在文件栏和桥各做一遍 `/tmp` 中转：

| 消费者 | 位置 | root 会话 |
| --- | --- | --- |
| 文件栏 home / list / download / upload | `sftp.ts` | 跟随 root |
| ZMODEM 桥下载 / 上传（`rz`/`sz`） | `transfer.ts` | 跟随 root |
| Agent `write_file`（stat + 写） | `llm/tools.ts` | 跟随 root——因此有上节 `write_file` 上抬 |
| shell integration 脚本落盘 | `ssh.ts` `warmupSession` | **显式用普通槽位**（写 `/tmp` 登录用户即可，不等握手、不挡连接关键路径） |

### ssh2 切入点

`client.sftp()` 的实现是 `openChannel(this, 'sftp', cb)` 构造 SFTP 实例，随后
`reqSubsystem` 发 channel request。实例类型在 `openChannel` 时就定死，不能先开 exec
channel 再把协议包上去。ssh2 的 `SFTP` 是 `EventEmitter` 子类，只是鸭子类型地像
`Channel`，不是真子类。

`Protocol.exec(chan, cmd, wantReply)` 与 `Protocol.subsystem(chan, name, wantReply)`
签名一致，协议层同为 channel request，服务端回同样的 success/failure。所以切入点是
**临时接管一次 `_protocol.subsystem`**，SFTP 实例本身仍由 ssh2 官方构造。

接管面共三处内部 API，防御性存在性检查全覆盖，任一不匹配即整会话降级、不崩：

| 接管点 | 为什么 |
| --- | --- |
| `_protocol.subsystem` | 改发 `exec`，跑 `sudo <auth> -- <sftp-server>`；只接管这一次，**失败路径也必须复原** |
| SFTP 实例的 `_init` | 拦下自动发 INIT（时序见下节）；它被调用的那一刻就是"服务端已接受 exec 请求"的精确锚点 |
| SFTP 实例的 `stderr` | ssh2 设成 `fakeStderr`（`push` 是空函数），而 extended data 统一走 `channel.stderr.push`——不换成真收集器，sudo 的哨兵一个字节都收不到，表现是干等超时；收口后还原 |

定位实例的约束：

- **不能 `_chanMgr.get(chanId)`**：`subsystem()` 收到的是 `outgoing.id`（远端 id），
  而 `_chanMgr` 按 local id 索引。两者经常凑巧相等（都从 0 分配），换个并发时序才炸。
  须遍历 `_chanMgr._channels` 按 `outgoing.id` 匹配。
- **不能按 `type === 'sftp'` 过滤**：实例的 `type` 是 `'session'`。
- **定位失败必须降级**：静默 fallback 成登录用户的普通 SFTP 不报错、只是权限不对，
  恰好复刻"让用户和 Agent 各自去猜"。
- **同一连接上的建立必须串行**（per-connection promise 锁），否则并发的 `conn.sftp()`
  会被误接管。

### 单 channel 认证：延迟 INIT + stderr 哨兵

若 `sudo -S` 与 SFTP 协议无时序控制地共用 stdin，sudo 读到的第一段就是 INIT 二进制包，
会被当成密码。解法是在**时间轴**上拆开，而不是拆到两个 channel（那条路押在 timestamp
跨 channel 上，不成立）：

1. 发起 SFTP channel（接管 subsystem→exec：
   `sudo -S -p 'TSUBASATERMINAL_SFTP_PW:' -- <sftp-server>`），同时拦下自动 `_init`；
2. 等 stderr 出现哨兵——sudo 的 `-S` 提示写 stderr，即 channel 的 extended data，
   与 stdout 上的协议流互不污染；
3. 写 `密码\n`（**不能 EOF**——stdin 之后归协议）；
4. 立即手动补发 INIT，收到 VERSION 即成功；
5. **stderr 再现哨兵 = 失败（主判据），主动收口**（关 channel + 降级）；channel 退出只作兜底。

`-n` 模式跳过 2、3，同走延迟 INIT 路径——两种模式共用一套代码与测试剧本。

时序依据（Ubuntu 22.04 / sudo 1.9.9 / ssh2 1.17.0 真机）：

- sudo 的 `-S` 严格按行读、不预读，读到 `\n` 即停，剩余字节原样留给 exec 后的
  sftp-server。即使 `密码\n` 与 INIT 合在同一个 buffer 一次到达也不丢字节，
  因此**不需要任何"等 sudo exec 完"的延迟**。唯一会把 INIT 当密码吃掉的分支是
  "认证失败再提示"，该分支按失败处理、不重试（pty 握手也会先暴露密码错）。
- 密码错时 stderr 再现哨兵约 2 秒到达，而 channel 退出（sudo 三次尝试耗尽）要 10 秒以上。
  all-or-nothing 握手期间用户在等，所以必须以哨兵为主判据，否则一次密码错要卡十几秒才降级。
- 本 channel 自带认证，sftp-server 起来后进程一直活着，没有 timestamp 过期问题。

### sftp-server 路径

优先用主机配置 `sftpServerPath`；否则按候选列表探，回落读 `/etc/ssh/sshd_config` 的
`Subsystem sftp` 行（通常 0644 可读）：

| 发行版 | 路径 |
| --- | --- |
| Debian / Ubuntu | `/usr/lib/openssh/sftp-server` |
| RHEL 系 | `/usr/libexec/openssh/sftp-server` |
| Alpine / SUSE | `/usr/lib/ssh/sftp-server` |

### 槽位与时序

- 普通槽位 `sftpPromise`：`warmupSession` 写 SI 脚本用，不等身份切换握手。
- root 槽位 `elevatedSftp` **不懒建**：探 3 成功的那条 channel 直接留作实例，root 会话下
  `getSftp` 返回它。懒建与 all-or-nothing 矛盾——会话中途才发现 sftp-server 起不来时，
  pty/exec 早已是 root，来不及整会话退回。
- 运行中 channel 断开时清空槽位，下次 `getSftp` 走同一路径重建；重建失败是唯一可能出现
  **中途降级**的地方，徽章如实反映。

## UI：徽章的信息量在降级态

不加警示色——勾了"登录后以 root 运行"就是自己选的，成功时徽章只是安静的 `root`。
它存在的理由是**降级**：整会话退回登录用户，徽章带原因（`ElevationFailReason`：
`no-password` / `password` / `not-root` / `no-exec-auth` / `no-sftp-server` /
`sftp-init` / `timeout` / `error`），消灭"用户以为自己是 root"的猜谜。

system prompt 主机档案节同样告知 Agent 生效与降级——降级时 Agent 若按 root 假设行动，
每条命令都会在权限上撞墙。

传输与文件栏错误按 SFTP 状态码分流（`sftpError.ts`）：`NO_SUCH_FILE` 才说"嵌套 ssh/
容器够不着"（桥另补 trzsz 出路），`PERMISSION_DENIED` 说身份不足——把权限问题误诊成
通道问题比不提示更有害。状态码缺失时退回 ssh2 固定英文报错文本匹配。

## 审计

- root 会话的条目带 `elevated` 与有效身份。
- 审批台在 pty 里执行的命令记 **pty 上报身份**（`sudo su` 后即 root）；探不到标
  `unknown`——**不要猜，更不要沿用登录身份**。
- `-S` 模式的密码只出现在 exec channel 的 stdin（加密信道内、主进程拼装、不落任何日志）；
  审计与转录记录的是模板前缀 + Agent 原文。

## 存量兜底：手动 `sudo su` 仍然会发生

没勾"以 root 运行"的会话里，用户照样会手动 `sudo su`。这层永远需要，且不要求改配置：

- **pty 身份上报**：SI 脚本随 OSC 7 一并上报 `id -un`，转录单元带 `ptyUser`；exec 通道
  身份由主机档案探测。两者不同即错位，主机档案节出一行"终端当前身份"说明
  "人屏已切换、你的 exec 与文件读写仍是登录用户、需要该身份的操作走审批台"。
- **失败翻译**：识别 `cd: ...: Permission denied` + 非零退出，翻译成结构化 meta 回给 Agent，
  说明 exec 通道是登录用户、终端已切 root，需要 root 的操作请提案走审批台。
- **身份错位时不借 pty cwd**：跨平面借状态是根错。退回 exec 通道的 `$HOME` 并在 meta 里说明。
- **cwd 变更通知**：基线是 system prompt 主机档案节的"当前目录（对话开始时）"一行；
  `agent:send` 时比对 `latestCwd` 与**上一次告知 Agent 的值**（首轮即基线），变了就在该轮
  user 内容前加一行"【工作目录变更】终端当前目录已变为 …"（`loop.ts` 的 `lastToldCwd`；追加在对话尾部，不炸缓存）。接续对话沿用存档
  快照作基线，偏离即在首轮补一行。cwd 唯一来源是 OSC 7，SI 缺失时 `latestCwd` 恒为
  null——基线行不出、通知整体静默，不拿 exec 通道的 `$HOME` 冒充人屏目录。
  它是感知补充，**不替代机械 cd 前缀**：前缀消灭"静默跑错目录"，且路径敏感度闸门
  解析相对路径所依据的 cwd 必须与实际执行 cwd 恒等，只有机械前缀能保证。
- **自动重载 SI**（`lib/siReinject.ts`）：根据转录单元的命令文本检测到 `sudo su` /
  `su -` / `sudo -i` 后，在下一个 prompt 替用户 source 一次 `/tmp/.tsubasaterminal-si-*.sh`，
  一步修好转录断流、OSC 7 停更、身份上报。SI 脚本 source 后不删、权限 0644，正是为
  `su - deploy` 这类切到另一普通用户的重载留的。

## 边界

- **`internal-sftp`**：sshd 配 `Subsystem sftp internal-sftp` 时没有独立二进制。多数
  发行版的 openssh-server 包仍装了 `sftp-server`（Ubuntu 22.04 的 `sshd -T` 给出
  `/usr/lib/openssh/sftp-server`），但不保证——探不到就整会话降级。
- **`requiretty`**：RHEL 老基线默认开，exec channel 无 tty，sudo 直接拒——探 1 挡住，整会话降级。
- **孤儿进程**：channel 异常断开后 sudo 正常转发信号、`sudo sftp-server` 由 sshd 回收
  （`-n` / `-S` 两种模式真机观测无残留）。运行中重建路径若出现残留，应回到这条重验。
- **ssh2 内部 API 依赖**：`_protocol.subsystem`、SFTP 的 `_init` 与 `stderr`，改名或改签名
  就会碎。防御性检查 + 整会话降级，不崩；升级 ssh2 时须重跑真机 smoke。
- 身份分裂在结构上被 all-or-nothing 消灭；唯一残留是运行中 SFTP channel 断开且重建失败的
  中途降级，徽章如实标注。
- `su - <另一个普通用户>` 不在本设计范围（只切到 root）；存量兜底的失败翻译对它同样生效。

## 测试要点

- **fake server**：收到 exec 且命令匹配 sftp-server 路径时挂同一套 SFTP 实现；模拟 sudo
  剧本——`-S` 的 stderr 哨兵与密码校验、`-n` 通/不通、`-D` 通/拒、`requiretty`；pty 侧用
  fake shell 模拟密码提示。剧本按真机观察到的时序写。断言重点：每条探活失败路径都落到
  "pty 已退回登录 shell + 整会话退回普通身份 + 徽章带原因"，无静默、无身份分裂。
- **真机 smoke**（协议变化时必跑，至少覆盖 `-n` 与 `-S` 两种认证形态：如 NOPASSWD 账号与
  `%sudo` + 密码的 stock 云镜像账号）：`sudo -i` 握手；exec 上 `-S` 喂密码 + EOF；`-D`
  探测分流；SFTP 延迟 INIT 拿 VERSION、哨兵时序与密码错失败路径；文件栏读 `/root`；
  桥的 `rz`/`sz` 在 root 会话双向通；channel 异常断开后查孤儿进程。
- ssh2 内部接管与 sudo stdin 读法这类协议不确定性，先写独立 spike 直连真机验证，再动产品代码。
