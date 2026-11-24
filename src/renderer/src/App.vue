<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import HostSidebar from './components/HostSidebar.vue'
import TerminalWorkspace from './components/TerminalWorkspace.vue'
import RightPanel from './components/RightPanel.vue'
import TitleBar from './components/TitleBar.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ConfirmDlg from './components/ui/ConfirmDlg.vue'
import Sash from './components/ui/Sash.vue'
import { useAppStore } from './composables/useAppStore'
import { bootstrapSettings, useSettingsStore } from './composables/useSettingsStore'
import {
  beginPaneDrag,
  bindRightPanelSession,
  endPaneDrag,
  hydrateLayout,
  movePaneDrag,
  resetPaneWidth,
  revealRightPane,
  setRightPanelTabFor,
  toggleLeftPane,
  toggleRightPane,
  useUiStore
} from './composables/useUiStore'
import { MIDDLE_MIN_WIDTH, PANE_MIN_WIDTH, type PaneSide } from '@shared/layout'
import { initAgentWiring, loadLlmProfiles } from './composables/useAgentStore'
import {
  appendDraft,
  applyInputPreferenceAll,
  composerState,
  inputOverrideRevision,
  sendHumanInput
} from './composables/useComposerStore'
import { focusMultiInput, initMultiWiring } from './composables/useMultiApprovalStore'
import { initSuggestWiring, setSuggestGate } from './composables/useSuggestStore'
import {
  copyText,
  hasTextSelection,
  noteNativeCopy,
  pasteToSession,
  trimTerminalSelection
} from './lib/clipboard'
import {
  focusAgentInput,
  focusApprovalInput,
  focusHome,
  focusInHome,
  setActiveSessionProvider
} from './lib/focusManager'
import { getTerminal } from './lib/terminalRegistry'
import { applyAppTheme } from './lib/appTheme'
import { themeById } from '@shared/terminalThemes'
import { setDialogScrimScheme } from './composables/useDialogScrim'

const { loadHosts, sessions, activeSessionId, activateSession } = useAppStore()
const { rightPanelTab, leftPaneOpen, rightPaneOpen, leftPaneWidth, rightPaneWidth, settingsOpen } =
  useUiStore()
const { settings } = useSettingsStore()

/**
 * 同步引导：settings 一步到位、布局回填，都在首帧之前。这一行必须排在
 * 下面 terminalTheme 那条 immediate watch 之前——它跑的时候 settings 已是真值，
 * 首帧就是正确的主题，不再"先灰阶再切"。放 setup 而不是 onMounted，理由同下面的
 * setActiveSessionProvider：子组件先于父组件 mount。
 */
hydrateLayout(bootstrapSettings())

/**
 * 把"谁是活动会话"递给焦点管理器（v0.12.2 前的整理）：focusManager 不再反向
 * import useAppStore，渲染层的循环依赖组就此断开。
 *
 * 放 setup 体内而不是 onMounted——Vue 里子组件的 onMounted 先于父组件触发，
 * 而子组件（Composer / TerminalView）挂载时就可能调 focusHome()；
 * 父的 setup 则严格早于所有子的 setup 与 mount，注册不会迟到。
 */
setActiveSessionProvider(() => activeSessionId.value)

/**
 * 右栏按标签页记忆栏位：活动会话一变就把右栏绑到它身上（useUiStore 不反向 import
 * useAppStore，由这里装配）。sync 而不是默认的 pre：活动会话已变、绑定还没跟上的
 * 空档里若有人切栏，选择会记进上一个会话。排在 hydrateLayout 之后，新会话沿用的是回填后的栏。
 */
watch(activeSessionId, (id) => bindRightPanelSession(id), { immediate: true, flush: 'sync' })

// L3 触发闸：native 无 ghost 宿主、TUI 态 composer 隐藏，都不发请求
setSuggestGate((sessionId) => {
  const state = composerState(sessionId)
  return state.effectiveInput !== 'native' && state.mode !== 'tui'
})

/**
 * 主题贯穿：UI 外壳的配色变量从终端配色方案派生，切方案即时贯穿三栏。
 * v0.13.11 起 settings 由上面的 bootstrapSettings 同步就位，首帧即真值。
 * v0.14.3：明暗随方案底色走，弹窗遮罩的浓度跟着换（亮底上 0.58 的黑幕太重）。
 */
