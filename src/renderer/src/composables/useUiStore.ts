import { computed, ref } from 'vue'
import {
  PANE_DEFAULT_WIDTH,
  PANE_MIN_WIDTH,
  clampPaneWidth,
  maxPaneWidth,
  type PaneSide
} from '@shared/layout'
import type { AppSettings, RightPanelTab } from '@shared/types'
import { updateSettings } from './useSettingsStore'

/**
 * 每个标签页各自记住右栏停在哪一栏：按 sessionId 记，只活在本次运行，不落盘。
 * 不按 hostId——同一台主机开两个标签页，一个给内置 Agent、一个给外部 agent 是常态。
 * 只记栏位，不记右栏显隐与宽度：那两项随会话变会改中栏宽度，切标签就是一次 SIGWINCH。
 *
 * 写穿而不是"切走时保存"：选择发生时就记进当时绑定的会话。closeSession 先清理、
 * 后改活动会话，"切走时保存"会把已关会话的条目写回来。
 * 绑定由 App 以同步 watch 跟随活动会话（本模块不 import useAppStore），
 * 清理由 closeSession 调 forgetRightPanelSession。
 */
const tabBySession = new Map<string, RightPanelTab>()
let boundSession: string | null = null

/**
 * 右栏当前显示的 tab（'agent' | 'files' | 'cli'）；Ctrl+Shift+A 跳 Agent 需要程序化切换，故做成受控状态。
 * 对外是可写 computed 而不是裸 ref：reka-ui 的 v-model 与 App 的赋值都经过
 * setter，切 tab 即持久化；启动回填写内层 ref，不触发写盘。
 * 类型放宽为 string 以匹配 reka-ui TabsRoot 的 modelValue；setter 只认合法值。
 * 'cli' 只在 CLI 通道总开关开着时存在，总开关关掉时由 RightPanel 调 retreatFromCliTab 退回 Agent。
 */
const rightPanelTabInner = ref<RightPanelTab>('agent')
const rightPanelTab = computed<string>({
  get: () => rightPanelTabInner.value,
  set: (value) => {
    if (value !== 'agent' && value !== 'files' && value !== 'cli') return
    // 写穿：选择当场记进所绑会话，含 Ctrl+Shift+A 这类程序化切栏
    if (boundSession) tabBySession.set(boundSession, value)
    if (rightPanelTabInner.value === value) return
    rightPanelTabInner.value = value
    persistLayout()
  }
})

/**
 * 活动会话变了：恢复它记住的栏；没有记忆的（新开的标签页）沿用当前显示栏并就此记下，
 * 开标签页不切栏。没有会话时保持当前栏。恢复导致显示栏变化时写回一次
 * ——settings.json 的 rightPanelTab 是显示栏的镜像，只决定启动时停在哪一栏。
 */
export function bindRightPanelSession(sessionId: string | null): void {
  boundSession = sessionId
  if (!sessionId) return
  const remembered = tabBySession.get(sessionId)
  if (remembered === undefined) {
    tabBySession.set(sessionId, rightPanelTabInner.value)
    return
  }
  if (remembered === rightPanelTabInner.value) return
  rightPanelTabInner.value = remembered
  persistLayout()
}

/**
 * 指定某个会话停在哪一栏（`use` 自动开的标签页落在 CLI 栏）。不依赖绑定 watch 的
 * 时序：会话已绑定就当场切，还没绑定就先记下，绑定时按记忆恢复。
 */
export function setRightPanelTabFor(sessionId: string, tab: RightPanelTab): void {
  tabBySession.set(sessionId, tab)
  if (boundSession === sessionId) rightPanelTab.value = tab
}

export function forgetRightPanelSession(sessionId: string): void {
  tabBySession.delete(sessionId)
}

/**
 * CLI 通道总开关关掉：显示栏停在 CLI 的退回 Agent，各会话记着 CLI 的也一并退回
 * ——之后重开总开关，旧记忆不会再把人带回 CLI 栏。
 */
