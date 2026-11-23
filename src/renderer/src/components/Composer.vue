<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, Lightbulb, Loader2, ShieldAlert, ShieldCheck } from 'lucide-vue-next'
import type { AgentProposal, RedactionSummaryEntry } from '@shared/types'
import {
  composerState,
  computeWriteStatus,
  declareLineClean,
  historyNext,
  historyPrev,
  inputPreferenceFromHost,
  resetToPassthrough,
  sendCommand
} from '@/composables/useComposerStore'
import {
  approvalState,
  approveProposal,
  denyProposal,
  toggleViewer
} from '@/composables/useApprovalStore'
import { clearSuggestion, suggestState } from '@/composables/useSuggestStore'
import {
  multiApprovalState,
  multiPending,
  multiRemainingSeconds
} from '@/composables/useMultiApprovalStore'
import { useFileStore } from '@/composables/useFileStore'
import {
  buildCompgenCommand,
  cachedPathCandidates,
  contextCandidates,
  extractWordAt,
  longestCommonPrefix,
  parseCandidates,
  tokensBefore
} from '@/lib/completion'
import { specCandidates, type CompletionCandidate } from '@/lib/specCompletion'
import { cachedCommands } from '@/lib/remoteContext'
import { useAppStore } from '@/composables/useAppStore'
import { copyText, copyToast, hasTextSelection, trimTerminalSelection } from '@/lib/clipboard'
import { envStyle } from '@/lib/env'
import {
  focusHome,
  focusInHome,
  registerApprovalInput,
  registerComposer,
  unregisterApprovalInput,
  unregisterComposer
} from '@/lib/focusManager'
import { NEUTRAL_CARD, RISK_STYLE } from '@/lib/risk'
import { getTerminal } from '@/lib/terminalRegistry'
import { cn } from '@/lib/utils'

const props = defineProps<{ sessionId: string }>()

const state = computed(() => composerState(props.sessionId))
const fileStore = useFileStore()
const { sessions } = useAppStore()

/** 环境标识（v0.9 视觉层）：左缘色条标记"危险源头是输入行"，审批卡徽章与风险 ring 并列 */
const sessionEnv = computed(() =>
  envStyle(sessions.value.find((s) => s.id === props.sessionId)?.host.envLevel)
)

/**
 * 审批台：与 composer 同体，不做第二个输入表面（composer-design）。
 * 提案行/风险行占位长在 composer 内部（不覆盖终端）；决策在主输入框：
 * Enter 归终端（肌肉记忆不变，提案不阻塞会话），Ctrl+Enter 归审批。
 */
const approval = computed(() => approvalState(props.sessionId))
const proposal = computed(() => approval.value.current)

/** 原生输入模式：命令输入行收起、审批用独立决策输入 */
const isNative = computed(() => state.value.effectiveInput === 'native')

/** write-safe 口径与主进程同源（v0.13.4 fail-closed）：只有 clean 可批 exec——
 *  native 半行 dirty、none 未声明都挡；write_file/transfer/continue 不受限 */
const writeStatus = computed(() => computeWriteStatus(state.value))
const canExecuteExec = computed(() => writeStatus.value === 'clean')

/** exec 批不了的原因（黄字提示行），按状态给出对应的解锁路径 */
const execBusyHint = computed(() => {
  switch (writeStatus.value) {
    case 'dirty':
      return '终端输入行非空——在终端提交或 Ctrl+C 清行后，下一个提示符自动解锁批准'
    case 'none-unverified':
      return '无法自动确认终端输入行为空——清空后点状态条的「已回到空提示符」解锁批准'
    case 'tui':
      return '终端在全屏应用中——退出后可批准'
    default:
      return '终端正忙（命令运行中）——可拒绝或留言，批准需等终端空闲'
  }
})

/** 审批卡分级风险圈（来源边界：这一块是 Agent 的话）；continue 是费用护栏、
 *  save_experience 不碰远端不做风险分级，都用中性圈 */
const cardStyle = computed(() => {
  const p = proposal.value
  if (!p) return ''
  return p.kind === 'continue' || p.kind === 'save_experience'
    ? NEUTRAL_CARD
    : cn(RISK_STYLE[p.risk].ring, RISK_STYLE[p.risk].bg)
})

function clearDraft(): void {
  state.value.draft = ''
  state.value.historyIndex = null
  state.value.stash = ''
}

/** 决策文本的来源槽：fixed 与命令草稿同框，native 用独立审批草稿 */
function decisionText(): string {
  return (isNative.value ? state.value.approvalDraft : state.value.draft).trim()
}

/** 决策提交成功后清对应的槽；native 顺带回家（借走的焦点要还） */
function clearDecisionDraft(): void {
  if (isNative.value) {
    state.value.approvalDraft = ''
    focusHome()
  } else {
    clearDraft()
  }
}

