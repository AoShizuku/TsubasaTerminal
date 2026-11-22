import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecution } from '../../../src/main/llm/tools'

const execution: ToolExecution = {
  content: 'done',
  uiStatus: 'executed',
  uiSummary: '退出 0',
  raw: { text: 'ok\n', exitCode: 0 }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-27T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CLI asynchronous job registry', () => {
  it('keeps pending and completed results readable without consuming them', async () => {
    const jobs = await import('../../../src/main/cli/jobs')
    jobs.registerJob({
      proposalId: 'proposal-a',
      sessionId: 'session-a',
      handle: 'deadbeef',
      agent: 'codex',
      command: 'systemctl restart nginx'
    })

    expect(jobs.getJob('proposal-a')).toMatchObject({ doneAt: null, execution: null })
    jobs.completeJob('proposal-a', execution)
    expect(jobs.getJob('proposal-a')).toMatchObject({ execution, doneAt: Date.now() })
    expect(jobs.getJob('proposal-a')).toMatchObject({ execution })
  })

  it('retains terminal results for ten minutes and sweeps them afterwards', async () => {
    const jobs = await import('../../../src/main/cli/jobs')
    jobs.registerJob({
      proposalId: 'proposal-a',
      sessionId: 'session-a',
      handle: 'deadbeef',
      command: 'failcmd'
    })
    jobs.completeJob('proposal-a', execution)

    vi.advanceTimersByTime(10 * 60_000)
    expect(jobs.getJob('proposal-a')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(jobs.getJob('proposal-a')).toBeNull()
  })
})
