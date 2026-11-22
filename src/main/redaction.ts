import { createHmac, randomBytes } from 'crypto'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getSelfSecrets } from './hosts'
import { getSettingsSync } from './settings'

/**
 * 回显脱敏闸门（security-design）：结构化转录出口的纯函数，
 * 所有机器消费者（LLM 上下文/历史入库/审计）从这一个闸门取数据。
 * 检测层次：1 高置信格式正则（gitleaks 精选子集 + 关键词预过滤）
 * 2 上下文启发式（key=value / Authorization 头 / 命令行密码参数）
 * 3 自持凭据精确匹配（主机密码/口令，零误报）
 * 4 良性区间白名单（git SHA / digest / UUID——只约束格式类规则，
 *   上下文与自持是强信号不受豁免）。熵检测层 v0.5 未做（排后续）。
 * 替换形态：«REDACTED:type:hmac4» 稳定指纹——同一凭据多处出现占位符相同，
 * LLM 保留引用推理能力但拿不到值。
 */

export interface RedactionHit {
  type: string
  fingerprint: string
}

export interface RedactionResult {
  text: string
  hits: RedactionHit[]
}

interface RedactionRule {
  type: string
  /** 廉价预过滤：文本（小写）含任一关键词才跑正则 */
  keywords: string[]
  pattern: RegExp
  /** 只替换该捕获组（如连接串只脱密码段） */
  group?: number
  /** 强信号规则：不受良性区间豁免 */
  overrideBenign?: boolean
  /** 值级豁免（如 -p 后跟端口映射不是密码） */
  exempt?: (value: string) => boolean
}

