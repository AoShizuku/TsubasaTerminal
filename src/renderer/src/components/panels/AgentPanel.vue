<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  BookMarked,
  BookmarkPlus,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Pencil,
  Pin,
  Play,
  ShieldCheck,
  Square,
  SquarePen,
  Trash2
} from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import ExperienceEditor from '@/components/ExperienceEditor.vue'
import ContextBreakdown from './ContextBreakdown.vue'
import AgentMessageList from './AgentMessageList.vue'
import { useAppStore } from '@/composables/useAppStore'
import { approvalState, clearTrust, loadTrust } from '@/composables/useApprovalStore'
import {
  activeProfileId,
  agentState,
  llmProfiles,
  loadSystemPrompt,
  openContextViewer,
  selectSessionProfile,
  sendToAgent,
  sessionProfileId,
  startNewConversation,
  stopAgent
} from '@/composables/useAgentStore'
import {
  clearConversations,
  closeReview,
  conversationList,
  exportConversation,
  formatConvTime,
  lastUsageOf,
  openReview,
  refreshConversations,
  removeConversation,
  renameConversation,
  resumeConversation,
  reviewEvents,
  reviewItems,
  reviewMeta
} from '@/composables/useConversationStore'
import {
  experienceList,
  experienceNote,
  openExperienceEdit,
  openExperienceExtract,
  refreshExperience,
  removeExperience,
  setExperiencePinned
} from '@/composables/useExperienceStore'
import { openGlobalKnowledge, useUiStore } from '@/composables/useUiStore'
import { composerState } from '@/composables/useComposerStore'
import { registerAgentInput, unregisterAgentInput, focusHome } from '@/lib/focusManager'
import { confirmDialog } from '@/lib/confirm'
import type {
  ConversationMeta,
  ExperienceMeta,
  SystemPromptBreakdown,
  TranscriptUnitSummary
} from '@shared/types'

const { activeSession, activeSessionId, hosts } = useAppStore()
const { settingsOpen, hostEditRequest } = useUiStore()

const draft = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const scrollEl = ref<HTMLDivElement | null>(null)
const sendError = ref<string | null>(null)

const state = computed(() => (activeSessionId.value ? agentState(activeSessionId.value) : null))
const connected = computed(() => activeSession.value?.status === 'connected')

/** 选择器显示的 profile：跟随 active 会话，活动对话锁定在它自己的 profile 上 */
const currentProfileId = computed(() =>
  activeSessionId.value ? sessionProfileId(activeSessionId.value) : activeProfileId.value
)
const profileLocked = computed(() => Boolean(state.value?.boundProfileId))

function profileName(id: string | null | undefined): string {
  return llmProfiles.value.find((p) => p.id === id)?.name ?? '已删除的模型服务'
}

// ---------- token 用量圆环：数据是每轮请求的官方 usage，本地不估算 ----------

const DEFAULT_CONTEXT_WINDOW = 200_000
const RING_CIRC = 2 * Math.PI * 8
/**
 * 弧长下限（2% 圆周）：0 长度的弧会让圆环塌成一个空圈，留一丁点让它"有起点"。
 * 只到 2% 是因为百万窗口的模型下几千 token 本来就该显示成几乎为零——把它撑成
 * 肉眼舒服的长度就是在谎报占用。"这里能点"靠交互习惯教会，不靠夸大读数。
 */
const RING_MIN_ARC = RING_CIRC * 0.02

const usage = computed(() => state.value?.usage ?? null)
const items = computed(() => state.value?.items.length ?? 0)
const contextWindow = computed(() => {
  const profile = llmProfiles.value.find((p) => p.id === currentProfileId.value)
  return profile?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
})
/** 当前上下文体积 ≈ 上轮输入（含缓存）+ 上轮输出（都会进下一轮请求） */
const usedTokens = computed(() =>
  usage.value ? usage.value.inputTokens + usage.value.outputTokens : 0
)
const usagePct = computed(() => Math.min(usedTokens.value / contextWindow.value, 1))
const cacheHitPct = computed(() => {
  const u = usage.value
  if (!u || u.cacheReadTokens === null || u.inputTokens === 0) return null
  return Math.round((u.cacheReadTokens / u.inputTokens) * 100)
})

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// ---------- 上下文构成：圆环报总量，点开报构成——两层是同一件事的下钻 ----------

/**
 * header 浮层单选位：构成/历史/经验/信任四个浮层共用 header 下方同一块地
 * （absolute top-full），各持一个布尔时互斥全靠每个 toggle 手工关掉另外三个——
 * 漏一处就叠成一摞（实测三个同时展开）。改成单一状态位，互斥由"只有一个值"保证，
 * 加第五个浮层也不用回头补别人的关闭逻辑。
 */
type HeaderPopover = 'prompt' | 'history' | 'exp' | 'trust'
const popover = ref<HeaderPopover | null>(null)

const promptInfo = ref<SystemPromptBreakdown | null>(null)

/** 与发送同口径的主机标签（system prompt 的主机档案一行用的就是它） */
const hostLabel = computed(() => {
  const session = activeSession.value
  return session ? `${session.host.username}@${session.host.host}（${session.title}）` : ''
})

