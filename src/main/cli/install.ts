import { app } from 'electron'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CliSkillState, CliSkillStatus, CliSkillTarget } from '../../shared/types'
import { CLI_EXIT } from '../../shared/cli'
import { renderSkill, SKILL_DIR_NAME, SKILL_FILE, SKILL_MARKER } from './skill'
import { skillVersion } from './rules'

/**
 * 安装面（cli-bridge-design 第六节）：CLI 本体的落点、shim 三件套与 PATH、
 * 两家 skill 的原地安装。
 *
 * Codex 的落点 v0.13.17 起改为通用目录 `~/.agents/skills/`，旧 `~/.codex/skills/` 只做迁移清理。
 *
 * 三条纪律：
 * 1. **应用自管，不交给 NSIS**——社区常用的 `EnvVarUpdate` 在 PATH 超 1024 字符时
 *    静默截断整条 PATH（现代开发机几乎必超），且安装器写死的路径没人自愈。
 *    这里每次启动用当前 `process.execPath` 重写 shim：应用更新、用户挪了安装位置，
 *    下次启动自动指回正确的 exe，PATH 条目永远不用变。
 * 2. **sh 版是命根子**——Claude Code 在 Windows 上的 Bash 工具是 Git Bash，
 *    按名字只解析 `.exe` 与无扩展名脚本，**不解析 `.cmd`**。没有它，这条通道
 *    对 CC 根本不存在。
 * 3. **改版检测与卸载都在原地完成**（`.tsubasa-ssh-install.json` 记 version + 逐文件
 *    sha256），不在别人的 settings.json 里留中央状态；hash 对不上 = 人手工改过，
 *    **绝不静默覆盖**。
 */

/** e2e / 便携场景的落点覆盖：shim 目录与两家 skill 的宿主目录一起改到沙盒里 */
function cliHomeOverride(): string | null {
  const v = process.env['TSUBASATERMINAL_CLI_HOME']?.trim()
  return v ? v : null
}

/** PATH 改动开关：e2e 一律跳过（不能去动开发机真实的 HKCU\\Environment） */
export function pathManaged(): boolean {
  return process.platform === 'win32' && process.env['TSUBASATERMINAL_CLI_SKIP_PATH'] !== '1'
}

/** shim 目录：给 tsubasa-mysql / tsubasa-redis 家族留同一个屋檐 */
export function shimDir(): string {
  const override = cliHomeOverride()
  if (override) return join(override, 'bin')
  const local = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local')
  return join(local, 'tsubasa', 'bin')
}

function skillHome(): string {
  return cliHomeOverride() ?? homedir()
}

/**
 * skill 落点。Codex 现行读取通用目录 `~/.agents/skills/`（v0.13.17 起），
 * `~/.codex/skills/` 是旧落点，只做迁移清理（{@link cleanLegacySkill}），不再写入。
 */
export function skillDir(target: CliSkillTarget): string {
  return target === 'claude'
    ? join(skillHome(), '.claude', 'skills', SKILL_DIR_NAME)
    : join(skillHome(), '.agents', 'skills', SKILL_DIR_NAME)
}

/** 宿主检测仍探 `~/.claude` / `~/.codex`：有没有装 Codex 看的是它自己的家目录 */
function skillHostDir(target: CliSkillTarget): string {
  return join(skillHome(), target === 'claude' ? '.claude' : '.codex')
}

/** v0.13.17 前 Codex skill 的落点；Claude 没有旧落点 */
function legacySkillDir(target: CliSkillTarget): string | null {
  return target === 'codex' ? join(skillHome(), '.codex', 'skills', SKILL_DIR_NAME) : null
}

/**
 * CLI 单文件产物。打包版走 `extraResources` 落 `resources\\cli\\`——**放 asar 外**，
 * 不赌 `ELECTRON_RUN_AS_NODE` 模式下的 asar 补丁行为。
 */
export function cliScriptPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'cli', 'tsubasa-ssh.js')
  return join(app.getAppPath(), 'out', 'cli', 'tsubasa-ssh.js')
}

// ---------- shim 三件套 ----------

/** Git Bash 认得 `C:/x/y` 形态，且 MSYS 的参数路径转换不会去动它（不像 `/c/x/y`） */
function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

interface Shim {
  name: string
  content: string
  /** sh 版要可执行位（Git Bash 下 NTFS 的 x 位靠 MSYS 模拟，写上不亏） */
  mode: number
}

