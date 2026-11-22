import { collectPromptInputs, hostProfileLines } from '../llm/systemPrompt'
import { sessionIntegrationLoaded, type SessionMeta } from '../ssh'
import { sessionTags, type Binding } from './bindings'

/**
 * 建联包（cli-bridge-design 第四节）——挂在 `use` 上：绑定与知识交接同一时刻。
 *
 * 先验按**改动频率**切两半：随 app 版本变的（角色纪律、闸门规则、退出码表）进 skill，
 * 随主机与人变的（主机档案、全局/本机知识、经验索引）进这里。skill 因此是主机无关的
 * 静态文件，永不因某台主机的档案变了而要重装。
 *
 * 实现上这就是 `collectPromptInputs` 的**第二个渲染器**——数据源一行不改，
 * 内置 Agent 与外部 agent 拿到的是同一批事实，"两套先验各自演化"的风险被压到最小。
 * envLevel 与 root 标记必须在包里：否则外部 agent 理解不了它的 mid 档提案为什么被抬成 high。
 */

/** 知识块截断：建联包是一次性输出，不该把 4000 字的知识整段砸进对方上下文。
 *  v0.13.6 `hosts <别名>` 的本机知识同档——同是"一台机的知识预览"，别分两档 */
export const KNOWLEDGE_PREVIEW = 1200

export function clip(text: string, limit: number): string {
  const body = text.trim()
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}\n…（已截断，完整内容见 Tsubasa Terminal 设置 / 主机表单）`
}

export function briefingHeader(binding: Binding, meta: SessionMeta): string {
  const tags = sessionTags(meta).map((t) => `⚠ ${t}`)
  return [
    `session ${binding.handle}`,
    `${meta.name} (${meta.username}@${meta.host}:${meta.port})`,
    ...tags
  ].join(' · ')
}

export async function renderBriefing(binding: Binding, meta: SessionMeta): Promise<string> {
  const inputs = await collectPromptInputs(
    binding.sessionId,
    `${meta.username}@${meta.host}（${meta.name}）`,
    // nonce 是内置 Agent 的定界符声明，建联包不包定界符（CLI 输出要能管道）——
    // 这里只是为了复用同一个采集函数，值不进任何输出
    'cli',
    sessionIntegrationLoaded(binding.sessionId)
  )
  const parts: string[] = [briefingHeader(binding, meta)]
  parts.push(`[主机档案]\n${hostProfileLines(inputs)}`)
  if (inputs.hostKnowledge.trim()) {
    parts.push(`[本机知识]（人写，仅适用于本机）\n${clip(inputs.hostKnowledge, KNOWLEDGE_PREVIEW)}`)
  }
  if (inputs.globalKnowledge.trim()) {
    parts.push(`[全局知识]（人写，适用于所有主机）\n${clip(inputs.globalKnowledge, KNOWLEDGE_PREVIEW)}`)
  }

  // 排障经验：读给、写不给（4.3）。条目落盘时全过了人审，信任级别与内置 Agent 读到的
  // 一模一样；它恰是"本机特有历史、侦察不出来"的知识，没有就会在同一个坑上重复
  // 烧用户的审批次数。同款筛选（单机 20 / 全局 10、pinned 优先），正文按需 `exp <id>`。
  const exp = inputs.experience
  const expLines: string[] = []
  for (const e of exp.host) expLines.push(`  ${e.id}  ${e.summary}`)
  for (const e of exp.global) expLines.push(`  ${e.id}  [全局] ${e.summary}`)
  if (expLines.length > 0) {
    const omitted = exp.omittedHost + exp.omittedGlobal
    parts.push(
      `[排障经验索引]（过往对话提炼、经用户逐条确认；正文：tsubasa-ssh exp <id>）\n` +
        `遇到与条目症状相关的问题，**先读正文再动手侦察**——这些是本机与本组织特有的历史，\n` +
        `你自己侦察不出来。经验是过去某时刻的结论，与现实对不上时向用户指出（写明 id）。\n` +
        expLines.join('\n') +
        (omitted > 0 ? `\n  （另有 ${omitted} 条未列入本次注入）` : '')
    )
  }

  parts.push(
    `提示：本会话的转录 unit id 均为 ${binding.handle}:<n> 形态；` +
      `log 列清单、log ${binding.handle}:<n> 读正文。换会话请重新 use（句柄会变）。` +
      `本地文件上传用 push <本地文件> <远端绝对路径>（一律经用户审批，详见 rules）。`
  )
  return parts.join('\n\n')
}
