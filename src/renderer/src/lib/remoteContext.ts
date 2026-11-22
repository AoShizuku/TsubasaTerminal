/**
 * L2 远端上下文预取（completion-design）：击键路径上零延迟的正确姿势是预取缓存，
 * compgen 实查退为缓存未命中的兜底。
 * - 命令表：连接后独立 exec 预取一次（PATH 变化极少，会话级缓存）
 * - systemctl unit / docker 容器名：首次需要时采集，30s TTL（名字会变）
 */

const COMMANDS_LIMIT = 5000
const TTL = 30_000

interface CachedList {
  list: string[]
  at: number
}

interface SessionContext {
  commands: string[] | null
  commandsPending: boolean
  units: CachedList | null
  unitsPending: Promise<string[]> | null
  containers: CachedList | null
  containersPending: Promise<string[]> | null
}

const contexts = new Map<string, SessionContext>()

function ensure(sessionId: string): SessionContext {
  let ctx = contexts.get(sessionId)
  if (!ctx) {
    ctx = {
      commands: null,
      commandsPending: false,
      units: null,
      unitsPending: null,
      containers: null,
      containersPending: null
    }
    contexts.set(sessionId, ctx)
  }
  return ctx
}

export function disposeRemoteContext(sessionId: string): void {
  contexts.delete(sessionId)
}

function parseLines(stdout: string | undefined): string[] {
  return (stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 连接后调用：预取远端命令表 */
export function prefetchRemoteContext(sessionId: string): void {
  const ctx = ensure(sessionId)
  if (ctx.commands || ctx.commandsPending) return
  ctx.commandsPending = true
  void window.api.ssh
    .exec(sessionId, `compgen -c | sort -u | head -n ${COMMANDS_LIMIT}`)
    .then((result) => {
      const current = contexts.get(sessionId)
      if (!current) return
      current.commandsPending = false
      if (result.ok) current.commands = parseLines(result.stdout)
    })
    .catch(() => {
      const current = contexts.get(sessionId)
      if (current) current.commandsPending = false
    })
}

/** 预取好的命令表；null = 尚未就绪（调用方回退实查） */
export function cachedCommands(sessionId: string): string[] | null {
  return contexts.get(sessionId)?.commands ?? null
}

async function cachedFetch(
  sessionId: string,
  kind: 'units' | 'containers',
  command: string
): Promise<string[]> {
  const ctx = ensure(sessionId)
  const cached = ctx[kind]
  if (cached && Date.now() - cached.at < TTL) return cached.list
  const pendingKey = kind === 'units' ? 'unitsPending' : 'containersPending'
  const pending = ctx[pendingKey]
  if (pending) return pending
  const promise = window.api.ssh
    .exec(sessionId, command)
    .then((result) => {
      const current = contexts.get(sessionId)
      const list = result.ok ? parseLines(result.stdout) : []
      if (current) {
        current[kind] = { list, at: Date.now() }
        current[pendingKey] = null
      }
      return list
    })
    .catch(() => {
      const current = contexts.get(sessionId)
      if (current) current[pendingKey] = null
      return []
    })
  ctx[pendingKey] = promise
  return promise
}

export function getUnits(sessionId: string): Promise<string[]> {
  return cachedFetch(
    sessionId,
    'units',
    "systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}' | head -n 500"
  )
}

export function getContainers(sessionId: string): Promise<string[]> {
  return cachedFetch(
    sessionId,
    'containers',
    "docker ps -a --format '{{.Names}}' 2>/dev/null | head -n 200"
  )
}
