// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 模型按会话绑定：选择器不再是全局一份。痛点是同主机多 tab 用不同价位的
 * 模型，切 tab 时选择器停在别处选的模型——拿高价模型开新对话、或拿低价模型"接"
 * 高价对话（实际是主进程静默开了个没上下文的新对话）。主进程的硬拒由 e2e 经真实
 * IPC 守，这里守渲染层状态：各会话各持选择、对话绑定后发送只用绑定的 profile、
 * 恢复只动本会话。
 */

const api = {
  settings: {
    get: vi.fn(async () => ({ activeLlmProfileId: 'a' })),
    set: vi.fn(async () => ({}))
  },
  llm: {
    profiles: vi.fn(async () => [
      { id: 'a', name: 'Opus', provider: 'anthropic', model: 'model-a', hasKey: true },
      { id: 'b', name: 'Haiku', provider: 'anthropic', model: 'model-b', hasKey: true },
      { id: 'c', name: 'Sonnet', provider: 'anthropic', model: 'model-c', hasKey: true }
    ])
  },
  agent: {
    send: vi.fn(async (): Promise<{ ok: boolean; error?: string; boundProfileId?: string }> => ({
      ok: true
    })),
    newConversation: vi.fn(async () => ({ ok: true })),
    resumeConversation: vi.fn(
      async (): Promise<Record<string, unknown>> => ({ ok: true, profileId: 'c', migrated: false })
    )
  },
  conversations: {
    events: vi.fn(async () => []),
    list: vi.fn(async () => [])
  }
}

beforeEach(() => {
  vi.resetModules()
  ;(window as unknown as { api: typeof api }).api = api
})

async function loadStores() {
  const agent = await import('@/composables/useAgentStore')
  const conv = await import('@/composables/useConversationStore')
  await agent.loadLlmProfiles()
  return { agent, conv }
}

const META = {
  convId: 'conv-1',
  title: 't',
  titleSource: 'fallback' as const,
  createdAt: 0,
  updatedAt: 0,
  dateDir: '20261020',
  hostIds: ['h'],
  profileId: 'c',
  turnCount: 1,
  bytes: 0
}

describe('per-session model binding', () => {
  it('keeps each session on its own choice; a new session follows the last choice', async () => {
    const { agent } = await loadStores()
    agent.agentState('s1')
    agent.agentState('s2')

    await agent.selectSessionProfile('s2', 'b')

    expect(agent.sessionProfileId('s1')).toBe('a')
    expect(agent.sessionProfileId('s2')).toBe('b')
    expect(api.settings.set).toHaveBeenLastCalledWith({ activeLlmProfileId: 'b' })
    // 新开的会话默认跟随最后一次选择
    expect(agent.sessionProfileId('s3')).toBe('b')
  })

  it('sends with the bound profile even after another tab changes the last choice', async () => {
    const { agent } = await loadStores()
    await agent.sendToAgent('s1', 'hello', 'h')
    expect(api.agent.send).toHaveBeenLastCalledWith('s1', 'hello', expect.objectContaining({ profileId: 'a' }))
    expect(agent.agentState('s1').boundProfileId).toBe('a')

    await agent.selectSessionProfile('s2', 'b')
    await agent.sendToAgent('s1', 'again', 'h')
    expect(api.agent.send).toHaveBeenLastCalledWith('s1', 'again', expect.objectContaining({ profileId: 'a' }))
  })

  it('syncs the lock from the main process when a send is rejected as a model switch', async () => {
    const { agent } = await loadStores()
    api.agent.send.mockResolvedValueOnce({ ok: false, error: '换模型需先新建对话', boundProfileId: 'c' })

    const result = await agent.sendToAgent('s1', 'hello', 'h')

    expect(result.ok).toBe(false)
    expect(agent.agentState('s1').boundProfileId).toBe('c')
    expect(agent.sessionProfileId('s1')).toBe('c')
  })

  it('unlocks the model on new conversation but keeps the session choice', async () => {
    const { agent } = await loadStores()
    await agent.sendToAgent('s1', 'hello', 'h')
    const state = agent.agentState('s1')
    state.items.push({ kind: 'notice', text: 'x' })

    await agent.startNewConversation('s1')

    expect(state.boundProfileId).toBeNull()
    expect(state.items).toEqual([])
    expect(agent.sessionProfileId('s1')).toBe('a')
  })

  it('resume locks only this session to the conversation profile, leaving the last choice alone', async () => {
    const { agent, conv } = await loadStores()
    agent.agentState('s2')

    const result = await conv.resumeConversation('s1', META, { hostLabel: 'h' })

    expect(result.ok).toBe(true)
    expect(agent.sessionProfileId('s1')).toBe('c')
    expect(agent.agentState('s1').boundProfileId).toBe('c')
    expect(agent.sessionProfileId('s2')).toBe('a')
    expect(agent.activeProfileId.value).toBe('a')
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it('passes a model-change confirmation through without binding', async () => {
    const { agent, conv } = await loadStores()
    const confirm = {
      profileId: 'c',
      profileName: 'Sonnet',
      fromModel: 'model-old',
      toModel: 'model-c',
      substitute: false
    }
    api.agent.resumeConversation.mockResolvedValueOnce({ ok: false, confirm })

    const result = await conv.resumeConversation('s1', META, { hostLabel: 'h' })

    expect(result).toEqual({ ok: false, error: undefined, confirm })
    expect(agent.agentState('s1').boundProfileId).toBeNull()
  })
})