watch(
  () => settings.value?.terminalTheme,
  (id) => setDialogScrimScheme(applyAppTheme(themeById(id)).scheme),
  { immediate: true }
)

/** 界面密度：main.css 的 :root[data-density] 覆盖行高与控件高，首帧即真值 */
watch(
  () => settings.value?.uiDensity,
  (density) => {
    document.documentElement.dataset.density = density ?? 'standard'
  },
  { immediate: true }
)

/** 界面字号：main.css 的 :root[data-ui-font-size] 设 --fs-step，整张字号表同步抬 */
watch(
  () => settings.value?.uiFontSize,
  (size) => {
    document.documentElement.dataset.uiFontSize = size ?? 'standard'
  },
  { immediate: true }
)

/**
 * 输入方式偏好下发：对所有已建会话按 pending 表安全切换。落焦在这里做
 * （store 不 import focusManager——那是现成的环）：只在焦点本就在"家"时移动，
 * 不从 Agent 输入框等处抢焦点。v0.13.19 起编辑主机改了本机输入方式也走这一条。
 * "在不在家"切换前同步判，落焦等 nextTick：主机表单是先关窗回家、IPC 回来才切换，
 * 切到固定栏时 textarea 随 v-if 才挂上，同步调 focusHome 拿不到它，焦点会留在 xterm。
 */
watch(
  // 多源形式逐项比较；别写成返回数组的 getter——新数组每次都"变了"，任何设置改动都会落焦
  [() => settings.value?.terminalInputMode, inputOverrideRevision],
  () => {
    const wasHome = focusInHome()
    applyInputPreferenceAll()
    if (wasHome) void nextTick(() => focusHome())
  }
)

/**
 * 点空白回家（focus-design 易忘细节 1）：
 * - data-keep-focus 区（Agent 输入、composer）自持焦点；
 * - data-return-home 区（文件栏、右栏 tab 条）点完任何条目焦点立即回家；
 * - 其余交互控件（按钮、输入框）维持默认；真正的空白 → 回家。
 * 弹窗 Teleport 到 body，不经过此处，天然豁免。
 */
function onRootClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null
  if (!target) return
  // 拖选只读文本的收尾 click：回家会 focus 输入框，Chromium 随即把选区
  // 收进去——选区当场归零，复制无从谈起。有选区就不回家，键盘落点交给
  // catchStrayKey 兜底。单纯点击（选区已折叠）不受影响，照旧回家。
  if (hasTextSelection()) return
  if (target.closest('[data-keep-focus]')) return
  if (target.closest('[data-return-home]')) {
    focusHome()
    return
  }
  if (target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
  focusHome()
}

/**
 * 焦点掉在 body 时不丢键：拖选只读文本后焦点无处可去——选区守卫
 * 让它停在 body 以保住选区，键盘落点由这里接回家。与 TerminalView 里
 * xterm 的按键回流是同一套补丁式兜底：焦点是路由问题，键必须落在正确的地方。
 * Ctrl/Alt/Meta 组合一律放行——body 焦点下的 Ctrl+C 正是原生复制那一路。
 */
function catchStrayKey(ev: KeyboardEvent): boolean {
  const el = document.activeElement
  // 焦点在真正的输入接收器上（含 xterm 的隐藏 textarea）→ 键归它，不插手。
  // 判"非输入元素"而不是判 body：Chromium 会把焦点给可滚动的 div（隐式可聚焦），
  // 在 Agent 面板里拖选时焦点落的就是那个滚动容器，不是 body
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  ) {
    return false
  }
  // 弹窗打开时按键归弹窗，不劫回终端
  if (document.querySelector('[data-modal]')) return false
  // 标题栏按钮可由键盘激活；Enter / Space 不能被兜底输入通路送到远端。
  if (
    el instanceof HTMLElement &&
    el.closest('.app-titlebar button') &&
    (ev.key === 'Enter' || ev.key === ' ')
  ) {
    return false
  }
  const sessionId = activeSessionId.value
  if (!sessionId) return false
  if (ev.key === 'Enter' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault()
    focusHome()
    return true
  }
  if (ev.key.length !== 1 || ev.ctrlKey || ev.altKey || ev.metaKey) return false
  ev.preventDefault()
  // 按 effective 输入载体分流：native 的 prompt 也直通 pty
  const state = composerState(sessionId)
  if (state.mode === 'prompt' && state.effectiveInput === 'composer') {
    appendDraft(sessionId, ev.key)
  } else {
    sendHumanInput(sessionId, ev.key)
  }
  focusHome()
  return true
}