function shimFiles(): Shim[] {
  const exe = process.execPath
  const script = cliScriptPath()
  const userData = app.getPath('userData')
  // 固定 bootstrap 不含双引号/空格；业务 argv 以 UTF-8 JSON/Base64 作为一个原生参数传递。
  // PS 5.1 的 Legacy 拼参会丢空串、拆嵌套双引号，不能仅靠 @args；CLI 本身仍只读 process.argv。
  const psBootstrap =
    "process.argv=[process.execPath,...JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'))];require(process.argv[1])"
  return [
    {
      name: 'tsubasa-ssh.cmd',
      mode: 0o755,
      content: [
        '@echo off',
        'rem 由 Tsubasa Terminal 每次启动自动重写，请勿手工编辑',
        'setlocal',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `set "TSUBASA_SSH_USERDATA=${userData}"`,
        `"${exe}" "${script}" %*`,
        'exit /b %ERRORLEVEL%',
        ''
      ].join('\r\n')
    },
    {
      // 无扩展名 sh 脚本：Claude Code / Codex 在 Windows 上的 Bash 工具靠它找到本命令
      name: 'tsubasa-ssh',
      mode: 0o755,
      content: [
        '#!/bin/sh',
        '# 由 Tsubasa Terminal 每次启动自动重写，请勿手工编辑',
        'ELECTRON_RUN_AS_NODE=1 \\',
        `TSUBASA_SSH_USERDATA='${toSlash(userData)}' \\`,
        `exec '${toSlash(exe)}' '${toSlash(script)}' "$@"`,
        ''
      ].join('\n')
    },
    {
      // GUI Electron 必须接入 PowerShell 管道才会等待并接管 stdout。
      // 不转交 cmd：远端命令里的 %变量% / 引号不能被本机再次解释。
      name: 'tsubasa-ssh.ps1',
      mode: 0o755,
      content: [
        // Windows PowerShell 5.1 以 ANSI 读取无 BOM 脚本；安装路径也可能含中文。
        String.fromCharCode(0xfeff) + '# 由 Tsubasa Terminal 每次启动自动重写，请勿手工编辑',
        '$previousEncoding = [Console]::OutputEncoding',
        '$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE',
        '$previousUserData = $env:TSUBASA_SSH_USERDATA',
        `$shimExitCode = ${CLI_EXIT.FAILED}`,
        'try {',
        "  $ErrorActionPreference = 'Continue'",
        '  $PSNativeCommandUseErrorActionPreference = $false',
        '  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
        "  $env:ELECTRON_RUN_AS_NODE = '1'",
        `  $env:TSUBASA_SSH_USERDATA = '${userData.replace(/'/g, "''")}'`,
        `  $cliArgs = [string[]](@('${script.replace(/'/g, "''")}') + @($args))`,
        '  $payload = ConvertTo-Json -InputObject $cliArgs -Compress -Depth 3',
        '  $encodedArgs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))',
        '  $global:LASTEXITCODE = $null',
        `  & '${exe.replace(/'/g, "''")}' -e '${psBootstrap.replace(/'/g, "''")}' -- $encodedArgs | Write-Output`,
        "  if ($null -eq $global:LASTEXITCODE) { throw 'CLI process did not start' }",
        '  $shimExitCode = $global:LASTEXITCODE',
        '} catch {',
        "  Write-Error ('tsubasa-ssh: ' + $_.Exception.Message) -ErrorAction Continue",
        '} finally {',
        '  [Console]::OutputEncoding = $previousEncoding',
        '  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode',
        '  $env:TSUBASA_SSH_USERDATA = $previousUserData',
        '}',
        'exit $shimExitCode',
        ''
      ].join('\r\n')
    }
  ]
}

/** 每次启动自愈：用当前 execPath 重写三个 shim（内容一致时不重复写盘） */
export async function writeShims(): Promise<void> {
  const dir = shimDir()
  await fs.mkdir(dir, { recursive: true })
  for (const shim of shimFiles()) {
    const target = join(dir, shim.name)
    const existing = await fs.readFile(target, 'utf-8').catch(() => null)
    if (existing === shim.content) continue
    await fs.writeFile(target, shim.content, { encoding: 'utf-8', mode: shim.mode })
  }
}

export async function removeShims(): Promise<void> {
  const dir = shimDir()
  for (const shim of shimFiles()) {
    await fs.rm(join(dir, shim.name), { force: true }).catch(() => {})
  }
  // 目录空了才删——家族里还有 tsubasa-mysql / tsubasa-redis 时不能连锅端
  await fs.rmdir(dir).catch(() => {})
}

export async function shimsInstalled(): Promise<boolean> {
  const dir = shimDir()
  for (const shim of shimFiles()) {
    const existing = await fs.readFile(join(dir, shim.name), 'utf-8').catch(() => null)
    if (existing !== shim.content) return false
  }
  return true
}

