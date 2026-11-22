<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore, type TerminalSession } from '@/composables/useAppStore'
import {
  onSessionCommandFinished,
  parseOsc7,
  setSessionCwd
} from '@/composables/useFileStore'
import {
  appendDraft,
  composerState,
  enterRunning,
  initComposerReporting,
  noteOutput,
  onBufferTypeChange,
  onPromptReady,
  onSessionGone,
  sendHumanInput
} from '@/composables/useComposerStore'
import { useSettingsStore } from '@/composables/useSettingsStore'
import { useUiStore } from '@/composables/useUiStore'
import TerminalContextMenu from './TerminalContextMenu.vue'
import { copyText, pasteToSession, trimTerminalSelection } from '@/lib/clipboard'
import { elevationReasonText } from '@/lib/elevation'
import { disposeCommandLine, markCommandLineStart, readCommandLine } from '@/lib/commandLine'
import { focusHome } from '@/lib/focusManager'
import { acceptPromptReady, disposeGuard, note133 } from '@/lib/oscGuard'
import { buildFontFamily, minimumContrastFor, themeById } from '@shared/terminalThemes'
import { disposeSiReinject, initSiReinject } from '@/lib/siReinject'
import {
  disposeTranscript,
  feedTranscript,
  initTranscript,
  noteScreenCommand
} from '@/lib/transcript'
import { handleZmodemDetected } from '@/lib/transferBridge'
import { registerTerminal, unregisterTerminal } from '@/lib/terminalRegistry'
import { installUnicodeWidth, TERMINAL_UNICODE_OPTIONS } from '@/lib/unicodeWidth'

const props = defineProps<{
  session: TerminalSession
  active: boolean
}>()

const { setSessionStatus, setSessionElevation } = useAppStore()
const { settings } = useSettingsStore()
const { paneDragging } = useUiStore()

const container = ref<HTMLDivElement | null>(null)

let term: Terminal | null = null
let fit: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
const disposers: Array<() => void> = []

/**
 * 断线自动重连（v0.9 会话可靠性）：只有**非干净关闭**（网络断开、服务端崩溃——
 * 主进程未见 shell 退出状态）触发；exit/logout 是用户意图，不重连。
 * 指数退避有限次；主机开了 tmux 保活则重连后 bootstrap 自动 attach 回原现场。
 */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let everConnected = false
let unmounted = false

function scheduleReconnect(): void {
  if (unmounted) return
  if (reconnectAttempt >= RECONNECT_DELAYS.length) {
    setSessionStatus(props.session.id, 'error', '自动重连失败')
    term?.writeln('\r\n\x1b[31m[自动重连失败，已放弃——可关闭标签后重新连接]\x1b[0m')
    return
  }
  const delay = RECONNECT_DELAYS[reconnectAttempt]
  reconnectAttempt += 1
  setSessionStatus(props.session.id, 'connecting')
  term?.writeln(
    `\r\n\x1b[90m[连接断开，${delay / 1000}s 后自动重连（${reconnectAttempt}/${RECONNECT_DELAYS.length}）…]\x1b[0m`
  )
  reconnectTimer = setTimeout(() => void reconnect(), delay)
}

async function reconnect(): Promise<void> {
  if (unmounted || !term) return
  try {
    const result = await window.api.ssh.connect(props.session.id, props.session.host.id, {
      cols: term.cols,
      rows: term.rows
    })
    if (unmounted) return
    if (result.ok) {
      reconnectAttempt = 0
      setSessionStatus(props.session.id, 'connected')
      term.writeln('\x1b[90m[已重连]\x1b[0m')
    } else {
      scheduleReconnect()
    }
  } catch {
    if (!unmounted) scheduleReconnect()
  }
}

