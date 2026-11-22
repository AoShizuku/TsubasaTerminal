import { app, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  KNOWLEDGE_LIMIT,
  type HostConfig,
  type HostInput,
  type TerminalInputMode
} from '../shared/types'
import { removeExperienceForHost } from './llm/experience'

/** 磁盘存储格式：机密字段以 safeStorage 加密后的 base64 保存 */
interface StoredHost extends HostConfig {
  passwordEnc?: string
  passphraseEnc?: string
  /** sudo 密码（v0.11.1"登录后以 root 运行"）：与登录密码同待遇 */
  sudoPasswordEnc?: string
  /** 旧版明文字段，读取时自动迁移为加密存储 */
  password?: string
  passphrase?: string
  sudoPassword?: string
}

const PLAIN_PREFIX = 'plain:'

function hostsFile(): string {
  return join(app.getPath('userData'), 'hosts.json')
}

function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  // 桌面密钥环不可用时的降级路径（Windows DPAPI 正常情况下总是可用）
  return PLAIN_PREFIX + Buffer.from(plain, 'utf-8').toString('base64')
}

function decryptSecret(enc?: string): string | undefined {
  if (!enc) return undefined
  if (enc.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(enc.slice(PLAIN_PREFIX.length), 'base64').toString('utf-8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

async function writeStored(hosts: StoredHost[]): Promise<void> {
  await fs.writeFile(hostsFile(), JSON.stringify(hosts, null, 2), 'utf-8')
}

async function readStored(): Promise<StoredHost[]> {
  let hosts: StoredHost[]
  try {
    const parsed = JSON.parse(await fs.readFile(hostsFile(), 'utf-8'))
    hosts = Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
  // 迁移旧版明文凭据
  let migrated = false
  for (const host of hosts) {
    if (typeof host.password === 'string' && host.password.length > 0) {
      host.passwordEnc = encryptSecret(host.password)
    }
    if (typeof host.passphrase === 'string' && host.passphrase.length > 0) {
      host.passphraseEnc = encryptSecret(host.passphrase)
    }
    if (typeof host.sudoPassword === 'string' && host.sudoPassword.length > 0) {
      host.sudoPasswordEnc = encryptSecret(host.sudoPassword)
    }
    if ('password' in host || 'passphrase' in host || 'sudoPassword' in host) {
      delete host.password
      delete host.passphrase
      delete host.sudoPassword
      migrated = true
    }
  }
  if (migrated) await writeStored(hosts)
  return hosts
}

function sanitize(host: StoredHost): HostConfig {
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authType,
    privateKeyPath: host.privateKeyPath,
    shellIntegration: host.shellIntegration,
    envLevel: host.envLevel,
    tmuxKeepalive: host.tmuxKeepalive,
    // 读出也过白名单：手改 hosts.json 写错的值按"跟随全局"处理
    inputMode: normalizeInputMode(host.inputMode),
    elevate: host.elevate === 'sudo' ? 'sudo' : undefined,
    // 渲染进程只见"是否已配置"布尔——sudo 密码明文永不跨 IPC
    hasSudoPassword: host.sudoPasswordEnc ? true : undefined,
    sftpServerPath: host.sftpServerPath,
    // 知识是非机密面：渲染进程要能编辑它，跨 IPC 照常带上
    knowledge: host.knowledge
  }
}

/**
 * sftp-server 路径归一：只收绝对路径、拒空白与引号。
 * 它会被拼进 `sudo -- <path>` 由远端 shell 解析——虽然出口过 shellQuote 已经安全，
 * 但形态可疑的值宁可当没配（回落自动探测），不给自己留一处需要反复论证的入口。
 */
function normalizeSftpServerPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text) return undefined
  if (!text.startsWith('/') || /[\s'"\\]/.test(text) || text.length > 512) return undefined
  return text
}

/** 本机输入方式归一：白名单外一律 undefined = 跟随全局 */
function normalizeInputMode(raw: unknown): TerminalInputMode | undefined {
  return raw === 'composer' || raw === 'native' ? raw : undefined
}

/** 知识块归一：主进程侧硬截断，不信渲染进程的 maxlength（它每轮都进 system） */
function normalizeKnowledge(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.slice(0, KNOWLEDGE_LIMIT).trim()
  return text || undefined
}

/** 仅供主进程 SSH 模块使用：带解密后机密的完整配置 */
export interface ConnectableHost extends HostConfig {
  password?: string
  passphrase?: string
  sudoPassword?: string
}

export async function getHostForConnect(id: string): Promise<ConnectableHost | null> {
  const stored = (await readStored()).find((h) => h.id === id)
  if (!stored) return null
  return {
    ...sanitize(stored),
    password: decryptSecret(stored.passwordEnc),
    passphrase: decryptSecret(stored.passphraseEnc),
    sudoPassword: decryptSecret(stored.sudoPasswordEnc)
  }
}

/**
 * 本机知识：system prompt 拼装时按 hostId 取。每次读盘——
 * 编辑主机走的是同一份文件，缓存只会让"下一对话生效"变成"下一次启动生效"。
 */
export async function getHostKnowledge(hostId: string | undefined): Promise<string> {
  if (!hostId) return ''
  const stored = (await readStored()).find((h) => h.id === hostId)
  return normalizeKnowledge(stored?.knowledge) ?? ''
}

let selfSecretsCache: { at: number; secrets: string[] } | null = null

/**
 * 应用自持的全部主机凭据（脱敏闸门的精确匹配层用，零误报）。
 * 明文只在主进程内存中短暂存在，5s TTL 缓存避免每个转录单元都跑解密。
 */
export async function getSelfSecrets(): Promise<string[]> {
  if (selfSecretsCache && Date.now() - selfSecretsCache.at < 5000) {
    return selfSecretsCache.secrets
  }
  const secrets = new Set<string>()
  for (const host of await readStored()) {
    for (const enc of [host.passwordEnc, host.passphraseEnc, host.sudoPasswordEnc]) {
      const plain = decryptSecret(enc)
      // 过短的凭据精确替换会在正常文本上大量碰撞，不纳入
      if (plain && plain.length >= 4) secrets.add(plain)
    }
  }
  selfSecretsCache = { at: Date.now(), secrets: [...secrets] }
  return selfSecretsCache.secrets
}

/** 脱敏后的主机配置清单（v0.12.2 CLI `use` 自动开会话按别名找主机用；无机密字段） */
export async function listHostConfigs(): Promise<HostConfig[]> {
  return (await readStored()).map(sanitize)
}

export function registerHostHandlers(): void {
  ipcMain.handle('hosts:list', async () => (await readStored()).map(sanitize))

  ipcMain.handle('hosts:add', async (_event, input: HostInput) => {
    const hosts = await readStored()
    hosts.push({
      id: randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      privateKeyPath: input.privateKeyPath,
      shellIntegration: input.shellIntegration,
      envLevel: input.envLevel,
      tmuxKeepalive: input.tmuxKeepalive,
      inputMode: normalizeInputMode(input.inputMode),
      elevate: input.elevate === 'sudo' ? 'sudo' : undefined,
      sftpServerPath: normalizeSftpServerPath(input.sftpServerPath),
      knowledge: normalizeKnowledge(input.knowledge),
      passwordEnc: input.password ? encryptSecret(input.password) : undefined,
      passphraseEnc: input.passphrase ? encryptSecret(input.passphrase) : undefined,
      sudoPasswordEnc: input.sudoPassword ? encryptSecret(input.sudoPassword) : undefined
    })
    await writeStored(hosts)
    return hosts.map(sanitize)
  })

  ipcMain.handle('hosts:update', async (_event, input: HostInput) => {
    const hosts = await readStored()
    const target = hosts.find((h) => h.id === input.id)
    if (target) {
      target.name = input.name
      target.host = input.host
      target.port = input.port
      target.username = input.username
      target.authType = input.authType
      target.privateKeyPath = input.privateKeyPath
      target.shellIntegration = input.shellIntegration
      target.envLevel = input.envLevel
      target.tmuxKeepalive = input.tmuxKeepalive
      target.inputMode = normalizeInputMode(input.inputMode)
      target.elevate = input.elevate === 'sudo' ? 'sudo' : undefined
      target.sftpServerPath = normalizeSftpServerPath(input.sftpServerPath)
      target.knowledge = normalizeKnowledge(input.knowledge)
      // 留空表示保持原值
      if (input.password) target.passwordEnc = encryptSecret(input.password)
      if (input.passphrase) target.passphraseEnc = encryptSecret(input.passphrase)
      if (input.sudoPassword) target.sudoPasswordEnc = encryptSecret(input.sudoPassword)
      await writeStored(hosts)
    }
    return hosts.map(sanitize)
  })

  ipcMain.handle('hosts:remove', async (_event, id: string) => {
    const hosts = (await readStored()).filter((h) => h.id !== id)
    await writeStored(hosts)
    // 级联删该主机名下的排障经验（v0.13.1 二次返工）：主机没了，那些条目
    // 在注入侧与管理列表同时筛不到——看不见也删不掉的幽灵。UI 的删除确认
    // 已如实说明这一条会连带发生
    await removeExperienceForHost(id)
    return hosts.map(sanitize)
  })
}
