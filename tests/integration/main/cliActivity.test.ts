import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliRequest } from '../../../src/shared/cli'
import type { AgentEvent, CliActivity } from '../../../src/shared/types'
import type { ToolContext, ToolExecution } from '../../../src/main/llm/tools'

/**
 * CLI 活动栏的主进程半边（cli-bridge-design 第七节）：经真实的 handleCli → runExec /
 * runPushCmd / runExecMulti 发出 cli-activity 事件，executeTool 以下（闸门、审批、执行）
 * 换成可编排的替身——这里守的是"每条 exec / push 都有一张卡，且按真实进度推进到终态"。
 */

const state = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; sessionId: string; event: AgentEvent }>,
  executeTool: vi.fn(),
  planExec: vi.fn(),
  executeAutoPlan: vi.fn()
}))

function fakeSender(): { isDestroyed(): boolean; send(...args: unknown[]): void } {
  return {
    isDestroyed: () => false,
    send: (channel: unknown, sessionId: unknown, event: unknown) => {
      state.sent.push({
        channel: channel as string,
        sessionId: sessionId as string,
        event: event as AgentEvent
      })
    }
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
  Notification: { isSupported: () => false }
}))

vi.mock('../../../src/main/llm/tools', () => ({
  executeTool: state.executeTool,
  planExec: state.planExec,
  executeAutoPlan: state.executeAutoPlan,
  collectTerminalResult: vi.fn()
}))

vi.mock('../../../src/main/llm/loop', () => ({ isAgentRunning: () => false }))

vi.mock('../../../src/main/llm/approvals', () => ({
  hasPendingProposal: () => false,
  hasMultiPendingProposal: () => false,
  isProposalPending: () => false,
  emitMultiEvent: vi.fn(),
  submitMultiProposal: vi.fn()
}))

vi.mock('../../../src/main/llm/terminalState', () => ({
  isTerminalIdle: () => true,
  terminalBusyText: () => ''
}))

vi.mock('../../../src/main/ssh', () => {
  const senders = new Map<string, ReturnType<typeof fakeSender>>()
  return {
    awaitElevation: vi.fn(),
    getSessionSender: (sessionId: string) => {
      if (!senders.has(sessionId)) senders.set(sessionId, fakeSender())
      return senders.get(sessionId)
    }
  }
})

vi.mock('../../../src/main/hosts', () => ({ listHostConfigs: vi.fn(async () => []) }))
vi.mock('../../../src/main/settings', () => ({ getSettingsSync: () => ({}) }))
vi.mock('../../../src/main/cli/briefing', () => ({
  clip: (s: string) => s,
  KNOWLEDGE_PREVIEW: 100,
  renderBriefing: vi.fn()
}))
vi.mock('../../../src/main/cli/autoOpen', () => ({ requestOpenSession: vi.fn() }))
vi.mock('../../../src/main/cli/rules', () => ({ gateRulesText: () => '' }))

vi.mock('../../../src/main/cli/bindings', () => {
  const meta = (name: string) => ({
    name,
    host: `${name}.example`,
    port: 22,
    username: 'ops',
    envLevel: 'normal',
    elevated: false
  })
  return {
    allSessions: () => [],
    bind: vi.fn(),
    boundSessionId: () => null,
    sessionTags: () => [],
    currentBinding: () => ({
      ok: true,
      binding: { sessionId: 'session-a', handle: 'aaaaaaaa', alias: 'web1' },
      meta: meta('web1')
    }),
    resolveRef: (ref: string) => [
      { sessionId: `session-${ref}`, handle: `${ref}000000`.slice(0, 8), meta: meta(ref) }
    ]
  }
})

const FLAGS: CliRequest['flags'] = {
  session: undefined,
  limit: undefined,
  save: false,
  bg: false,
  intent: undefined,
  timeout: undefined,
  async: false,
  hosts: undefined,
  json: false,
  mode: undefined
}

function request(
  cmd: string,
  args: string[],
  flags: Partial<CliRequest['flags']> = {},
  /** null = 匿名（未带 --agent） */
  agent: string | null = 'cc'
): CliRequest {
  return {
    v: 1,
    token: 't',
    clientId: 'client',
    agent: agent ?? undefined,
    cmd,
    args,
    flags: { ...FLAGS, ...flags }
  }
}

