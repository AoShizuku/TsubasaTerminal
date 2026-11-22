import { computed, reactive, ref } from 'vue'
import type { ExperienceMeta, ExperienceScope } from '@shared/types'
import { confirmDialog } from '@/lib/confirm'

/**
 * 排障经验的渲染态：列表 + 编辑器。
 *
 * **编辑器是弹窗，不是中栏面板**（v0.13.1 二次返工）。前两版分别放右栏（`w-72`
 * 固定 288px，4KB 正文塞进 260px、中文每行 14 个字）和中栏（复用 save_experience
 * 审批那套形态）。中栏那版的账算下来是亏的：编辑一条经验是**独立任务**，跟终端
 * 会话的关系弱到只取一个 hostId，却要占中栏 70% 把终端挤成一条缝，还得为它发明
 * 一条让位链——四个占用方各写各的可见性判定、两种让位语义（真关掉 vs 藏起来）、
 * 守卫还不对称。坑比复用省下的代码多。
 *
 * "同一件事必须在同一个位置"那条论证**是被审批语境绑架了**：审批时改经验必须在
 * 中栏，因为"内容与决策同屏"是硬约束（弹窗会盖住 composer，没法边看边 y/n）；
 * 事后编辑没有这个约束。形态相似 ≠ 语境相同。
 *
 * 弹窗形态白拿三件事：尺寸自由、天然独占（不进让位链）、**模态开着时 TabBar 在它
 * 下面——"切 tab 稿子没了"从存在性上消失**，编辑器状态因此不必 per-会话。
 */

// ---------- 列表 ----------

export const experienceList = ref<ExperienceMeta[]>([])

export async function refreshExperience(hostId: string | undefined): Promise<void> {
  experienceList.value = await window.api.experience.list(hostId)
}

export async function setExperiencePinned(
  meta: ExperienceMeta,
  hostId: string | undefined
): Promise<void> {
  experienceList.value = await window.api.experience.setPinned(meta.id, !meta.pinned, hostId)
}

export async function removeExperience(
  meta: ExperienceMeta,
  hostId: string | undefined
): Promise<void> {
  experienceList.value = await window.api.experience.remove(meta.id, hostId)
}

// ---------- 编辑器：提炼补录与事后编辑共用 ----------

/**
 * 两个模式落盘走不同入口，但**人做的事是同一件**：把一条经验写对。
 * 故形态不分家（同一个弹窗、同一套字段区 ExperienceFields、同一套软提示），
 * 只有标题、落盘调用与"生效口径"提示不同。
 */
export type ExperienceEditorMode = 'extract' | 'edit'

interface EditorState {
  open: boolean
  mode: ExperienceEditorMode
  /** edit 模式的条目 id（extract 模式无） */
  id: string | null
  summary: string
  detail: string
  scope: ExperienceScope
  /** 归属主机：edit 沿用条目原值，extract 取来源对话的末台 */
  hostId: string | undefined
  /** 列表 injected 口径用的当前会话主机，与 hostId 是两回事 */
  viewHostId: string | undefined
  /** extract 模式的来源对话（落盘记进索引，供日后回跳） */
  sourceConvId: string | undefined
  error: string | null
  /** Agent 起草中（extract 模式打开后的头几秒） */
  loading: boolean
  /** 落盘中：Dlg 的 busy，挡住 ESC / 点遮罩把写操作打断在半路 */
  saving: boolean
}

export const experienceEditor = reactive<EditorState>({
  open: false,
  mode: 'extract',
  id: null,
  summary: '',
  detail: '',
  scope: 'host',
  hostId: undefined,
  viewHostId: undefined,
  sourceConvId: undefined,
  error: null,
  loading: false,
  saving: false
})

/** 保存/放弃的回执（显示在右栏通知位，5 秒自散） */
export const experienceNote = ref<string | null>(null)

/** 打开（或草稿到手）那一刻的内容快照——关面板前据此判断要不要拦一下 */
const baseline = ref('')

function contentKey(): string {
  return JSON.stringify([experienceEditor.scope, experienceEditor.summary, experienceEditor.detail])
}

const dirty = computed(() => contentKey() !== baseline.value)

/**
 * 稿子身份（v0.13.1 二次返工修）：开新的一份 / 结束当前这份都自增，异步动作回来
 * 前先比对。**没有它就是把 A 的草稿写进经验 B**——提炼草稿最长等 30s（LLM 超时），
 * 期间关掉再开另一条完全来得及，而回写是无条件的 `summary = / detail =`，连
 * `baseline` 都一起重置（dirty 随之失效，关面板都不再问"放弃修改"）。
 * 落盘回执同理：它带着"存的是哪一份"的语义，不能落到别人的稿子上。
 */
let epoch = 0

function invalidate(): number {
  epoch += 1
  return epoch
}

function stale(token: number): boolean {
  return token !== epoch
}

interface EditorSeed {
  id?: string
  summary: string
  detail: string
  scope: ExperienceScope
  hostId?: string
  viewHostId?: string
  sourceConvId?: string
  /** 正文文件缺失（外部删过 experience/<id>.md） */
  missingBody?: boolean
}

