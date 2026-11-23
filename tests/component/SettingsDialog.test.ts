// @vitest-environment jsdom

import { nextTick } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BtnStub, DlgStub, SelStub, SwStub } from './stubs'

vi.mock('@/composables/useAgentStore', () => ({
  loadLlmProfiles: vi.fn(async () => undefined)
}))

vi.mock('@/components/ui/Sel.vue', () => ({ default: { name: 'Sel' } }))

vi.mock('@/lib/localFonts', () => ({
  detectMonospaceFonts: vi.fn(async () => [])
}))

vi.mock('@/composables/useSettingsStore', async () => {
  const { ref } = await import('vue')
  const settings = ref({
    redactionEnabled: true,
    activeLlmProfileId: null,
    completionLlmEnabled: false,
    terminalTheme: 'tsubasaterminal',
    terminalFontFamily: '',
    terminalFontSize: 13,
    terminalCopyOnSelect: true,
    terminalConfirmMultilinePaste: true,
    terminalConfirmCloseBusy: true,
    terminalInputMode: 'composer',
    globalKnowledge: '',
    cliBridgeEnabled: false,
    cliSkillClaude: false,
    cliSkillCodex: false,
    uiDensity: 'standard',
    uiFontSize: 'standard'
  })

  return {
    useSettingsStore: () => ({ settings }),
    loadSettings: vi.fn(async () => settings.value),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
      settings.value = { ...settings.value, ...patch }
      return settings.value
    })
  }
})

vi.mock('@/composables/useUiStore', async () => {
  const { ref } = await import('vue')
  const settingsSection = ref('appearance')
  const settingsFocus = ref<string | null>(null)

  return {
    useUiStore: () => {
      settingsSection.value = 'appearance'
      settingsFocus.value = null
      return { settingsSection, settingsFocus }
    }
  }
})

import { updateSettings, useSettingsStore } from '@/composables/useSettingsStore'
import { detectMonospaceFonts } from '@/lib/localFonts'
import SettingsDialog from '../../src/renderer/src/components/SettingsDialog.vue'

enableAutoUnmount(afterEach)

const API = {
  settings: {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => ({}))
  },
  llm: {
    profiles: vi.fn(async () => []),
    saveProfile: vi.fn(async () => []),
    deleteProfile: vi.fn(async () => [])
  },
  cli: {
    status: vi.fn(async () => ({
      enabled: false,
      listening: false,
      cliScriptExists: true,
      pathManaged: false,
      onPath: false,
      pipeName: 'test-pipe',
      skills: []
    })),
    setBridge: vi.fn(),
    setSkill: vi.fn()
  },
  audit: { reveal: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: API
  })
})

describe('SettingsDialog density', () => {
  it('marks the stored level and saves the clicked one through updateSettings', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: true },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    const level = (value: string) => wrapper.get(`[data-testid="settings-density-${value}"]`)

    expect(level('standard').attributes('aria-checked')).toBe('true')
    expect(level('standard').classes()).toContain('is-active')
    expect(level('compact').attributes('aria-checked')).toBe('false')

    await level('cozy').trigger('click')
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ uiDensity: 'cozy' })
    expect(level('cozy').classes()).toContain('is-active')
    expect(level('standard').classes()).not.toContain('is-active')

    await level('standard').trigger('click')
    await flushPromises()
  })
})

describe('SettingsDialog UI font size', () => {
  it('marks the stored level and saves the clicked one through updateSettings', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: true },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    const level = (value: string) => wrapper.get(`[data-testid="settings-ui-font-size-${value}"]`)

    expect(level('standard').attributes('aria-checked')).toBe('true')
    expect(level('large').attributes('aria-checked')).toBe('false')

    await level('larger').trigger('click')
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ uiFontSize: 'larger' })
    expect(level('larger').classes()).toContain('is-active')
    expect(level('standard').classes()).not.toContain('is-active')

    await level('standard').trigger('click')
    await flushPromises()
  })
})

