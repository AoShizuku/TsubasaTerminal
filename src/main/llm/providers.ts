import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { UsableProfile } from './profiles'
import type { ThinkingLevel } from '../../shared/types'

/**
 * BYOK provider 封装（agent-design 第三节）：
 * 对话状态 = provider 原生消息数组——不做统一中间 schema。
 * "无损"的天敌是归一化层：Anthropic thinking 块连同 signature 必须原样回传
 * （interleaved thinking 的签名校验），chat.completions 的 reasoning_content
 * 渲染但按 provider 规则不回传（DeepSeek 语义），responses 分支 reasoning items
 * 按官方协议整体回传。跨 provider 切换 = 新对话（签名不可迁移）。
 */

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema（object） */
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResultInput {
  id: string
  content: string
  isError?: boolean
}

/** 上轮请求的 token 用量（token 圆环数据源）：input 含缓存命中/写入部分 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  /** 前缀缓存命中量；provider 不报则 null */
  cacheReadTokens: number | null
}

export interface TurnResult {
  toolCalls: ToolCall[]
  /** provider 未返回 usage（老中转等）则 null，UI 显示未知 */
  usage: TurnUsage | null
}

export type StreamEmit = (ev: { kind: 'thinking' | 'text'; text: string }) => void

/**
 * 对话原生消息快照（v0.10.1 落盘 messages.json）：provider 原生形态原样存——
 * thinking signature、tool_use/tool_result 配对、responses 的加密 reasoning items
 * 都在里面，v0.10.2 接续只能靠它。wireFormat 与 model 一并记下，
 * 回灌时才知道该起哪个分支、该不该接受（跨 provider 不可迁移）。
 */
export interface ProviderMessagesSnapshot {
  provider: 'anthropic' | 'openai-compatible'
  wireFormat?: 'chat.completions' | 'responses'
  model: string
  system: string
  messages: unknown[]
}

export interface ProviderSession {
  pushUser(text: string): void
  pushToolResults(results: ToolResultInput[]): void
  /** 跑一轮 assistant 响应（流式回调增量），返回待执行的工具调用（空 = 回合结束） */
  runTurn(signal: AbortSignal, emit: StreamEmit): Promise<TurnResult>
  /** 当前对话状态的原生快照（每轮结束落盘） */
  snapshot(): ProviderMessagesSnapshot
}

const MAX_TOKENS_DEFAULT = 8192
/** xhigh/max 档要给思考留出空间，否则答案会被 max_tokens 截断在半途 */
const MAX_TOKENS_DEEP = 64000

/** 真正带深度的四档——两边 effort 参数的公共取值集 */
type EffortLevel = Exclude<ThinkingLevel, 'inherit' | 'none'>

/**
 * 思考档位 → Anthropic 参数。两个正交字段：
 * `thinking` 管开关与可见性，`output_config.effort` 才是深度旋钮
 * （注意 effort 嵌在 output_config 里，不是顶层）。
 *
 * `display: 'summarized'` 必须显式开——Opus 4.7 起默认 'omitted'，
 * thinking 块照发但文本是空串，Agent 面板的思考区会哑掉。
 */
function anthropicThinkingParams(level: ThinkingLevel): Record<string, unknown> {
  if (level === 'inherit') return {}
  if (level === 'none') return { thinking: { type: 'disabled' } }
  // 显式标注：SDK 0.111 的非 beta MessageCreateParams 认得 output_config.effort
  // 的这五个取值但没有 adaptive 的类型，故整体走 Record 展开——这行是补回来的
  // 守卫，往 ThinkingLevel 加档位时若忘了对齐 effort 取值集，这里先报错
  const effort: EffortLevel = level
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort }
  }
}

/**
 * 思考档位 → OpenAI reasoning 参数。`summary` 同样必须显式开，
 * 否则 `response.reasoning_summary_text.delta` 永不触发（官方："不 opt in
 * 就不会包含这个输出"）——responses 分支的思考流全靠它。
 */
function openaiReasoningParams(level: ThinkingLevel): Record<string, unknown> {
  if (level === 'inherit') return {}
  if (level === 'none') return { reasoning: { effort: 'none' } }
  return { reasoning: { effort: level, summary: 'auto' } }
}

/** chat.completions 的 effort 是顶层 `reasoning_effort`，且没有 summary 通道 */
function chatReasoningEffort(level: ThinkingLevel): Record<string, unknown> {
  if (level === 'inherit') return {}
  return { reasoning_effort: level === 'none' ? 'none' : level }
}

function maxTokensFor(level: ThinkingLevel): number {
  return level === 'xhigh' || level === 'max' ? MAX_TOKENS_DEEP : MAX_TOKENS_DEFAULT
}

// ---------- Anthropic messages ----------

class AnthropicSession implements ProviderSession {
  private client: Anthropic
  private messages: Anthropic.MessageParam[] = []

