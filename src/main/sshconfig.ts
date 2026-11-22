import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { homedir, userInfo } from 'os'
import { join } from 'path'
import type { SshConfigEntry, SshConfigLoadResult } from '../shared/types'

/**
 * ~/.ssh/config 一键导入：只做只读解析，取无通配符的 Host 块的
 * HostName / User / Port / IdentityFile 四项。Include、Match、ProxyJump 等
 * 高级指令不展开（导入的是主机清单，不是连接语义的完整迁移）。
 * e2e 用 TSUBASATERMINAL_SSH_CONFIG 环境变量指向 fixture 文件。
 */

function configPath(): string {
  return process.env.TSUBASATERMINAL_SSH_CONFIG || join(homedir(), '.ssh', 'config')
}

function localUsername(): string {
  try {
    return userInfo().username
  } catch {
    return 'root'
  }
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  interface Block {
    aliases: string[]
    fields: Record<string, string>
  }
  const blocks: Block[] = []
  let current: Block | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    // `Key value` 与 `Key=value` 两种形态；key 大小写不敏感
    const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = { aliases: value.split(/\s+/), fields: {} }
      blocks.push(current)
    } else if (current && !(key in current.fields)) {
      // ssh_config 语义：同键首个出现者生效
      current.fields[key] = value
    }
  }

  const entries: SshConfigEntry[] = []
  for (const block of blocks) {
    for (const alias of block.aliases) {
      // 通配符/否定模式不是具体主机，跳过
      if (/[*?!]/.test(alias)) continue
      entries.push({
        alias,
        host: block.fields['hostname'] ?? alias,
        port: Number(block.fields['port']) || 22,
        username: block.fields['user'] ?? localUsername(),
        identityFile: block.fields['identityfile']
      })
    }
  }
  return entries
}

export function registerSshConfigHandlers(): void {
  ipcMain.handle('sshconfig:load', async (): Promise<SshConfigLoadResult> => {
    let text: string
    try {
      text = await fs.readFile(configPath(), 'utf-8')
    } catch {
      return { ok: false, error: `未找到 ${configPath()}` }
    }
    try {
      return { ok: true, entries: parseSshConfig(text) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
