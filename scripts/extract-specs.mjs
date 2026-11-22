/**
 * 从 @withfig/autocomplete（devDependency）提取运维高频命令的精简补全语料，
 * 生成 src/renderer/src/assets/fig-specs.json（checked in，运行时零依赖）。
 * 提取深度两层：命令 → 子命令（各带 options）；generators 等动态部分丢弃
 * （远端上下文由 L2 预取负责）。语料更新：npm update @withfig/autocomplete 后重跑本脚本。
 */
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 运维高频命令集（withfig 无对应 spec 的会被跳过并打印） */
const COMMANDS = [
  'git', 'docker', 'docker-compose', 'systemctl', 'journalctl', 'kubectl',
  'npm', 'pnpm', 'yarn', 'apt', 'apt-get', 'pip', 'pip3',
  'ssh', 'scp', 'rsync', 'tar', 'curl', 'wget',
  'grep', 'find', 'ps', 'kill', 'killall', 'chmod', 'chown',
  'du', 'df', 'ip', 'nginx', 'ufw', 'pm2',
  'mysql', 'psql', 'redis-cli', 'tmux', 'make', 'node',
  'python', 'python3', 'cargo', 'crontab', 'mount', 'head', 'tail', 'watch', 'xargs'
]

const DESC_LIMIT = 100

function names(value) {
  return (Array.isArray(value) ? value : [value]).filter((n) => typeof n === 'string')
}

function trimDesc(value) {
  if (typeof value !== 'string') return undefined
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > DESC_LIMIT ? oneLine.slice(0, DESC_LIMIT - 1) + '…' : oneLine
}

function extractOptions(options) {
  if (!Array.isArray(options)) return []
  return options
    .filter((o) => o && !o.hidden && !o.deprecated)
    .map((o) => ({ names: names(o.name), description: trimDesc(o.description) }))
    .filter((o) => o.names.length > 0)
}

function extractSubcommands(subcommands) {
  if (!Array.isArray(subcommands)) return []
  return subcommands
    .filter((s) => s && !s.hidden)
    .map((s) => ({
      names: names(s.name),
      description: trimDesc(s.description),
      options: extractOptions(s.options)
    }))
    .filter((s) => s.names.length > 0)
}

const result = {}
const missing = []
for (const command of COMMANDS) {
  try {
    const url = pathToFileURL(
      join(APP_ROOT, 'node_modules', '@withfig', 'autocomplete', 'build', `${command}.js`)
    ).href
    const spec = (await import(url)).default
    result[command] = {
      description: trimDesc(spec.description),
      options: extractOptions(spec.options),
      subcommands: extractSubcommands(spec.subcommands)
    }
  } catch {
    missing.push(command)
  }
}

const outFile = join(APP_ROOT, 'src', 'renderer', 'src', 'assets', 'fig-specs.json')
const json = JSON.stringify(result)
writeFileSync(outFile, json, 'utf-8')
console.log(`extracted ${Object.keys(result).length} specs -> ${outFile} (${(json.length / 1024).toFixed(0)} KB)`)
if (missing.length) console.log('missing specs:', missing.join(', '))
