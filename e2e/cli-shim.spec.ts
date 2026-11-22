import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { CliRequest } from '../src/shared/cli'
import { launchApp } from './fixtures/launch'
import { powershellHosts, psQuote, runPowerShell } from './fixtures/powershell'

// 回归边界：应用生成的 shim → 真实 PowerShell → GUI Electron → CLI → 命名管道。
// 可控服务端只负责制造延迟/大输出并观察 argv，不替代 cli.spec 中的真实主进程与 SSH 接线。
let app: ElectronApplication
let page: Page
let userDataDir: string
let cliHome: string
let shim: string
let server: Server
let pipe: string
let received: CliRequest[] = []
const sockets = new Set<Socket>()
const timers = new Set<ReturnType<typeof setTimeout>>()
let respond: (request: CliRequest, socket: Socket) => void

async function launch(): Promise<void> {
  const launched = await launchApp([], userDataDir, {
    executablePath: process.env.TSUBASATERMINAL_SHIM_TEST_EXE,
    settings: { cliBridgeEnabled: true },
    env: {
      TSUBASATERMINAL_CLI_HOME: cliHome,
      TSUBASATERMINAL_CLI_SKIP_PATH: '1',
      TSUBASA_SSH_PIPE: pipe + '-app'
    }
  })
  app = launched.app
  page = launched.page
}

test.beforeAll(async () => {
  cliHome = mkdtempSync(join(tmpdir(), 'tsubasaterminal shim 中文 '))
  userDataDir = mkdtempSync(join(tmpdir(), "tsubasaterminal 数据 ' "))
  pipe = `\\\\.\\pipe\\tsubasaterminal-shim-${process.pid}`
  await launch()
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(Boolean(process.env.TSUBASATERMINAL_SHIM_TEST_EXE))
  shim = join(cliHome, 'bin', 'tsubasa-ssh.ps1')
  await expect.poll(() => {
    try { return readFileSync(shim, 'utf8').length } catch { return 0 }
  }).toBeGreaterThan(0)
  server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (data: string) => {
      buffer += data
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.split('\n')[0]) as CliRequest
      received.push(request)
      respond(request, socket)
      socket.removeAllListeners('data')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, resolve)
  })
})

test.beforeEach(() => { received = [] })

test.afterAll(async () => {
  for (const timer of timers) clearTimeout(timer)
  for (const socket of sockets) socket.destroy()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await app?.close()
})

function reply(socket: Socket, stdout: string, stderr: string, code: number): void {
  socket.end([
    JSON.stringify({ t: 'out', d: stdout }),
    JSON.stringify({ t: 'err', d: stderr }),
    JSON.stringify({ t: 'exit', code }), ''
  ].join('\n'))
}

