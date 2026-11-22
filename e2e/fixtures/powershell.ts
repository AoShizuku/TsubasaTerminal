import { spawn } from 'child_process'

export const powershellHosts = ['powershell.exe', 'pwsh.exe']

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 真宿主执行：命令文本通过 UTF-16LE 传入；stdout/stderr 分开收集，不依赖开发机 profile。 */
export function runPowerShell(
  host: string,
  script: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, ...extraEnv }
  delete env.NODE_OPTIONS
  delete env.VSCODE_INSPECTOR_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const prefix = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);\n"
  const child = spawn(host, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-OutputFormat', 'Text', '-EncodedCommand',
    Buffer.from(prefix + script, 'utf16le').toString('base64')
  ], { env, windowsHide: true, timeout: 20_000 })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: string) => { stdout += data })
  child.stderr.on('data', (data: string) => { stderr += data })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
