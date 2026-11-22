import { app } from 'electron'
import { NON_INTERACTIVE_COMMAND_GUIDANCE } from '../llm/commandGuidance'
import { whitelistCommands } from '../llm/gate'
import { CLI_EXIT } from '../../shared/cli'

/**
 * 闸门规则摘要与退出码表（cli-bridge-design 五.②）。
 *
 * **`rules` 子命令与 SKILL.md 正文同源生成**——两处各写一份必然漂移，而外部 agent
 * 反复撞墙的成本远高于内置 Agent（它没有 system prompt 兜底，每次撞墙都是一次
 * 真实的往返 + 一次用户审批次数）。白名单本身取 `gate.ts` 的 `whitelistCommands()`，
 * 与闸门实现同一份数据，不抄。
 *
 * 注：`systemPrompt.ts` 的闸门一节是**内置 Agent 的变体**（面向 write_file / wait /
 * save_to_file 这套工具面写的），与此处不是同一批读者，故不强行合一；共享的是
 * 白名单数据源与 commandGuidance.ts 中不依赖工具名的命令纪律。
 */

export function skillVersion(): string {
  return app.getVersion()
}

/** 白名单一行（skill 与 rules 共用） */
function whitelistLine(): string {
  return whitelistCommands().join(' ')
}