/** Ctrl+Shift 快捷键层（不占 shell 命根子）+ Ctrl+1..9 会话切换 */
function onGlobalKeydown(ev: KeyboardEvent): void {
  // Ctrl+Shift+Enter：前往多机批次浮层的输入框。composer 的 Ctrl+Enter
  // 分支明确要求 !shiftKey，这个键是干净的；无多机挂起时不吞键
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.key === 'Enter') {
    if (focusMultiInput()) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    return
  }
  // Ctrl+Shift+Y（v0.13.4 原生模式恢复）：借焦点给审批决策输入。fixed 模式 /
  // 无提案时没有这个输入框，不吞键
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyY') {
    if (focusApprovalInput()) {
      ev.preventDefault()
      ev.stopPropagation()
    }
    return
  }
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyA') {
    ev.preventDefault()
    ev.stopPropagation()
    // 右栏折叠着就先请回来：Agent 输入框在 display:none 的子树里，
    // focus() 会静默失败。class 绑定在 patch 期同步落，nextTick 时 DOM 已可见
    revealRightPane()
    rightPanelTab.value = 'agent'
    void nextTick(() => focusAgentInput())
    return
  }
  /**
   * 侧栏折叠。**不能用 Ctrl+B**——那是 tmux 的默认 prefix，终端客户端
   * 截胡它等于废掉用户的 tmux，折叠一律留在 Ctrl+Shift 层。
   * 折叠后必须回家：焦点可能正停在要被藏起来的子树里（右栏的 Agent 输入框），
   * display:none 一加浏览器就把它丢给 body，键盘随即无处落地。
   */
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyB') {
    ev.preventDefault()
    ev.stopPropagation()
    toggleLeftPane()
    focusHome()
    return
  }
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyM') {
    ev.preventDefault()
    ev.stopPropagation()
    toggleRightPane()
    focusHome()
    return
  }
  // Ctrl+Shift+C：终端复制的键盘路径（终端惯例）。任何焦点下都复制活动终端选区——
  // composer 的 Ctrl+C 只在 prompt 态且焦点在家时管用，焦点在 Agent 框时够不着。
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyC') {
    const sessionId = activeSessionId.value
    const term = sessionId ? getTerminal(sessionId) : undefined
    if (term?.hasSelection()) {
      ev.preventDefault()
      ev.stopPropagation()
      void copyText(trimTerminalSelection(term.getSelection()))
    } else if (hasTextSelection()) {
      // 终端没选区就复制页面选区——这个键的心智是"复制我选的东西"，不该分表面
      ev.preventDefault()
      ev.stopPropagation()
      void copyText(window.getSelection()?.toString() ?? '')
    }
    return
  }
  /**
   * 粘贴的键盘路径。Ctrl+Shift+V 是终端惯例（与 Ctrl+Shift+C 对称），
   * Ctrl+V 是 Windows 用户的强预期（Windows Terminal 默认就绑着它）。
   * 两条都只在焦点够不着别的输入接收器时才接管：Agent 输入框、设置弹窗、composer
   * 里的 Ctrl+V 一律让位给原生——原生按光标位置插入，比程序化落点更准。
   * xterm 的隐藏 textarea 不算"别的输入接收器"，它就是终端本身。
   * Ctrl+V 在 TUI 态不接管：那是 vim 的可视块选择，劫了就没法用了。
   * 弹窗开着时也不接管：焦点停在弹窗按钮上不算"输入接收器"，不拦的话
   * 会往被遮住的终端里粘——多行粘贴确认框开着时再按一次，就是第二次粘贴。
   */
  if (ev.ctrlKey && !ev.altKey && ev.code === 'KeyV') {
    if (document.querySelector('[data-modal]')) return
    const el = document.activeElement
    const inXterm = el instanceof HTMLElement && !!el.closest('.xterm')
    if (
      !inXterm &&
      (el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable))
    ) {
      return
    }
    const sessionId = activeSessionId.value
    if (!sessionId) return
    if (!ev.shiftKey && composerState(sessionId).mode === 'tui') return
    ev.preventDefault()
    ev.stopPropagation()
    void pasteToSession(sessionId)
    return
  }
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && /^Digit[1-9]$/.test(ev.code)) {
    const session = sessions.value[Number(ev.code.slice(5)) - 1]
    if (session) {
      ev.preventDefault()
      ev.stopPropagation()
      activateSession(session.id)
      return
    }
  }
  catchStrayKey(ev)
}