onMounted(async () => {
  // 外观：配色/字体/字号来自全局设置；字体栈殿后 CJK 等宽回退保 2:1 对齐。
  // 浅色方案另开最低对比度（见 minimumContrastFor）
  const themeDef = themeById(settings.value?.terminalTheme)
  term = new Terminal({
    cursorBlink: true,
    fontSize: settings.value?.terminalFontSize ?? 13,
    fontFamily: buildFontFamily(settings.value?.terminalFontFamily ?? ''),
    scrollback: 5000,
    theme: themeDef.theme,
    minimumContrastRatio: minimumContrastFor(themeDef),
    ...TERMINAL_UNICODE_OPTIONS
  })
  installUnicodeWidth(term)
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container.value!)
  fit.fit()
  registerTerminal(props.session.id, term)
  initTranscript(props.session.id, props.session.host.id)
  // write-safe 初始态上报（v0.13.4 fail-closed）：无 SI 主机可能永远没有模式变化
  initComposerReporting(props.session.id)
  // 自动重载 SI：幂等接线，监听转录的"命令开始"事件
  initSiReinject()

  // shell integration：OSC 7 上报 cwd；OSC 133;C 命令开始 / D 命令结束 / A prompt 就绪
  term.parser.registerOscHandler(7, (data) => {
    const path = parseOsc7(data)
    if (path) setSessionCwd(props.session.id, path)
    return true
  })
  term.parser.registerOscHandler(133, (data) => {
    const kind = data[0] ?? ''
    // 直打命令的屏幕读数：与转录组装器逐个 C 配对，故排在限流之前、
    // 每个 C 都入队（读不到也占位）；不改任何状态，伪造的 B/C 至多换来一条读数，
    // 还要过转录侧的回显子序列校验
    if (term && kind === 'B') markCommandLineStart(props.session.id, term)
    else if (term && kind === 'C') noteScreenCommand(props.session.id, readCommandLine(props.session.id, term))
    // 合理性校验：限流丢弃 + A 只在紧随 D 时可信（防输出内容伪造 A 抢输入路由）
    const { ok, prev } = note133(props.session.id, kind)
    if (!ok) return true
    if (kind === 'C') enterRunning(props.session.id)
    else if (kind === 'D') onSessionCommandFinished(props.session.id)
    else if (kind === 'A' && acceptPromptReady(prev)) onPromptReady(props.session.id)
    return true
  })

  // 备用屏幕缓冲区切换（vim/htop）→ composer 模式路由
  const bufferListener = term.buffer.onBufferChange((buffer) =>
    onBufferTypeChange(props.session.id, buffer.type)
  )
  disposers.push(() => bufferListener.dispose())

  // prompt 态落在 xterm 上的按键路由回 composer（点终端选完文本直接打字不丢键）。
  // 只在固定输入栏模式生效：native 下键本就该逐段进 pty，全部放行
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const state = composerState(props.session.id)
    if (state.mode !== 'prompt' || state.effectiveInput !== 'composer') return true
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      appendDraft(props.session.id, ev.key)
      focusHome()
      return false
    }
    if (ev.key === 'Enter') {
      focusHome()
      return false
    }
    return true
  })

  // 统一出口：写 pty 前先标 lineDirty（native prompt / none），别绕过
  term.onData((data) => sendHumanInput(props.session.id, data))
  term.onResize(({ cols, rows }) => window.api.ssh.resize(props.session.id, cols, rows))

  /**
   * 选中即复制（设置可关）：终端的 Ctrl+C 是 SIGINT，复制与中断抢同一个键，
   * 把复制挪到鼠标路径才能同时绕开焦点与键位两重冲突。
   * 用 mouseup 提交而不是 onSelectionChange——后者在拖动中每帧触发，会把剪贴板刷爆；
   * mouseup 挂 window，拖出终端区域松手也算数。双击选词/三击选行/Alt 列选天然覆盖。
   */
  let selecting = false
  const onSelectStart = (ev: MouseEvent): void => {
    // 只有左键在拖选。右键不滤掉的话，右键粘贴会先闪一次"已复制"（xterm 有选区时
    // 也不清选区，onSelectEnd 会把同样内容再复制一遍）
    if (ev.button !== 0) return
    selecting = true
  }
  const onSelectEnd = (): void => {
    if (!selecting) return
    selecting = false
    if (settings.value?.terminalCopyOnSelect === false) return
    if (!term?.hasSelection()) return
    void copyText(trimTerminalSelection(term.getSelection()))
  }
  container.value!.addEventListener('mousedown', onSelectStart)
  window.addEventListener('mouseup', onSelectEnd)
  disposers.push(() => {
    container.value?.removeEventListener('mousedown', onSelectStart)
    window.removeEventListener('mouseup', onSelectEnd)
  })

  disposers.push(
    window.api.ssh.onData((sessionId, data) => {
      if (sessionId !== props.session.id) return
      // 同一份字节流喂转录组装器（独立扫描，不依赖 xterm parser）。放在 xterm 解析完
      // 这一块之后：组装器扫到 133;C 时，屏幕读数已由 OSC 处理器入队
      term?.write(data, () => feedTranscript(sessionId, data))
      // SI 断链检测的心跳：只写时间戳，不触发响应式
      noteOutput(sessionId)
    }),
    window.api.ssh.onDataTransient((sessionId, data) => {
      if (sessionId !== props.session.id) return
      // trzsz 传输进度：人屏可见、不喂转录（Agent 上下文剥离，v0.8.4）。
      // 心跳仍要打——传输期间终端并没有卡住
      noteOutput(sessionId)
      term?.write(data)
    }),
    window.api.ssh.onZmodem((sessionId, kind) => {
      if (sessionId !== props.session.id) return
      // hint 行 xterm 本地写入：不经 pty、不进转录。整行纪律（行尾换行），
      // 桥收尾后主进程放行的 prompt 从新行 0 列起笔不粘行
      void handleZmodemDetected(sessionId, kind, (text) => term?.write(`${text}\r\n`))
    }),
    window.api.ssh.onExit((sessionId, clean) => {
      if (sessionId !== props.session.id) return
      onSessionGone(sessionId)
      // 非干净关闭 + 曾成功连接 → 自动重连；用户 exit/logout（clean）照旧收场
      if (!clean && everConnected) {
        scheduleReconnect()
        return
      }
      if (props.session.status === 'connected' || props.session.status === 'connecting') {
        setSessionStatus(sessionId, 'closed')
        term?.writeln('\r\n\x1b[90m[连接已关闭]\x1b[0m')
      }
    }),
    window.api.ssh.onError((sessionId, message) => {
      if (sessionId !== props.session.id) return
      onSessionGone(sessionId)
      // 已建立过的连接报错（网络抖动）只提示不定性——随后的非干净 close 走重连；
      // 从未连上的错误照旧置 error 收场
      if (!everConnected) setSessionStatus(sessionId, 'error', message)
      term?.writeln(`\r\n\x1b[31m[连接错误] ${message}\x1b[0m`)
    }),
    window.api.ssh.onElevation((sessionId, info) => {
      if (sessionId !== props.session.id) return
      setSessionElevation(sessionId, info)
      // 降级绝不静默（identity-design）：徽章之外终端里也落一行原因——徽章可能没被
      // 注意到，而用户接下来的每条命令都会以登录用户身份跑。xterm 本地写入，不经 pty
      if (info.requested && !info.active) {
        term?.writeln(
          `\r\n\x1b[33m[以 root 运行未生效：${elevationReasonText(info.reason)}——本会话为登录用户身份]\x1b[0m`
        )
      }
    })
  )

  // 拖拽调宽期间不 fit：每跨一个字符宽就是一次 ssh:resize = 一次 SIGWINCH，
  // 松手后由下面 paneDragging 的 watch 补一次。画布在拖动中保持旧尺寸——
  // 加宽露出的是同色 themeBg，收窄由 terminal-area 的 overflow-hidden 裁掉
  resizeObserver = new ResizeObserver(() => {
    if (props.active && !paneDragging.value) fit?.fit()
  })
  resizeObserver.observe(container.value!)

  const { host } = props.session
  term.writeln(`\x1b[90m正在连接 ${host.username}@${host.host}:${host.port} ...\x1b[0m`)

  try {
    const result = await window.api.ssh.connect(props.session.id, host.id, {
      cols: term.cols,
      rows: term.rows
    })
    if (result.ok) {
      if (result.hostKey?.status === 'new') {
        term.writeln(`\x1b[90m已记录主机密钥指纹 ${result.hostKey.fingerprint}\x1b[0m`)
      }
      everConnected = true
      setSessionStatus(props.session.id, 'connected')
      // 连接成功获焦：用户双击主机这一显式动作的延续（focus-design 允许项）
      focusHome()
    } else {
      setSessionStatus(props.session.id, 'error', result.error)
      term.writeln(`\r\n\x1b[31m[连接失败] ${result.error ?? '未知错误'}\x1b[0m`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSessionStatus(props.session.id, 'error', message)
    term.writeln(`\r\n\x1b[31m[连接失败] ${message}\x1b[0m`)
  }
})

watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick()
      fit?.fit()
      focusHome()
    }
  }
)

// 侧栏拖拽松手：抑制期间攒下的尺寸变化在这里一次结清。
// 宽度没变 fit 也是空操作（cols/rows 不变就不触发 onResize，远端零感知）
watch(paneDragging, async (dragging) => {
  if (dragging) return
  await nextTick()
  if (props.active) fit?.fit()
})

// 进出 TUI 时 composer 显隐改变终端高度，显式 refit 兜底（不依赖 ResizeObserver 时序）；
// 切输入模式同理：native 收起命令输入行，底部坞高度变了
watch(
  () => [
    composerState(props.session.id).mode === 'tui',
    composerState(props.session.id).effectiveInput
  ],
  async () => {
    await nextTick()
    if (props.active) fit?.fit()
  }
)

// 外观设置变更即时应用（设置弹窗改 → 共享 store → 所有已开终端同步）
watch(
  () => [
    settings.value?.terminalTheme,
    settings.value?.terminalFontFamily,
    settings.value?.terminalFontSize
  ] as const,
  ([theme, font, size]) => {
    if (!term) return
    const def = themeById(theme)
    term.options.theme = def.theme
    term.options.minimumContrastRatio = minimumContrastFor(def)
    term.options.fontFamily = buildFontFamily(font ?? '')
    term.options.fontSize = size ?? 13
    if (props.active) fit?.fit()
  }
)