  constructor(
    private profile: UsableProfile,
    private system: string,
    private tools: ToolSpec[],
    initialMessages?: unknown[]
  ) {
    this.client = new Anthropic({
      apiKey: profile.apiKey,
      baseURL: profile.baseURL || undefined
    })
    // 接续回灌：落盘的原生消息原样灌回——thinking 块连 signature、
    // tool_use/tool_result 配对都不动，provider 侧的签名校验才过得去
    if (initialMessages) this.messages = initialMessages as Anthropic.MessageParam[]
  }

  pushUser(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }

  pushToolResults(results: ToolResultInput[]): void {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError
      }))
    })
  }

  snapshot(): ProviderMessagesSnapshot {
    return {
      provider: 'anthropic',
      model: this.profile.model,
      system: this.system,
      messages: this.messages
    }
  }

  async runTurn(signal: AbortSignal, emit: StreamEmit): Promise<TurnResult> {
    const level = this.profile.thinking ?? 'inherit'

    const stream = this.client.messages.stream(
      {
        model: this.profile.model,
        max_tokens: maxTokensFor(level),
        system: this.system,
        ...anthropicThinkingParams(level),
        tools: this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema
        })),
        messages: this.messages
      },
      { signal }
    )

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') emit({ kind: 'text', text: event.delta.text })
        else if (event.delta.type === 'thinking_delta') {
          emit({ kind: 'thinking', text: event.delta.thinking })
        }
      }
    })

    const final = await stream.finalMessage()
    // 原生 content（含 thinking 块与 signature）原样入历史——无损回传
    this.messages.push({ role: 'assistant', content: final.content })

    const toolCalls: ToolCall[] = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }))
    // anthropic 的 input_tokens 不含缓存部分——上下文体积 = 三者之和
    const u = final.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
    }
    const usage: TurnUsage | null = u
      ? {
          inputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? null
        }
      : null
    return { toolCalls, usage }
  }
}

// ---------- OpenAI chat.completions（中转/私有模型通用语） ----------

class ChatCompletionsSession implements ProviderSession {
  private client: OpenAI
  private messages: OpenAI.ChatCompletionMessageParam[] = []

  constructor(
    private profile: UsableProfile,
    private system: string,
    private tools: ToolSpec[],
    initialMessages?: unknown[],
    private cacheKey?: string
  ) {
    this.client = new OpenAI({
      apiKey: profile.apiKey,
      baseURL: profile.baseURL || undefined
    })
    if (initialMessages) {
      // 接续回灌：首条 system 行换成传入的 system——迁移时是重建后的新 system，
      // 同主机接续时与原值相同，替换无副作用
      this.messages = initialMessages as OpenAI.ChatCompletionMessageParam[]
      if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: system }
      else this.messages.unshift({ role: 'system', content: system })
    } else {
      this.messages.push({ role: 'system', content: system })
    }
  }

  pushUser(text: string): void {
    this.messages.push({ role: 'user', content: text })
  }

  pushToolResults(results: ToolResultInput[]): void {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
    }
  }

  snapshot(): ProviderMessagesSnapshot {
    // messages[0] 就是 system 行；顶层 system 字段冗余存一份，回灌方好认
    return {
      provider: 'openai-compatible',
      wireFormat: 'chat.completions',
      model: this.profile.model,
      system: this.system,
      messages: this.messages
    }
  }

  async runTurn(signal: AbortSignal, emit: StreamEmit): Promise<TurnResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.profile.model,
        messages: this.messages,
        tools: this.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema }
        })),
        stream: true,
        ...chatReasoningEffort(this.profile.thinking ?? 'inherit'),
        // 缓存分片路由：没有它，负载均衡会把同一对话的连续轮次
        // 打到不同 cache shard，命中率在"全中"和"0"之间摆动
        ...(this.cacheKey ? { prompt_cache_key: this.cacheKey } : {}),
        // OpenAI 规范字段（2024 起），vLLM/one-api/DeepSeek 均支持；
        // 不识别的老中转最多忽略/无 usage，token 圆环显示未知
        stream_options: { include_usage: true }
      },
      { signal }
    )

    let content = ''
    let usage: TurnUsage | null = null
    const calls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
      if (chunk.usage) {
        // include_usage 的用量 chunk（choices 为空）；prompt_tokens 已含缓存部分
        const details = chunk.usage.prompt_tokens_details as { cached_tokens?: number } | undefined
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: details?.cached_tokens ?? null
        }
      }
      const delta = chunk.choices[0]?.delta
      if (!delta) continue
      // reasoning_content 是 DeepSeek 系扩展字段（SDK 类型外）——渲染给人看，不回传
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content
      if (reasoning) emit({ kind: 'thinking', text: reasoning })
      if (delta.content) {
        content += delta.content
        emit({ kind: 'text', text: delta.content })
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        calls.set(tc.index, slot)
      }
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => {
        let input: unknown = {}
        try {
          input = c.args ? JSON.parse(c.args) : {}
        } catch {
          input = {}
        }
        return { id: c.id, name: c.name, input }
      })

    // 回传 assistant 消息（不含 reasoning_content——provider 规则）
    this.messages.push({
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: [...calls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, c]) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.args }
              }))
          }
        : {})
    })
    return { toolCalls, usage }
  }
}

// ---------- OpenAI responses（官方推理模型无损） ----------