/**
 * 没配模型服务就不算构成：这里会触发主机档案的独立探测（v0.10.0 起从"首次对话"
 * 提前到"面板要算构成"），而不打算用 Agent 的会话不该为一块看不到的面板付这次远端往返。
 */
async function refreshPromptInfo(): Promise<void> {
  const sessionId = activeSessionId.value
  if (!sessionId || !connected.value || llmProfiles.value.length === 0) {
    promptInfo.value = null
    return
  }
  promptInfo.value = await loadSystemPrompt(sessionId, hostLabel.value)
}

/**
 * 圆环口径：上下文窗口从来不是从 0 开始的——它一开始就被 system prompt
 * 占掉一截。首轮 usage 回来之前只能用估算，那就**画得弱一档**（细描边、单色），
 * 不让估算冒充官方计数（v0.8.3 "本地不估算"禁的是拿估算当准数，不是禁止展示）。
 */
const ringEstimated = computed(() => !usage.value)
const ringTokens = computed(() =>
  usage.value ? usedTokens.value : (promptInfo.value?.totalEstTokens ?? 0)
)
const ringPct = computed(() => Math.min(ringTokens.value / contextWindow.value, 1))

async function togglePrompt(): Promise<void> {
  if (popover.value === 'prompt') {
    popover.value = null
    return
  }
  await refreshPromptInfo()
  if (promptInfo.value) popover.value = 'prompt'
}

/**
 * 中栏只读位被更该占它的东西占着：待审批的 write_file 要逐行审阅、TUI 要整屏。
 * 这段原文优先级最低，连打开都不打开——否则中栏会摞成两层，终端被挤成一条缝。
 */
const centerBusy = computed(() => {
  const sessionId = activeSessionId.value
  if (!sessionId) return false
  const kind = approvalState(sessionId).current?.kind
  return kind === 'write_file' || kind === 'save_experience' || composerState(sessionId).mode === 'tui'
})

function viewSection(row: { title: string; scope: string; source: string; text: string }): void {
  const sessionId = activeSessionId.value
  if (!sessionId || centerBusy.value) return
  openContextViewer({
    sessionId,
    title: row.title,
    scope: row.scope,
    source: row.source as 'code' | 'human' | 'probe',
    text: row.text
  })
  popover.value = null
}

function editHostKnowledge(): void {
  const hostId = activeSession.value?.host.id
  if (hostId) hostEditRequest.value = hostId
  popover.value = null
}

function editGlobalKnowledge(): void {
  openGlobalKnowledge()
  popover.value = null
}

/**
 * 刷新时机：换会话/连上（档案变）、切 profile（= 开新对话）、对话开始（快照转 live）、
 * 关掉设置弹窗或主机列表变动（人写知识可能刚被改过）。
 */
watch(
  [activeSessionId, connected, currentProfileId, items, llmProfiles],
  () => void refreshPromptInfo(),
  { immediate: true }
)
watch([settingsOpen, hosts], ([open]) => {
  if (!open) void refreshPromptInfo()
})

// ---------- 信任集徽章（v0.9.2 `a` 免问）：主进程是事实源，这里显示与收回 ----------

const trustedVerbs = computed(() =>
  activeSessionId.value ? approvalState(activeSessionId.value).trustedVerbs : []
)

// ---------- 对话历史与回溯：对话已是一等对象，这里是它的读侧 ----------

/**
 * 面板通知位（导出结果 / 中栏被占 / 回溯提示，5 秒自散；经验存盘的回执由
 * useExperienceStore 出，两个源合并显示）。testid 沿用 `agent-export-note`
 * 是 e2e 契约，别按名字以为它只跟导出有关。
 * 声明在 watch 之前（v0.10.1 踩坑：immediate watch 引用后声明的 ref 是 TDZ 错误）。
 */
const panelNote = ref<string | null>(null)
const shownNote = computed(() => panelNote.value ?? experienceNote.value)

/** 连接后拉一次：实验机的信任跨会话持久，重连回来仍然生效 */
watch(
  [activeSessionId, connected],
  ([sessionId, isConnected]) => {
    popover.value = null
    // 经验编辑器**不在这里收**（v0.13.1 二次返工）：它是模态弹窗，开着时 TabBar
    // 在它下面，切 tab 根本发生不了；而这条 watch 还挂着 connected——断线重连
    // 顺手把人写了一半的稿子关掉，是旧中栏形态遗留的误伤
    // 面板永远跟随 active 会话：切了 tab，header 已是新会话的，主体不能还看着旧对话
    closeReview()
    if (sessionId && isConnected) void loadTrust(sessionId)
  },
  { immediate: true }
)

// ---------- 排障经验管理：pin/删/打开/来源回跳——都是人的动作 ----------
// 状态住 useExperienceStore：编辑器落在中栏（v0.13.1 修订），触发点在这里，隔着组件树

const currentHostId = computed(() => activeSession.value?.host.id)
/** 管理面板只看当前主机 + 全局（其他主机的经验去那台主机的会话里管） */
const expVisible = computed(() =>
  experienceList.value.filter((e) => e.scope === 'global' || e.hostId === currentHostId.value)
)
/** 淘汰 = 不注入不是删除：被截断的条数必须可见，不能静默 */
const expOmitted = computed(() => expVisible.value.filter((e) => !e.injected).length)

