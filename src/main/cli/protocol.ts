import type { CliFlags, CliRequest } from '../../shared/cli'

/**
 * 命名管道入口的不可信 flags 归一化。
 *
 * CLI 侧虽然已经做过参数解析，服务端仍只接收协议允许的字段，并在这里统一限制
 * 数值范围与字符串长度。这个模块刻意不依赖 Electron，协议边界可以直接在 Node 中测试。
 */
export function normalizeFlags(raw: unknown): CliFlags {
  const f = (raw ?? {}) as Record<string, unknown>
  const limit = Number(f.limit)
  const timeout = Number(f.timeout)
  // mode（v0.13.2 push）：CLI 侧已按八进制解析成数值，这里只收 0..0o7777 的整数
  const mode = Number(f.mode)
  return {
    session: typeof f.session === 'string' ? f.session.slice(0, 64) : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : undefined,
    save: f.save === true,
    bg: f.bg === true,
    intent: typeof f.intent === 'string' ? f.intent.slice(0, 300) : undefined,
    timeout:
      Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 3600) : undefined,
    async: f.async === true,
    hosts: typeof f.hosts === 'string' ? f.hosts.slice(0, 512) : undefined,
    json: f.json === true,
    mode: Number.isInteger(mode) && mode >= 0 && mode <= 0o7777 ? mode : undefined
  }
}

/** 请求体一律重建，不把管道里来的对象原样往下传。 */
export function parseRequest(line: string): CliRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  if (typeof r.cmd !== 'string') return null
  return {
    v: Number(r.v) || 0,
    token: typeof r.token === 'string' ? r.token : '',
    clientId: typeof r.clientId === 'string' && r.clientId ? r.clientId.slice(0, 128) : 'global',
    agent: typeof r.agent === 'string' ? r.agent.slice(0, 64) : undefined,
    cmd: r.cmd.slice(0, 32),
    args: Array.isArray(r.args) ? r.args.filter((a) => typeof a === 'string').slice(0, 64) : [],
    flags: normalizeFlags(r.flags)
  }
}