type ResponseItem = Record<string, unknown>

class ResponsesSession implements ProviderSession {
  private client: OpenAI
  private input: ResponseItem[] = []

  constructor(
    private profile: UsableProfile,
    private system: string,
    private tools: ToolSpec[],
    initialMessages?: unknown[],
    private cacheKey?: string
  ) {
    this.client = new OpenAI({
      apiKey: profile.apiKey,
      baseURL: profile.baseURL || undefined
    })
    // 接续回灌：input items 原样灌回（含加密 reasoning items）；system 走顶层
    // instructions 字段，不在 input 里，无需替换
    if (initialMessages) this.input = initialMessages as ResponseItem[]
  }

  pushUser(text: string): void {
    this.input.push({ type: 'message', role: 'user', content: text })
  }

  pushToolResults(results: ToolResultInput[]): void {
    for (const r of results) {
      this.input.push({ type: 'function_call_output', call_id: r.id, output: r.content })
    }
  }

  snapshot(): ProviderMessagesSnapshot {
    return {
      provider: 'openai-compatible',
      wireFormat: 'responses',
      model: this.profile.model,
      system: this.system,
      messages: this.input
    }
  }

  async runTurn(signal: AbortSignal, emit: StreamEmit): Promise<TurnResult> {
    // store:false + encrypted reasoning 回传 = 无状态且推理链无损
    const stream = (await this.client.responses.create(
      {
        model: this.profile.model,
        instructions: this.system,
        input: this.input as never,
        tools: this.tools.map((t) => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          strict: false
        })) as never,
        store: false,
        include: ['reasoning.encrypted_content'] as never,
        ...openaiReasoningParams(this.profile.thinking ?? 'inherit'),
        // 见 chat.completions 分支同名字段：缺它则同对话内命中率摆动
        ...(this.cacheKey ? { prompt_cache_key: this.cacheKey } : {}),
        stream: true
      },
      { signal }
    )) as AsyncIterable<Record<string, unknown>>

    const toolCalls: ToolCall[] = []
    let usage: TurnUsage | null = null
    for await (const event of stream) {
      const type = event.type as string
      if (type === 'response.output_text.delta') {
        emit({ kind: 'text', text: String(event.delta ?? '') })
      } else if (type === 'response.reasoning_summary_text.delta') {
        emit({ kind: 'thinking', text: String(event.delta ?? '') })
      } else if (type === 'response.completed') {
        const response = event.response as
          | {
              output?: ResponseItem[]
              usage?: {
                input_tokens?: number
                output_tokens?: number
                input_tokens_details?: { cached_tokens?: number }
              }
            }
          | undefined
        if (response?.usage) {
          usage = {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            cacheReadTokens: response.usage.input_tokens_details?.cached_tokens ?? null
          }
        }
        const output = response?.output ?? []
        // 全部 output items（含 reasoning 加密块）原样回传进 input——无损
        this.input.push(...output)
        for (const item of output) {
          if (item.type === 'function_call') {
            let input: unknown = {}
            try {
              input = item.arguments ? JSON.parse(String(item.arguments)) : {}
            } catch {
              input = {}
            }
            toolCalls.push({ id: String(item.call_id), name: String(item.name), input })
          }
        }
      }
    }
    return { toolCalls, usage }
  }
}

export function createProviderSession(
  profile: UsableProfile,
  system: string,
  tools: ToolSpec[],
  /** 接续回灌：落盘 snapshot 的 messages 原样灌回，缺省开全新对话 */
  initialMessages?: unknown[],
  /**
   * OpenAI 前缀缓存的分片路由键：传 convId——对话主键天然稳定且唯一，
   * 正对上官方建议的"会话 ID"。Anthropic 分支用不上（那边靠 cache_control 断点）。
   */
  cacheKey?: string
): ProviderSession {
  if (profile.provider === 'anthropic') {
    return new AnthropicSession(profile, system, tools, initialMessages)
  }
  if (profile.wireFormat === 'responses') {
    return new ResponsesSession(profile, system, tools, initialMessages, cacheKey)
  }
  return new ChatCompletionsSession(profile, system, tools, initialMessages, cacheKey)
}

/**
 * 一次性非流式文本调用（补全 L3 的预测/修复建议）：无工具、无对话状态，
 * 三分支同一个出口。不复用 ProviderSession——建议是判官式最小上下文调用，
 * 不该挂进带工具与转录注入的对话。
 */
export async function oneShotText(
  profile: UsableProfile,
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens = 512
): Promise<string> {
  if (profile.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: profile.apiKey, baseURL: profile.baseURL || undefined })
    const message = await client.messages.create(
      {
        model: profile.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }]
      },
      { signal }
    )
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  const client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseURL || undefined })
  if (profile.wireFormat === 'responses') {
    const response = await client.responses.create(
      {
        model: profile.model,
        instructions: system,
        input: user,
        store: false,
        max_output_tokens: maxTokens
      },
      { signal }
    )
    return response.output_text ?? ''
  }
  const completion = await client.chat.completions.create(
    {
      model: profile.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    { signal }
  )
  return completion.choices[0]?.message?.content ?? ''
}