for (const host of powershellHosts) {
  test(`${host} shim：等待延迟双流并透传 0 / 1 / 101`, { tag: '@daily' }, async () => {
    for (const code of [0, 1, 101]) {
      respond = (_request, socket) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          reply(socket, '延迟结果 stdout\n', '诊断 stderr\n', code)
        }, 500)
        timers.add(timer)
      }
      const result = await runPowerShell(host,
        `$global:LASTEXITCODE = 77; & ${psQuote(shim)} exec 'whoami'; exit $LASTEXITCODE`,
        { TSUBASA_SSH_PIPE: pipe })
      expect(result).toEqual({ code, stdout: '延迟结果 stdout\r\n', stderr: '诊断 stderr\n' })
    }
  })

  test(`${host} shim：变量捕获、管道、大输出与参数原文`, async () => {
    const command = 'grep "中文 a b" /tmp/x%TSUBASA_SHIM_PROBE% | head -n 2'
    const output = Array.from({ length: 3000 }, (_, i) => `输出-${i}`).join('\n') + '\n'
    const diagnostic = Array.from({ length: 3000 }, (_, i) => `诊断-${i}`).join('\n') + '\n'
    respond = (_request, socket) => reply(socket, output, diagnostic, 0)
    const result = await runPowerShell(host, [
      `$value = & ${psQuote(shim)} exec ${psQuote(command)} | ForEach-Object { $_ }`,
      '$code = $LASTEXITCODE',
      '[Console]::Out.Write(($value -join "`n") + "`n")',
      'exit $code'
    ].join('\n'), { TSUBASA_SSH_PIPE: pipe, TSUBASA_SHIM_PROBE: 'LOCAL_EXPANSION' })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr.length).toBe(diagnostic.length)
    expect(result.stderr === diagnostic).toBe(true)
    expect(result.stdout.length).toBe(output.length)
    expect(result.stdout === output).toBe(true)
    expect(received.map((request) => request.args)).toEqual([[command]])
  })

  test(`${host} shim：空参数、引号、尾反斜杠与宿主 Legacy 模式`, async () => {
    const args = [
      '', '"a b"', 'a\\"b', 'C:\\path with spaces\\', "a'b", 'a&b|c>file',
      '%TSUBASA_SHIM_PROBE%', '--%', 'line1\nline2\tend'
    ]
    respond = (_request, socket) => reply(socket, 'ok\n', '', 0)
    const result = await runPowerShell(host,
      `$PSNativeCommandArgumentPassing = 'Legacy'; & ${psQuote(shim)} exec ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`,
      { TSUBASA_SSH_PIPE: pipe, TSUBASA_SHIM_PROBE: 'LOCAL_EXPANSION' })
    expect(result).toEqual({ code: 0, stdout: 'ok\r\n', stderr: '' })
    expect(received.map((request) => request.args)).toEqual([args])
  })

  test(`${host} shim：分别重定向，失败退出码与诊断不混入 stdout`, async () => {
    respond = (_request, socket) => reply(socket, '正常输出\n', '远端诊断\n', 1)
    const outFile = join(cliHome, 'stdout.txt')
    const errFile = join(cliHome, 'stderr.txt')
    const result = await runPowerShell(host, [
      "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true",
      `& ${psQuote(shim)} exec whoami 1> ${psQuote(outFile)} 2> ${psQuote(errFile)}`,
      '$code = $LASTEXITCODE',
      `$out = [IO.File]::ReadAllText(${psQuote(outFile)})`,
      `$err = [IO.File]::ReadAllText(${psQuote(errFile)})`,
      '[Console]::Out.Write((ConvertTo-Json -Compress @{stdout=$out; stderr=$err}))',
      'exit $code'
    ].join('\n'), { TSUBASA_SSH_PIPE: pipe })
    expect(result.code, result.stderr).toBe(1)
    expect(result.stderr).toBe('')
    const captured = JSON.parse(result.stdout) as { stdout: string; stderr: string }
    expect(captured.stdout).toBe('正常输出\r\n')
    expect(captured.stderr).toContain('远端诊断')
    expect(captured.stderr).not.toContain('正常输出')
  })

  test(`${host} shim：恢复调用方编码和环境，启动失败不沿用旧退出码`, async () => {
    respond = (_request, socket) => reply(socket, '中文保真\n', '', 0)
    const checkState = [
      '$code = $LASTEXITCODE',
      "if ([Console]::OutputEncoding.CodePage -ne 437 -or $env:ELECTRON_RUN_AS_NODE -ne 'before' -or $env:TSUBASA_SSH_USERDATA -ne 'before') { exit 88 }",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '[Console]::Out.Write($value)',
      'exit $code'
    ]
    const prepare = [
      '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)',
      "$env:ELECTRON_RUN_AS_NODE = 'before'; $env:TSUBASA_SSH_USERDATA = 'before'",
      '$global:LASTEXITCODE = 77'
    ]
    const result = await runPowerShell(host, [
      ...prepare, `$value = & ${psQuote(shim)} exec whoami`, ...checkState
    ].join('\n'), { TSUBASA_SSH_PIPE: pipe })
    expect(result).toEqual({ code: 0, stdout: '中文保真', stderr: '' })

    const exe = await app.evaluate(() => process.execPath)
    const broken = join(cliHome, 'missing-exe.ps1')
    writeFileSync(broken, readFileSync(shim, 'utf8').replace(
      `& ${psQuote(exe)} -e`, `& ${psQuote(join(cliHome, 'absent.exe'))} -e`
    ))
    const failed = await runPowerShell(host, [
      ...prepare, `$value = & ${psQuote(broken)} exec whoami`, ...checkState
    ].join('\n'), { TSUBASA_SSH_PIPE: pipe })
    expect(failed.code).toBe(107)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('tsubasa-ssh: ')
    expect(failed.stderr).toContain('absent.exe')
    expect(received).toHaveLength(1)
  })
}

test('shim：旧脚本启动自愈，真实安装状态与本地 version 一致', async () => {
  const original = readFileSync(shim, 'utf8')
  writeFileSync(shim, original.replace(' | Write-Output', ''))
  expect((await page.evaluate(() => window.api.cli.status())).shimsInstalled).toBe(false)
  await app.close()
  await launch()
  await expect.poll(() => readFileSync(shim, 'utf8')).toBe(original)
  expect((await page.evaluate(() => window.api.cli.status())).shimsInstalled).toBe(true)
  const version = await app.evaluate(({ app }) => app.getVersion())
  for (const host of powershellHosts) {
    const result = await runPowerShell(host, `& ${psQuote(shim)} --version; exit $LASTEXITCODE`)
    expect(result).toEqual({ code: 0, stdout: version + '\r\n', stderr: '' })
  }
})