/** transfer 卡：字节数的人读形态 */
function formatBytes(n: number | undefined): string {
  if (n === undefined) return '?'
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** transfer 卡的覆盖标注：原大小 + 原属主（rename 换 inode 会换走属主，覆盖他人文件必须看得见） */
function transferOverwriteLabel(p: AgentProposal): string {
  if (p.exists === true) {
    return `覆盖（原 ${formatBytes(p.oldSize)}${p.owner ? ` · ${p.owner}` : ''}）`
  }
  return p.exists === false ? '新建' : '覆盖状态未知'
}

/**
 * 多机批次挂起（9.5）：审批输入语义全局唯一——批次浮层有自己的输入框，
 * composer 的 Ctrl+Enter 一律拦下并提示（防"以为批当前这台、实际批 7 台"的肌肉记忆
 * 误操作），当前 tab 的单机卡也批不了（多机 90s 自撤、单机无限期等，让有时限的先走）。
 */
const multiState = multiApprovalState()
const multiBlock = computed(() => multiPending())
const multiRemaining = computed(() => multiRemainingSeconds())
const multiIntercepted = ref(false)
let interceptTimer: ReturnType<typeof setTimeout> | null = null

function noteMultiIntercept(): void {
  multiIntercepted.value = true
  if (interceptTimer) clearTimeout(interceptTimer)
  interceptTimer = setTimeout(() => (multiIntercepted.value = false), 3000)
}

async function tryApprove(confirmText?: string, trust?: boolean): Promise<void> {
  const p = proposal.value
  if (!p) return
  if (multiBlock.value) {
    approval.value.error = '多机批次审批待决期间，单机提案暂不可批（批次卡最多挂到超时窗口结束）'
    return
  }
  if (p.kind === 'write_file' && !approval.value.viewed) {
    // 防盲批软拦截：write_file 批准的是内容本身，没看过不能批
    approval.value.error = '请先查看写入内容（点击上方徽标展开）再批准'
    return
  }
  if (p.kind === 'save_experience' && !approval.value.viewed) {
    // 同款防盲批：这条内容会进未来所有对话的上下文，没看过不能存
    approval.value.error = '请先查看经验内容（点击上方徽标展开，可修改）再保存'
    return
  }
  if (p.kind === 'exec' && !canExecuteExec.value) {
    approval.value.error = execBusyHint.value
    return
  }
  if (await approveProposal(props.sessionId, p.id, confirmText, trust)) clearDecisionDraft()
}

async function tryDeny(comment?: string): Promise<void> {
  const p = proposal.value
  if (!p) return
  if (multiBlock.value) {
    approval.value.error = '多机批次审批待决期间，单机提案暂不可批（批次卡最多挂到超时窗口结束）'
    return
  }
  if (await denyProposal(props.sessionId, p.id, comment)) clearDecisionDraft()
}

/**
 * 摩擦阶梯：low 档空 Ctrl+Enter 即批准——Ctrl+Enter 本身已是显式
 * 动作，再打个 y 不产生额外注意力。生产机不空过（blankApprove 由主进程按
 * SessionMeta 算），`continue` 费用护栏与 write_file 效果级审批同样不适用。
 */
const canBlankApprove = computed(() => proposal.value?.blankApprove === true)
/** `a` 免问资格：high 档与跨机/跳板动词不可（主进程判定，这里只用于显示） */
const canTrust = computed(() => proposal.value?.trustable === true)

/** 按键提示按档位分文案：摩擦阶梯 [空过 | y | 确认词] 各自只讲自己那档；
 *  native 提示决策框的进入路径（Ctrl+Shift+Y），Enter 仍归 shell */
const approvalKeyHint = computed(() => {
  const p = proposal.value
  if (!p) return ''
  const tail = isNative.value
    ? '（Ctrl+Shift+Y 进决策框 · 终端里的 Enter 仍归 shell）'
    : ' · Enter 仍发送终端命令'
  if (p.risk === 'high') {
    return `输入「${p.verb}」后 Ctrl+Enter 确认执行 · n 拒绝 · 其他文字留言让 Agent 修订${tail}`
  }
  const approve = canBlankApprove.value ? 'Ctrl+Enter 直接批准' : 'y 批准'
  const trust = canTrust.value ? ' · a 批准且本机免问该命令' : ''
  return `${approve} · n 拒绝${trust} · 其他文字留言让 Agent 修订，Ctrl+Enter 提交${tail}`
})

/** native 决策输入：仅提案存在时挂载。注册给 focusManager 供
 *  Ctrl+Shift+Y 借焦；元素随 v-if 动态出没，用 watch 跟注册 */
const decisionEl = ref<HTMLInputElement | null>(null)
watch(decisionEl, (el, old) => {
  if (old) unregisterApprovalInput(old)
  if (el) registerApprovalInput(el)
})

function onDecisionKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' && ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    if (multiBlock.value) {
      noteMultiIntercept()
      return
    }
    submitApproval()
    return
  }
  if (ev.key === 'Escape') {
    ev.preventDefault()
    focusHome()
  }
}

const decisionPlaceholder = computed(() => {
  const p = proposal.value
  if (!p) return ''
  if (p.risk === 'high') return `输入「${p.verb}」确认 · Ctrl+Enter 提交`
  return `y / n${canTrust.value ? ' / a' : ''} / 留言 · Ctrl+Enter 提交`
})

// 提案更替 / 会话切换即清审批草稿：决策文本不能串到别的提案
watch(
  () => [props.sessionId, proposal.value?.id] as const,
  () => {
    state.value.approvalDraft = ''
  }
)

/** Ctrl+Enter 的审批语义：空=low 档批准 / y 批准 / n 拒绝 / a 批准且免问 / 高危输确认词 / 其他文字留言拒绝 */
function submitApproval(): void {
  const p = proposal.value
  if (!p) return
  const text = decisionText()
  if (text === '') {
    if (canBlankApprove.value) {
      approval.value.error = null
      void tryApprove()
      return
    }
    approval.value.error =
      p.kind === 'continue'
        ? '输入 y 继续 · n 暂停'
        : `空输入不做操作：y 批准 · n 拒绝${canTrust.value ? ' · a 批准且免问' : ''} · 其他文字留言拒绝`
    return
  }
  approval.value.error = null
  if (p.risk === 'high' && text === p.verb) {
    void tryApprove(text)
    return
  }
  if (text === 'y' || text === 'Y') {
    if (p.risk === 'high') {
      approval.value.error = `高危操作需输入「${p.verb}」确认执行`
      return
    }
    void tryApprove()
    return
  }
  if (text === 'n' || text === 'N') {
    void tryDeny()
    return
  }
  if (text === 'a' || text === 'A') {
    if (p.risk === 'high') {
      approval.value.error = `高危操作需输入「${p.verb}」确认执行`
      return
    }
    if (!canTrust.value) {
      approval.value.error = '该命令不支持免问（高危、跨机或跳板类动词一律逐条审批）'
      return
    }
    void tryApprove(undefined, true)
    return
  }
  // 其他文字 = comment 回流 Agent 修订（审批从打断变协作）
  void tryDeny(text)
}

