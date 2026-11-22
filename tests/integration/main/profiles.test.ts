import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: any[]) => any

const profileState = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, IpcHandler>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => profileState.userDataDir },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => profileState.handlers.set(channel, handler)
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

let userDataDir: string

beforeEach(() => {
  vi.resetModules()
  profileState.handlers.clear()
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-profiles-test-'))
  profileState.userDataDir = userDataDir
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

function plainKey(value: string): string {
  return `plain:${Buffer.from(value, 'utf-8').toString('base64')}`
}

describe('LLM profile persistence without Electron', () => {
  it.each([
    [{ enabled: true, budgetTokens: 8192 }, 'high'],
    [{ enabled: false }, 'inherit'],
    ['xhigh', 'xhigh'],
    ['unknown', undefined]
  ])('normalizes legacy thinking value %o to %s', async (thinking, expected) => {
    writeFileSync(
      join(userDataDir, 'llm-profiles.json'),
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          provider: 'anthropic',
          model: 'model-a',
          thinking,
          apiKeyEnc: plainKey('sk-test')
        }
      ])
    )
    const { getProfileForUse } = await import('../../../src/main/llm/profiles')

    expect(await getProfileForUse('legacy')).toMatchObject({
      id: 'legacy',
      thinking: expected,
      apiKey: 'sk-test'
    })
  })

  it('keeps an existing key when the edit form submits an empty key', async () => {
    writeFileSync(
      join(userDataDir, 'llm-profiles.json'),
      JSON.stringify([
        {
          id: 'profile-a',
          name: 'Before',
          provider: 'anthropic',
          model: 'model-a',
          apiKeyEnc: plainKey('sk-existing')
        }
      ])
    )
    const profiles = await import('../../../src/main/llm/profiles')
    profiles.registerLlmProfileHandlers()
    const save = profileState.handlers.get('llm:save-profile')
    if (!save) throw new Error('missing llm:save-profile handler')

    const visible = await save(undefined, {
      id: 'profile-a',
      name: 'After',
      provider: 'anthropic',
      model: 'model-b',
      thinking: 'medium',
      apiKey: ''
    })

    expect(visible).toEqual([
      expect.objectContaining({ id: 'profile-a', name: 'After', hasKey: true })
    ])
    expect(await profiles.getProfileForUse('profile-a')).toMatchObject({
      name: 'After',
      model: 'model-b',
      apiKey: 'sk-existing'
    })
  })

  it('finds a usable substitute only by protocol, wire format and exact model', async () => {
    writeFileSync(
      join(userDataDir, 'llm-profiles.json'),
      JSON.stringify([
        // 同模型但无 key：不可用，跳过
        { id: 'no-key', name: 'NoKey', provider: 'anthropic', model: 'model-a' },
        // 同模型不同协议：原生消息不可跨协议
        {
          id: 'openai-a',
          name: 'OpenAI A',
          provider: 'openai-compatible',
          wireFormat: 'chat.completions',
          model: 'model-a',
          apiKeyEnc: plainKey('sk-o')
        },
        { id: 'other-model', name: 'Other', provider: 'anthropic', model: 'model-b', apiKeyEnc: plainKey('sk-b') },
        { id: 'match', name: 'Match', provider: 'anthropic', model: 'model-a', apiKeyEnc: plainKey('sk-m') },
        {
          id: 'responses-a',
          name: 'Responses A',
          provider: 'openai-compatible',
          wireFormat: 'responses',
          model: 'model-r',
          apiKeyEnc: plainKey('sk-r')
        }
      ])
    )
    const { findProfileForModel } = await import('../../../src/main/llm/profiles')

    expect(await findProfileForModel({ provider: 'anthropic', model: 'model-a' })).toMatchObject({
      id: 'match',
      apiKey: 'sk-m'
    })
    // 缺省 wireFormat 按 chat.completions 比
    expect(
      await findProfileForModel({ provider: 'openai-compatible', model: 'model-a' })
    ).toMatchObject({ id: 'openai-a' })
    expect(
      await findProfileForModel({
        provider: 'openai-compatible',
        wireFormat: 'chat.completions',
        model: 'model-r'
      })
    ).toBeNull()
    expect(await findProfileForModel({ provider: 'anthropic', model: 'model-x' })).toBeNull()
    expect(await findProfileForModel({ provider: 'anthropic', model: '' })).toBeNull()
  })
})