export function gateRulesText(): string {
  return `# tsubasa-ssh 闸门规则摘要（v${skillVersion()}）

闸门是主进程里的 argv 硬解析，fail-closed，**不问 LLM**：它不看你说什么，只看命令长什么样。
被拒不是"再解释一遍就能过"，换个写法之前不要重试。

## 三条执行路径
- **只读白名单** → 旁路 channel 自动执行（不占用户终端，内置 Agent 在跑也不受影响）。
- **白名单之外** → 弹审批卡给用户（桌面通知 + 闪任务栏），批准后在用户终端执行、
  退出码与输出回流。默认挂 90 秒（--timeout 可调）：超时**主动撤回**退 125——
  那不是拒绝，是用户没来得及看；稍后重发或换 --async。用户拒绝退 102，stderr 带留言。
  预计"批准后执行很久"的命令用 \`exec --async\`：立刻返回 proposalId，
  \`job <id>\` 轮询（108=还没完，继续轮）。
- **解析即拒绝**（见下）→ 101，换写法之前别重试。

会话忙（内置 Agent 在本会话跑 / 用户终端非空闲 / 已有提案挂着 / 多机批次待决）时
审批路径退 105，稍后重试；只读白名单不受影响。启动常驻服务用 \`exec --bg\`（系统代为
nohup 后台化，一律经用户审批）；**每条 exec 都带 \`--intent "<一句话>"\`**——用户在
审批卡上靠它判断你要干什么，自动执行时它也会作为旁白上屏。

## 多机并行（--hosts）
同一条命令要在多台机器上跑时用 \`exec --hosts web1,web2 "<cmd>"\`（2..7 台，逗号分隔，
无 all）。规则：
- **\`hosts\` 看有哪些机器 → 逐台 \`use\` 拿建联包 → 才 --hosts**：多机不自动开会话，
  且没读过建联包就没有这台的 OS/身份先验（别在 CentOS 上发 apt）。
- 白名单命令逐台旁路并行直执行；**非白名单一张卡罩整批**——用户一次决策 N 台，
  不支持部分批准（想拆会拒绝并留言，按留言分组重发）。
- 目标解析 fail-closed：任一别名未命中/歧义，整批 103/104，一台都不会跑。
- stdout 是**一个 JSON 对象**（results 逐台带 handle/code/exitCode/stdout），
  退出码逐台全同则透传，不一致退 **109**——逐台读 results 分别处理。
- 挂起窗口同 --timeout（缺省 90s），超时整批撤回退 125；预计执行很久照样用 --async。
- 单机 exec 也可加 \`--json\` 拿同构的结构化输出。

## 自动执行的只读白名单
${whitelistLine()}

带约束的几个：
- systemctl 仅 status/show/cat/list-*/is-*
- docker 仅 ps/logs/inspect/images/version/info/top/port/diff/stats（stats 须 --no-stream）
- kubectl 仅 get/describe/logs/top/explain/version/cluster-info/api-*
  （禁 -f/-w 与 --raw/--context/--kubeconfig；secret 与 cluster-info dump 不放行）
- tail / journalctl / docker logs 禁 follow；find 禁 -exec/-delete 族

## 结构规则
- 管道允许，但**每一段**都在白名单内才自动执行。
- 通配符（* ? [ ]）在每段都是只读白名单命令时放行；flag 位里的通配不放行
  （\`--include='*.log'\` 要用单引号包起来）。
- \`~\` 由系统按主机 \$HOME 展开，可以直接写；\`~user/\` 不支持。
- **解析即拒绝**（写了就是浪费一次往返）：重定向（仅 \`2>/dev/null\` \`1>/dev/null\`
  \`>/dev/null\` \`2>&1\` 四个紧凑整词例外）、\`&&\`、后台 \`&\`、\`;\`、\`\$()\`、反引号、
  换行、双引号里的 $ 与反引号与反斜杠——字面量参数一律用**单引号**包裹（单引号内不做任何展开）。
  要两条命令就发两次 exec。
- 网络出口命令（curl/wget/ping/dig 等）永不进白名单。
- 远端 \`sleep\` / \`watch\` 直接拒绝——要等就在你自己那边等（本 CLI 不提供等待动词）。
- **敏感路径不自动执行**：/etc/shadow、/etc/sudoers、SSH 私钥（.ssh/id_*）、
  /proc/*/environ、云凭据（.aws/credentials、.kube/config、.docker/config.json）、
  root 命令历史——即使命令在白名单内也需要人审。

${NON_INTERACTIVE_COMMAND_GUIDANCE}

## 大输出
一次可能吐上万行（拉日志、导全量清单）时加 \`--save\`：输出**全量、不截断**落到远端
临时文件，只回规模数字与前 30 行预览；之后用 grep -n / grep -c / sed -n / tail 点查
那个文件（都是白名单，自动执行）。省的是"进上下文"，不是"跑出来"。

## 文件上传（push）
\`tsubasa-ssh push <本地文件> <远端绝对路径> [--mode 755]\`（别名 rz；pull/sz 不存在）
- **一律人批**：不进白名单、不进信任集，审批卡展示两端路径 / 大小 / 覆盖状态 / mode。
- 远端必须是**已存在目录下的完整文件绝对路径**：不猜目录、不递归、不通配、无多机
  ——要传目录树就本地打 tar 再 push。
- \`--mode\` 按**八进制**解析；覆盖且未显式 --mode 时保持原文件权限位。
- 落盘走"同目录临时文件 + 原子 rename"：不会留半个文件在目标位置。
- 大文件（>100MB）会警示；预计传很久配 \`--async\` + \`job\` 轮询。
- **110 = 同目标已有一笔传输在途**：等那一笔落地（--async 的用 job 轮询它）再重试。

## 退出码
| 码 | 含义 | 补救 |
| --- | --- | --- |
| 0..99 | 远端命令的真实退出码 | 照常判断 |
| ${CLI_EXIT.HANDSHAKE} | 握手失败（协议/token 对不上） | 可能连到了别的实例，让用户确认 Tsubasa Terminal |
| ${CLI_EXIT.GATE} | 闸门结构性拒绝 | **别重试同样写法**，读 stderr 的修复建议 |
| ${CLI_EXIT.DENIED} | 用户否决 | 按 stderr 里的留言改方案 |
| ${CLI_EXIT.NO_SESSION} | 无会话 / 未绑定 / 已断连 / 主机列表里没有这个别名 | 跑 \`hosts\` 看有哪些机器，再 \`use <别名>\`（无会话时会自动开标签页连接） |
| ${CLI_EXIT.AMBIGUOUS} | 别名歧义（同主机多个会话，或主机列表里同名多台） | 用 \`use <句柄>\` 指定；配置里同名要让用户改名 |
| ${CLI_EXIT.BUSY} | 会话忙（内置 Agent 在跑 / 终端非空闲 / 已有提案或多机批次挂着） | 稍后重试这条命令 |
| ${CLI_EXIT.NOT_RUNNING} | Tsubasa Terminal 未运行 | **让用户启动它**，不要自己去拉起 exe |
| ${CLI_EXIT.FAILED} | 命令未取得退出码（超时/通道错误） | 命令**没跑完**，不要当成"失败了" |
| ${CLI_EXIT.PENDING} | 异步 job 未到终态（提案待决 / 执行中） | 继续 \`job <id>\` 轮询 |
| ${CLI_EXIT.MIXED} | 多机批量逐台结果不一致 | 读 stdout JSON 的 results，逐台分别处理 |
| ${CLI_EXIT.TRANSFER_BUSY} | push 同目标已有一笔传输在途 | 等那一笔落地（--async 的用 job 轮询）再重试 |
| ${CLI_EXIT.USAGE} | 用法错误（含失效的 unit id 引用、需整体加引号的命令） | 按 stderr 指引修正；用法看 \`--help\` |
| ${CLI_EXIT.TIMEOUT} | 审批超时，提案已**主动撤回**（命令未执行） | 不是拒绝；稍后重发，或改 \`--async\` |
`
}