/** y/确认执行 按钮（鼠标路径；running/tui 态输入框禁用时靠它） */
function onApproveClick(): void {
  const p = proposal.value
  if (!p) return
  if (p.risk === 'high') {
    const text = decisionText()
    if (text !== p.verb) {
      approval.value.error = `高危操作需输入「${p.verb}」确认执行`
      return
    }
    void tryApprove(text)
    return
  }
  void tryApprove()
}

/** 补全 L3 建议（LLM 停顿时刻进场）：draft 为空时以 ghost text 呈现 */
const suggestion = computed(() => suggestState(props.sessionId).suggestion)

/** Tab 补全候选面板（瞬态 UI，切会话即弃） */
interface CompletionPanel {
  items: CompletionCandidate[]
  index: number
  /** 被替换词的起止偏移 */
  start: number
  end: number
}
const completion = ref<CompletionPanel | null>(null)
let completionSeq = 0

/** 脱敏审查明细（点角标展开；只有类型统计，原文不出主进程） */
const redactionDetail = ref<RedactionSummaryEntry[] | null>(null)
let disposeRedactionListener: (() => void) | null = null

async function toggleRedactionDetail(): Promise<void> {
  if (redactionDetail.value) {
    redactionDetail.value = null
    focusHome()
    return
  }
  redactionDetail.value = await window.api.transcript.redactionSummary(props.sessionId)
}

const inputEl = ref<HTMLTextAreaElement | null>(null)
const searchInputEl = ref<HTMLInputElement | null>(null)
const mirrorEl = ref<HTMLDivElement | null>(null)

/**
 * 输入行 autosize：mirror 在文档流内撑高（1→6 行），textarea absolute 铺满。
 * 尾随零宽占位保证空草稿有单行高、尾随换行能撑出末行（按约定不嵌入不可见字面量）。
 */
const MIRROR_PAD = String.fromCharCode(8203)

/** 草稿超 6 行后 textarea 内部滚动，mirror 同步 scrollTop 保持 ghost 对位 */
function onInputScroll(): void {
  if (mirrorEl.value && inputEl.value) mirrorEl.value.scrollTop = inputEl.value.scrollTop
}

const modeHint: Record<string, { dot: string; label: string }> = {
  prompt: { dot: 'bg-ok', label: '就绪 · Tab 补全 · Ctrl+R 搜索历史' },
  running: { dot: 'bg-warn animate-pulse', label: '命令运行中 · 按键直达终端' },
  none: { dot: 'bg-muted-foreground', label: '直通模式 · 未检测到 Shell 集成' },
  tui: { dot: 'bg-muted-foreground', label: '' }
}

/**
 * 状态点与文案：native 的 prompt 有自己的说法——键根本不经这里。
 * 本机指定了输入方式时标出来源，免得和设置页的默认值对不上。
 */
const currentHint = computed(() => {
  const fromHost = inputPreferenceFromHost(props.sessionId)
  if (state.value.mode === 'prompt' && isNative.value) {
    return { dot: 'bg-ok', label: fromHost ? '原生输入 · 本机设置' : '原生输入' }
  }
  const source = fromHost ? '本机设置 · ' : ''
  const hint = modeHint[state.value.mode]
  return state.value.mode === 'prompt' && source ? { ...hint, label: source + hint.label } : hint
})

/**
 * SI 断链提示：running 卡死的唯一成因几乎都是 `sudo su` 换了 shell。
 * 两个出口——「重新装载」是真修复（新 shell 重新挂上 OSC 133，不用退出 root），
 * 「切回直通」是保底降级。自动判定只负责让这行字出现，动作一律由用户点。
 */
const stalled = computed(() => state.value.mode === 'running' && state.value.stalled)
const stallError = ref('')

async function onReinject(): Promise<void> {
  stallError.value = ''
  if (!(await window.api.ssh.reinjectSi(props.sessionId))) {
    stallError.value = '该会话未启用 Shell 集成'
    return
  }
  // 不动 stalled：新 shell 的 133;A 到达时 onPromptReady 会自然清掉；
  // 若新 shell 不是 bash/zsh（脚本静默无操作），提示留着，用户还能点降级
}

/** ghost text：draft 非空走 L1 历史前缀匹配；draft 为空且有 L3 建议时整条呈现 */
const ghostSuffix = computed(() => {
  const draft = state.value.draft
  if (state.value.mode !== 'prompt' || isNative.value) return ''
  if (!draft) return suggestion.value?.command ?? ''
  const history = state.value.history
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].startsWith(draft) && history[i] !== draft) {
      return history[i].slice(draft.length)
    }
  }
  return ''
})

/** 历史搜索候选：去重、最近优先、包含匹配 */
const searchResults = computed(() => {
  const query = state.value.searchQuery.toLowerCase()
  const seen = new Set<string>()
  const results: string[] = []
  for (let i = state.value.history.length - 1; i >= 0; i--) {
    const item = state.value.history[i]
    if (seen.has(item)) continue
    seen.add(item)
    if (item.toLowerCase().includes(query)) results.push(item)
    if (results.length >= 8) break
  }
  return results
})

// 模式切换时移焦（仅当焦点本就在"家"，绝不从 Agent 框等处抢焦点）；
// flush post 保证 disabled/v-show 先生效再落焦
watch(
  () => [props.sessionId, state.value.mode] as const,
  () => {
    if (state.value.mode !== 'prompt') state.value.searchOpen = false
    completion.value = null
    completionSeq += 1
    if (focusInHome()) focusHome()
  },
  { flush: 'post' }
)