// ---------- HKCU PATH ----------

function runPowerShell(script: string, timeoutMs = 20000): Promise<string> {
  // -EncodedCommand（UTF-16LE base64）绕开全部引号/换行转义问题
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/**
 * 读 HKCU\\Environment 的 Path **原值**：`DoNotExpandEnvironmentNames` 保住
 * `%USERPROFILE%` 这类未展开条目，`GetValueKind` 保住 REG_EXPAND_SZ 类型——
 * 用 `[Environment]::SetEnvironmentVariable` 会把整条降级成 REG_SZ，别用。
 */
const PS_READ_PATH = `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($k) {
  $v = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $k.Close()
  [Console]::Out.Write($v)
}
`

/** 改完广播 WM_SETTINGCHANGE，新开的终端才认；失败不致命（反正要提示重开终端） */
const PS_BROADCAST = `
try {
  Add-Type -Namespace TsubasaWin32 -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
  $r = [UIntPtr]::Zero
  [TsubasaWin32.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
} catch { }
`

function pathScript(action: 'add' | 'remove'): string {
  const mutate =
    action === 'add'
      ? `if (-not $hit) { $parts += $d; $changed = $true }`
      : `if ($hit) { $parts = @($parts | Where-Object { $_.TrimEnd([char]92) -ine $d.TrimEnd([char]92) }); $changed = $true }`
  return `
$d = $env:TSUBASA_SHIM_DIR
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if (-not $k) { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
$v = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
try { $kind = $k.GetValueKind('Path') } catch { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
$parts = @($v -split ';' | Where-Object { $_ -ne '' })
$hit = [bool]($parts | Where-Object { $_.TrimEnd([char]92) -ieq $d.TrimEnd([char]92) })
$changed = $false
${mutate}
if ($changed) { $k.SetValue('Path', ($parts -join ';'), $kind) }
$k.Close()
${PS_BROADCAST}
`
}

export async function isShimDirOnPath(): Promise<boolean> {
  if (!pathManaged()) return false
  try {
    const raw = await runPowerShell(PS_READ_PATH, 10000)
    const target = shimDir().replace(/\\+$/, '').toLowerCase()
    return raw
      .split(';')
      .map((p) => p.trim().replace(/\\+$/, '').toLowerCase())
      .includes(target)
  } catch {
    return false
  }
}

async function mutatePath(action: 'add' | 'remove'): Promise<void> {
  if (!pathManaged()) return
  const dir = shimDir()
  const encoded = Buffer.from(pathScript(action), 'utf16le').toString('base64')
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, TSUBASA_SHIM_DIR: dir }
      },
      // PATH 改不成不该让整个开关失败：shim 已经写好了，用户手动加一次目录也能用
      () => resolve()
    )
  })
}

// ---------- skill 原地安装 ----------

interface SkillMarker {
  version: string
  files: Record<string, string>
}

function sha256(data: string | Buffer): string {
  const hash = createHash('sha256')
  if (typeof data === 'string') hash.update(data, 'utf-8')
  else hash.update(data)
  return hash.digest('hex')
}

