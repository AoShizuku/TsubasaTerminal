import { app, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { LlmProfile, LlmProfileInput, ThinkingLevel } from '../../shared/types'

/**
 * LLM profile 存储（BYOK）：userData/llm-profiles.json。
 * apiKey 与主机凭据同级待遇——safeStorage 加密落盘、只在主进程解密、
 * 永不跨 IPC；渲染进程只见 hasKey 元数据。
 */

interface StoredProfile {
  id: string
  name: string
  provider: 'anthropic' | 'openai-compatible'
  wireFormat?: 'chat.completions' | 'responses'
  baseURL?: string
  model: string
  thinking?: ThinkingLevel
  contextWindow?: number
  apiKeyEnc?: string
}

/** v0.10.3 及更早的落盘形态：数字预算通道，读时一次性迁移 */
interface LegacyThinking {
  enabled?: boolean
  budgetTokens?: number
}

const PLAIN_PREFIX = 'plain:'
const THINKING_LEVELS: ThinkingLevel[] = [
  'inherit',
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/**
 * 思考配置归一：数字预算 → 档位。
 * 老的 `{enabled:true, budgetTokens?}` 一律落到 `high`——那是 Anthropic
 * effort 的默认值，对"原来开着思考"的 profile 最保真；
 * 没开过思考的（undefined/enabled:false）落到 `inherit` 而非 `none`，
 * 保持"不发参数"的原行为，避免在不接受 disabled 的模型上凭空 400。
 */
function normalizeThinking(raw: unknown): ThinkingLevel | undefined {
  if (typeof raw === 'string') {
    return THINKING_LEVELS.includes(raw as ThinkingLevel) ? (raw as ThinkingLevel) : undefined
  }
  if (raw && typeof raw === 'object') {
    return (raw as LegacyThinking).enabled ? 'high' : 'inherit'
  }
  return undefined
}

function profilesFile(): string {
  return join(app.getPath('userData'), 'llm-profiles.json')
}

function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
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

async function readStored(): Promise<StoredProfile[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(profilesFile(), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    // 老格式在读路径统一归一——sanitize / getProfileForUse / 回写都只见档位形态，
    // 下一次保存自然把新形态落盘，不需要单独的迁移动作
    return parsed.map((p: StoredProfile) => ({ ...p, thinking: normalizeThinking(p?.thinking) }))
  } catch {
    return []
  }
}

async function writeStored(profiles: StoredProfile[]): Promise<void> {
  await fs.writeFile(profilesFile(), JSON.stringify(profiles, null, 2), 'utf-8')
}

function sanitize(p: StoredProfile): LlmProfile {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    wireFormat: p.wireFormat,
    baseURL: p.baseURL,
    model: p.model,
    thinking: p.thinking,
    contextWindow: p.contextWindow,
    hasKey: Boolean(p.apiKeyEnc)
  }
}

/** 仅供主进程 agent loop 使用：带解密后 apiKey 的完整 profile */
export interface UsableProfile extends Omit<LlmProfile, 'hasKey'> {
  apiKey: string
}

export async function getProfileForUse(id: string): Promise<UsableProfile | null> {
  const stored = (await readStored()).find((p) => p.id === id)
  if (!stored) return null
  const apiKey = decryptSecret(stored.apiKeyEnc)
  if (!apiKey) return null
  const { apiKeyEnc: _enc, ...rest } = stored
  return { ...rest, apiKey }
}

/**
 * 接续的替身 profile：原 profile 已删除时，按"协议 + wire format + 模型"
 * 找一个可用的。原生消息只认协议，模型同名才保得住原对话的行为与价位；
 * 端点存档里没记，替身只作候选，调用方必须交人确认。
 */
export async function findProfileForModel(match: {
  provider: UsableProfile['provider']
  wireFormat?: UsableProfile['wireFormat']
  model: string
}): Promise<UsableProfile | null> {
  if (!match.model) return null
  const wire = (p: { provider: string; wireFormat?: string }): string =>
    p.provider === 'openai-compatible' ? (p.wireFormat ?? 'chat.completions') : ''
  for (const stored of await readStored()) {
    if (stored.provider !== match.provider || stored.model !== match.model) continue
    if (wire(stored) !== wire(match)) continue
    const usable = await getProfileForUse(stored.id)
    if (usable) return usable
  }
  return null
}

function normalizeInput(input: LlmProfileInput): Omit<StoredProfile, 'id' | 'apiKeyEnc'> {
  return {
    name: String(input.name ?? '').slice(0, 100),
    provider: input.provider === 'openai-compatible' ? 'openai-compatible' : 'anthropic',
    wireFormat:
      input.provider === 'openai-compatible'
        ? input.wireFormat === 'responses'
          ? 'responses'
          : 'chat.completions'
        : undefined,
    baseURL: input.baseURL?.trim() ? input.baseURL.trim() : undefined,
    model: String(input.model ?? '').slice(0, 200),
    thinking: normalizeThinking(input.thinking),
    contextWindow:
      typeof input.contextWindow === 'number' && input.contextWindow > 0
        ? Math.min(Math.floor(input.contextWindow), 100_000_000)
        : undefined
  }
}

export function registerLlmProfileHandlers(): void {
  ipcMain.handle('llm:profiles', async () => (await readStored()).map(sanitize))

  ipcMain.handle('llm:save-profile', async (_event, input: LlmProfileInput) => {
    const profiles = await readStored()
    const fields = normalizeInput(input)
    if (input.id) {
      const target = profiles.find((p) => p.id === input.id)
      if (target) {
        Object.assign(target, fields)
        // apiKey 留空表示保持原值
        if (input.apiKey) target.apiKeyEnc = encryptSecret(input.apiKey)
      }
    } else {
      profiles.push({
        id: randomUUID(),
        ...fields,
        apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey) : undefined
      })
    }
    await writeStored(profiles)
    return profiles.map(sanitize)
  })

  ipcMain.handle('llm:delete-profile', async (_event, id: string) => {
    const profiles = (await readStored()).filter((p) => p.id !== id)
    await writeStored(profiles)
    return profiles.map(sanitize)
  })
}