/**
 * 侧栏拖拽调宽。几何真值与写盘在 useUiStore，这里只做它不该做的事——
 * 量 DOM：容器宽与另一栏的**有效**宽（窗口太窄时 flex 已在收缩，有效宽小于偏好宽，
 * 拿偏好宽算上限会把中栏挤破 MIDDLE_MIN）。折叠着的另一栏按 0 算。
 */
const bodyEl = ref<HTMLDivElement | null>(null)
const leftPaneEl = ref<ComponentPublicInstance | null>(null)
const rightPaneEl = ref<ComponentPublicInstance | null>(null)

function paneStyle(side: PaneSide): Record<string, string> {
  const width = side === 'left' ? leftPaneWidth.value : rightPaneWidth.value
  return { width: `${width}px`, minWidth: `${PANE_MIN_WIDTH[side]}px` }
}

function onSashStart(side: PaneSide): void {
  const container = bodyEl.value?.clientWidth ?? window.innerWidth
  const otherOpen = side === 'left' ? rightPaneOpen.value : leftPaneOpen.value
  const otherEl = (side === 'left' ? rightPaneEl : leftPaneEl).value?.$el as
    | HTMLElement
    | undefined
  beginPaneDrag(side, container, otherOpen ? (otherEl?.offsetWidth ?? 0) : 0)
}

/** 原生复制（DOM 选区的 Ctrl+C / 右键复制）也给同一个显性反馈 */
function onDocumentCopy(): void {
  noteNativeCopy((window.getSelection()?.toString() ?? '').length)
}

/** 窗口失焦恢复（易忘细节 2）：Alt+Tab 回来焦点落在 body 时送回家 */
function onWindowFocus(): void {
  const el = document.activeElement
  if (!el || el === document.body) focusHome()
}

/**
 * CLI 审批通知点击 → 切到提案所在会话（v0.12.1 fix）：审批台是 per-会话的
 * composer 占位，提案卡只在它自己的 tab 上可见——只把窗口拽到前台还不够，
 * 用户停在别的 tab 时仍要手动找是哪个会话。
 *
 * 会话已经关掉就什么都不做：通知活得比会话久是常态（通知中心留存），
 * 切到一个不存在的 tab 只会更迷惑。
 */
function onFocusSessionRequest(sessionId: string): void {
  if (!sessions.value.some((s) => s.id === sessionId)) return
  activateSession(sessionId)
  // 落焦要等 Vue patch 完：Composer 是跨会话单例（TerminalWorkspace 里不在 v-for），
  // 同步调时它身上还是旧会话的 disabled 状态
  void nextTick(() => focusHome())
}

/**
 * `use` 自动开会话（cli-bridge-design 9.7）：主进程请求 → 开标签页，
 * 然后盯连接状态把结果回给主进程——失败原因（含 TOFU mismatch 的"主机密钥已改变"）
 * 借这条应答穿透到 CLI stderr。连接本身走 TerminalView 挂载即连的既有流程，
 * 这里不新增任何连接代码，只做状态观察。
 */
const OPEN_WATCH_MS = 29_000