async function readMarker(dir: string): Promise<SkillMarker | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir, SKILL_MARKER), 'utf-8')) as SkillMarker
    if (typeof parsed?.version !== 'string') return null
    if (typeof parsed.files !== 'object' || parsed.files === null || Array.isArray(parsed.files)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function detectState(target: CliSkillTarget): Promise<{
  state: CliSkillState
  installedVersion: string | null
}> {
  const dir = skillDir(target)
  const marker = await readMarker(dir)
  const body = await fs.readFile(join(dir, SKILL_FILE), 'utf-8').catch(() => null)
  if (!marker || body === null) {
    // 有正文没标记 = 用户自己放的，同样按"手工内容"对待，不覆盖
    return { state: body === null ? 'absent' : 'modified', installedVersion: null }
  }
  if (marker.files[SKILL_FILE] !== sha256(body)) {
    return { state: 'modified', installedVersion: marker.version }
  }
  const current = renderSkill()
  if (marker.version !== skillVersion() || sha256(current) !== sha256(body)) {
    return { state: 'outdated', installedVersion: marker.version }
  }
  return { state: 'installed', installedVersion: marker.version }
}

/** 两条路径是否落在同一处（junction / 符号链接把旧落点接到新落点时不能当旧目录清） */
async function samePlace(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([
    fs.realpath(a).catch(() => null),
    fs.realpath(b).catch(() => null)
  ])
  if (!ra || !rb) return false
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/** 旧落点还在且不是新落点的别名 → 返回它（状态行据此提示"旧目录已保留"） */
async function legacyResidue(target: CliSkillTarget): Promise<string | null> {
  const dir = legacySkillDir(target)
  if (!dir) return null
  const present = await fs.lstat(dir).then(() => true).catch(() => false)
  if (!present || (await samePlace(dir, skillDir(target)))) return null
  return dir
}

/** manifest 里的条目只认单层普通文件名，`..`、分隔符一律不碰 */
function isPlainEntry(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/:]/.test(name)
}

/**
 * 旧落点迁移清理：只删本安装器 manifest 记录且 hash 未变的文件；
 * 记录的文件全部清掉才删 manifest；目录空了才删目录。
 *
 * 手工改过的文件、manifest 之外的文件、没有（或读不懂）manifest 的整个目录
 * 一律原样保留，由状态行提示用户自己处理——与新落点同一条"绝不静默覆盖/删除"纪律。
 * 不跟随链接：旧落点本身是 junction / 符号链接时不是我们建的，不进去删。
 * 只动 `<home>/.codex/skills/tsubasa-ssh/` 这一个目录，`.system` 与别的 skill 不在视野内。
 * 删不掉（占用、权限）也不抛：新落点已经装好，残留靠状态行如实说出来。
 */
export async function cleanLegacySkill(target: CliSkillTarget): Promise<void> {
  const dir = legacySkillDir(target)
  if (!dir) return
  const st = await fs.lstat(dir).catch(() => null)
  if (!st || !st.isDirectory() || (await samePlace(dir, skillDir(target)))) return
  const marker = await readMarker(dir)
  if (!marker) return
  let kept = false
  for (const [name, hash] of Object.entries(marker.files)) {
    if (!isPlainEntry(name) || typeof hash !== 'string') {
      kept = true
      continue
    }
    const file = join(dir, name)
    const fst = await fs.lstat(file).catch(() => null)
    if (!fst) continue
    if (!fst.isFile()) {
      kept = true
      continue
    }
    const data = await fs.readFile(file).catch(() => null)
    if (data === null || sha256(data) !== hash) {
      kept = true
      continue
    }
    await fs.rm(file).catch(() => {
      kept = true
    })
  }
  if (kept) return
  await fs.rm(join(dir, SKILL_MARKER)).catch(() => {})
  // rmdir 只删空目录：manifest 之外还有文件时自然失败并保留
  await fs.rmdir(dir).catch(() => {})
}

export async function skillStatus(target: CliSkillTarget): Promise<CliSkillStatus> {
  const dir = skillDir(target)
  const hostPresent = await fs
    .stat(skillHostDir(target))
    .then((s) => s.isDirectory())
    .catch(() => false)
  const { state, installedVersion } = await detectState(target)
  const legacyDir = await legacyResidue(target)
  return { target, hostPresent, state, installedVersion, dir, legacyDir }
}

/**
 * 装载 / 重渲染。**手工改过（`modified`）一律不写**——这是"指令通道只能人写"纪律的
 * 镜像：我们写进别人指令通道的东西，也要尊重人后来的修改。
 * 新落点就绪（或本来就有人写的内容）后清理旧落点，避免 Codex 读到两份同名 skill。
 */
export async function installSkill(target: CliSkillTarget, force = false): Promise<CliSkillStatus> {
  const current = await skillStatus(target)
  if (current.state === 'modified' && !force) {
    await cleanLegacySkill(target)
    return await skillStatus(target)
  }
  const dir = skillDir(target)
  const body = renderSkill()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, SKILL_FILE), body, 'utf-8')
  const marker: SkillMarker = { version: skillVersion(), files: { [SKILL_FILE]: sha256(body) } }
  await fs.writeFile(join(dir, SKILL_MARKER), JSON.stringify(marker, null, 2), 'utf-8')
  await cleanLegacySkill(target)
  return await skillStatus(target)
}

/** 取消勾选 = 删目录（原地标记跟文件走，卸载不留中央状态）；旧落点按迁移规则一并清理 */
export async function removeSkill(target: CliSkillTarget): Promise<CliSkillStatus> {
  await fs.rm(skillDir(target), { recursive: true, force: true }).catch(() => {})
  await cleanLegacySkill(target)
  return await skillStatus(target)
}

export async function cliScriptExists(): Promise<boolean> {
  return await fs
    .stat(cliScriptPath())
    .then((s) => s.isFile())
    .catch(() => false)
}

// ---------- 总开关 ----------

export async function enableBridgeInstall(): Promise<void> {
  await writeShims()
  await mutatePath('add')
}

export async function disableBridgeInstall(): Promise<void> {
  await mutatePath('remove')
  await removeShims()
}