export function retreatFromCliTab(): void {
  for (const [sessionId, tab] of tabBySession) {
    if (tab === 'cli') tabBySession.set(sessionId, 'agent')
  }
  if (rightPanelTabInner.value === 'cli') rightPanelTab.value = 'agent'
}

/**
 * 设置弹窗开合：标题栏齿轮与 Agent 空态的"去写全局知识"共用状态，App 挂载弹窗。
 */
const settingsOpen = ref(false)

/**
 * 设置弹窗的分节。弹窗从单列滚动流改成左导航 + 右内容之后，
 * "打开设置"不再等于"看得见任何一项"——外部入口必须连带指定落在哪一节。
 */
export type SettingsSection = 'appearance' | 'knowledge' | 'models' | 'security' | 'cli' | 'about'
const settingsSection = ref<SettingsSection>('appearance')

/** 打开设置后要聚焦的字段（null = 只切到分节，不落焦到具体控件） */
const settingsFocus = ref<'global-knowledge' | null>(null)

/** 请求编辑某台主机（Agent 空态的"去写本机知识"）；HostSidebar 消费后自行置空 */
const hostEditRequest = ref<string | null>(null)

/**
 * 左右侧栏显隐与宽度（v0.13.3 折叠；v0.13.11 调宽 + 记忆）。
 *
 * 这几个 ref 是**运行期唯一真值**；settings.json 里的同名字段只是持久化镜像——
 * 启动时 hydrateLayout 回填一次，之后每个提交点（折叠、松手、双击复位、切 tab、切会话换了栏）
 * 调 persistLayout 全量写回。别的组件不要从 settings 读它们。
 * v0.13.3 曾裁决"折叠只活在本次运行"，运维日用后改口要记住——机制不变，只加持久化。
 *
 * 折叠**不是卸载**（App.vue 用 class 绑 `hidden`，不是 v-if）：左栏模板里挂着
 * 主机表单 / 导入全局单例弹窗，右栏挂着 focusManager 的 Agent 输入
 * 注册与 prompt 构成的 immediate watch——卸载掉这些全得重建。
 */
const leftPaneOpen = ref(true)
const rightPaneOpen = ref(true)
const leftPaneWidth = ref(PANE_DEFAULT_WIDTH.left)
const rightPaneWidth = ref(PANE_DEFAULT_WIDTH.right)

/**
 * 拖拽进行中：TerminalView 的 ResizeObserver 看它决定要不要 fit。
 * 拖动期间中栏每变一像素都会触发 observer，跨一个字符宽就是一次 ssh:resize =
 * 一次 SIGWINCH，一次拖拽能打二十几下，远端 vim/htop 会被刷乱。松手置回 false，
 * TerminalView 补一次 fit——一次拖拽只换一次 resize。
 */
const paneDragging = ref(false)

function paneWidth(side: PaneSide): typeof leftPaneWidth {
  return side === 'left' ? leftPaneWidth : rightPaneWidth
}

/** 启动回填：在 App setup、首帧之前调用。宽度按绝对边界夹，settings.json 手改成垃圾也不崩 */
export function hydrateLayout(settings: AppSettings): void {
  leftPaneOpen.value = settings.leftPaneOpen
  rightPaneOpen.value = settings.rightPaneOpen
  leftPaneWidth.value = clampPaneWidth('left', settings.leftPaneWidth) ?? PANE_DEFAULT_WIDTH.left
  rightPaneWidth.value =
    clampPaneWidth('right', settings.rightPaneWidth) ?? PANE_DEFAULT_WIDTH.right
  rightPanelTabInner.value =
    settings.rightPanelTab === 'files'
      ? 'files'
      : settings.rightPanelTab === 'cli' && settings.cliBridgeEnabled
        ? 'cli'
        : 'agent'
}