describe('SettingsDialog terminal font', () => {
  const { settings } = useSettingsStore()
  const setFontFamily = (terminalFontFamily: string): void => {
    settings.value = { ...settings.value!, terminalFontFamily }
  }
  afterEach(() => setFontFamily(''))

  const fontOptions = (wrapper: ReturnType<typeof mount>) =>
    wrapper
      .findAll('[data-testid="settings-font"] option')
      .map((o) => [o.attributes('value'), o.text()])

  it('lists detected fonts by their real names and saves the picked one', async () => {
    vi.mocked(detectMonospaceFonts).mockResolvedValueOnce(['Consolas', 'Maple Mono Normal NL NF CN'])
    const wrapper = mount(SettingsDialog, {
      props: { open: false },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    await wrapper.setProps({ open: true })
    await flushPromises()

    expect(fontOptions(wrapper)).toEqual([
      ['', '默认'],
      ['Consolas', 'Consolas'],
      ['Maple Mono Normal NL NF CN', 'Maple Mono Normal NL NF CN']
    ])
    await wrapper.get('[data-testid="settings-font"]').setValue('Maple Mono Normal NL NF CN')
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontFamily: 'Maple Mono Normal NL NF CN' })
  })

  it('keeps a saved but missing font selectable and marks it as not installed', async () => {
    // 旧下拉框把写死的候选名当"已安装"，用户可能存下了本机根本没有的名字
    setFontFamily('Maple Mono NF CN')
    let resolve!: (fonts: string[]) => void
    vi.mocked(detectMonospaceFonts).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const wrapper = mount(SettingsDialog, {
      props: { open: false },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    await wrapper.setProps({ open: true })
    await flushPromises()

    // 探测完成前不下结论
    expect(fontOptions(wrapper)).toContainEqual(['Maple Mono NF CN', 'Maple Mono NF CN'])

    resolve(['Consolas'])
    await flushPromises()
    expect(fontOptions(wrapper)).toEqual([
      ['', '默认'],
      ['Maple Mono NF CN', 'Maple Mono NF CN（未安装）'],
      ['Consolas', 'Consolas']
    ])
  })
})

describe('SettingsDialog section navigation', () => {
  it('defaults to appearance and mounts only the selected one of all six sections', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: true },
      global: {
        stubs: {
          Dlg: DlgStub,
          Sel: SelStub,
          Sw: SwStub,
          Btn: BtnStub
        }
      }
    })

    const nav = (section: string) => wrapper.get(`[data-testid="settings-nav-${section}"]`)
    const markers = {
      appearance: 'settings-theme',
      knowledge: 'settings-global-knowledge',
      models: 'llm-add-profile',
      security: 'settings-redaction-toggle',
      cli: 'settings-cli-section'
    } as const

    const expectOnly = (section: keyof typeof markers): void => {
      for (const [key, testId] of Object.entries(markers)) {
        expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(key === section)
      }
    }

    expect(nav('appearance').classes()).toContain('is-active')
    expectOnly('appearance')

    for (const section of ['knowledge', 'models', 'security', 'cli'] as const) {
      await nav(section).trigger('click')
      await nextTick()
      expect(nav(section).classes()).toContain('is-active')
      expect(nav('appearance').classes()).not.toContain('is-active')
      expectOnly(section)
    }

    await nav('about').trigger('click')
    await nextTick()

    expect(nav('about').classes()).toContain('is-active')
    for (const testId of Object.values(markers)) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(false)
    }
    expect(wrapper.get('.set-body h3').text()).toBe('关于')
    expect(wrapper.text()).toMatch(/Tsubasa Terminal · v\d+\.\d+\.\d+/)
  })
})

describe('SettingsDialog copy & paste group', () => {
  it('toggles multiline paste confirmation through updateSettings and reflects the stored value', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: true },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    const sw = () =>
      wrapper.get<HTMLInputElement>('[data-testid="settings-confirm-multiline-paste"]')

    // 默认开：老用户升级后行为不变
    expect(sw().element.checked).toBe(true)

    await sw().setValue(false)
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalConfirmMultilinePaste: false })
    expect(sw().element.checked).toBe(false)

    await sw().setValue(true)
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalConfirmMultilinePaste: true })
    expect(sw().element.checked).toBe(true)
  })
})

describe('SettingsDialog session group', () => {
  it('toggles busy-close confirmation through updateSettings and reflects the stored value', async () => {
    const wrapper = mount(SettingsDialog, {
      props: { open: true },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    const sw = () => wrapper.get<HTMLInputElement>('[data-testid="settings-confirm-close-busy"]')

    // 默认开
    expect(sw().element.checked).toBe(true)

    await sw().setValue(false)
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalConfirmCloseBusy: false })
    expect(sw().element.checked).toBe(false)

    await sw().setValue(true)
    await flushPromises()
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalConfirmCloseBusy: true })
    expect(sw().element.checked).toBe(true)
  })
})

describe('SettingsDialog CLI skill rows', () => {
  it('shows the Codex install dir and a warning when the legacy ~/.codex dir was kept (v0.13.17)', async () => {
    const skill = (target: 'claude' | 'codex', dir: string, legacyDir: string | null) => ({
      target,
      hostPresent: true,
      state: 'installed',
      installedVersion: '0.13.17',
      dir,
      legacyDir
    })
    API.cli.status.mockResolvedValueOnce({
      enabled: true,
      listening: true,
      cliScriptExists: true,
      pathManaged: false,
      onPath: false,
      pipeName: 'test-pipe',
      skills: [
        skill('claude', 'C:/home/.claude/skills/tsubasa-ssh', null),
        skill('codex', 'C:/home/.agents/skills/tsubasa-ssh', 'C:/home/.codex/skills/tsubasa-ssh')
      ]
    } as never)
    const wrapper = mount(SettingsDialog, {
      props: { open: false },
      global: { stubs: { Dlg: DlgStub, Sel: SelStub, Sw: SwStub, Btn: BtnStub } }
    })
    // 状态在弹窗打开时现探
    await wrapper.setProps({ open: true })
    await flushPromises()
    await wrapper.get('[data-testid="settings-nav-cli"]').trigger('click')
    await nextTick()

    expect(wrapper.text()).toContain('C:/home/.agents/skills/tsubasa-ssh')
    expect(wrapper.find('[data-testid="settings-cli-skill-legacy-claude"]').exists()).toBe(false)
    const legacy = wrapper.get('[data-testid="settings-cli-skill-legacy-codex"]')
    expect(legacy.classes()).toContain('is-warn')
    expect(legacy.text()).toContain('C:/home/.codex/skills/tsubasa-ssh')
    expect(legacy.text()).toContain('已原样保留')
  })
})