function openEditor(mode: ExperienceEditorMode, seed: EditorSeed): number {
  const token = invalidate()
  experienceEditor.mode = mode
  experienceEditor.id = seed.id ?? null
  experienceEditor.summary = seed.summary
  experienceEditor.detail = seed.detail
  experienceEditor.scope = seed.scope
  experienceEditor.hostId = seed.hostId
  experienceEditor.viewHostId = seed.viewHostId
  experienceEditor.sourceConvId = seed.sourceConvId
  experienceEditor.error = seed.missingBody
    ? '正文文件缺失（experience/<id>.md 已不在），可在这里重写后保存'
    : null
  experienceEditor.loading = false
  experienceEditor.saving = false
  experienceEditor.open = true
  baseline.value = contentKey()
  return token
}

/**
 * 打开一条已存经验：**读写一体**，此前只能去中栏只读查看器看。
 * 经验会过期、会写错，"打开"却只能看不能改，唯一的修法是删了重存——那会换掉 id
 * （Agent 引用它的钩子）并清空 createdAt/pinned/readCount/来源对话。
 * 编辑是人的动作（与 pin/删同级，不经审批台），Agent 仍然没有改写路径。
 */
export async function openExperienceEdit(
  meta: ExperienceMeta,
  viewHostId: string | undefined
): Promise<void> {
  // 正文先读再开：读盘失败也照开（missingBody 提示重写），但开了之后不再回写，
  // 省掉"面板开着、内容半秒后才蹦出来"的一跳
  const body = await window.api.experience.body(meta.id)
  openEditor('edit', {
    id: meta.id,
    summary: meta.summary,
    detail: body ?? '',
    scope: meta.scope,
    hostId: meta.hostId,
    viewHostId,
    missingBody: body === null
  })
}

/** 提炼补录：Agent 出草稿，人改完自己存（不经审批台） */
export async function openExperienceExtract(
  conv: { convId: string; hostIds: string[] },
  viewHostId: string | undefined
): Promise<void> {
  const token = openEditor('extract', {
    summary: '',
    detail: '',
    scope: 'host',
    hostId: conv.hostIds[conv.hostIds.length - 1],
    viewHostId,
    sourceConvId: conv.convId
  })
  experienceEditor.loading = true
  const draft = await window.api.experience.draft(conv.convId)
  // 这半分钟里用户可能已经关掉、或换开了另一条：那份草稿到此为止
  if (stale(token)) return
  experienceEditor.summary = draft.summary
  experienceEditor.detail = draft.detail
  experienceEditor.loading = false
  // 草稿到手才定基线：Agent 写的那份不算"人的修改"，没动过就该能直接关掉
  baseline.value = contentKey()
}

/**
 * 关闭（✕ / ESC / 点遮罩三条路都走这里）：未保存改动拦一下——正文可能是刚敲的
 * 几百字，手滑不该无声蒸发。落盘中不给关（Dlg 的 busy 已挡住 ESC 与遮罩，这里
 * 兜住 ✕）。
 * 确认框叠在编辑器上：Esc 只关确认框，取消后焦点回到编辑器里。
 */
export async function closeExperienceEditor(): Promise<void> {
  if (experienceEditor.saving) return
  if (dirty.value) {
    const ok = await confirmDialog({
      title: '放弃修改',
      message: '放弃未保存的修改？',
      confirmText: '放弃',
      cancelText: '继续编辑',
      danger: true
    })
    // 确认是异步的：等待期间编辑器若已被别处关掉，不再重复收尾
    if (!ok || !experienceEditor.open) return
  }
  invalidate()
  experienceEditor.open = false
}

function setNote(text: string): void {
  experienceNote.value = text
  setTimeout(() => {
    if (experienceNote.value === text) experienceNote.value = null
  }, 5000)
}

export async function saveExperienceEditor(): Promise<void> {
  if (experienceEditor.saving) return
  const summary = experienceEditor.summary.replace(/\s+/g, ' ').trim()
  const detail = experienceEditor.detail
  const scope = experienceEditor.scope
  // 主进程才是校验的事实源（非空/上限/孤儿/写盘），这里只挡最常见的两种给即时反馈
  if (!summary) {
    experienceEditor.error = '梗概不能为空'
    return
  }
  if (!detail.trim()) {
    experienceEditor.error = '正文不能为空'
    return
  }
  const hostId =
    scope === 'host' ? (experienceEditor.hostId ?? experienceEditor.viewHostId) : undefined
  const id = experienceEditor.id
  const mode = experienceEditor.mode
  const viewHostId = experienceEditor.viewHostId
  const sourceConvId = experienceEditor.sourceConvId
  const token = epoch
  experienceEditor.saving = true
  const result =
    mode === 'edit' && id
      ? await window.api.experience.update({ id, summary, detail, scope, hostId }, viewHostId)
      : await window.api.experience.save({ scope, hostId, summary, detail, sourceConvId })
  // 存的过程中被换开了另一条：回执连同错误提示都不该落到新稿子上
  if (stale(token)) return
  experienceEditor.saving = false
  if (!result.ok) {
    experienceEditor.error = result.reason ?? '保存失败'
    return
  }
  experienceList.value = result.list
  invalidate()
  experienceEditor.open = false
  // 生效口径两半不同步：正文按需读（下次 read_experience 就是新的），
  // 梗概进 system 索引而 system 在对话开始时快照——笼统写"下一对话生效"是不准的
  setNote(
    mode === 'edit'
      ? '已保存修改（正文即时生效，梗概进索引从下一对话起）'
      : '已存为经验（从下一个对话起进入索引）'
  )
}
