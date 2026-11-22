import { mkdtempSync, writeFileSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostConfig, HostInput } from '../../../src/shared/types'

/** 本机输入方式的主进程落盘与白名单：经真实 hosts IPC handler 与 hosts.json */

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
vi.mock('../../../src/main/llm/experience', () => ({ removeExperienceForHost: vi.fn() }))

let userDataDir: string

beforeEach(async () => {
  vi.resetModules()
  electronState.handlers.clear()
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-host-input-'))
  electronState.userDataDir = userDataDir
  const { registerHostHandlers } = await import('../../../src/main/hosts')
  registerHostHandlers()
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

function handler(channel: string): IpcHandler {
  const h = electronState.handlers.get(channel)
  if (!h) throw new Error(`${channel} handler was not registered`)
  return h
}

const BASE: HostInput = {
  name: 'web-1',
  host: '10.0.0.1',
  port: 22,
  username: 'ops',
  authType: 'password'
}

async function stored(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(userDataDir, 'hosts.json'), 'utf-8'))
}

describe('hosts IPC：本机输入方式', () => {
  it('新建与编辑都落盘，改回跟随全局时字段从文件里消失', async () => {
    const added = (await handler('hosts:add')({}, { ...BASE, inputMode: 'native' })) as HostConfig[]
    expect(added[0].inputMode).toBe('native')
    expect((await stored())[0].inputMode).toBe('native')

    const id = added[0].id
    const switched = (await handler('hosts:update')({}, { ...BASE, id, inputMode: 'composer' })) as HostConfig[]
    expect(switched[0].inputMode).toBe('composer')

    const followed = (await handler('hosts:update')({}, { ...BASE, id })) as HostConfig[]
    expect(followed[0].inputMode).toBeUndefined()
    expect(await readFile(join(userDataDir, 'hosts.json'), 'utf-8')).not.toContain('inputMode')
  })

  it('白名单外的值按跟随全局处理：写入挡、读出（手改文件）也挡', async () => {
    const added = (await handler('hosts:add')({}, { ...BASE, inputMode: 'raw' as never })) as HostConfig[]
    expect(added[0].inputMode).toBeUndefined()

    writeFileSync(
      join(userDataDir, 'hosts.json'),
      JSON.stringify([{ ...BASE, id: 'hand-edited', inputMode: 'NATIVE' }])
    )
    const listed = (await handler('hosts:list')({})) as HostConfig[]
    expect(listed[0].inputMode).toBeUndefined()
  })
})
