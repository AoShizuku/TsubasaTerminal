# 智能命令补全设计：三层延迟预算

核心原则：**LLM 永远不进击键路径**——运维击键 100-200ms 一次，任何网络请求都追不上；
LLM 只在"人本来就在停顿"的时刻进场。

补全宿主是固定输入栏模式下的本地 composer（本地组稿、整行发送），ghost text 与候选列表
都活在 composer 内，不做 xterm buffer 内联；原生终端模式下补全整体交给远端 shell。
详见 [composer-design.md](composer-design.md)。

## 问题定义

补全差的那口气不是"更聪明的模型"，而是"**不懂这台服务器**"：历史、cwd、文件名、容器名、
unit 名全是确定性数据。把它们预取到本地，击键路径上根本轮不到 LLM。

## L1 本地确定性（<10ms）

- **历史 ghost text**（fish / zsh-autosuggestions 手感）：草稿非空时按历史前缀匹配，灰字提示，
  → 接受。**历史按主机隔离**，与主机记忆共用同一份持久化数据。
- **语法规则补全**：flag / 子命令来自 withfig/autocomplete 开源 spec 语料的精简提取
  （`assets/fig-specs.json`，由 `scripts/extract-specs.mjs` 生成；`lib/specCompletion.ts`），
  不需要 AI。

## L2 远端上下文，预取成本地（击键时仍 0 延迟）

远端上下文的正确消费方式是**预取**，不是击键时现查（`lib/remoteContext.ts`）：

- **路径补全吃 SFTP 目录缓存**：cd 跟随实时维护 cwd 目录列表，`cat ngi` → `nginx.conf`
  是纯内存查找；
- **命令表**：连接后经独立 exec channel 静默预取一次 `compgen -c`（会话级缓存）；
- **systemctl unit / docker 容器名**：首次 Tab 需要时采集，短 TTL 缓存（名字会变）。

Tab 是显式动作，用户本就预期一个 RTT；因此缓存未命中时允许 Tab 现查 `compgen` 兜底
（`lib/completion.ts`），这不违反击键路径原则。已知限制：非交互 shell 补不到 alias / 函数。

## L3 LLM：只在停顿时刻进场

| 时机 | 触发信号 | 延迟为何无感 |
| --- | --- | --- |
| 预测下一条命令 | OSC 133;D（命令结束、单元上报） | 用户正在读输出，1-2s 内返回即可作为 ghost 候选 |
| 出错修复建议 | 非零退出码 | 用户正在读报错 |

- 由设置 `completionLlmEnabled` 开关；建议只在草稿为空时作为 ghost 呈现，用户开始下一条
  命令即弃，竞态令牌丢弃过期应答（`useSuggestStore`）。
- 原生终端模式与 TUI 阶段不发请求——没有展示/接受宿主还消耗用户 key 是静默浪费；
  闸在 `useSuggestStore` 的单元上报入口。

**反模式**：每次击键防抖后请求 LLM——延迟感、候选闪烁、打断心流、成本失控。