async function toggleExperience(): Promise<void> {
  if (popover.value === 'exp') {
    popover.value = null
    return
  }
  await refreshExperience(currentHostId.value)
  popover.value = 'exp'
}

async function onExpPin(e: ExperienceMeta): Promise<void> {
  await setExperiencePinned(e, currentHostId.value)
}

async function onExpRemove(e: ExperienceMeta): Promise<void> {
  const ok = await confirmDialog({
    title: '删除经验',
    message: `删除经验「${e.summary}」？不可恢复（不想删又不想注入可以等它被新条目自然挤出）。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  await removeExperience(e, currentHostId.value)
}

/**
 * 打开一条经验（v0.13.1 起是**读写一体**，此前是中栏只读查看器）。
 * 经验会过期、会写错，"打开"却只能看不能改，唯一的修法是删了重存——那会换掉 id
 * （Agent 引用它的钩子）并清空 createdAt/pinned/readCount/来源对话。
 * 编辑是人的动作（与 pin/删同级，不经审批台），Agent 仍然没有改写路径。
 */
async function onExpOpen(e: ExperienceMeta): Promise<void> {
  // 弹窗形态起（v0.13.1 二次返工）不再有"中栏忙就不给开"这道守卫：它不占中栏，
  // 提案与 TUI 都不受影响。守卫连同它的反向（编辑器压住查看器）一起消失
  popover.value = null
  await openExperienceEdit(e, currentHostId.value)
}

/** 提炼为经验（v0.10.3 补路径）：Agent 起草，人改完自己存（不经审批台） */
async function openExtract(): Promise<void> {
  const meta = reviewMeta.value
  if (!meta) return
  // 表单是弹窗，header 浮层留着没意义，一起收掉
  popover.value = null
  await openExperienceExtract({ convId: meta.convId, hostIds: meta.hostIds }, currentHostId.value)
}

/** 来源对话回跳（4.8）：sourceConvId 可跳回原对话看当时的完整上下文 */
async function onExpSource(e: ExperienceMeta): Promise<void> {
  if (!e.sourceConvId) return
  await refreshConversations()
  const meta = conversationList.value.find((m) => m.convId === e.sourceConvId)
  if (!meta) return
  popover.value = null
  await openReview(meta)
}

async function toggleHistory(): Promise<void> {
  if (popover.value === 'history') {
    popover.value = null
    return
  }
  await refreshConversations()
  popover.value = 'history'
}

function hostNamesOf(meta: ConversationMeta): string[] {
  return meta.hostIds.map((id) => hosts.value.find((h) => h.id === id)?.name ?? '已删除的主机')
}

async function onOpenReview(meta: ConversationMeta): Promise<void> {
  popover.value = null
  await openReview(meta)
}

async function onClearAll(): Promise<void> {
  const ok = await confirmDialog({
    title: '清空历史对话',
    message: '清空所有历史对话？活动对话将保留，其余不可恢复。',
    confirmText: '清空',
    danger: true
  })
  if (!ok) return
  await clearConversations()
}

/**
 * 新建对话（清场，一键无对话框）：旧对话已随每轮落盘，这里只是把指针摘下、
 * 渲染态清空。也是"知识改动下一对话生效"的显式触发器——refreshPromptInfo
 * 会立刻转回"下一个对话将用"的口径。
 * 清场也包括关掉历史浮层：它的列表是打开那一刻的快照，"当前"徽标还指着刚被
 * 摘下的那条，留在屏上就是过期信息（下次 toggleHistory 会重新拉）。
 */
async function onNewConversation(): Promise<boolean> {
  const sessionId = activeSessionId.value
  const s = state.value
  if (!sessionId || !s || s.busy) return false
  const result = await startNewConversation(sessionId)
  if (!result.ok) return false
  popover.value = null
  closeReview()
  await refreshPromptInfo()
  return true
}

/**
 * 选择器换模型。没有活动对话：只改本会话，并记为最后一次选择
 * （新开的会话跟随它）。有活动对话：对话锁定在自己的 profile 上，换模型 = 新建对话，
 * 先确认——误用另一档价位的模型接着聊、或拿高价模型开新对话，都是这个口子。
 */
async function onProfileChange(ev: Event): Promise<void> {
  const select = ev.target as HTMLSelectElement
  const id = select.value
  const sessionId = activeSessionId.value
  if (!sessionId) return
  const s = agentState(sessionId)
  const bound = s.boundProfileId
  if (bound && bound !== id) {
    // 确认期间选择器仍显示对话实际在用的；取消时响应式值没变，DOM 不会自己拨回
    select.value = bound
    if (s.busy) {
      sendError.value = '对话进行中，先停止再换模型'
      return
    }
    const ok = await confirmDialog({
      title: '切换模型',
      message:
        `当前对话固定使用「${profileName(bound)}」。切换到「${profileName(id)}」将新建对话，` +
        `当前对话已自动保存，可从历史恢复。`,
      confirmText: '新建对话'
    })
    // 确认框期间世界会变：会话换了、对话跑起来了或已被别处解绑，都按当下重新判
    if (!ok || activeSessionId.value !== sessionId || s.boundProfileId !== bound) return
    if (!(await onNewConversation())) return
  }
  sendError.value = null
  await selectSessionProfile(sessionId, id)
}

// ---------- 回溯视图：标题编辑（manual 后不再被自动覆盖）与 markdown 导出 ----------

const editingTitle = ref(false)
const titleDraft = ref('')

function startEditTitle(): void {
  if (!reviewMeta.value) return
  titleDraft.value = reviewMeta.value.title
  editingTitle.value = true
}

async function saveTitle(): Promise<void> {
  const meta = reviewMeta.value
  if (!meta) return
  const title = titleDraft.value.trim()
  if (title && title !== meta.title) await renameConversation(meta.convId, title)
  editingTitle.value = false
}

async function onExport(): Promise<void> {
  const meta = reviewMeta.value
  if (!meta) return
  const result = await exportConversation(meta, reviewItems.value, hostNamesOf(meta))
  if (result.ok && result.savedTo) {
    panelNote.value = `已导出：${result.savedTo}`
  } else if (!result.canceled) {
    panelNote.value = `导出失败：${result.error ?? '未知错误'}`
  }
  setTimeout(() => (panelNote.value = null), 5000)
}

// ---------- 接续与迁移：回溯里"在当前会话继续"，活动对话不可捞出 ----------

// 声明在 watch 之前（v0.10.1 踩坑：watch 回调引用后声明的 ref 有 TDZ 风险）
const resumeError = ref<string | null>(null)

watch(reviewMeta, () => {
  editingTitle.value = false
  panelNote.value = null
  resumeError.value = null
})

/** 恢复前如实展示重算成本：隔夜恢复 = prompt cache 全失效，一次全量重算 */
const resumeCost = computed(() => {
  const usage = lastUsageOf(reviewEvents.value)
  return usage ? usage.inputTokens + usage.outputTokens : null
})

/** 历史条目的模型（v0.13.14 起索引直接记 model；存量只有 profile，显示其名） */
function modelOf(meta: ConversationMeta): string {
  return meta.model ?? profileName(meta.profileId)
}

/**
 * 继续按钮的说明：缓存是否还在取决于离上次活动多久（各家有效期不同，不替它下结论），
 * 只摆事实——用哪个模型接、隔了多久、全失效时要重算多少。
 */
const resumeTitle = computed(() => {
  const meta = reviewMeta.value
  if (!meta) return ''
  const minutes = Math.max(0, Math.round((Date.now() - meta.updatedAt) / 60_000))
  const idle =
    minutes < 60
      ? `${minutes} 分钟`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} 小时`
        : `${Math.round(minutes / 1440)} 天`
  const cost =
    resumeCost.value !== null ? `；缓存失效时约需重算 ${formatTokens(resumeCost.value)} token` : ''
  return `以 ${modelOf(meta)} 把这段对话回灌进当前会话接着聊（距上次活动 ${idle}${cost}）`
})

/** 活动对话（正被某会话持有）不可捞出——主进程还有硬校验，这里是体验层 */
const resumable = computed(
  () => Boolean(reviewMeta.value && !reviewMeta.value.active && connected.value && state.value && !state.value.busy)
)

async function onResume(): Promise<void> {
  const sessionId = activeSessionId.value
  const meta = reviewMeta.value
  if (!sessionId || !meta || !resumable.value) return
  resumeError.value = null
  const opts = {
    hostLabel: hostLabel.value,
    integrationSeen: composerState(sessionId).integrationSeen
  }
  let result = await resumeConversation(sessionId, meta, opts)
  // 模型有变化：profile 被改过模型或原 profile 已删改用替身——
  // 计价、端点、缓存命中都会变，问过人才接
  if (!result.ok && result.confirm) {
    const c = result.confirm
    const ok = await confirmDialog({
      title: '接续模型有变化',
      message: c.substitute
        ? `原对话的模型服务已删除，将改用「${c.profileName}」（同为 ${c.toModel}）接续，` +
          `计价与端点以该服务为准。`
        : `原对话用的是 ${c.fromModel}，模型服务「${c.profileName}」现已改为 ${c.toModel}。` +
          `继续将按 ${c.toModel} 计价，且无法命中原对话的缓存。`,
      confirmText: '仍然接续'
    })
    if (!ok || activeSessionId.value !== sessionId || reviewMeta.value?.convId !== meta.convId) {
      return
    }
    result = await resumeConversation(sessionId, meta, {
      ...opts,
      accept: { profileId: c.profileId, model: c.toModel }
    })
  }
  if (!result.ok) {
    // 二次确认后主进程又判出新的变化（确认期间 profile 再被改）：不连环弹框，如实告知
    resumeError.value =
      result.error ?? (result.confirm ? '模型服务在确认期间又有变化，请重新点继续' : '恢复失败')
    return
  }
  // 对话已转 live：构成面板切到恢复对话的快照口径
  await refreshPromptInfo()
}

async function onClearTrust(): Promise<void> {
  if (!activeSessionId.value) return
  await clearTrust(activeSessionId.value)
  popover.value = null
}

// ---------- 勾选 picker（上下文拾取：随下一条消息附带，发送即消费） ----------

const pickerOpen = ref(false)
const pickerUnits = ref<TranscriptUnitSummary[]>([])

async function refreshPicker(): Promise<void> {
  if (!activeSessionId.value) return
  pickerUnits.value = (await window.api.transcript.summaries(activeSessionId.value)).reverse()
}

watch(pickerOpen, (open) => {
  if (open) void refreshPicker()
})
watch(activeSessionId, () => {
  pickerOpen.value = false
})

function toggleAttach(id: number): void {
  if (!state.value) return
  const list = state.value.attached
  const index = list.indexOf(id)
  if (index === -1) list.push(id)
  else list.splice(index, 1)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

// ---------- 发送 ----------

async function send(): Promise<void> {
  const sessionId = activeSessionId.value
  const session = activeSession.value
  const text = draft.value.trim()
  if (!sessionId || !session || !text) return
  sendError.value = null
  const hostLabel = `${session.host.username}@${session.host.host}（${session.title}）`
  const result = await sendToAgent(sessionId, text, hostLabel)
  if (result.ok) {
    draft.value = ''
    pickerOpen.value = false
  } else {
    sendError.value = result.error ?? '发送失败'
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    void send()
  } else if (ev.key === 'Escape') {
    ev.preventDefault()
    // 回程票：Esc 回终端（草稿保留）；对话是持续交互，Enter 发送不回家
    focusHome()
  }
}

// ---------- 自动滚底（用户上翻时不打扰） ----------

watch(
  () => state.value?.items,
  () => {
    const el = scrollEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) void nextTick(() => el.scrollTo({ top: el.scrollHeight }))
  },
  { deep: true }
)

onMounted(() => {
  if (inputEl.value) registerAgentInput(inputEl.value)
})

onBeforeUnmount(() => {
  if (inputEl.value) unregisterAgentInput(inputEl.value)
})

</script>

<template>
  <div class="relative flex h-full flex-col">
    <!-- 顶部：模型服务选择 -->
    <div class="relative flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <!-- 上下文圆环（v0.10.0 起常驻）：窗口占用总量，点开是它的构成明细。
           连上就有值——system prompt 一开始就占掉一截，从 0 起画是在撒谎 -->
      <button
        v-if="connected && promptInfo"
        class="relative flex shrink-0 items-center rounded p-0.5 hover:bg-accent"
        :title="
          ringEstimated
            ? `背景约 ${formatTokens(ringTokens)} tokens（估算）· 点击看构成`
            : `上下文 ${formatTokens(ringTokens)} / ${formatTokens(contextWindow)} · 点击看构成`
        "
        data-testid="agent-token-ring"
        :data-used="ringTokens"
        :data-estimated="String(ringEstimated)"
        @click="togglePrompt"
      >
        <svg viewBox="0 0 20 20" class="size-4 -rotate-90">
          <circle cx="10" cy="10" r="8" fill="none" stroke-width="3" class="stroke-muted" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            :stroke-width="ringEstimated ? 2 : 3"
            stroke-linecap="round"
            :class="
              ringEstimated
                ? 'stroke-foreground/60'
                : ringPct >= 0.85
                  ? 'stroke-danger'
                  : ringPct >= 0.6
                    ? 'stroke-warn'
                    : 'stroke-ok'
            "
            :stroke-dasharray="`${Math.max(ringPct * RING_CIRC, RING_MIN_ARC).toFixed(2)} ${RING_CIRC.toFixed(2)}`"
          />
        </svg>
      </button>
      <!-- inset-x-3 而非定宽：右栏可以窄到 320px 以下，而 TabsContent 是 overflow-hidden，
           定宽面板会被直接裁掉右半边（v0.10.0 实测）。宽栏时由 max-w-80 收住。
           面板本身不再滚动——原文去了中栏查看器，这里只剩固定几行 -->
      <div
        v-if="popover === 'prompt' && promptInfo"
        class="absolute inset-x-3 top-full z-30 mt-1 max-w-80 rounded-md border bg-card p-2.5 shadow-lg"
        data-testid="agent-prompt-panel"
      >
        <ContextBreakdown
          :info="promptInfo"
          dense
          @view="viewSection"
          @edit-global="editGlobalKnowledge"
          @edit-host="editHostKnowledge"
        />
        <p v-if="centerBusy" class="mt-1.5 text-meta text-muted-foreground/80">
          中栏正忙（待审批文件 / 全屏程序），原文稍后再看
        </p>
        <div v-if="usage" class="mt-2 space-y-0.5 border-t pt-2 text-meta tabular-nums text-muted-foreground">
          <p class="font-medium text-foreground">
            连背景带对话共 {{ formatTokens(usedTokens) }} / {{ formatTokens(contextWindow) }}（{{
              (usagePct * 100).toFixed(1)
            }}%）
          </p>
          <p>上轮输入 {{ usage.inputTokens }} · 输出 {{ usage.outputTokens }}</p>
          <p>
            缓存命中
            {{
              usage.cacheReadTokens !== null
                ? `${usage.cacheReadTokens}（${cacheHitPct}%）`
                : '未上报'
            }}
          </p>
          <p>窗口大小在设置 · 模型服务里按 profile 配置</p>
        </div>
        <p v-else class="mt-2 border-t pt-2 text-meta text-muted-foreground">
          首轮回来前只有估算值；官方计数到手后圆环转为实测口径。
        </p>
      </div>
      <!-- :title 防模型名 truncate 后认不出（v0.10.1 顺带）。v0.13.14 起按会话：
           活动对话锁定在自己的 profile 上，换选项 = 确认后新建对话 -->
      <select
        v-if="llmProfiles.length > 0"
        :value="currentProfileId ?? undefined"
        :title="
          profileLocked
            ? `本对话固定使用 ${profileName(currentProfileId)}（换模型将新建对话）`
            : profileName(currentProfileId)
        "
        data-testid="agent-profile-select"
        :data-locked="String(profileLocked)"
        class="min-w-0 flex-1 truncate rounded border bg-transparent px-1.5 py-0.5 text-list outline-none"
        @change="onProfileChange"
      >
        <option v-for="p in llmProfiles" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <span v-else class="flex-1 text-list text-muted-foreground">未配置模型服务</span>
      <!-- 新建对话：清场一键无对话框；旧对话已随每轮落盘，不弹"要不要保存" -->
      <button
        v-if="connected && state"
        class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        title="新建对话（当前对话已自动保存）"
        data-testid="agent-new-conversation"
        :disabled="state.busy || state.items.length === 0"
        @click="onNewConversation"
      >
        <SquarePen class="i-16" />
      </button>
      <!-- 历史对话：浮层选、主体区切回溯视图 -->
      <button
        class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="历史对话"
        data-testid="agent-history-toggle"
        @click="toggleHistory"
      >
        <History class="i-16" />
      </button>
      <div
        v-if="popover === 'history'"
        class="absolute inset-x-3 top-full z-30 mt-1 rounded-md border bg-card shadow-lg"
        data-testid="agent-history-panel"
      >
        <div class="max-h-72 overflow-y-auto p-1">
          <p
            v-if="conversationList.length === 0"
            class="px-2 py-3 text-center text-meta text-muted-foreground"
          >
            暂无历史对话
          </p>
          <div
            v-for="m in conversationList"
            :key="m.convId"
            class="group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/50"
            data-testid="agent-history-item"
            @click="onOpenReview(m)"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-list" data-testid="agent-history-title">
                {{ m.title }}
                <span
                  v-if="m.active"
                  class="ml-1 rounded bg-primary/15 px-1 text-badge text-primary"
                  >当前</span
                >
              </p>
              <p class="truncate text-meta tabular-nums text-muted-foreground">
                {{ hostNamesOf(m).join('、') }} · {{ formatConvTime(m.updatedAt) }} ·
                {{ m.turnCount }} 轮 · <span data-testid="agent-history-model">{{ modelOf(m) }}</span>
              </p>
            </div>
            <button
              v-if="!m.active"
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
              title="删除该对话"
              data-testid="agent-history-delete"
              @click.stop="removeConversation(m.convId)"
            >
              <Trash2 class="i-12" />
            </button>
          </div>
        </div>
        <div v-if="conversationList.some((m) => !m.active)" class="border-t p-1.5">
          <button
            class="w-full rounded border px-2 py-0.5 text-meta text-muted-foreground hover:bg-accent"
            data-testid="agent-history-clear"
            @click="onClearAll"
          >
            清空历史（活动对话保留）
          </button>
        </div>
      </div>
      <!-- 排障经验管理：pin/删/看正文/来源回跳。不可见的上下文注入是
           调试黑洞——本次注入了哪些、挤出了哪些，都要在这里一眼可见 -->
      <button
        class="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="排障经验"
        data-testid="agent-exp-toggle"
        @click="toggleExperience"
      >
        <BookMarked class="i-16" />
      </button>
      <div
        v-if="popover === 'exp'"
        class="absolute inset-x-3 top-full z-30 mt-1 rounded-md border bg-card shadow-lg"
        data-testid="agent-exp-panel"
      >
        <div class="max-h-72 overflow-y-auto p-1">
          <p
            v-if="expVisible.length === 0"
            class="px-2 py-3 text-center text-meta leading-relaxed text-muted-foreground"
          >
            暂无排障经验。排完让 Agent"记一下"，或在历史对话里"提炼为经验"。
          </p>
          <div
            v-for="e in expVisible"
            :key="e.id"
            class="group flex items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/50"
            data-testid="agent-exp-item"
            :data-injected="String(e.injected === true)"
          >
            <button
              :class="
                e.pinned
                  ? 'shrink-0 rounded p-0.5 text-primary'
                  : 'shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 hover:text-foreground group-hover:opacity-100'
              "
              :title="e.pinned ? '取消固定（回到按时间截断）' : '固定注入（不被新条目挤出，计入上限）'"
              data-testid="agent-exp-pin"
              @click="onExpPin(e)"
            >
              <Pin class="i-12" />
            </button>
            <button
              class="min-w-0 flex-1 text-left"
              title="打开（可改梗概与正文）"
              data-testid="agent-exp-summary"
              @click="onExpOpen(e)"
            >
              <p :class="['truncate text-list', !e.injected && 'text-muted-foreground']">
                {{ e.summary }}
              </p>
              <p class="truncate text-meta tabular-nums text-muted-foreground">
                {{ e.scope === 'global' ? '全局' : '本机' }} ·
                {{ formatConvTime(e.createdAt) }}
                <span v-if="e.updatedAt" data-testid="agent-exp-edited"> · 改过</span>
                <span v-if="e.readCount > 0"> · 被读 {{ e.readCount }} 次</span>
                <span v-if="!e.injected" class="text-warn"> · 未注入</span>
              </p>
            </button>
            <button
              v-if="e.sourceConvId"
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              title="回到来源对话（当时的完整上下文）"
              data-testid="agent-exp-source"
              @click="onExpSource(e)"
            >
              <History class="i-12" />
            </button>
            <button
              class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
              title="删除该经验"
              data-testid="agent-exp-delete"
              @click="onExpRemove(e)"
            >
              <Trash2 class="i-12" />
            </button>
          </div>
        </div>
        <p
          v-if="expOmitted > 0"
          class="border-t px-2 py-1 text-meta text-muted-foreground"
          data-testid="agent-exp-omitted"
        >
          超出注入上限，另有 {{ expOmitted }} 条未注入（按创建时间新者优先；pin 可固定，删可腾位）
        </p>
      </div>
      <!-- 信任集徽章（v0.9.2 `a` 免问）：授出去的信任必须一眼可见、可随时收回 -->
      <button
        v-if="trustedVerbs.length > 0"
        class="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-meta text-ok hover:bg-accent"
        :title="`本机免审批动词：${trustedVerbs.join(' ')}`"
        data-testid="agent-trust-badge"
        @click="popover = popover === 'trust' ? null : 'trust'"
      >
        <ShieldCheck class="i-12" />
        免问 {{ trustedVerbs.length }}
      </button>
      <div
        v-if="popover === 'trust' && trustedVerbs.length > 0"
        class="absolute right-3 top-full z-20 mt-1 w-56 rounded-md border bg-card p-2 shadow-lg"
        data-testid="agent-trust-panel"
      >
        <p class="mb-1 text-meta text-muted-foreground">
          以下动词在本机免审批直接执行（仍进终端、进审计）
        </p>
        <p class="break-all font-mono text-meta">{{ trustedVerbs.join(' · ') }}</p>
        <button
          class="mt-1.5 w-full rounded border px-2 py-0.5 text-meta text-muted-foreground hover:bg-accent"
          data-testid="agent-trust-clear"
          @click="onClearTrust"
        >
          全部收回
        </button>
      </div>
    </div>

    <!-- 回溯工具栏（v0.10.2 增"继续"）：主体区切回溯视图；
         非活动对话可在当前会话接续/迁移 -->
    <div
      v-if="reviewMeta"
      class="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-3 py-1.5"
      data-testid="agent-review-bar"
    >
      <button
        class="shrink-0 rounded p-0.5 hover:bg-accent"
        title="返回当前对话"
        data-testid="agent-review-close"
        @click="closeReview"
      >
        <ArrowLeft class="i-16" />
      </button>
      <template v-if="editingTitle">
        <input
          v-model="titleDraft"
          class="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-list outline-none focus:ring-1 focus:ring-primary/50"
          data-testid="agent-review-title-input"
          maxlength="60"
          @keydown.enter.prevent="saveTitle"
          @keydown.escape="editingTitle = false"
        />
        <button
          class="shrink-0 rounded p-0.5 hover:bg-accent"
          title="保存标题"
          data-testid="agent-review-title-save"
          @click="saveTitle"
        >
          <Check class="i-16" />
        </button>
      </template>
      <template v-else>
        <span class="min-w-0 flex-1 truncate text-list font-medium" data-testid="agent-review-title">
          {{ reviewMeta.title }}
        </span>
        <!-- 在当前会话继续：活动对话不出此按钮（不可捞出）。
             成本如实展示——隔夜恢复 = cache 全失效，一次全量重算 -->
        <button
          v-if="resumable"
          class="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
          :title="resumeTitle"
          data-testid="agent-review-resume"
          @click="onResume"
        >
          <Play class="i-12" />
          继续<template v-if="resumeCost !== null">（约重算 {{ formatTokens(resumeCost) }}）</template>
        </button>
        <!-- 提炼为经验（v0.10.3 补路径）：Agent 起草、人改完保存；排完的当下
             记不了的，第二天还能从这里补 -->
        <button
          class="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
          title="从这段对话提炼一条排障经验（Agent 起草，你确认后保存）"
          data-testid="agent-review-extract"
          @click="openExtract"
        >
          <BookmarkPlus class="i-12" />
          提炼为经验
        </button>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="改标题（改后不再被自动覆盖）"
          data-testid="agent-review-rename"
          @click="startEditTitle"
        >
          <Pencil class="i-12" />
        </button>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="导出 markdown"
          data-testid="agent-review-export"
          @click="onExport"
        >
          <Download class="i-16" />
        </button>
      </template>
    </div>
    <!-- 通知位不再挂在回溯态上：经验编辑从 header 浮层进，存完人在
         当前对话里，条件带 reviewMeta 就等于这条提示永远不出现 -->
    <p
      v-if="shownNote"
      class="shrink-0 border-b px-3 py-1 text-meta text-muted-foreground"
      data-testid="agent-export-note"
    >
      {{ shownNote }}
    </p>
    <p
      v-if="reviewMeta && resumeError"
      class="shrink-0 border-b px-3 py-1 text-meta text-destructive"
      data-testid="agent-resume-error"
    >
      {{ resumeError }}
    </p>

    <!-- 消息流：回溯态渲染重放条目，否则当前对话（同一套组件，回溯"就像当时"） -->
    <div ref="scrollEl" class="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      <template v-if="reviewMeta">
        <AgentMessageList :items="reviewItems" />
        <p class="pt-1 text-center text-meta text-muted-foreground/70" data-testid="agent-review-footer">
          只读回溯 · {{ hostNamesOf(reviewMeta).join('、') || '未知主机' }} ·
          {{ formatConvTime(reviewMeta.createdAt) }} · {{ reviewMeta.turnCount }} 轮 ·
          {{ modelOf(reviewMeta) }}
        </p>
      </template>
      <template v-else-if="state && state.items.length > 0">
        <AgentMessageList :items="state.items" />
      </template>

      <!-- 空态（v0.10.0 UI 改版）：这块地原本放一段读一次就废的功能介绍。
           换成"这次对话会带上什么"——换台主机、刚写完知识，它每次都不一样，
           而且"开口之前知情"正是这个面板存在的理由 -->
      <div
        v-else-if="promptInfo"
        class="flex flex-col gap-4 p-4"
        data-testid="agent-empty-context"
      >
        <ContextBreakdown
          :info="promptInfo"
          @view="viewSection"
          @edit-global="editGlobalKnowledge"
          @edit-host="editHostKnowledge"
        />
        <p class="text-meta leading-relaxed text-muted-foreground/70">
          <span v-if="centerBusy">中栏正忙（待审批文件 / 全屏程序），原文稍后再看 · </span>
          对话自动保存，右上角历史里可回看与导出。
        </p>
      </div>

      <div v-else class="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <Bot class="i-20 text-muted-foreground/40" />
        <p class="text-title font-medium">AI Agent</p>
        <p class="text-list leading-relaxed text-muted-foreground">
          <template v-if="llmProfiles.length === 0">
            先在顶部设置中添加模型服务（Anthropic / OpenAI 兼容端点），
          </template>
          <template v-else-if="!connected">先连接一台主机，</template>
          然后在这里提问。Agent 可读屏、查转录、自动执行只读命令；
          写操作会填入输入栏由你确认。对话自动保存，可从历史回看与导出。
        </p>
      </div>
    </div>

    <!-- 勾选 picker：折叠条（加速器，不是关卡）。回溯态藏起（v-show 保挂载：
         焦点 registry 与草稿都不能因为看了眼历史就丢） -->
    <div v-show="!reviewMeta" v-if="connected && state" class="shrink-0 border-t">
      <button
        class="flex w-full items-center gap-1 px-3 py-1.5 text-meta text-muted-foreground hover:text-foreground"
        data-testid="agent-picker-toggle"
        @click="pickerOpen = !pickerOpen"
      >
        <component :is="pickerOpen ? ChevronDown : ChevronRight" class="i-12" />
        最近命令
        <span v-if="state.attached.length" class="rounded bg-primary/15 px-1 text-primary">
          已勾选 {{ state.attached.length }} 条随下一条消息附带
        </span>
      </button>
      <div v-if="pickerOpen" class="max-h-40 overflow-y-auto border-t px-2 py-1" data-testid="agent-picker">
        <p v-if="pickerUnits.length === 0" class="px-1 py-2 text-meta text-muted-foreground">
          暂无命令记录
        </p>
        <label
          v-for="u in pickerUnits"
          :key="u.id"
          class="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-list tabular-nums hover:bg-accent/50"
          data-testid="agent-picker-item"
        >
          <input
            type="checkbox"
            class="size-3"
            :checked="state.attached.includes(u.id)"
            @change="toggleAttach(u.id)"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-code">{{ u.command }}</span>
          <span
            class="shrink-0"
            :class="u.exitCode === 0 ? 'text-muted-foreground' : 'font-semibold text-destructive'"
          >
            {{ u.exitCode === null ? '?' : u.exitCode }}
          </span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(u.outputBytes) }}</span>
          <span v-if="u.redactions" class="shrink-0 text-warn">🔒{{ u.redactions }}</span>
        </label>
      </div>
    </div>

    <!-- 输入区。回溯态 v-show 藏起：textarea 保持挂载，focusManager 的注册不失效 -->
    <div v-show="!reviewMeta" class="shrink-0 border-t p-2" data-keep-focus>
      <p v-if="sendError" class="mb-1 px-1 text-meta text-destructive" data-testid="agent-send-error">
        {{ sendError }}
      </p>
      <div class="flex items-end gap-1.5">
        <textarea
          ref="inputEl"
          v-model="draft"
          rows="2"
          data-testid="agent-input"
          :placeholder="connected ? '向 Agent 提问…（Ctrl+Shift+A，Enter 发送）' : '先连接主机'"
          :disabled="!connected"
          class="min-h-0 w-full resize-none rounded-md border bg-transparent px-2.5 py-1.5 text-body outline-none transition-shadow placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          @keydown="onKeydown"
        />
        <Btn
          v-if="state?.busy"
          icon-only
          class="shrink-0"
          title="停止"
          data-testid="agent-stop"
          @click="activeSessionId && stopAgent(activeSessionId)"
        >
          <Square class="i-12" />
        </Btn>
      </div>
    </div>

    <!-- 经验编辑器（v0.13.1 二次返工起是模态弹窗）：挂在触发点这一侧，同
         HostSidebar 挂设置/主机弹窗那样。DialogPortal 会 teleport 到 body，
         挂载位置不影响层级；状态住 useExperienceStore，与这里隔着组件树 -->
    <ExperienceEditor />
  </div>
</template>
