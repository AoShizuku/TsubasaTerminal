import { mkdtempSync } from 'fs'
import { readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../src/shared/types'

type IpcHandler = (...args: any[]) => any

const electronState = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, IpcHandler>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userDataDir },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => electronState.handlers.set(channel, handler)
  }
}))

let userDataDir: string

beforeEach(() => {
  vi.resetModules()
  electronState.handlers.clear()
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-conversations-test-'))
  electronState.userDataDir = userDataDir
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

async function loadStorage() {
  return await import('../../../src/main/llm/conversations')
}

function handler(channel: string): IpcHandler {
  const found = electronState.handlers.get(channel)
  if (!found) throw new Error(`missing IPC handler: ${channel}`)
  return found
}

describe('conversation persistence without Electron', () => {
  it('persists provider snapshots and ordered render events, skipping corrupt event lines', async () => {
    const storage = await loadStorage()
    const meta = await storage.createConversation({
      profileId: 'profile-a',
      hostIds: ['host-a'],
      title: '初始标题'
    })
    const events: AgentEvent[] = [
      { kind: 'user', text: '检查磁盘', attachedUnits: [] },
      { kind: 'thinking', text: '先看容量' },
      { kind: 'tool-start', toolUseId: 'tool-1', name: 'exec', detail: 'df -h' },
      { kind: 'tool-end', toolUseId: 'tool-1', status: 'executed', summary: '退出 0' }
    ]
    const snapshot = {
      provider: 'anthropic',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', signature: 'sig-1' }] }]
    }

    storage.appendConversationEvents(meta.convId, events)
    await storage.persistConversationTurn(meta.convId, snapshot, 1)

    expect(await storage.readConversationSnapshot(meta.convId)).toEqual(snapshot)
    expect(await storage.readConversationEvents(meta.convId)).toEqual(events)

    const eventFile = join(
      userDataDir,
      'conversations',
      meta.dateDir,
      `${meta.convId}.events.jsonl`
    )
    await writeFile(eventFile, `${await readFile(eventFile, 'utf-8')}not-json\n`, 'utf-8')
    expect(await storage.readConversationEvents(meta.convId)).toEqual(events)

    expect(storage.getConversationMeta(meta.convId)).toEqual(
      expect.objectContaining({ convId: meta.convId, turnCount: 1, bytes: expect.any(Number) })
    )
  })

  it('keeps a manual title, protects active conversations, then removes both files when inactive', async () => {
    const storage = await loadStorage()
    const meta = await storage.createConversation({
      profileId: 'profile-a',
      hostIds: ['host-a'],
      title: '降级标题'
    })
    storage.appendConversationEvents(meta.convId, [
      { kind: 'user', text: 'hello', attachedUnits: [] }
    ])
    await storage.persistConversationTurn(meta.convId, { messages: [] }, 1)
    storage.registerConversationHandlers()

    storage.setActiveConvIdsProvider(() => new Set([meta.convId]))
    await handler('conversations:rename')(undefined, meta.convId, '  人工标题  ')
    storage.applyLlmTitle(meta.convId, '不应覆盖')
    await storage.readConversationSnapshot(meta.convId)

    let list = await handler('conversations:list')()
    expect(list[0]).toMatchObject({ title: '人工标题', titleSource: 'manual', active: true })

    list = await handler('conversations:remove')(undefined, meta.convId)
    expect(list).toHaveLength(1)

    storage.setActiveConvIdsProvider(() => new Set())
    list = await handler('conversations:remove')(undefined, meta.convId)
    expect(list).toEqual([])
    expect(await storage.readConversationSnapshot(meta.convId)).toBeNull()
    expect(await storage.readConversationEvents(meta.convId)).toBeNull()
  })

  it('records the host timeline with adjacent deduplication across resume and migration', async () => {
    const storage = await loadStorage()
    const meta = await storage.createConversation({
      profileId: 'profile-a',
      hostIds: ['host-a'],
      title: '迁移测试'
    })
    const binding = { profileId: 'profile-a', model: 'model-a' }

    storage.recordConversationResume(meta.convId, 'host-a', binding)
    storage.recordConversationResume(meta.convId, 'host-b', binding)
    storage.recordConversationResume(meta.convId, 'host-b', binding)
    storage.recordConversationResume(meta.convId, 'host-a', binding)
    await storage.readConversationEvents(meta.convId)

    expect(storage.getConversationMeta(meta.convId)?.hostIds).toEqual([
      'host-a',
      'host-b',
      'host-a'
    ])
  })

  it('records the model at creation and rebinds profile/model on resume, persisted to the index', async () => {
    const storage = await loadStorage()
    const meta = await storage.createConversation({
      profileId: 'profile-a',
      model: 'model-a',
      hostIds: ['host-a'],
      title: '模型绑定'
    })
    expect(meta).toMatchObject({ profileId: 'profile-a', model: 'model-a' })

    // 原 profile 删除后用替身接续：下次接续要找的是替身
    storage.recordConversationResume(meta.convId, 'host-a', {
      profileId: 'profile-b',
      model: 'model-a'
    })
    await storage.readConversationEvents(meta.convId)

    const index = await readFile(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
    expect(JSON.parse(index.trim())).toMatchObject({
      convId: meta.convId,
      profileId: 'profile-b',
      model: 'model-a'
    })
  })
})