const RULES: RedactionRule[] = [
  {
    type: 'aws-access-key',
    keywords: ['akia', 'asia', 'abia', 'acca', 'a3t'],
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
  },
  {
    type: 'aliyun-ak',
    keywords: ['ltai'],
    pattern: /\bLTAI[A-Za-z0-9]{12,22}\b/g
  },
  {
    type: 'github-token',
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g
  },
  {
    type: 'gitlab-token',
    keywords: ['glpat-'],
    pattern: /\bglpat-[\w-]{20,}\b/g
  },
  {
    type: 'slack-token',
    keywords: ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-'],
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    type: 'stripe-key',
    keywords: ['sk_live_', 'rk_live_'],
    pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g
  },
  {
    type: 'openai-key',
    keywords: ['sk-'],
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]{48}\b/g
  },
  {
    type: 'anthropic-key',
    keywords: ['sk-ant-'],
    pattern: /\bsk-ant-[A-Za-z0-9-]{20,}\b/g
  },
  {
    type: 'google-api-key',
    keywords: ['aiza'],
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g
  },
  {
    type: 'npm-token',
    keywords: ['npm_'],
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g
  },
  {
    type: 'telegram-bot-token',
    keywords: [':aa'],
    pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g
  },
  {
    type: 'jwt',
    keywords: ['eyj'],
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  },
  {
    type: 'private-key',
    keywords: ['private key'],
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g
  },
  {
    // mysql://user:pass@host —— 只脱密码段，主机/用户是诊断必需上下文
    type: 'url-credential',
    keywords: ['://'],
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@'"]{1,64}:([^\s@'"]{3,})@/gi,
    group: 1,
    overrideBenign: true
  },
  {
    // password=xxx / DB_SECRET: xxx / api_key = "xxx" —— cat .env、配置 dump 的主现场。
    // 键名核心词必须精确：裸 auth 会误杀 git log 的 "Author:"（真实误报，2026-07）
    type: 'kv-secret',
    keywords: ['password', 'passwd', 'pwd', 'secret', 'token', 'api', 'access_key', 'auth'],
    pattern:
      /[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|authorization|auth[_-]token)[\w.-]*["']?\s*[:=]\s*["']?([^\s"'`;,&|]{4,})/gi,
    group: 1,
    overrideBenign: true,
    // $VAR 引用与打码占位不是真值；纯数字是 max_tokens=1024/timeout=3000 类配置，
    // 误杀代价（Agent 变笨）大于漏掉纯数字弱密码的风险
    exempt: (value) => value.startsWith('$') || /^[*xX•]+$/.test(value) || /^\d+$/.test(value)
  },
  {
    type: 'auth-header',
    keywords: ['authorization'],
    pattern: /authorization:\s*(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    group: 1,
    overrideBenign: true
  },
  {
    // mysql -pS3cret / --password=xxx —— 命令行本身也是泄漏源（会进历史）
    type: 'cli-password',
    keywords: ['--password', '-p'],
    pattern: /(?:--password[= ]|(?<=\s)-p(?=\S))["']?([^\s"';&|]{4,})/g,
    group: 1,
    overrideBenign: true,
    // -p 后跟纯数字/端口映射/IP（docker -p 8080:80、ssh -p 2222）不是密码
    exempt: (value) => /^[\d.:/]+$/.test(value)
  }
]

/** 良性高熵格式：git SHA、镜像 digest、UUID、容器短 ID——LLM 诊断必需，误杀 Agent 就废了 */
const BENIGN_PATTERNS = [
  /\bsha(?:1|256|512):[0-9a-f]{32,128}\b/gi,
  /\b[0-9a-f]{40}\b/g,
  /\b[0-9a-f]{64}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
]

let hmacKey: Buffer | null = null

/** 指纹密钥按安装持久化——同一凭据跨会话指纹稳定，且不可逆推 */
function getHmacKey(): Buffer {
  if (hmacKey) return hmacKey
  const keyFile = join(app.getPath('userData'), 'redaction-key')
  if (existsSync(keyFile)) {
    hmacKey = Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'hex')
  } else {
    hmacKey = randomBytes(32)
    writeFileSync(keyFile, hmacKey.toString('hex'), 'utf-8')
  }
  return hmacKey
}

function fingerprint(secret: string): string {
  return createHmac('sha256', getHmacKey()).update(secret).digest('hex').slice(0, 4)
}

function placeholder(type: string, secret: string): string {
  return `«REDACTED:${type}:${fingerprint(secret)}»`
}

interface Match {
  start: number
  end: number
  type: string
  value: string
}

function collectBenignRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const pattern of BENIGN_PATTERNS) {
    pattern.lastIndex = 0
    for (const m of text.matchAll(pattern)) {
      ranges.push([m.index, m.index + m[0].length])
    }
  }
  return ranges
}

function insideAny(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => start >= s && end <= e)
}

/**
 * 脱敏纯函数。selfSecrets 由调用方传入（redactUnit 封装了获取），
 * 便于规则层单独测试。
 */
export function redactText(text: string, selfSecrets: string[]): RedactionResult {
  if (!text) return { text, hits: [] }
  const matches: Match[] = []

  // 3 层：自持凭据精确匹配（最高优先）
  for (const secret of selfSecrets) {
    let from = 0
    while (true) {
      const at = text.indexOf(secret, from)
      if (at === -1) break
      matches.push({ start: at, end: at + secret.length, type: 'self-credential', value: secret })
      from = at + secret.length
    }
  }

  // 1+2 层：格式规则 + 上下文启发式（关键词预过滤）
  const lower = text.toLowerCase()
  const benign = collectBenignRanges(text)
  for (const rule of RULES) {
    if (!rule.keywords.some((k) => lower.includes(k))) continue
    rule.pattern.lastIndex = 0
    for (const m of text.matchAll(rule.pattern)) {
      const value = rule.group !== undefined ? m[rule.group] : m[0]
      if (!value) continue
      const start = rule.group !== undefined ? m.index + m[0].lastIndexOf(value) : m.index
      const end = start + value.length
      if (rule.exempt?.(value)) continue
      if (!rule.overrideBenign && insideAny(benign, start, end)) continue
      matches.push({ start, end, type: rule.type, value })
    }
  }

  if (matches.length === 0) return { text, hits: [] }

  // 重叠消解：起点排序，先到（同起点取更长）者胜，统一倒序替换
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted: Match[] = []
  let lastEnd = -1
  for (const match of matches) {
    if (match.start < lastEnd) continue
    accepted.push(match)
    lastEnd = match.end
  }
  let result = text
  const hits: RedactionHit[] = []
  for (const match of [...accepted].reverse()) {
    result =
      result.slice(0, match.start) +
      placeholder(match.type, match.value) +
      result.slice(match.end)
  }
  for (const match of accepted) {
    hits.push({ type: match.type, fingerprint: fingerprint(match.value) })
  }
  return { text: result, hits }
}

/** 闸门入口：自动携带自持凭据；总开关关闭时原文放行（净化不受此开关影响） */
export async function redact(text: string): Promise<RedactionResult> {
  if (!getSettingsSync().redactionEnabled) return { text, hits: [] }
  return redactText(text, await getSelfSecrets())
}
