import { shellQuote } from '@shared/shell'
import { useFileStore } from '@/composables/useFileStore'
import { getContainers, getUnits } from '@/lib/remoteContext'
import type { CompletionCandidate } from '@/lib/specCompletion'

/**
 * Tab 补全：L1 spec（specCompletion）+ L2 预取缓存（remoteContext / SFTP 目录缓存）
 * 打头阵，compgen 实时问远端（v0.4.1 起）退为缓存未命中的兜底。
 * 已知限制：非交互 shell 补不到 alias/函数；引号内空格与 ~ 展开不处理。
 */

export interface WordAt {
  /** 光标前的当前词（POSIX 空白切分） */
  word: string
  /** 词在草稿中的起始偏移（替换起点） */
  start: number
  /** 是否为整行第一个词（补命令名而非文件名） */
  isFirstWord: boolean
}

export function extractWordAt(text: string, caret: number): WordAt {
  const before = text.slice(0, caret)
  const word = /(\S*)$/.exec(before)![1]
  const start = caret - word.length
  return { word, start, isFirstWord: before.slice(0, start).trim() === '' }
}

/** 生成 compgen 查询命令；目录候选带尾 /（sed 标注），文件不带 */
export function buildCompgenCommand(word: string, isFirstWord: boolean, cwd: string | null): string {
  const quoted = shellQuote(word)
  if (isFirstWord) {
    return `compgen -c -- ${quoted} | sort -u | head -n 100`
  }
  const cd = cwd ? `cd ${shellQuote(cwd)} 2>/dev/null; ` : ''
  return `${cd}{ compgen -d -- ${quoted} | sed 's:$:/:'; compgen -f -- ${quoted}; } 2>/dev/null | head -n 200`
}

/** 解析候选：去空行、目录/文件去重（compgen -d 与 -f 会重复报目录）、排序、截断 */
export function parseCandidates(stdout: string): string[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
  const set = new Set(lines)
  return [...set]
    .filter((item) => !set.has(`${item}/`))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 50)
}

/** 当前词之前的完整 token 序列（首个即命令名） */
export function tokensBefore(text: string, start: number): string[] {
  return text.slice(0, start).trim().split(/\s+/).filter(Boolean)
}

function resolveDir(cwd: string, dirPart: string): string {
  if (!dirPart) return cwd
  let abs = dirPart.startsWith('/') ? dirPart : (cwd === '/' ? '/' : `${cwd}/`) + dirPart
  if (abs !== '/') abs = abs.replace(/\/+$/, '')
  return abs
}

/**
 * L2 路径缓存：cd 跟随实时维护的 cwd 目录列表（文件栏），目标目录恰为
 * 当前展示目录时零延迟命中。返回 null = 缓存未命中（调用方回退 compgen 实查）。
 */
export function cachedPathCandidates(
  sessionId: string,
  word: string,
  cwd: string | null
): CompletionCandidate[] | null {
  if (!cwd) return null
  const state = useFileStore().states[sessionId]
  if (!state || state.entriesLoading || state.entriesError) return null
  const slash = word.lastIndexOf('/')
  const dirPart = slash >= 0 ? word.slice(0, slash + 1) : ''
  const base = slash >= 0 ? word.slice(slash + 1) : word
  if (state.viewPath !== resolveDir(cwd, dirPart)) return null
  return state.entries
    .filter((entry) => entry.name.startsWith(base))
    .map((entry) => ({ label: dirPart + entry.name + (entry.type === 'dir' ? '/' : '') }))
}

const DOCKER_NAME_SUBCOMMANDS = new Set([
  'exec', 'logs', 'stop', 'start', 'restart', 'rm', 'inspect',
  'top', 'stats', 'attach', 'kill', 'pause', 'unpause', 'port'
])

/** L2 上下文候选：systemctl 参数位补 unit 名、docker 参数位补容器名（TTL 缓存采集） */
export async function contextCandidates(
  sessionId: string,
  tokens: string[],
  word: string
): Promise<CompletionCandidate[]> {
  if (word.startsWith('-')) return []
  let list: string[] = []
  if (tokens[0] === 'systemctl' && tokens.length >= 2) {
    list = await getUnits(sessionId)
  } else if (tokens[0] === 'docker' && tokens.length >= 2 && DOCKER_NAME_SUBCOMMANDS.has(tokens[1])) {
    list = await getContainers(sessionId)
  }
  return list
    .filter((item) => item.startsWith(word) && item !== word)
    .slice(0, 50)
    .map((label) => ({ label }))
}

export function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return ''
  let prefix = items[0]
  for (const item of items.slice(1)) {
    let i = 0
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i += 1
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}
