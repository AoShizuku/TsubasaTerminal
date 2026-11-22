import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  AgentEvent,
  ConversationExportResult,
  ConversationMeta,
  ConversationTitleSource
} from '../../shared/types'

/**
 * 对话持久化存储层（knowledge-design 第二节）：
 *
 * ```
 * userData/conversations/
 *   index.jsonl                       # 列表索引，一行一对话（后行覆盖前行）
 *   <yyyymmdd>/                       # 创建日分目录，固定不动
 *     <convId>.messages.json          # provider 原生消息（v0.10.2 接续用）
 *     <convId>.events.jsonl           # 渲染事件流（回溯用）
 * ```
 *
 * 两份都存且各自不可替代：messages.json 含 thinking signature 与 tool 配对，
 * 接续只能靠它（**本版就要存，哪怕本版不回灌**——数据没采就补不回来）；
 * events.jsonl 是 AgentEvent 序列，工具卡状态/advisory/usage 不在原生消息里，
 * 回溯渲染只能靠它。
 *
 * 落盘的脱敏姿态：工具结果早已过脱敏闸门；用户输入沿用"人屏不脱敏"原样存
 * （设置页明示）。目录名用 conversations/——history/ 已被 v0.5 命令历史占用。
 */

/** 保留策略：超限自动清理（活动对话除外），另有 UI 手动清理入口 */
const MAX_CONVERSATIONS = 200
const MAX_AGE_DAYS = 90
/** 单行事件的兜底上限（正常事件远小于此；防损坏数据把索引读挂） */
const EVENT_LINE_LIMIT = 512 * 1024

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function indexFile(): string {
  return join(conversationsDir(), 'index.jsonl')
}

/** convId 是主进程生成的 UUID，仍防御性过滤路径字符（与 transcript.ts 同款姿态） */
function safeId(convId: string): string {
  return convId.replace(/[^\w-]/g, '_')
}

function convDir(meta: Pick<ConversationMeta, 'dateDir'>): string {
  return join(conversationsDir(), meta.dateDir.replace(/[^\d]/g, ''))
}

function messagesFile(meta: ConversationMeta): string {
  return join(convDir(meta), `${safeId(meta.convId)}.messages.json`)
}

function eventsFile(meta: ConversationMeta): string {
  return join(convDir(meta), `${safeId(meta.convId)}.events.jsonl`)
}

