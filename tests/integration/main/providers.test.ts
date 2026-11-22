import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  createProviderSession,
  type StreamEmit,
  type ToolSpec
} from '../../../src/main/llm/providers'

type ProviderProfile = Parameters<typeof createProviderSession>[0]

interface CapturedRequest {
  method: string | undefined
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

interface ProviderTestServer {
  baseURL: string
  requests: CapturedRequest[]
  close(): Promise<void>
}

const TOOLS: ToolSpec[] = [
  {
    name: 'inspect_file',
    description: 'Inspect a remote file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
]

function profile(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: 'profile-test',
    name: 'Provider test',
    provider: 'anthropic',
    baseURL: '',
    model: 'test-model',
    apiKey: 'sk-test',
    ...overrides
  }
}

function writeSse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeAnthropicSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 0
      }
    }
  })
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' }
  })
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'inspect first' }
  })
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'signed-thinking' }
  })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' }
  })
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'anthropic answer' }
  })
  send('content_block_stop', { type: 'content_block_stop', index: 1 })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 }
  })
  send('message_stop', { type: 'message_stop' })
  res.end()
}

function writeChatSse(res: ServerResponse): void {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): unknown => ({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  writeSse(res, [
    chunk({ role: 'assistant' }),
    chunk({ reasoning_content: 'chat thinks' }),
    chunk({ content: 'chat answer' }),
    chunk({}, 'stop'),
    {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [],
      usage: {
        prompt_tokens: 13,
        completion_tokens: 5,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 }
      }
    }
  ])
}

function writeChatToolCallSse(res: ServerResponse): void {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): unknown => ({
    id: 'chatcmpl-tool-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  writeSse(res, [
    chunk({ role: 'assistant' }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_chat_tool',
          type: 'function',
          function: { name: 'inspect_', arguments: '{"path":"/var/' }
        }
      ]
    }),
    chunk({
      tool_calls: [{ index: 0, function: { name: 'file', arguments: 'log/app.' } }]
    }),
    chunk(
      { tool_calls: [{ index: 0, function: { arguments: 'log"}' } }] },
      'tool_calls'
    ),
    {
      id: 'chatcmpl-tool-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 6,
        total_tokens: 23,
        prompt_tokens_details: { cached_tokens: 2 }
      }
    }
  ])
}

function writeChatToolFollowupSse(res: ServerResponse): void {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): unknown => ({
    id: 'chatcmpl-tool-followup',
    object: 'chat.completion.chunk',
    created: 2,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })

  writeSse(res, [
    chunk({ role: 'assistant' }),
    chunk({ content: 'tool result accepted' }),
    chunk({}, 'stop'),
    {
      id: 'chatcmpl-tool-followup',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'test-model',
      choices: [],
      usage: {
        prompt_tokens: 29,
        completion_tokens: 4,
        total_tokens: 33,
        prompt_tokens_details: { cached_tokens: 11 }
      }
    }
  ])
}

function chatMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(body.messages)) return []
  return body.messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && !Array.isArray(message)
  )
}

function writeResponsesSse(res: ServerResponse): void {
  writeSse(res, [
    { type: 'response.reasoning_summary_text.delta', delta: 'response thinks' },
    { type: 'response.output_text.delta', delta: 'response answer' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        status: 'completed',
        output: [
          {
            id: 'rs_test',
            type: 'reasoning',
            encrypted_content: 'opaque-reasoning',
            summary: []
          },
          {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'response answer',
                annotations: []
              }
            ]
          },
          {
            id: 'fc_test',
            type: 'function_call',
            call_id: 'call_test',
            name: 'inspect_file',
            arguments: '{"path":"/tmp/app.log"}',
            status: 'completed'
          }
        ],
        usage: {
          input_tokens: 21,
          output_tokens: 8,
          total_tokens: 29,
          input_tokens_details: { cached_tokens: 6 }
        }
      }
    }
  ])
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

