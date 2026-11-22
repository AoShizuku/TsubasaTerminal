// @vitest-environment jsdom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptUnitRaw } from '../../src/shared/types'

/**
 * 直打命令的屏幕读取：真 xterm + 与 TerminalView 相同的接线——
 * OSC 133 处理器在 B 记起点、C 读屏入队，转录组装器在 write 回调里扫同一块字节。
 * 字节剧本取自 arch 真机 zsh（zle 重绘 / 行中插入 / autosuggestions / 整行重显）。
 */

const SID = 'sess-1'
const reports: TranscriptUnitRaw[] = []

beforeEach(() => {
  reports.length = 0
  ;(window as unknown as { api: unknown }).api = {
    transcript: {
      report: (_sid: string, _hostId: string, unit: TranscriptUnitRaw) => reports.push(unit),
      identity: vi.fn(),
      dispose: vi.fn()
    }
  }
})

let term: Terminal | null = null

afterEach(() => {
  term?.dispose()
  term = null
})

async function setup(cols = 80): Promise<(chunk: string) => Promise<void>> {
  const commandLine = await import('../../src/renderer/src/lib/commandLine')
  const transcript = await import('../../src/renderer/src/lib/transcript')
  const t = new Terminal({ cols, rows: 24, allowProposedApi: true })
  term = t
  transcript.initTranscript(SID, 'host-1')
  t.parser.registerOscHandler(133, (data) => {
    if (data[0] === 'B') commandLine.markCommandLineStart(SID, t)
    else if (data[0] === 'C') {
      transcript.noteScreenCommand(SID, commandLine.readCommandLine(SID, t))
    }
    return true
  })
  const encoder = new TextEncoder()
  return (chunk) =>
    new Promise<void>((resolve) => {
      const bytes = encoder.encode(chunk)
      t.write(bytes, () => {
        transcript.feedTranscript(SID, bytes)
        resolve()
      })
    })
}

const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07[user@zsh-test-host ~]%\x1b]133;B\x07'
const ACCEPT = '\r\n\x1b]133;C\x07'
const END = '\x1b]133;D;0\x07'

describe('screen-read command line', () => {
  it('zle 每键重绘（首字重画 + 整行重着色）读出终态命令', async () => {
    const feed = await setup()
    await feed(PROMPT)
    let line = ''
    for (const ch of 'ls /tmp') {
      // syntax-highlighting 式：退回行首整行重画
      await feed((line ? `\x1b[${line.length}D` : '') + `\x1b[32m${line + ch}\x1b[0m`)
      line += ch
    }
    // accept-line 再整行重显一次
    await feed(`\x1b[${line.length}D${line}${ACCEPT}x\r\n${END}`)
    expect(reports).toHaveLength(1)
    expect(reports[0].echo).toBe('ls /tmp')
  })

  it('行中插入：方向键回退后补字', async () => {
    const feed = await setup()
    await feed(`${PROMPT}echo helo\x1b[2Dllo\x1b[2D\x1b[2C${ACCEPT}hello\r\n${END}`)
    expect(reports[0].echo).toBe('echo hello')
  })

  it('autosuggestions 灰字在 accept-line 前清掉，不进命令', async () => {
    const feed = await setup()
    await feed(`${PROMPT}ec\x1b[90mho one echo two\x1b[0m\x1b[15D`)
    await feed(`ho hello\x1b[K${ACCEPT}hello\r\n${END}`)
    expect(reports[0].echo).toBe('echo hello')
  })

  it('软折行无缝拼接，多行缓冲保留换行', async () => {
    const feed = await setup(20)
    const long = 'echo abcdefghijklmnopqrstuvwxyz'
    await feed(`${PROMPT}${long}${ACCEPT}${END}`)
    expect(reports[0].echo).toBe(long)

    await feed(`${PROMPT}echo one\r\necho two${ACCEPT}${END}`)
    expect(reports[1].echo).toBe('echo one\necho two')
  })

  it('一块里连着两条命令：读数按次序各归各位', async () => {
    const feed = await setup()
    await feed(`${PROMPT}cd /tmp${ACCEPT}${PROMPT}pwd${ACCEPT}/tmp\r\n${END}`)
    expect(reports.map((u) => u.echo)).toEqual(['cd /tmp', 'pwd'])
  })

  it('读数不是回显子序列时退回回显近似', async () => {
    const feed = await setup()
    await feed(`${PROMPT}echo hi`)
    // 绕开转录直接改屏（模拟错位读数）：屏幕上多出的字从未出现在 B..C 回显里
    await new Promise<void>((resolve) => term?.write(' QQ', resolve))
    await feed(`${ACCEPT}${END}`)
    // 上报的是原始回显（主进程照旧净化），不是屏幕上的 `echo hi QQ`
    expect(reports[0].echo).toBe('echo hi\r\n')
  })

  it('composer 精确文本仍然优先', async () => {
    const feed = await setup()
    const transcript = await import('../../src/renderer/src/lib/transcript')
    await feed(PROMPT)
    transcript.noteComposerCommand(SID, 'echo exact')
    await feed(`echo exact${ACCEPT}${END}`)
    expect(reports[0].command).toBe('echo exact')
  })
})
