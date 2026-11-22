import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptUnitRaw } from '../../../src/shared/types'

type IpcListener = (...args: unknown[]) => unknown

const ipcState = vi.hoisted(() => ({
  listeners: new Map<string, IpcListener>()
}))
const redactionState = vi.hoisted(() => ({
  redact: vi.fn(async (text: string) => ({ text, hits: [] }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: {
    on: (channel: string, listener: IpcListener) => ipcState.listeners.set(channel, listener),
    handle: vi.fn()
  }
}))
vi.mock('../../../src/main/redaction', () => ({ redact: redactionState.redact }))

beforeEach(() => {
  vi.resetModules()
  ipcState.listeners.clear()
  redactionState.redact.mockClear()
})

describe('transcript ingestion without Electron', () => {
  it('sanitizes terminal controls and invisible Unicode before redaction and storage', async () => {
    const transcript = await import('../../../src/main/transcript')
    transcript.registerTranscriptHandlers()
    const listener = ipcState.listeners.get('transcript:report') as
      | ((
          event: { sender: { isDestroyed(): boolean; send(): void } },
          sessionId: string,
          hostId: string,
          raw: TranscriptUnitRaw
        ) => void)
      | undefined
    if (!listener) throw new Error('transcript:report listener was not registered')

    listener(
      { sender: { isDestroyed: () => false, send: vi.fn() } },
      'session-a',
      'host-a',
      {
        command: null,
        echo: '\u001b[32mnoise\u001b[0m\u200b',
        output: '\u001b[31mred\u001b[0m z\u200bw',
        outputTruncated: false,
        exitCode: 0,
        cwd: '/tmp',
        ptyUser: 'ops',
        startedAt: 100,
        endedAt: 200
      }
    )

    await vi.waitFor(() => expect(transcript.getTranscriptUnits('session-a')).toHaveLength(1))

    expect(redactionState.redact).toHaveBeenNthCalledWith(1, 'noise')
    expect(redactionState.redact).toHaveBeenNthCalledWith(2, 'red zw')
    expect(transcript.getTranscriptUnits('session-a')[0]).toMatchObject({
      command: 'noise',
      output: 'red zw',
      exitCode: 0,
      cwd: '/tmp',
      ptyUser: 'ops'
    })
  })

  it('drops the zsh PROMPT_SP tail before storage (arch 真机 v0.13.15)', async () => {
    const transcript = await import('../../../src/main/transcript')
    transcript.registerTranscriptHandlers()
    const listener = ipcState.listeners.get('transcript:report') as (
      event: { sender: { isDestroyed(): boolean; send(): void } },
      sessionId: string,
      hostId: string,
      raw: TranscriptUnitRaw
    ) => void
    const tail = `\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m${' '.repeat(156)}\r \r`
    // command 留空走回显近似：精确命令会落主机历史，而本文件 mock 的 userData 是空串
    const report = (echo: string, output: string): void =>
      listener({ sender: { isDestroyed: () => false, send: vi.fn() } }, 'session-z', 'host-z', {
        command: null,
        echo,
        output,
        outputTruncated: false,
        exitCode: 0,
        cwd: '/tmp',
        ptyUser: 'ops',
        startedAt: 100,
        endedAt: 200
      })

    report('cd /tmp', tail)
    report('printf foo', `foo${tail}`)
    report('echo hello', `hello\r\n${tail}`)

    await vi.waitFor(() => expect(transcript.getTranscriptUnits('session-z')).toHaveLength(3))
    expect(transcript.getTranscriptUnits('session-z').map((u) => u.output)).toEqual([
      '',
      'foo',
      'hello\n'
    ])
  })
})
