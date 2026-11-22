import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXPERIENCE_DETAIL_LIMIT,
  EXPERIENCE_HOST_INJECT_LIMIT,
  type ExperienceMeta
} from '../../../src/shared/types'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const electronState = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, IpcHandler>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userDataDir },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronState.handlers.set(channel, handler)
    })
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8')
  }
}))
vi.mock('../../../src/main/settings', () => ({
  getSettingsSync: () => ({ activeLlmProfileId: undefined })
}))
vi.mock('../../../src/main/llm/profiles', () => ({ getProfileForUse: vi.fn() }))
vi.mock('../../../src/main/llm/providers', () => ({ oneShotText: vi.fn() }))
vi.mock('../../../src/main/llm/conversations', () => ({ readConversationEvents: vi.fn() }))

let userDataDir: string

beforeEach(() => {
  vi.resetModules()
  electronState.handlers.clear()
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-experience-test-'))
  electronState.userDataDir = userDataDir
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('experience persistence without Electron', () => {
  it('saves, reads and updates an entry without losing identity or governance fields', async () => {
    const storage = await import('../../../src/main/llm/experience')
    const saved = await storage.saveExperience({
      scope: 'host',
      hostId: 'host-a',
      summary: '磁盘满 → core dump 堆积',
      detail: '## 真因\n旧正文',
      sourceConvId: 'conv-a'
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error(saved.reason)

    const first = await storage.readExperienceForAgent(saved.meta.id, 'host-a')
    expect(first?.detail).toContain('旧正文')
    expect(first?.meta.readCount).toBe(1)
    expect(await storage.readExperienceForAgent(saved.meta.id, 'host-b')).toBeNull()

    const updated = await storage.updateExperience({
      id: saved.meta.id,
      scope: 'host',
      summary: '磁盘满 → 日志目录堆积',
      detail: '## 真因\n新正文'
    })
    expect(updated).toEqual({ ok: true })

    const injection = await storage.selectExperienceInjection('host-a')
    expect(injection.host[0]).toMatchObject({
      id: saved.meta.id,
      hostId: 'host-a',
      createdAt: saved.meta.createdAt,
      sourceConvId: 'conv-a',
      readCount: 1,
      summary: '磁盘满 → 日志目录堆积'
    })
    expect(await readFile(join(userDataDir, 'experience', `${saved.meta.id}.md`), 'utf-8')).toContain(
      '新正文'
    )
  })

  it('injects pinned entries first, then newest entries, and reports omissions', async () => {
    const root = join(userDataDir, 'experience')
    mkdirSync(root, { recursive: true })
    const rows: ExperienceMeta[] = Array.from({ length: EXPERIENCE_HOST_INJECT_LIMIT + 3 }, (_, i) => ({
      id: `host${String(i).padStart(4, '0')}`,
      scope: 'host',
      hostId: 'host-a',
      summary: `经验 ${i}`,
      pinned: i < 2,
      createdAt: i,
      lastReadAt: null,
      readCount: 0,
      bytes: 1
    }))
    rows.push({
      id: 'global01',
      scope: 'global',
      summary: '全局经验',
      pinned: false,
      createdAt: 999,
      lastReadAt: null,
      readCount: 0,
      bytes: 1
    })
    writeFileSync(join(root, 'index.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

    const storage = await import('../../../src/main/llm/experience')
    const injection = await storage.selectExperienceInjection('host-a')

    expect(injection.host).toHaveLength(EXPERIENCE_HOST_INJECT_LIMIT)
    expect(injection.host.slice(0, 2).map((item) => item.id)).toEqual(['host0001', 'host0000'])
    expect(injection.host.map((item) => item.id)).toContain('host0022')
    expect(injection.host.map((item) => item.id)).not.toContain('host0002')
    expect(injection.omittedHost).toBe(3)
    expect(injection.global.map((item) => item.id)).toEqual(['global01'])
  })

  it('wires hosts:remove to the experience cascade while preserving global entries', async () => {
    const storage = await import('../../../src/main/llm/experience')
    const owned = await storage.saveExperience({
      scope: 'host',
      hostId: 'host-a',
      summary: '本机问题 → 本机结论',
      detail: 'owned body'
    })
    const global = await storage.saveExperience({
      scope: 'global',
      summary: '通用问题 → 通用结论',
      detail: 'global body'
    })
    expect(owned.ok && global.ok).toBe(true)
    if (!owned.ok || !global.ok) throw new Error('failed to seed experience')

    writeFileSync(
      join(userDataDir, 'hosts.json'),
      JSON.stringify([
        {
          id: 'host-a',
          name: '待删除',
          host: '127.0.0.1',
          port: 22,
          username: 'root',
          authType: 'password'
        },
        {
          id: 'host-b',
          name: '保留',
          host: '127.0.0.2',
          port: 22,
          username: 'ops',
          authType: 'password'
        }
      ])
    )
    const { registerHostHandlers } = await import('../../../src/main/hosts')
    registerHostHandlers()
    const removeHost = electronState.handlers.get('hosts:remove')
    if (!removeHost) throw new Error('hosts:remove handler was not registered')

    const remaining = (await removeHost({}, 'host-a')) as Array<{ id: string }>

    expect(remaining.map((host) => host.id)).toEqual(['host-b'])
    expect(await readFile(join(userDataDir, 'hosts.json'), 'utf-8')).not.toContain('host-a')
    expect((await storage.selectExperienceInjection('host-a')).host).toEqual([])
    expect((await storage.selectExperienceInjection('host-a')).global[0].id).toBe(global.meta.id)
    await expect(
      readFile(join(userDataDir, 'experience', `${owned.meta.id}.md`), 'utf-8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await readFile(join(userDataDir, 'experience', `${global.meta.id}.md`), 'utf-8')
    ).toBe('global body')
  })

  it('returns IPC rejection receipts without touching either the index or body', async () => {
    const storage = await import('../../../src/main/llm/experience')
    storage.registerExperienceHandlers()
    const update = electronState.handlers.get('experience:update')
    if (!update) throw new Error('experience:update handler was not registered')
    const saved = await storage.saveExperience({
      scope: 'global',
      summary: '旧症状 → 旧结论',
      detail: 'old body'
    })
    if (!saved.ok) throw new Error(saved.reason)
    const indexPath = join(userDataDir, 'experience', 'index.jsonl')
    const beforeIndex = await readFile(indexPath, 'utf-8')

    expect(
      await update({}, {
        id: saved.meta.id,
        scope: 'global',
        summary: '仍有摘要',
        detail: ''
      })
    ).toMatchObject({
      ok: false,
      reason: 'detail 不能为空',
      list: [expect.objectContaining({ id: saved.meta.id, summary: '旧症状 → 旧结论' })]
    })

    const tooLong = await update({}, {
      id: saved.meta.id,
      scope: 'global',
      summary: '超长正文不应落盘',
      detail: 'x'.repeat(EXPERIENCE_DETAIL_LIMIT + 1)
    })
    expect(tooLong).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`detail 超长（${EXPERIENCE_DETAIL_LIMIT + 1}`),
      list: [expect.objectContaining({ id: saved.meta.id, summary: '旧症状 → 旧结论' })]
    })

    expect(
      await update({}, {
        id: 'missing-experience',
        scope: 'global',
        summary: '不存在的条目',
        detail: '正文'
      })
    ).toMatchObject({
      ok: false,
      reason: '该经验已不存在（可能刚被删除）',
      list: [expect.objectContaining({ id: saved.meta.id, summary: '旧症状 → 旧结论' })]
    })

    expect(await readFile(indexPath, 'utf-8')).toBe(beforeIndex)
    expect(
      await readFile(join(userDataDir, 'experience', `${saved.meta.id}.md`), 'utf-8')
    ).toBe('old body')
  })
})