function onOpenSessionRequest(requestId: string, hostId: string): void {
  const { hosts, sessions: sessionList, openSession } = useAppStore()
  const host = hosts.value.find((h) => h.id === hostId)
  if (!host) {
    window.api.cli.openSessionResult(requestId, '', false, '主机配置不存在（可能刚被删除）')
    return
  }
  const sessionId = openSession(host)
  // 外部 agent 开的标签页落在 CLI 栏：它接下来的命令都列在那里。只切栏，右栏收着就不展开
  // ——收起是用户的选择。总开关在请求途中被关掉时不切
  if (settings.value?.cliBridgeEnabled === true) setRightPanelTabFor(sessionId, 'cli')
  const deadline = Date.now() + OPEN_WATCH_MS
  const timer = setInterval(() => {
    const session = sessionList.value.find((s) => s.id === sessionId)
    const finish = (ok: boolean, error?: string): void => {
      clearInterval(timer)
      window.api.cli.openSessionResult(requestId, sessionId, ok, error)
    }
    if (!session) {
      finish(false, '标签页已被关闭')
      return
    }
    if (session.status === 'connected') {
      finish(true)
      return
    }
    if (session.status === 'error' || session.status === 'closed') {
      finish(false, session.error ?? '连接失败')
      return
    }
    if (Date.now() > deadline) {
      finish(false, '连接仍在进行（超过等待窗口）——标签页已打开，稍后重跑 use 即可绑定')
    }
  }, 250)
}

let disposeFocusSession: (() => void) | null = null
let disposeOpenSession: (() => void) | null = null

onMounted(() => {
  void loadHosts()
  initAgentWiring()
  initSuggestWiring()
  initMultiWiring()
  void loadLlmProfiles()
  disposeFocusSession = window.api.cli.onFocusSession(onFocusSessionRequest)
  disposeOpenSession = window.api.cli.onOpenSession(onOpenSessionRequest)
  window.addEventListener('keydown', onGlobalKeydown, true)
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('copy', onDocumentCopy)
})

onBeforeUnmount(() => {
  disposeFocusSession?.()
  disposeFocusSession = null
  disposeOpenSession?.()
  disposeOpenSession = null
  window.removeEventListener('keydown', onGlobalKeydown, true)
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('copy', onDocumentCopy)
})
</script>

<template>
  <div
    class="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
    @click="onRootClick"
  >
    <TitleBar />
    <div ref="bodyEl" class="flex min-h-0 flex-1" data-testid="window-body">
      <!-- 左栏：主机列表与信息。
           折叠用 class 绑 `hidden` 而不是 v-show / v-if：v-show 的
           display 更新是 post-render effect，会晚于落焦用的 post watcher；v-if 则
           连带卸载左栏模板里挂着的主机表单 / 导入全局单例弹窗。
           不加宽度过渡：中栏一变宽 TerminalView 的 ResizeObserver 就 fit，动画
           每帧算出的新 cols 都是一次 SIGWINCH，远端 vim/htop 会被刷到错乱。
           宽度：inline style 写的是**偏好宽**（flex: 0 1 auto + min-width），
           窗口窄到放不下时由 flex 收缩让位——中栏 base 为 0 不参与收缩，两侧按各自宽度
           等比让、到 min 冻结，不需要任何 JS 量窗口 -->
      <HostSidebar
        ref="leftPaneEl"
        class="shrink border-r"
        :class="{ hidden: !leftPaneOpen }"
        :style="paneStyle('left')"
        data-testid="left-pane"
      />
      <Sash
        side="left"
        :class="{ hidden: !leftPaneOpen }"
        @start="onSashStart('left')"
        @move="movePaneDrag"
        @end="endPaneDrag"
        @reset="resetPaneWidth('left')"
      />
      <!-- 中栏：标签页 + 终端 + 钉底 composer。min-width 是拖拽夹值的另一半：
           有它 flex 收缩才会让两侧退而不是把中栏挤没 -->
      <TerminalWorkspace class="flex-1" :style="{ minWidth: `${MIDDLE_MIN_WIDTH}px` }" />
      <Sash
        side="right"
        :class="{ hidden: !rightPaneOpen }"
        @start="onSashStart('right')"
        @move="movePaneDrag"
        @end="endPaneDrag"
        @reset="resetPaneWidth('right')"
      />
      <!-- 右栏：Agent / 文件 -->
      <RightPanel
        ref="rightPaneEl"
        class="shrink border-l"
        :class="{ hidden: !rightPaneOpen }"
        :style="paneStyle('right')"
        data-testid="right-pane"
      />
    </div>
    <SettingsDialog v-model:open="settingsOpen" />
    <!-- 全局唯一的确认框：lib/confirm 的 confirmDialog 下发内容 -->
    <ConfirmDlg />
  </div>
</template>