function todayDir(now: number): string {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}${mm}${dd}`
}

// ---------- 索引：内存 Map 为准，变更全量重写（写串行队列防交叠） ----------

let index: Map<string, ConversationMeta> | null = null
let writeChain: Promise<void> = Promise.resolve()

/** 所有磁盘写都排进同一条队列：对话数在保留上限内，全量重写索引成本可控 */
function enqueue(job: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(job).catch(() => {
    // 单次写失败不阻塞后续写；对话持久化是尽力而为，不能拖垮 Agent 主链路
  })
  return writeChain
}

async function loadIndex(): Promise<Map<string, ConversationMeta>> {
  if (index) return index
  const map = new Map<string, ConversationMeta>()
  try {
    const content = await fs.readFile(indexFile(), 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ConversationMeta
        if (typeof parsed.convId === 'string' && typeof parsed.dateDir === 'string') {
          map.set(parsed.convId, parsed)
        }
      } catch {
        // 跳过损坏行
      }
    }
  } catch {
    // 无索引 = 无对话
  }
  index = map
  return map
}

async function writeIndex(): Promise<void> {
  const map = await loadIndex()
  const lines = [...map.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => JSON.stringify(m))
  await fs.mkdir(conversationsDir(), { recursive: true })
  await fs.writeFile(indexFile(), lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
}

// ---------- 活动对话保护：删除/清理绕开正被会话持有的对话 ----------

/** loop.ts 注册；避免 conversations ↔ loop 循环 import */
let activeConvIdsProvider: () => Set<string> = () => new Set()

export function setActiveConvIdsProvider(provider: () => Set<string>): void {
  activeConvIdsProvider = provider
}

// ---------- 供 loop.ts 使用的存储 API ----------

export async function createConversation(init: {
  profileId: string
  model?: string
  hostIds: string[]
  title: string
}): Promise<ConversationMeta> {
  const map = await loadIndex()
  const now = Date.now()
  const meta: ConversationMeta = {
    convId: randomUUID(),
    title: init.title || '未命名对话',
    titleSource: 'fallback',
    createdAt: now,
    updatedAt: now,
    dateDir: todayDir(now),
    hostIds: init.hostIds,
    profileId: init.profileId,
    ...(init.model ? { model: init.model } : {}),
    turnCount: 0,
    bytes: 0
  }
  map.set(meta.convId, meta)
  await enqueue(async () => {
    await fs.mkdir(convDir(meta), { recursive: true })
    await writeIndex()
  })
  void enforceRetention()
  return meta
}

export function getConversationMeta(convId: string): ConversationMeta | null {
  return index?.get(convId) ?? null
}

/** 事件流追加（聚合器 flush 时成批进来，保持行序） */
export function appendConversationEvents(convId: string, events: AgentEvent[]): void {
  if (events.length === 0) return
  void enqueue(async () => {
    const meta = (await loadIndex()).get(convId)
    if (!meta) return
    const lines = events.map((e) => JSON.stringify(e) + '\n').join('')
    await fs.mkdir(convDir(meta), { recursive: true })
    await fs.appendFile(eventsFile(meta), lines, 'utf-8')
  })
}

/**
 * 每轮结束的落盘：messages.json 全量覆盖 + 索引行更新。
 * 中止/出错的轮也写——对话中断不等于数据可丢，接续要从最后一致状态起步。
 */
export function persistConversationTurn(
  convId: string,
  snapshot: unknown,
  turnCount: number
): Promise<void> {
  return enqueue(async () => {
    const meta = (await loadIndex()).get(convId)
    if (!meta) return
    const body = JSON.stringify(snapshot)
    await fs.mkdir(convDir(meta), { recursive: true })
    await fs.writeFile(messagesFile(meta), body, 'utf-8')
    let eventsBytes = 0
    try {
      eventsBytes = (await fs.stat(eventsFile(meta))).size
    } catch {
      // 事件文件尚未产生
    }
    meta.turnCount = turnCount
    meta.updatedAt = Date.now()
    meta.bytes = body.length + eventsBytes
    await writeIndex()
  })
}

/**
 * 读取接续用的原生消息快照：先排空写队列——活动写入不能被读到一半。
 * 文件缺失/损坏返回 null（索引与文件非原子写入的既有边界，读侧兜底）。
 */
export async function readConversationSnapshot(convId: string): Promise<unknown | null> {
  const meta = (await loadIndex()).get(String(convId))
  if (!meta) return null
  await enqueue(async () => {})
  try {
    return JSON.parse(await fs.readFile(messagesFile(meta), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 记录接续/迁移：hostIds 按时间线追加（相邻去重——A→B→A 记 [A,B,A]，
 * 末项即"最后绑定主机"，迁移判定靠它；相同主机连续接续不重复记）。
 * 接续所用的 profile/model 一并改记：替身 profile 接续后，下次再接续
 * 要找的是替身，原 id 已不存在。
 */
export function recordConversationResume(
  convId: string,
  hostId: string | undefined,
  binding: { profileId: string; model: string }
): void {
  void enqueue(async () => {
    const meta = (await loadIndex()).get(convId)
    if (!meta) return
    if (hostId && meta.hostIds[meta.hostIds.length - 1] !== hostId) meta.hostIds.push(hostId)
    meta.profileId = binding.profileId
    meta.model = binding.model
    meta.updatedAt = Date.now()
    await writeIndex()
  })
}

/** LLM 自动标题：只在标题仍是降级值时应用——手改（manual）永不被覆盖 */
export function applyLlmTitle(convId: string, title: string): void {
  void enqueue(async () => {
    const meta = (await loadIndex()).get(convId)
    if (!meta || meta.titleSource !== 'fallback') return
    meta.title = title
    meta.titleSource = 'llm'
    await writeIndex()
  })
}

// ---------- 保留策略 ----------

async function removeFiles(meta: ConversationMeta): Promise<void> {
  await fs.rm(messagesFile(meta), { force: true })
  await fs.rm(eventsFile(meta), { force: true })
  // 日期目录空了就顺手收走（失败无所谓，下一次清理再试）
  await fs.rmdir(convDir(meta)).catch(() => {})
}

/**
 * 条数/天数上限（2.5"别让 userData 无声长到几百 MB"）：
 * 超龄按创建时间删，超量按更新时间保新删旧；活动对话永不自动清。
 */
async function enforceRetention(): Promise<void> {
  await enqueue(async () => {
    const map = await loadIndex()
    const active = activeConvIdsProvider()
    const doomed: ConversationMeta[] = []
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600_000
    const survivors: ConversationMeta[] = []
    for (const meta of map.values()) {
      if (active.has(meta.convId)) {
        survivors.push(meta)
      } else if (meta.createdAt < cutoff) {
        doomed.push(meta)
      } else {
        survivors.push(meta)
      }
    }
    if (survivors.length > MAX_CONVERSATIONS) {
      const removable = survivors
        .filter((m) => !active.has(m.convId))
        .sort((a, b) => a.updatedAt - b.updatedAt)
      const excess = survivors.length - MAX_CONVERSATIONS
      doomed.push(...removable.slice(0, excess))
    }
    if (doomed.length === 0) return
    for (const meta of doomed) {
      map.delete(meta.convId)
      await removeFiles(meta)
    }
    await writeIndex()
  })
}

// ---------- IPC ----------

function listSorted(map: Map<string, ConversationMeta>): ConversationMeta[] {
  // active 是运行时注入的浅拷贝字段：绝不能写回 map 里的原对象（会随索引落盘）
  const active = activeConvIdsProvider()
  return [...map.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => ({ ...m, active: active.has(m.convId) }))
}

/** 回溯渲染与经验补录提炼（v0.10.3 experience.ts 的草稿原料）共用的事件流读取 */
export async function readConversationEvents(convId: string): Promise<AgentEvent[] | null> {
  const meta = (await loadIndex()).get(String(convId))
  if (!meta) return null
  // 先排空写队列：活动对话的最后一批事件可能还在队列里
  await enqueue(async () => {})
  let content: string
  try {
    content = await fs.readFile(eventsFile(meta), 'utf-8')
  } catch {
    return []
  }
  const events: AgentEvent[] = []
  for (const line of content.split('\n')) {
    if (!line.trim() || line.length > EVENT_LINE_LIMIT) continue
    try {
      events.push(JSON.parse(line) as AgentEvent)
    } catch {
      // 跳过损坏行
    }
  }
  return events
}

export function registerConversationHandlers(): void {
  // 启动即执行一次保留策略（活动对话为空，放心清）
  void enforceRetention()

  ipcMain.handle('conversations:list', async () => listSorted(await loadIndex()))

  ipcMain.handle('conversations:events', (_event, convId: string) =>
    readConversationEvents(String(convId))
  )

  ipcMain.handle('conversations:rename', async (_event, convId: string, title: string) => {
    const map = await loadIndex()
    const meta = map.get(String(convId))
    const trimmed = String(title ?? '').trim().slice(0, 60)
    if (meta && trimmed) {
      meta.title = trimmed
      meta.titleSource = 'manual' satisfies ConversationTitleSource
      await enqueue(() => writeIndex())
    }
    return listSorted(map)
  })

  ipcMain.handle('conversations:remove', async (_event, convId: string) => {
    const map = await loadIndex()
    const meta = map.get(String(convId))
    // 活动对话拒删：它的 loop 还会继续追加事件，删了就是孤儿复活
    if (meta && !activeConvIdsProvider().has(meta.convId)) {
      map.delete(meta.convId)
      await enqueue(async () => {
        await removeFiles(meta)
        await writeIndex()
      })
    }
    return listSorted(map)
  })

  ipcMain.handle('conversations:clear', async () => {
    const map = await loadIndex()
    const active = activeConvIdsProvider()
    const doomed = [...map.values()].filter((m) => !active.has(m.convId))
    for (const meta of doomed) map.delete(meta.convId)
    await enqueue(async () => {
      for (const meta of doomed) await removeFiles(meta)
      await writeIndex()
    })
    return listSorted(map)
  })

  ipcMain.handle(
    'conversations:export-md',
    async (_event, convId: string, markdown: string): Promise<ConversationExportResult> => {
      const meta = (await loadIndex()).get(String(convId))
      if (!meta) return { ok: false, error: '对话不存在' }
      const body = String(markdown ?? '')
      // 文件名取标题（过滤路径保留字符），落点由用户选
      const fileName = `${meta.title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60) || 'conversation'}.md`
      // e2e 对话框 mock：TSUBASATERMINAL_E2E_EXPORT_DIR（CANCEL=取消），与 transfer.ts 同款
      const mockDir = process.env['TSUBASATERMINAL_E2E_EXPORT_DIR']
      let target: string | undefined
      if (mockDir !== undefined) {
        target = mockDir === 'CANCEL' ? undefined : join(mockDir, fileName)
      } else {
        const result = await dialog.showSaveDialog({
          defaultPath: fileName,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
        target = result.canceled ? undefined : result.filePath
      }
      if (!target) return { ok: false, canceled: true }
      try {
        await fs.writeFile(target, body, 'utf-8')
        return { ok: true, savedTo: target }
      } catch (err) {
        return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) }
      }
    }
  )
}