watch(
  () => props.sessionId,
  () => {
    redactionDetail.value = null
  }
)

watch(
  () => state.value.searchQuery,
  () => {
    state.value.searchIndex = 0
  }
)

function caretOnFirstLine(): boolean {
  const el = inputEl.value
  if (!el) return true
  return !el.value.slice(0, el.selectionStart ?? 0).includes('\n')
}

function caretOnLastLine(): boolean {
  const el = inputEl.value
  if (!el) return true
  return !el.value.slice(el.selectionEnd ?? el.value.length).includes('\n')
}

function moveCaretToEnd(): void {
  void nextTick(() => {
    const el = inputEl.value
    if (!el) return
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

function setCaret(position: number): void {
  void nextTick(() => inputEl.value?.setSelectionRange(position, position))
}

/** 回填候选：目录（尾 /）不加空格继续补，命令/文件加空格收尾 */
function applyCandidate(item: string): void {
  const panel = completion.value
  if (!panel) return
  const suffix = item.endsWith('/') ? '' : ' '
  const draft = state.value.draft
  state.value.draft = draft.slice(0, panel.start) + item + suffix + draft.slice(panel.end)
  setCaret(panel.start + item.length + suffix.length)
  completion.value = null
}

/** compgen 实查兜底（缓存未命中时的 v0.4.1 原路径） */
async function execCompgen(word: string, isFirstWord: boolean, cwd: string | null): Promise<CompletionCandidate[]> {
  const result = await window.api.ssh.exec(
    props.sessionId,
    buildCompgenCommand(word, isFirstWord, cwd)
  )
  if (!result.ok) return []
  return parseCandidates(result.stdout ?? '').map((label) => ({ label }))
}

/**
 * Tab 补全，候选分层合并（completion-design）：
 * L1 spec 语法（同步）> L2 上下文（unit/容器，TTL 缓存）>
 * 命令表/路径（预取与 SFTP 缓存优先，compgen 实查兜底）。
 * 唯一候选直接回填，多候选先补公共前缀再开面板。
 */
async function requestCompletion(): Promise<void> {
  const el = inputEl.value
  if (!el) return
  const caret = el.selectionStart ?? state.value.draft.length
  const { word, start, isFirstWord } = extractWordAt(state.value.draft, caret)
  // 空行 Tab 没有可补目标（列出全部命令无意义）
  if (isFirstWord && word === '') return
  const snapshot = state.value.draft
  const seq = ++completionSeq
  const cwd = fileStore.states[props.sessionId]?.cwd ?? null
  const tokens = tokensBefore(snapshot, start)

  const spec = specCandidates(tokens, word)
  const context = await contextCandidates(props.sessionId, tokens, word)

  let base: CompletionCandidate[] = []
  if (isFirstWord) {
    const commands = cachedCommands(props.sessionId)
    base = commands
      ? commands
          .filter((c) => c.startsWith(word) && c !== word)
          .slice(0, 100)
          .map((label) => ({ label }))
      : await execCompgen(word, true, cwd)
  } else if (!word.startsWith('-') && context.length === 0 && spec.length === 0) {
    // 参数位补路径：SFTP 目录缓存零延迟命中，未命中回退实查
    base = cachedPathCandidates(props.sessionId, word, cwd) ?? (await execCompgen(word, false, cwd))
  }

  // 响应期间草稿已变/会话已切/新请求已发 → 丢弃过期结果
  if (seq !== completionSeq || state.value.draft !== snapshot) return

  const seen = new Set<string>()
  const items: CompletionCandidate[] = []
  for (const list of [spec, context, base]) {
    for (const candidate of list) {
      if (seen.has(candidate.label)) continue
      seen.add(candidate.label)
      items.push(candidate)
      if (items.length >= 50) break
    }
    if (items.length >= 50) break
  }

  if (items.length === 0) return
  if (items.length === 1) {
    completion.value = { items, index: 0, start, end: caret }
    applyCandidate(items[0].label)
    return
  }
  const lcp = longestCommonPrefix(items.map((c) => c.label))
  if (lcp.length > word.length) {
    // bash 惯例：先补到公共前缀，同时列出候选
    state.value.draft = snapshot.slice(0, start) + lcp + snapshot.slice(caret)
    setCaret(start + lcp.length)
    completion.value = { items, index: 0, start, end: start + lcp.length }
  } else {
    completion.value = { items, index: 0, start, end: caret }
  }
}

/** 候选面板按键：↑/↓/Tab 选择、Enter 确认、Esc 关闭；其余按键关面板继续输入 */
function onCompletionKeydown(ev: KeyboardEvent): boolean {
  const panel = completion.value
  if (!panel) return false
  if (ev.key === 'Tab' || ev.key === 'ArrowDown') {
    ev.preventDefault()
    panel.index = (panel.index + 1) % panel.items.length
    return true
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    panel.index = (panel.index - 1 + panel.items.length) % panel.items.length
    return true
  }
  if (ev.key === 'Enter') {
    ev.preventDefault()
    applyCandidate(panel.items[panel.index].label)
    return true
  }
  if (ev.key === 'Escape') {
    ev.preventDefault()
    completion.value = null
    return true
  }
  // 修饰键本身不关面板
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return true
  completion.value = null
  return false
}

function openSearch(): void {
  state.value.searchOpen = true
  state.value.searchQuery = ''
  state.value.searchIndex = 0
  void nextTick(() => searchInputEl.value?.focus())
}

function closeSearch(): void {
  state.value.searchOpen = false
  focusHome()
}

function pickSearch(item: string): void {
  state.value.draft = item
  state.value.historyIndex = null
  closeSearch()
  moveCaretToEnd()
}

function onKeydown(ev: KeyboardEvent): void {
  if (onCompletionKeydown(ev)) return
  if (ev.key === 'Escape' && !ev.isComposing && approval.value.viewerOpen) {
    // 查看器开着时 Esc 收起（补全面板的 Esc 已在上面消费，无冲突）
    ev.preventDefault()
    toggleViewer(props.sessionId)
    return
  }
  if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
    ev.preventDefault()
    void requestCompletion()
    return
  }
  if (ev.key === 'Enter' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && multiBlock.value) {
    // 多机批次挂起：Ctrl+Enter 在 composer 里一律拦下并提示，不放行任何审批——
    // 归属由位置定不由优先级定；**不看当前 tab 有没有单机卡**（没有时本是 no-op，
    // 照样提示，少一条分支）。真提交去浮层（Ctrl+Shift+Enter 前往）
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    noteMultiIntercept()
    return
  }
  if (ev.key === 'Enter' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && proposal.value) {
    // 审批提交走 Ctrl+Enter；Enter 保持终端语义（提案不阻塞会话的键盘层表达）
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    submitApproval()
    return
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    sendCommand(props.sessionId, state.value.draft)
    return
  }
  if (ev.key === 'ArrowRight' && !ev.ctrlKey && !ev.altKey && ghostSuffix.value) {
    // → 接受 ghost text（仅当光标在草稿末尾，否则保持正常移动光标）
    const el = inputEl.value
    if (el && el.selectionStart === state.value.draft.length && el.selectionStart === el.selectionEnd) {
      ev.preventDefault()
      const wasSuggestion = state.value.draft === '' && suggestion.value
      state.value.draft += ghostSuffix.value
      if (wasSuggestion) clearSuggestion(props.sessionId)
      moveCaretToEnd()
      return
    }
  }
  if (ev.key === 'ArrowUp' && !ev.ctrlKey && !ev.altKey && caretOnFirstLine()) {
    ev.preventDefault()
    historyPrev(props.sessionId)
    moveCaretToEnd()
    return
  }
  if (ev.key === 'ArrowDown' && !ev.ctrlKey && !ev.altKey && caretOnLastLine()) {
    ev.preventDefault()
    historyNext(props.sessionId)
    moveCaretToEnd()
    return
  }
  if (ev.code === 'KeyR' && ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault()
    openSearch()
    return
  }
  if (ev.code === 'KeyC' && ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
    // 页面上有文本选区（Agent 面板/审批卡/查看器等只读表面）→ 让位给浏览器原生复制。
    // 不让位的话这里会把它当"空选区"处理去清草稿，用户的选区白选
    if (hasTextSelection()) return
    // 终端有选区 → 复制选区（复制输出的键盘路径，焦点在 composer 也能 Ctrl+C）
    const term = getTerminal(props.sessionId)
    if (term?.hasSelection()) {
      ev.preventDefault()
      void copyText(trimTerminalSelection(term.getSelection()))
      return
    }
    // composer 自身有选区 → 浏览器默认复制
    const el = inputEl.value
    if (el && el.selectionStart !== el.selectionEnd) return
    // 有内容清空，无内容不发送（prompt 态没有可打断的进程）
    ev.preventDefault()
    state.value.draft = ''
    state.value.historyIndex = null
    state.value.stash = ''
  }
}

function onSearchKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    state.value.searchIndex = Math.min(state.value.searchIndex + 1, searchResults.value.length - 1)
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    state.value.searchIndex = Math.max(state.value.searchIndex - 1, 0)
  } else if (ev.key === 'Enter') {
    if (ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    const item = searchResults.value[state.value.searchIndex]
    if (item) pickSearch(item)
    else closeSearch()
  } else if (ev.key === 'Escape') {
    ev.preventDefault()
    closeSearch()
  }
}

// 命令输入 textarea 在 native 下不渲染（v-if），注册随元素出没走 watch，
// 与决策输入同一套（onMounted 一次性注册在这里会拿到 null）
watch(inputEl, (el, old) => {
  if (old) unregisterComposer(old)
  if (el) registerComposer(el)
})

onMounted(() => {
  if (inputEl.value) registerComposer(inputEl.value)
  // 脱敏闸门的角标推送（Composer 是全局单例组件，挂一份即可）
  disposeRedactionListener = window.api.transcript.onRedactions((sessionId, total) => {
    composerState(sessionId).redactions = total
  })
})

onBeforeUnmount(() => {
  if (inputEl.value) unregisterComposer(inputEl.value)
  if (decisionEl.value) unregisterApprovalInput(decisionEl.value)
  disposeRedactionListener?.()
  if (interceptTimer) clearTimeout(interceptTimer)
})
</script>

<template>
  <div
    class="relative flex shrink-0 flex-col border-t bg-background transition-shadow focus-within:shadow-[inset_0_1px_0_0_var(--ring)]"
    data-testid="composer"
    :data-mode="state.mode"
    data-keep-focus
  >
    <!-- v0.9.1：生产机左缘色条已删（与终端顶缘光条撞位，常驻落点四收二） -->
    <!-- Ctrl+R 历史搜索面板 -->
    <div
      v-if="state.searchOpen"
      class="absolute inset-x-3 bottom-full z-10 mb-1 rounded-md border bg-popover p-1 shadow-lg"
      data-testid="history-search"
    >
      <input
        ref="searchInputEl"
        v-model="state.searchQuery"
        data-testid="history-search-input"
        placeholder="搜索历史命令… Enter 回填 · Esc 取消"
        class="mb-1 w-full rounded-sm bg-muted/50 px-2 py-1 font-mono text-code outline-none placeholder:text-muted-foreground/50"
        @keydown="onSearchKeydown"
      />
      <div v-if="searchResults.length === 0" class="px-2 py-1 text-meta text-muted-foreground">
        无匹配历史
      </div>
      <button
        v-for="(item, index) in searchResults"
        :key="item"
        :class="
          cn(
            'block w-full truncate rounded-sm px-2 py-1 text-left font-mono text-code',
            index === state.searchIndex ? 'bg-accent text-foreground' : 'text-muted-foreground'
          )
        "
        data-testid="history-search-item"
        @click="pickSearch(item)"
      >
        {{ item }}
      </button>
    </div>

    <!-- Tab 补全候选面板 -->
    <div
      v-if="completion"
      class="absolute inset-x-3 bottom-full z-10 mb-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-lg"
      data-testid="completion-panel"
    >
      <button
        v-for="(item, index) in completion.items"
        :key="item.label"
        :class="
          cn(
            'flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left font-mono text-code',
            index === completion.index ? 'bg-accent text-foreground' : 'text-muted-foreground'
          )
        "
        data-testid="completion-item"
        @click="applyCandidate(item.label)"
      >
        <span class="shrink-0">{{ item.label }}</span>
        <span v-if="item.description" class="min-w-0 truncate text-meta text-muted-foreground/60">
          {{ item.description }}
        </span>
      </button>
    </div>

    <!-- 脱敏审查明细：类型 + 指纹 + 次数（人在屏幕上本可见真值，此处只为确认未误伤） -->
    <div
      v-if="redactionDetail"
      class="absolute bottom-full right-3 z-10 mb-1 w-64 rounded-md border bg-popover p-2 shadow-lg"
      data-testid="redaction-detail"
    >
      <p class="mb-1 text-meta font-medium text-muted-foreground">
        本会话转录出口已脱敏（人屏不受影响）
      </p>
      <p v-if="redactionDetail.length === 0" class="text-meta text-muted-foreground">暂无记录</p>
      <div
        v-for="entry in redactionDetail"
        :key="`${entry.type}:${entry.fingerprint}`"
        class="flex items-center justify-between py-0.5 font-mono text-meta"
        data-testid="redaction-entry"
      >
        <span class="truncate text-foreground">{{ entry.type }}:{{ entry.fingerprint }}</span>
        <span class="ml-2 shrink-0 text-muted-foreground">× {{ entry.count }}</span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1.5 px-3 pt-1.5 text-meta text-muted-foreground">
      <span :class="cn('size-1.5 rounded-full', stalled ? 'bg-warn' : currentHint.dot)" />
      <span data-testid="composer-hint">
        {{ stalled ? '命令运行中 · Shell 集成已断开（可能切换了 shell）' : currentHint.label }}
      </span>
      <!-- none 的显式恢复动作（v0.13.4 fail-closed）：唯一能把无 SI 会话声明为
           可写的路径——人的现场判断，不做提示符正则/静默推断 -->
      <template v-if="state.mode === 'none' && state.lineDirty">
        <span class="shrink-0 text-warn">· 无法确认输入行为空</span>
        <button
          class="shrink-0 rounded border border-border px-1.5 text-meta hover:bg-accent"
          title="确认远端此刻停在空提示符（必要时先按 Ctrl+C 清行）——声明后 Agent 批准/免问命令才可写入本终端"
          data-testid="none-declare-clean"
          @click="declareLineClean(sessionId)"
        >
          已回到空提示符
        </button>
      </template>
      <!-- 输入方式切换 pending：设置已改但现场不允许立即切，如实说明 -->
      <span
        v-if="state.inputPendingReason"
        class="shrink-0 text-info"
        data-testid="input-pending-hint"
      >· {{ state.inputPendingReason }}</span>
      <template v-if="stalled">
        <button
          class="shrink-0 rounded border border-ok/40 px-1.5 text-meta text-ok hover:bg-ok/10"
          title="在当前 shell 里重新装载 Shell 集成（无需退出 sudo su）"
          data-testid="stall-reinject"
          @click="onReinject"
        >
          重新装载
        </button>
        <button
          class="shrink-0 rounded border border-border px-1.5 text-meta hover:bg-accent"
          title="本会话改按直通模式继续（解除 Agent 审批的终端忙锁定）"
          data-testid="stall-passthrough"
          @click="resetToPassthrough(sessionId)"
        >
          切回直通
        </button>
        <span v-if="stallError" class="shrink-0 text-destructive">{{ stallError }}</span>
      </template>
      <span
        v-if="suggestion?.explanation"
        :class="
          cn(
            'flex min-w-0 items-center gap-1 truncate',
            suggestion.kind === 'fix' ? 'text-warn' : 'text-muted-foreground'
          )
        "
        :title="suggestion.explanation"
        data-testid="suggest-explanation"
      >
        <Lightbulb class="i-12 shrink-0" />
        <span class="truncate">{{ suggestion.explanation }}（→ 接受）</span>
      </span>
      <!-- 多机审批路标（9.5）：composer 的 Ctrl+Enter 被拦截期间，把
           "我被挡住了"变成"我被挡住 62 秒"；拦截发生时附加即时提示 3 秒 -->
      <span
        v-if="multiBlock"
        :class="cn('flex min-w-0 items-center gap-1', multiIntercepted ? 'text-destructive' : 'text-warn')"
        data-testid="multi-approval-signpost"
      >
        <span class="truncate">
          ↑ {{ multiState.proposal?.targets.length ?? 0 }} 台多机审批待决{{
            multiRemaining !== null ? `（剩余 ${multiRemaining}s）` : ''
          }} · Ctrl+Shift+Enter 前往{{ multiIntercepted ? ' —— Ctrl+Enter 已拦下，这里不批多机' : '' }}
        </span>
      </span>
      <span class="min-w-0 flex-1" />
      <!-- 复制反馈：选中即复制是隐形动作，隐形规则必须配显性信号 -->
      <span v-if="copyToast" class="shrink-0 text-ok" data-testid="copy-toast">
        已复制 {{ copyToast.chars }} 字符
      </span>
      <!-- write_file 查看器入口：点击在中栏展开/收起只读查看器（占位不覆盖终端） -->
      <button
        v-if="proposal?.kind === 'write_file'"
        :class="
          cn(
            'flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-accent',
            RISK_STYLE[proposal.risk].fg
          )
        "
        :title="approval.viewerOpen ? '收起内容查看器' : '展开内容查看器（批准前须查看）'"
        data-testid="write-viewer-toggle"
        @click="toggleViewer(sessionId)"
      >
        <FileText class="i-12 shrink-0" />
        <span class="truncate">{{ proposal.verb }} 文件写入待审批</span>
        <span>{{ approval.viewerOpen ? '▾' : '▸' }}</span>
      </button>
      <!-- save_experience 查看器入口：同 write_file 形态，可修改后保存 -->
      <button
        v-if="proposal?.kind === 'save_experience'"
        class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-primary hover:bg-accent"
        :title="approval.viewerOpen ? '收起经验查看器' : '展开经验查看器（保存前须查看，可修改）'"
        data-testid="exp-viewer-toggle"
        @click="toggleViewer(sessionId)"
      >
        <FileText class="i-12 shrink-0" />
        <span class="truncate">排障经验待确认</span>
        <span>{{ approval.viewerOpen ? '▾' : '▸' }}</span>
      </button>
      <!-- 只显状态不显命令：批准的 exec 写入用户可见终端，回显即完整呈现 -->
      <span
        v-if="approval.executing"
        class="flex shrink-0 items-center gap-1 text-ok"
        data-testid="approval-executing"
      >
        <Loader2 class="i-12 shrink-0 animate-spin" />
        <span>已批准 · 执行中{{
          approval.transferPercent !== null ? ` · ${approval.transferPercent}%` : ''
        }}</span>
      </span>
      <button
        v-if="state.redactions > 0"
        class="flex items-center gap-1 rounded px-1 py-0.5 text-ok hover:bg-accent"
        title="转录出口的脱敏记录（终端屏幕不打码）"
        data-testid="redaction-badge"
        @click="toggleRedactionDetail"
      >
        <ShieldCheck class="i-12" />
        已脱敏 {{ state.redactions }} 处
      </button>
    </div>
    <!-- 行 1：人类输入（家）+ 审批按钮。Enter 归终端（肌肉记忆不变），Ctrl+Enter 归审批。
         autosize：mirror 在流内撑高（1→6 行），textarea absolute 铺满（composer-design v0.8.2）。
         native：命令输入行整个不渲染；有提案时换成独立决策输入——
         原生 shell 行不能兼任审批输入（屏幕网格反推 readline 缓冲必被击穿） -->
    <div v-if="!isNative || proposal" class="flex shrink-0 items-end">
      <div v-if="!isNative" class="relative min-w-0 flex-1">
        <!-- ghost text mirror：与 textarea 同字体同边距，draft 部分不可见、只露灰色后缀；
             同时是高度来源（长 L3 建议折行自动被容纳），尾随零宽占位兜住空行/尾随换行 -->
        <div
          ref="mirrorEl"
          aria-hidden="true"
          class="pointer-events-none max-h-[120px] min-h-[30px] overflow-hidden whitespace-pre-wrap break-all px-3 pb-2 pt-1 font-mono text-code-body leading-snug"
        ><span class="invisible">{{ state.draft }}</span><span
            class="text-muted-foreground/40"
            data-testid="ghost-text"
          >{{ ghostSuffix }}</span>{{ MIRROR_PAD }}</div>
        <textarea
          ref="inputEl"
          v-model="state.draft"
          data-testid="composer-input"
          :disabled="state.mode !== 'prompt'"
          :placeholder="state.mode === 'prompt' ? '输入命令…' : ''"
          spellcheck="false"
          class="absolute inset-0 h-full w-full resize-none break-all bg-transparent px-3 pb-2 pt-1 font-mono text-code-body leading-snug outline-none placeholder:text-muted-foreground/40 disabled:opacity-50"
          @keydown="onKeydown"
          @scroll="onInputScroll"
        /></div>
      <div v-else class="min-w-0 flex-1 px-3 pb-2 pt-1">
        <!-- native 决策输入：只承载 y/n/a/确认词/留言，绝不发送到 pty。
             提案到达不抢焦点——Ctrl+Shift+Y 或点击才进来，提交/Esc 后回家 -->
        <input
          ref="decisionEl"
          v-model="state.approvalDraft"
          data-testid="approval-decision-input"
          :placeholder="decisionPlaceholder"
          spellcheck="false"
          class="h-[26px] w-full rounded-sm bg-muted/50 px-2 font-mono text-code outline-none placeholder:text-muted-foreground/50"
          @keydown="onDecisionKeydown"
        />
      </div>
      <!-- y/N 按钮：与输入行同行横排、底对齐（多行长高时贴近下方提案行）；
           盒高=单行输入高，单行时视觉垂直居中（鼠标路径；running/tui 态输入框禁用时靠它） -->
      <div
        v-if="proposal"
        class="flex h-[30px] shrink-0 items-center gap-1.5 px-2"
        data-testid="approval-actions"
      >
        <button
          :class="
            cn(
              'rounded border px-2 py-0.5 text-meta disabled:opacity-40',
              proposal.risk === 'high'
                ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'border-ok/40 text-ok hover:bg-ok/10'
            )
          "
          :disabled="proposal.kind === 'exec' && !canExecuteExec"
          :title="
            proposal.risk === 'high'
              ? `高危：在输入框输入「${proposal.verb}」后点击确认`
              : canBlankApprove
                ? '批准（等价空输入 Ctrl+Enter）'
                : '批准（等价输入 y 后 Ctrl+Enter）'
          "
          data-testid="approval-approve"
          @click="onApproveClick"
        >
          {{
            proposal.risk === 'high'
              ? '确认执行'
              : proposal.kind === 'continue'
                ? '继续'
                : proposal.kind === 'write_file'
                  ? 'y 写入'
                  : proposal.kind === 'save_experience'
                    ? 'y 保存'
                    : proposal.kind === 'transfer'
                      ? 'y 上传'
                      : 'y 执行'
          }}
        </button>
        <button
          class="rounded border px-2 py-0.5 text-meta text-muted-foreground hover:bg-accent"
          data-testid="approval-deny"
          @click="tryDeny()"
        >
          {{ proposal.kind === 'continue' ? '暂停' : 'N 拒绝' }}
        </button>
      </div>
    </div>

    <!-- 行 2/3：Agent 提案与风险说明（占位长在 composer 内，绝不覆盖终端输出）。
         分级风险圈 = 来源边界：色框标记"这一块是 Agent 的话"，与输入行隔离 -->
    <div
      v-if="proposal"
      :class="cn('mx-2 mb-2 shrink-0 rounded-md px-2.5 py-1.5', cardStyle)"
      data-testid="approval-card"
      :data-risk="proposal.risk"
      :data-kind="proposal.kind"
    >
      <div class="flex items-start gap-1.5">
        <ShieldAlert class="mt-px i-12 shrink-0 text-muted-foreground" />
        <button
          v-if="proposal.kind === 'write_file'"
          class="min-w-0 flex-1 break-all text-left font-mono text-code-body font-medium hover:underline"
          title="点击展开/收起内容查看器"
          data-testid="approval-command"
          @click="toggleViewer(sessionId)"
        >
          write_file {{ proposal.path }}
          <span class="font-normal text-muted-foreground">
            ·
            {{
              proposal.exists === true
                ? `覆盖（原 ${proposal.oldSize ?? '?'} 字节）`
                : proposal.exists === false
                  ? '新建'
                  : '覆盖状态未知'
            }}
            · {{ (proposal.content ?? '').split('\n').length }} 行
          </span>
        </button>
        <!-- 决策依据永不截断：全量换行；max-h 滚动只兜病态长命令（滚动仍是全量可见） -->
        <span
          v-else-if="proposal.kind === 'exec'"
          class="max-h-32 min-w-0 flex-1 overflow-y-auto break-all font-mono text-code-body font-medium"
          data-testid="approval-command"
        >{{ proposal.command }}</span>
        <button
          v-else-if="proposal.kind === 'save_experience'"
          class="min-w-0 flex-1 break-all text-left text-body font-medium hover:underline"
          title="点击展开/收起经验查看器（可修改后保存）"
          data-testid="approval-command"
          @click="toggleViewer(sessionId)"
        >
          存为排障经验：{{ proposal.summary }}
          <span class="font-normal text-muted-foreground">
            · {{ proposal.scope === 'global' ? '所有主机' : '仅本机' }}
          </span>
        </button>
        <!-- transfer（v0.13.2 CLI push）：无查看器——审的是搬运动作不是字节；
             本机路径完整显示不截断（来路可辨是仅有的缓解，卡不许裁掉它） -->
        <span
          v-else-if="proposal.kind === 'transfer'"
          class="max-h-32 min-w-0 flex-1 overflow-y-auto break-all font-mono text-code-body font-medium"
          data-testid="approval-command"
        >
          push {{ proposal.localPath }} → {{ proposal.path }}
          <span class="font-normal tabular-nums text-muted-foreground">
            · {{ formatBytes(proposal.size) }} · {{ transferOverwriteLabel(proposal) }}
            <template v-if="proposal.modeStr">· mode {{ proposal.modeStr }}</template>
          </span>
          <span v-if="proposal.large" class="font-medium text-warn"> · 大文件（&gt;100MB）</span>
        </span>
        <span v-else class="min-w-0 flex-1 text-body font-medium" data-testid="approval-command">
          {{ proposal.reason }}，是否继续？
        </span>
      </div>
      <div class="mt-1 flex items-baseline gap-1.5 text-meta">
        <!-- 主机环境徽章与风险徽章并列：风险说"这个动作多危险"，环境说"在哪台机器上" -->
        <span
          v-if="sessionEnv && proposal.kind !== 'continue'"
          :class="cn('shrink-0 rounded px-1 py-px font-medium', sessionEnv.badge)"
          data-testid="approval-env-badge"
        >{{ sessionEnv.label }}</span>
        <!-- save_experience 不显示风险徽章：它不碰远端，审的不是机器安全 -->
        <span
          v-if="proposal.kind !== 'continue' && proposal.kind !== 'save_experience'"
          :class="cn('shrink-0 rounded px-1 py-px font-medium', RISK_STYLE[proposal.risk].badge)"
          data-testid="approval-risk"
        >{{ RISK_STYLE[proposal.risk].label }}</span>
        <span class="min-w-0 leading-relaxed text-muted-foreground">
          {{
            proposal.kind === 'continue'
              ? '费用护栏：继续将再跑 15 轮工具调用（y 继续 · n 暂停，Ctrl+Enter 提交）'
              : proposal.reason
          }}
        </span>
      </div>
      <p v-if="approval.error" class="mt-0.5 text-meta text-destructive" data-testid="approval-error">
        {{ approval.error }}
      </p>
      <p
        v-else-if="proposal.kind === 'exec' && !canExecuteExec"
        class="mt-0.5 text-meta text-warn"
        data-testid="approval-busy-hint"
      >
        {{ execBusyHint }}
      </p>
      <p
        v-else-if="proposal.kind !== 'continue'"
        class="mt-0.5 text-meta text-muted-foreground/60"
        data-testid="approval-keys"
      >
        {{ approvalKeyHint }}
      </p>
    </div>
  </div>
</template>