async function startProviderTestServer(): Promise<ProviderTestServer> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const body = await readJson(req)
        requests.push({
          method: req.method,
          path,
          headers: req.headers,
          body
        })

        if (path === '/v1/messages') writeAnthropicSse(res)
        else if (path === '/v1/chat/completions') {
          const messages = chatMessages(body)
          const isToolFlow = messages.some(
            (message) =>
              message.role === 'user' && message.content === 'inspect with streamed chat tool'
          )
          const hasToolResult = messages.some((message) => message.role === 'tool')
          if (isToolFlow && hasToolResult) writeChatToolFollowupSse(res)
          else if (isToolFlow) writeChatToolCallSse(res)
          else writeChatSse(res)
        }
        else if (path === '/v1/responses') writeResponsesSse(res)
        else {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `unexpected path ${path}` } }))
        }
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error) } }))
      }
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider test server has no port')

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

describe('provider protocol integration', () => {
  let server: ProviderTestServer

  beforeAll(async () => {
    server = await startProviderTestServer()
  })

  beforeEach(() => {
    server.requests.length = 0
  })

  afterAll(async () => {
    await server.close()
  })

  it('sends Anthropic adaptive thinking and preserves signed thinking blocks', async () => {
    const session = createProviderSession(
      profile({ baseURL: server.baseURL, thinking: 'high' }),
      'anthropic system',
      TOOLS
    )
    const emitted: Parameters<StreamEmit>[0][] = []
    session.pushUser('diagnose anthropic')

    const result = await session.runTurn(new AbortController().signal, (event) => {
      emitted.push(event)
    })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/v1/messages' })
    expect(server.requests[0].body).toMatchObject({
      model: 'test-model',
      system: 'anthropic system',
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'diagnose anthropic' }]
    })
    expect(server.requests[0].body).not.toHaveProperty('budget_tokens')
    expect(emitted).toEqual([
      { kind: 'thinking', text: 'inspect first' },
      { kind: 'text', text: 'anthropic answer' }
    ])
    expect(result).toEqual({
      toolCalls: [],
      usage: { inputTokens: 16, outputTokens: 7, cacheReadTokens: 3 }
    })
    expect(session.snapshot().messages).toEqual([
      { role: 'user', content: 'diagnose anthropic' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect first', signature: 'signed-thinking' },
          { type: 'text', text: 'anthropic answer' }
        ]
      }
    ])
  })

  it('omits all Anthropic thinking parameters for inherit', async () => {
    const session = createProviderSession(
      profile({ baseURL: server.baseURL, thinking: 'inherit' }),
      'inherit system',
      []
    )
    session.pushUser('inherit defaults')

    await session.runTurn(new AbortController().signal, () => undefined)

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].body).not.toHaveProperty('thinking')
    expect(server.requests[0].body).not.toHaveProperty('output_config')
    expect(server.requests[0].body).not.toHaveProperty('budget_tokens')
    expect(server.requests[0].body.max_tokens).toBe(8192)
  })

  it('sends chat reasoning_effort and a stable prompt_cache_key', async () => {
    const session = createProviderSession(
      profile({
        provider: 'openai-compatible',
        wireFormat: 'chat.completions',
        baseURL: `${server.baseURL}/v1`,
        thinking: 'medium'
      }),
      'chat system',
      TOOLS,
      undefined,
      'conversation-123'
    )
    const emitted: Parameters<StreamEmit>[0][] = []
    session.pushUser('diagnose chat')

    const result = await session.runTurn(new AbortController().signal, (event) => {
      emitted.push(event)
    })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions' })
    expect(server.requests[0].body).toMatchObject({
      model: 'test-model',
      reasoning_effort: 'medium',
      prompt_cache_key: 'conversation-123',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'chat system' },
        { role: 'user', content: 'diagnose chat' }
      ]
    })
    expect(server.requests[0].body).not.toHaveProperty('reasoning')
    expect(emitted).toEqual([
      { kind: 'thinking', text: 'chat thinks' },
      { kind: 'text', text: 'chat answer' }
    ])
    expect(result).toEqual({
      toolCalls: [],
      usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 4 }
    })
    expect(JSON.stringify(session.snapshot().messages)).not.toContain('chat thinks')
  })

  it('defaults legacy profiles to chat, assembles tool-call fragments, and feeds results back', async () => {
    const session = createProviderSession(
      profile({
        provider: 'openai-compatible',
        baseURL: `${server.baseURL}/v1`,
        thinking: 'inherit'
      }),
      'chat tool system',
      TOOLS
    )
    session.pushUser('inspect with streamed chat tool')

    const firstEmitted: Parameters<StreamEmit>[0][] = []
    const first = await session.runTurn(new AbortController().signal, (event) => {
      firstEmitted.push(event)
    })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions'
    })
    expect(server.requests[0].body).toMatchObject({
      messages: [
        { role: 'system', content: 'chat tool system' },
        { role: 'user', content: 'inspect with streamed chat tool' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'inspect_file',
            description: 'Inspect a remote file',
            parameters: TOOLS[0].inputSchema
          }
        }
      ]
    })
    expect(firstEmitted).toEqual([])
    expect(first).toEqual({
      toolCalls: [
        {
          id: 'call_chat_tool',
          name: 'inspect_file',
          input: { path: '/var/log/app.log' }
        }
      ],
      usage: { inputTokens: 17, outputTokens: 6, cacheReadTokens: 2 }
    })
    expect(session.snapshot()).toMatchObject({
      provider: 'openai-compatible',
      wireFormat: 'chat.completions'
    })
    expect(session.snapshot().messages).toEqual([
      { role: 'system', content: 'chat tool system' },
      { role: 'user', content: 'inspect with streamed chat tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_chat_tool',
            type: 'function',
            function: {
              name: 'inspect_file',
              arguments: '{"path":"/var/log/app.log"}'
            }
          }
        ]
      }
    ])

    session.pushToolResults([
      { id: 'call_chat_tool', content: 'last line: service healthy', isError: false }
    ])
    const secondEmitted: Parameters<StreamEmit>[0][] = []
    const second = await session.runTurn(new AbortController().signal, (event) => {
      secondEmitted.push(event)
    })

    expect(server.requests).toHaveLength(2)
    expect(server.requests[1].body.messages).toEqual([
      { role: 'system', content: 'chat tool system' },
      { role: 'user', content: 'inspect with streamed chat tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_chat_tool',
            type: 'function',
            function: {
              name: 'inspect_file',
              arguments: '{"path":"/var/log/app.log"}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_chat_tool',
        content: 'last line: service healthy'
      }
    ])
    expect(secondEmitted).toEqual([{ kind: 'text', text: 'tool result accepted' }])
    expect(second).toEqual({
      toolCalls: [],
      usage: { inputTokens: 29, outputTokens: 4, cacheReadTokens: 11 }
    })
    expect(session.snapshot().messages).toEqual([
      ...chatMessages(server.requests[1].body),
      { role: 'assistant', content: 'tool result accepted' }
    ])
  })

  it('streams Responses reasoning/text and retains opaque output items', async () => {
    const session = createProviderSession(
      profile({
        provider: 'openai-compatible',
        wireFormat: 'responses',
        baseURL: `${server.baseURL}/v1`,
        thinking: 'xhigh'
      }),
      'responses system',
      TOOLS,
      undefined,
      'conversation-responses'
    )
    const emitted: Parameters<StreamEmit>[0][] = []
    session.pushUser('diagnose responses')

    const result = await session.runTurn(new AbortController().signal, (event) => {
      emitted.push(event)
    })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/v1/responses' })
    expect(server.requests[0].body).toMatchObject({
      model: 'test-model',
      instructions: 'responses system',
      input: [{ type: 'message', role: 'user', content: 'diagnose responses' }],
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      prompt_cache_key: 'conversation-responses',
      stream: true
    })
    expect(emitted).toEqual([
      { kind: 'thinking', text: 'response thinks' },
      { kind: 'text', text: 'response answer' }
    ])
    expect(result).toEqual({
      toolCalls: [
        {
          id: 'call_test',
          name: 'inspect_file',
          input: { path: '/tmp/app.log' }
        }
      ],
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 6 }
    })
    expect(session.snapshot().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'rs_test',
          type: 'reasoning',
          encrypted_content: 'opaque-reasoning'
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_test',
          name: 'inspect_file'
        })
      ])
    )
  })
})