/** prompt 态点终端（选文本/看输出）后焦点回 composer；其余模式 xterm 自持 */
function onContainerClick(): void {
  if (composerState(props.session.id).mode === 'prompt') focusHome()
}

/** 右键菜单的落点（Shift+右键唤出，fixed 定位到光标处） */
const menu = ref<{ x: number; y: number } | null>(null)

/**
 * 右键：沿用 Windows Terminal 的键位传统，但语义随"选中即复制"设置走。
 * 开着（默认）时复制早在松手那一刻完成了，右键再背一次复制毫无收益 → 直接粘贴；
 * 关掉时才恢复 WT 的二合一（有选区先复制并清选区，下一次右键才是粘贴）。
 * 两种配置下心智是同一句话：右键 = 把剪贴板这件事做完。
 *
 * Shift+右键出菜单——Shift 修饰在 xterm 传统里本就是"绕开应用鼠标上报、我要终端
 * 自己的功能"，与下面 TUI 让位那条同源：应用（tmux/vim/htop）开了鼠标上报时
 * 右键归应用，xterm 已经把它编码发给 pty 了，我们不能截胡。
 */
function onContextMenu(ev: MouseEvent): void {
  const mouseApp = (term?.modes.mouseTrackingMode ?? 'none') !== 'none'
  if (mouseApp && !ev.shiftKey) return
  ev.preventDefault()
  if (ev.shiftKey) {
    menu.value = { x: ev.clientX, y: ev.clientY }
    return
  }
  if (settings.value?.terminalCopyOnSelect === false && term?.hasSelection()) {
    void copyText(trimTerminalSelection(term.getSelection()))
    term.clearSelection()
    return
  }
  void pasteToSession(props.session.id)
}

onBeforeUnmount(() => {
  unmounted = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  disposeGuard(props.session.id)
  disposeSiReinject(props.session.id)
  disposeTranscript(props.session.id)
  disposeCommandLine(props.session.id)
  unregisterTerminal(props.session.id)
  disposers.forEach((dispose) => dispose())
  resizeObserver?.disconnect()
  term?.dispose()
})
</script>

<template>
  <!-- padding 放外层：FitAddon 按 term.open 目标元素的 computed height 算行数
       （border-box 含 padding），padding 直接加在目标上会让网格溢出、底行被裁 -->
  <div
    data-testid="terminal-view"
    :data-session-id="session.id"
    class="h-full w-full pb-1 pl-2 pt-1 transition-shadow [&:has(.xterm:focus-within)]:shadow-[inset_2px_0_0_0_var(--ring)]"
    @click="onContainerClick"
    @contextmenu="onContextMenu"
  >
    <div ref="container" class="h-full w-full" />
    <TerminalContextMenu
      v-if="menu"
      :session-id="session.id"
      :x="menu.x"
      :y="menu.y"
      @close="menu = null"
    />
  </div>
</template>
