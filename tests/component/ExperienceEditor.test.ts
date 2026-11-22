// @vitest-environment jsdom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DlgStub, SelStub } from './stubs'
import ExperienceEditor from '@/components/ExperienceEditor.vue'
import {
  experienceEditor,
  experienceList,
  experienceNote,
  openExperienceEdit
} from '@/composables/useExperienceStore'
import { confirmRequest, settleConfirm } from '@/lib/confirm'
import type { Api, ExperienceMeta } from '@shared/types'

vi.mock('@/components/ui/Sel.vue', () => ({ default: { name: 'Sel' } }))

const META: ExperienceMeta = {
  id: 'expedit1',
  scope: 'host',
  hostId: 'host-a',
  summary: '磁盘满 → core dump 堆积',
  pinned: true,
  createdAt: 1_700_000_000_000,
  lastReadAt: null,
  readCount: 3,
  sourceConvId: 'conv-old',
  bytes: 32
}

const ORIGINAL_DETAIL = '## 症状\n磁盘已满\n'

type ExperienceApi = Api['experience']

let api: ExperienceApi
let wrapper: VueWrapper | undefined

function makeApi(): ExperienceApi {
  return {
    list: vi.fn<ExperienceApi['list']>().mockResolvedValue([]),
    body: vi.fn<ExperienceApi['body']>().mockResolvedValue(ORIGINAL_DETAIL),
    save: vi.fn<ExperienceApi['save']>().mockResolvedValue({ ok: true, list: [] }),
    update: vi.fn<ExperienceApi['update']>().mockResolvedValue({ ok: true, list: [] }),
    setPinned: vi.fn<ExperienceApi['setPinned']>().mockResolvedValue([]),
    remove: vi.fn<ExperienceApi['remove']>().mockResolvedValue([]),
    draft: vi.fn<ExperienceApi['draft']>().mockResolvedValue({
      summary: '',
      detail: '',
      fallback: true
    })
  }
}

async function openEditor(): Promise<VueWrapper> {
  await openExperienceEdit(META, 'view-host')
  wrapper = mount(ExperienceEditor, {
    global: {
      stubs: {
        Dlg: DlgStub,
        Sel: SelStub
      }
    }
  })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  api = makeApi()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { experience: api } as unknown as Api
  })
  experienceList.value = []
  experienceNote.value = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  settleConfirm(false)
})

describe('ExperienceEditor', () => {
  it('shows an immediate local error for an empty body without calling the main process', async () => {
    const view = await openEditor()

    await view.get('[data-testid="agent-extract-detail"]').setValue('   \n')
    await view.get('[data-testid="agent-extract-save"]').trigger('click')
    await nextTick()

    expect(view.get('[data-testid="agent-extract-error"]').text()).toBe('正文不能为空')
    expect(api.update).not.toHaveBeenCalled()
    expect(experienceEditor.open).toBe(true)
    expect(view.find('[data-testid="agent-extract-panel"]').exists()).toBe(true)
  })

  it('shows the main-process rejection reason and keeps the edited draft open', async () => {
    vi.mocked(api.update).mockResolvedValue({
      ok: false,
      reason: '写入磁盘失败（EACCES）',
      list: [META]
    })
    const view = await openEditor()

    await view.get('[data-testid="agent-extract-summary"]').setValue('  新症状   →   新结论  ')
    await view.get('[data-testid="agent-extract-detail"]').setValue('## 真因\n新正文\n')
    await view.get('[data-testid="agent-extract-save"]').trigger('click')
    await flushPromises()

    expect(api.update).toHaveBeenCalledWith(
      {
        id: 'expedit1',
        summary: '新症状 → 新结论',
        detail: '## 真因\n新正文\n',
        scope: 'host',
        hostId: 'host-a'
      },
      'view-host'
    )
    expect(view.get('[data-testid="agent-extract-error"]').text()).toBe(
      '写入磁盘失败（EACCES）'
    )
    expect(experienceEditor.open).toBe(true)
    expect(experienceEditor.saving).toBe(false)
    expect(view.get('[data-testid="agent-extract-detail"]').element).toHaveProperty(
      'value',
      '## 真因\n新正文\n'
    )
  })

  it('closes after a successful edit and publishes the returned list and lifecycle note', async () => {
    const updated = { ...META, summary: '新症状 → 新结论', updatedAt: 1_700_000_001_000 }
    vi.mocked(api.update).mockResolvedValue({ ok: true, list: [updated] })
    const view = await openEditor()

    await view.get('[data-testid="agent-extract-summary"]').setValue(updated.summary)
    await view.get('[data-testid="agent-extract-detail"]').setValue('## 处置\n清理 core dump\n')
    await view.get('[data-testid="agent-extract-save"]').trigger('click')
    await flushPromises()

    expect(experienceEditor.open).toBe(false)
    expect(view.find('[data-testid="agent-extract-panel"]').exists()).toBe(false)
    expect(experienceList.value).toEqual([updated])
    expect(experienceNote.value).toBe('已保存修改（正文即时生效，梗概进索引从下一对话起）')
    // 保存成功的关闭不经过放弃确认
    expect(confirmRequest.value).toBeNull()
  })

  it('closes a clean editor without asking', async () => {
    const view = await openEditor()

    await view.get('[data-testid="agent-extract-close"]').trigger('click')
    await flushPromises()

    expect(confirmRequest.value).toBeNull()
    expect(experienceEditor.open).toBe(false)
  })

  it('asks before discarding a dirty edit, preserving it on cancel and closing on confirmation', async () => {
    const view = await openEditor()

    await view.get('[data-testid="agent-extract-detail"]').setValue('## 真因\n尚未保存的新正文\n')
    await view.get('[data-testid="agent-extract-close"]').trigger('click')
    await nextTick()

    // 确认挂起期间编辑器照旧开着
    expect(confirmRequest.value).toMatchObject({ message: '放弃未保存的修改？', danger: true })
    expect(experienceEditor.open).toBe(true)

    settleConfirm(false)
    await flushPromises()
    expect(experienceEditor.open).toBe(true)
    expect(view.get('[data-testid="agent-extract-detail"]').element).toHaveProperty(
      'value',
      '## 真因\n尚未保存的新正文\n'
    )

    await view.get('[data-testid="agent-extract-close"]').trigger('click')
    await nextTick()
    settleConfirm(true)
    await flushPromises()

    expect(experienceEditor.open).toBe(false)
    expect(view.find('[data-testid="agent-extract-panel"]').exists()).toBe(false)
  })
})