const io = { out: vi.fn(), err: vi.fn() }

/** 本次请求推到某会话的活动快照序列（按推送顺序） */
function activities(sessionId = 'session-a'): CliActivity[] {
  return state.sent
    .filter((s) => s.sessionId === sessionId && s.event.kind === 'cli-activity')
    .map((s) => (s.event as Extract<AgentEvent, { kind: 'cli-activity' }>).activity)
}

function executed(summary = '已执行（exit 0）'): ToolExecution {
  return { content: '', uiStatus: 'executed', uiSummary: summary, raw: { text: 'ok', exitCode: 0 } }
}

async function run(req: CliRequest): Promise<number> {
  const { handleCli } = await import('../../../src/main/cli/commands')
  return await handleCli(req, io, new AbortController().signal)
}

beforeEach(() => {
  vi.resetModules()
  state.sent.length = 0
  state.executeTool.mockReset()
  state.planExec.mockReset()
  state.executeAutoPlan.mockReset()
})

describe('CLI 活动栏：单机 exec', () => {
  it('白名单直执行：开卡即执行中，结果到手推到已执行，前后同一 id', async () => {
    state.executeTool.mockResolvedValue(executed())
    expect(await run(request('exec', ['whoami'], { intent: '看看当前身份' }))).toBe(0)

    const seq = activities()
    expect(seq.map((a) => a.status)).toEqual(['running', 'executed'])
    expect(new Set(seq.map((a) => a.id)).size).toBe(1)
    expect(seq[1]).toMatchObject({
      agent: 'cc',
      verb: 'exec',
      detail: 'whoami',
      intent: '看看当前身份',
      summary: '已执行（exit 0）'
    })
    expect(state.sent.every((s) => s.channel === 'agent:event')).toBe(true)
  })

  it('审批路径：待审批 → 批准后执行中 → 已批准；匿名调用记为 null', async () => {
    state.executeTool.mockImplementation(async (ctx: ToolContext) => {
      ctx.onProposalCreated?.('proposal-1')
      ctx.onProposalDecided?.('approved')
      return {
        content: '',
        uiStatus: 'approved',
        uiSummary: '已批准执行（exit 1）',
        raw: { text: 'boom', exitCode: 1 }
      } satisfies ToolExecution
    })
    expect(await run(request('exec', ['failcmd'], {}, null))).toBe(1)

    const seq = activities()
    expect(seq.map((a) => a.status)).toEqual(['running', 'proposed', 'running', 'approved'])
    expect(seq[2].summary).toBe('已批准，等待执行结果')
    expect(seq[3]).toMatchObject({ agent: null, summary: '已批准执行（exit 1）' })
  })

  it.each([
    [
      '用户拒绝带留言',
      { uiStatus: 'denied', uiSummary: '用户拒绝：换只读方案', data: { denied: true } },
      'denied',
      '用户拒绝：换只读方案'
    ],
    [
      '超时撤回不是拒绝',
      { uiStatus: 'rejected', uiSummary: '审批超时，提案已撤回', data: { withdrawn: true } },
      'withdrawn',
      '审批超时，提案已撤回'
    ],
    [
      '请求方断连 / 会话中止',
      { uiStatus: 'rejected', uiSummary: '已中止，提案取消', data: { aborted: true } },
      'aborted',
      '已中止，提案取消'
    ]
  ] as const)('%s', async (_name, result, status, summary) => {
    state.executeTool.mockImplementation(async (ctx: ToolContext) => {
      ctx.onProposalCreated?.('proposal-1')
      ctx.onProposalDecided?.(status === 'denied' ? 'denied' : status === 'withdrawn' ? 'withdrawn' : 'aborted')
      return {
        content: '',
        uiStatus: result.uiStatus,
        uiSummary: result.uiSummary,
        raw: { text: 'x', exitCode: null, data: result.data }
      } satisfies ToolExecution
    })
    await run(request('exec', ['failcmd']))

    const seq = activities()
    expect(seq.map((a) => a.status)).toEqual(['running', 'proposed', status])
    expect(seq[2].summary).toBe(summary)
  })

  it('会话忙给出具体原因；闸门拒绝给出闸门理由', async () => {
    state.executeTool.mockResolvedValueOnce({
      content: '',
      uiStatus: 'rejected',
      uiSummary: '会话忙，稍后重试',
      raw: { text: '会话忙：内置 Agent 正在本会话运行', exitCode: null, data: { busy: true } }
    } satisfies ToolExecution)
    expect(await run(request('exec', ['failcmd']))).toBe(105)
    expect(activities().at(-1)).toMatchObject({
      status: 'busy',
      summary: '会话忙：内置 Agent 正在本会话运行'
    })

    state.sent.length = 0
    state.executeTool.mockResolvedValueOnce({
      content: '',
      uiStatus: 'rejected',
      uiSummary: '不允许 && 拼接',
      raw: { text: '不允许 && 拼接', exitCode: null }
    } satisfies ToolExecution)
    expect(await run(request('exec', ['a && b']))).toBe(101)
    expect(activities().at(-1)).toMatchObject({ status: 'rejected', summary: '不允许 && 拼接' })
  })

  it('执行抛异常：卡片收场为出错，异常照旧抛给管道层', async () => {
    state.executeTool.mockRejectedValue(new Error('channel closed'))
    await expect(run(request('exec', ['whoami']))).rejects.toThrow('channel closed')
    expect(activities().map((a) => a.status)).toEqual(['running', 'error'])
    expect(activities().at(-1)?.summary).toContain('channel closed')
  })

  it('--async：提案挂起即返回，之后的终态照样推到卡上', async () => {
    let finish: (execution: ToolExecution) => void = () => {}
    state.executeTool.mockImplementation(
      (ctx: ToolContext) =>
        new Promise<ToolExecution>((resolve) => {
          ctx.onProposalCreated?.('proposal-async')
          finish = resolve
        })
    )
    expect(await run(request('exec', ['failcmd'], { async: true }))).toBe(0)
    expect(activities().map((a) => a.status)).toEqual(['running', 'proposed'])

    finish({ content: '', uiStatus: 'approved', uiSummary: '已批准执行（exit 0）', raw: { text: '', exitCode: 0 } })
    await vi.waitFor(() => expect(activities().at(-1)?.status).toBe('approved'))
  })
})