/**
 * 全量写回五个字段。失败只记日志、不回滚、不弹提示——这是对"写入口必须回执"的
 * 有意例外：布局不是数据，内存态就是用户此刻的意图，下一次提交成功即自愈；
 * 把刚拖好的栏弹回去比丢一次记忆更糟。
 */
export function persistLayout(): void {
  void updateSettings({
    leftPaneOpen: leftPaneOpen.value,
    rightPaneOpen: rightPaneOpen.value,
    leftPaneWidth: leftPaneWidth.value,
    rightPaneWidth: rightPaneWidth.value,
    rightPanelTab: rightPanelTabInner.value
  }).catch((err: unknown) => {
    console.warn('[layout] 布局记忆写盘失败，本次运行仍按当前布局', err)
  })
}

export function toggleLeftPane(): void {
  leftPaneOpen.value = !leftPaneOpen.value
  persistLayout()
}

export function toggleRightPane(): void {
  rightPaneOpen.value = !rightPaneOpen.value
  persistLayout()
}

/**
 * 程序化请回右栏（Ctrl+Shift+A 跳 Agent）：藏着时 Agent 输入框在 `display:none`
 * 的子树里，focus() 会静默失败。**这也是折叠必须用 class 绑定而非 v-show 的原因**
 * ——v-show 的 display 更新是 post-render effect，会晚于落焦用的 post watcher。
 */
export function revealRightPane(): void {
  if (rightPaneOpen.value) return
  rightPaneOpen.value = true
  persistLayout()
}

/**
 * 拖拽调宽三步。上限在 pointerdown 时按容器宽与另一栏**有效**宽算一次
 * ——拖动中窗口不会变，另一栏有效宽在 flex 收缩时可能小于其偏好值，所以由 App.vue
 * 量 DOM 传进来，这里不碰 DOM。存的是偏好宽，显示宽由 CSS flex 在窗口太窄时自动让位。
 */
let drag: { side: PaneSide; startWidth: number; max: number } | null = null

export function beginPaneDrag(side: PaneSide, containerWidth: number, otherWidth: number): void {
  drag = {
    side,
    startWidth: paneWidth(side).value,
    max: maxPaneWidth(side, containerWidth, otherWidth)
  }
  paneDragging.value = true
}

/** dx = 指针相对按下点的横向位移；左栏往右拖变宽，右栏往右拖变窄 */
export function movePaneDrag(dx: number): void {
  if (!drag) return
  const raw = drag.side === 'left' ? drag.startWidth + dx : drag.startWidth - dx
  paneWidth(drag.side).value = Math.min(
    drag.max,
    Math.max(PANE_MIN_WIDTH[drag.side], Math.round(raw))
  )
}

/** 松手：结束抑制（TerminalView 随即补 fit），宽度真变了才写盘 */
export function endPaneDrag(): void {
  if (!drag) return
  const changed = paneWidth(drag.side).value !== drag.startWidth
  drag = null
  paneDragging.value = false
  if (changed) persistLayout()
}

/** 双击把手：回默认宽 */
export function resetPaneWidth(side: PaneSide): void {
  if (paneWidth(side).value === PANE_DEFAULT_WIDTH[side]) return
  paneWidth(side).value = PANE_DEFAULT_WIDTH[side]
  persistLayout()
}

/** 标题栏齿轮：不带诉求地打开，一律落在第一节 */
export function openSettings(section: SettingsSection = 'appearance'): void {
  settingsSection.value = section
  settingsFocus.value = null
  settingsOpen.value = true
}

/** Agent 空态的"去写全局知识"：切到知识节并把光标送进文本域 */
export function openGlobalKnowledge(): void {
  settingsSection.value = 'knowledge'
  settingsFocus.value = 'global-knowledge'
  settingsOpen.value = true
}

export function useUiStore() {
  return {
    rightPanelTab,
    settingsOpen,
    settingsSection,
    settingsFocus,
    hostEditRequest,
    leftPaneOpen,
    rightPaneOpen,
    leftPaneWidth,
    rightPaneWidth,
    paneDragging
  }
}
