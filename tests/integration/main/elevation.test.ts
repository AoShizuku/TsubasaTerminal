import { describe, expect, it } from 'vitest'

import {
  buildElevatedExec,
  runElevation,
  type ElevationIo,
  type ElevationState
} from '../../../src/main/elevation'
import { buildSftpServerProbe } from '../../../src/main/elevatedSftp'
import type { ElevationFailReason } from '../../../src/shared/types'

interface ExecCall {
  command: string
  timeoutMs: number
  stdin?: string
}

type ExecResult = Awaited<ReturnType<ElevationIo['exec']>>
type ExecScript = (call: ExecCall) => ExecResult
type PtyMode = 'nopasswd' | 'password' | 'reject-password'

interface ScriptedIoOptions {
  pty: PtyMode
  password?: string | null
  sftpServerPath?: string | null
  exec: ExecScript
  openSftpResult?: ElevationFailReason | null
}

/**
 * runElevation 的进程内 SSH 替身。PTY 输出在 writeInput 内同步送回，避免测试为了
 * QUIET_MS/PTY_TIMEOUT_MS 真等时钟；exec 与 root SFTP 则由每个场景显式给剧本。
 */
class ScriptedElevationIo implements ElevationIo {
  readonly writes: string[] = []
  readonly execCalls: ExecCall[] = []
  readonly openSftpCalls: Array<{
    serverPath: string
    authMode: ElevationState['authMode']
  }> = []

  readonly password: string | null
  readonly sftpServerPath: string | null

  private readonly listeners = new Set<(text: string) => void>()
  private waitingForPassword = false

  constructor(private readonly options: ScriptedIoOptions) {
    this.password = options.password ?? null
    this.sftpServerPath = options.sftpServerPath ?? null
  }

  writeInput(data: string): void {
    this.writes.push(data)

    if (data.startsWith('sudo -p ')) {
      if (this.options.pty === 'nopasswd') {
        this.emit('__TSUBASATERMINAL_ELEV__root\r\n')
      } else {
        this.waitingForPassword = true
        this.emit('TSUBASATERMINAL_PW:')
      }
      return
    }

    if (!this.waitingForPassword) return
    this.waitingForPassword = false
    if (this.options.pty === 'reject-password') {
      this.emit('TSUBASATERMINAL_PW:')
    } else {
      this.emit('__TSUBASATERMINAL_ELEV__root\r\n')
    }
  }