describe('CLI 活动栏：push', () => {
  it('detail 写明本地 → 远端，mode 按八进制回显', async () => {
    state.executeTool.mockResolvedValue({
      content: '',
      uiStatus: 'approved',
      uiSummary: '已上传 /opt/app/app（4 KB）',
      raw: { text: '', exitCode: 0 }
    } satisfies ToolExecution)
    await run(request('push', ['D:/build/app', '/opt/app/app'], { mode: 0o755 }))

    expect(activities().at(-1)).toMatchObject({
      verb: 'push',
      detail: 'D:/build/app → /opt/app/app · mode 755',
      status: 'approved'
    })
  })
})

describe('CLI 活动栏：多机 --hosts', () => {
  it('全白名单：逐台一张卡，带总台数', async () => {
    state.planExec.mockResolvedValue({ planned: true, action: 'auto', verdict: {}, risk: 'low' })
    state.executeAutoPlan.mockResolvedValue(executed())
    await run(request('exec', ['uptime'], { hosts: 'web1,web2' }))

    for (const sessionId of ['session-web1', 'session-web2']) {
      expect(activities(sessionId).at(-1)).toMatchObject({ status: 'executed', hosts: 2, detail: 'uptime' })
    }
  })

  it('一台被闸门拒绝：该台写闸门理由，其余台如实记"整批未执行"', async () => {
    state.planExec
      .mockResolvedValueOnce({ planned: true, action: 'auto', verdict: {}, risk: 'low' })
      .mockResolvedValueOnce({
        planned: false,
        execution: {
          content: '',
          uiStatus: 'rejected',
          uiSummary: '不允许重定向',
          raw: { text: '不允许重定向', exitCode: null }
        } satisfies ToolExecution
      })
    expect(await run(request('exec', ['cat x'], { hosts: 'web1,web2' }))).toBe(101)

    expect(activities('session-web2').at(-1)).toMatchObject({ status: 'rejected', summary: '不允许重定向' })
    expect(activities('session-web1').at(-1)).toMatchObject({
      status: 'rejected',
      summary: '整批未执行：web2 被拒'
    })
    expect(state.executeAutoPlan).not.toHaveBeenCalled()
  })
})