  onOutput(cb: (text: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async exec(command: string, timeoutMs: number, stdin?: string): Promise<ExecResult> {
    const call = { command, timeoutMs, stdin }
    this.execCalls.push(call)
    return this.options.exec(call)
  }

  async openSftp(
    serverPath: string,
    authMode: ElevationState['authMode']
  ): Promise<ElevationFailReason | null> {
    this.openSftpCalls.push({ serverPath, authMode })
    return this.options.openSftpResult ?? null
  }

  private emit(text: string): void {
    for (const listener of [...this.listeners]) listener(text)
  }
}

interface SuccessfulExecOptions {
  authMode?: ElevationState['authMode']
  chdir?: boolean
  sudoVersion?: string
  sftpProbeOutput?: string
}

function successfulExec(options: SuccessfulExecOptions = {}): ExecScript {
  const authMode = options.authMode ?? 'none'
  const chdir = options.chdir ?? true
  const sudoVersion = options.sudoVersion ?? '1.9.13'
  const sftpProbeOutput = options.sftpProbeOutput ?? '/usr/lib/openssh/sftp-server\n'

  return ({ command }) => {
    if (command === 'sudo -n true') {
      return { ok: true, exitCode: authMode === 'none' ? 0 : 1 }
    }
    if (command === "sudo -S -p '' true") {
      return { ok: true, exitCode: authMode === 'password' ? 0 : 1 }
    }
    if (command.includes(' -D /root true')) {
      return { ok: true, exitCode: chdir ? 0 : 1 }
    }
    if (command === 'sudo --version') {
      return { ok: true, exitCode: 0, stdout: `Sudo version ${sudoVersion}\n` }
    }
    if (command === buildSftpServerProbe()) {
      return { ok: true, exitCode: 0, stdout: sftpProbeOutput }
    }
    throw new Error(`unexpected exec command: ${command}`)
  }
}

describe('runElevation', () => {
  it('activates all three identity planes in NOPASSWD mode without sending a password', async () => {
    const io = new ScriptedElevationIo({
      pty: 'nopasswd',
      exec: successfulExec()
    })

    const state = await runElevation(io)

    expect(state).toEqual({
      active: true,
      authMode: 'none',
      cwdMode: 'chdir',
      sudoVersion: '1.9.13',
      sftpServerPath: '/usr/lib/openssh/sftp-server'
    })
    expect(io.execCalls.map((call) => call.command)).toEqual([
      'sudo -n true',
      'sudo -n -D /root true',
      'sudo --version',
      buildSftpServerProbe()
    ])
    expect(io.execCalls.every((call) => call.stdin === undefined)).toBe(true)
    expect(io.openSftpCalls).toEqual([
      { serverPath: '/usr/lib/openssh/sftp-server', authMode: 'none' }
    ])
    expect(io.writes).not.toContain('exit\r')
  })

  it('fixes password auth for every exec channel after a successful -S probe', async () => {
    const io = new ScriptedElevationIo({
      pty: 'password',
      password: 'sudo-secret',
      exec: successfulExec({ authMode: 'password' })
    })

    const state = await runElevation(io)

    expect(state).toMatchObject({ active: true, authMode: 'password', cwdMode: 'chdir' })
    expect(io.writes.filter((write) => write === 'sudo-secret\r')).toHaveLength(1)
    expect(io.execCalls.find((call) => call.command === 'sudo -n true')?.stdin).toBeUndefined()
    expect(io.execCalls.find((call) => call.command === "sudo -S -p '' true")?.stdin).toBe(
      'sudo-secret\n'
    )
    expect(io.execCalls.find((call) => call.command.includes(' -D /root true'))?.stdin).toBe(
      'sudo-secret\n'
    )
    expect(io.openSftpCalls).toEqual([
      { serverPath: '/usr/lib/openssh/sftp-server', authMode: 'password' }
    ])
  })

  it('treats a second password prompt as rejection and never opens an exec channel', async () => {
    const io = new ScriptedElevationIo({
      pty: 'reject-password',
      password: 'wrong-secret',
      exec: () => {
        throw new Error('exec must not run after PTY password rejection')
      }
    })

    const state = await runElevation(io)

    expect(state).toEqual({
      active: false,
      reason: 'password',
      authMode: 'none',
      cwdMode: 'chdir'
    })
    expect(io.execCalls).toHaveLength(0)
    expect(io.openSftpCalls).toHaveLength(0)
    expect(io.writes).toContain('\x03')
    expect(io.writes).not.toContain('exit\r')
  })

  it('backs out of the root PTY when requiretty blocks both exec auth probes', async () => {
    const io = new ScriptedElevationIo({
      pty: 'nopasswd',
      password: 'sudo-secret',
      exec: ({ command }) => {
        if (command === 'sudo -n true' || command === "sudo -S -p '' true") {
          return { ok: true, exitCode: 1 }
        }
        throw new Error(`unexpected exec command: ${command}`)
      }
    })

    const state = await runElevation(io)

    expect(state).toEqual({
      active: false,
      reason: 'no-exec-auth',
      authMode: 'none',
      cwdMode: 'chdir'
    })
    expect(io.execCalls.map((call) => call.command)).toEqual([
      'sudo -n true',
      "sudo -S -p '' true"
    ])
    expect(io.execCalls[1].stdin).toBe('sudo-secret\n')
    expect(io.writes).toContain('exit\r')
    expect(io.openSftpCalls).toHaveLength(0)
  })

  it.each([
    ['modern sudo whose policy rejects -D', '1.9.9'],
    ['old sudo without usable -D support', '1.8.31']
  ])('keeps elevation active in template mode for %s', async (_label, version) => {
    const io = new ScriptedElevationIo({
      pty: 'nopasswd',
      exec: successfulExec({ chdir: false, sudoVersion: version })
    })

    const state = await runElevation(io)

    expect(state).toMatchObject({
      active: true,
      authMode: 'none',
      cwdMode: 'template',
      sudoVersion: version
    })
    // 被拒的 -D 只决定 cwdMode；真正执行时必须落到登记过的固定模板，并把
    // `cd -- '<cwd>' && <command>` 整串再次 shellQuote 后交给 bash -c。
    expect(buildElevatedExec(state, 'whoami', '/root')).toBe(
      "sudo -n -- bash -c 'cd -- '\\''/root'\\'' && whoami'"
    )
    expect(io.execCalls.some((call) => call.command === 'sudo -n -D /root true')).toBe(true)
    expect(io.writes).not.toContain('exit\r')
  })

  it('keeps template mode in bash -c when cwd is unavailable and preserves password auth', () => {
    expect(
      buildElevatedExec(
        { authMode: 'password', cwdMode: 'template' },
        "printf '%s\\n' root",
        null
      )
    ).toBe("sudo -S -p '' -- bash -c 'printf '\\''%s\\n'\\'' root'")
  })

  it('degrades the whole session when no standalone sftp-server path can be probed', async () => {
    const io = new ScriptedElevationIo({
      pty: 'nopasswd',
      exec: successfulExec({ sftpProbeOutput: 'internal-sftp\nrelative/sftp-server\n' })
    })

    const state = await runElevation(io)

    expect(state).toEqual({
      active: false,
      reason: 'no-sftp-server',
      authMode: 'none',
      cwdMode: 'chdir'
    })
    expect(io.openSftpCalls).toHaveLength(0)
    expect(io.writes).toContain('exit\r')
  })

  it('degrades the whole session when the probed root SFTP channel cannot initialize', async () => {
    const io = new ScriptedElevationIo({
      pty: 'nopasswd',
      exec: successfulExec(),
      openSftpResult: 'sftp-init'
    })

    const state = await runElevation(io)

    expect(state).toEqual({
      active: false,
      reason: 'sftp-init',
      authMode: 'none',
      cwdMode: 'chdir'
    })
    expect(io.openSftpCalls).toEqual([
      { serverPath: '/usr/lib/openssh/sftp-server', authMode: 'none' }
    ])
    expect(io.writes).toContain('exit\r')
  })
})
