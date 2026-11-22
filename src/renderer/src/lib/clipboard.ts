import { ref } from 'vue'
import { composerState } from '@/composables/useComposerStore'
import { useSettingsStore } from '@/composables/useSettingsStore'
import { confirmDialog } from '@/lib/confirm'
import { focusHome, insertIntoComposer } from '@/lib/focusManager'
import { getTerminal } from '@/lib/terminalRegistry'

const { settings } = useSettingsStore()

/**
 * 复制单点入口。
 *
 * 复制在本应用是个焦点问题：终端的 Ctrl+C 天生是 SIGINT，而"点空白回家"的
 * 焦点纪律会在 focus 输入框时把页面选区一并收走——两条路都被堵死过。
 * 现在复制统一经这里，顺带发一个显性信号：选中即复制是隐形动作，
 * focus-design 的第三条易忘细节要求隐形规则必须配显性反馈。
 */

export interface CopyToast {
  chars: number
  /** 递增序号：连续复制同样长度的文本也要能重新触发提示 */
  seq: number
}

export const copyToast = ref<CopyToast | null>(null)

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** 提示由复制事件驱动；原生 Ctrl+C（DOM 选区）走 noteNativeCopy，不重复写剪贴板 */
export function noteNativeCopy(chars: number): void {
  if (chars <= 0) return
  seq += 1
  copyToast.value = { chars, seq }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (copyToast.value = null), 1500)
}

/**
 * 写系统剪贴板并给出提示；空文本不写（单击清选区不该清空剪贴板）。
 * 异步是必须的：写剪贴板会失败（文档失焦时浏览器直接拒绝），
 * "已复制"这三个字只能出现在写入兑现之后——先报后写就是在撒谎。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return false
  }
  noteNativeCopy(text.length)
  return true
}

/**
 * 终端选区收尾整形：去掉尾部空白行。
 * xterm 的行选择保留整行结构，拖到屏幕底部会带上整屏空行（实测 35 行），
 * 粘出来是一大段空白——尾部空白从来不是用户想要的那部分。
 */
export function trimTerminalSelection(text: string): string {
  return text.replace(/\s+$/, '')
}

/**
 * 粘贴单点入口。落点按 composer 模式分流，与焦点的"家"同一套规则：
 * prompt 态进草稿（粘来的多行命令先看得见、能改，Enter 才发送），其余态直通 pty。
 *
 * 直通必须走 `term.paste()` 而不是自己拼 `ssh.input`——\r\n 归一与 bracketed
 * paste（\x1b[200~/201~）包裹都在 xterm 内部：不经过包裹的话粘贴文本里的换行会被
 * shell 当回车逐条立刻执行、Tab 会触发补全。paste() 内部照旧经 onData 出去，
 * 链路与手打完全一致。
 *
 * 读剪贴板走主进程（`navigator.clipboard.readText` 要权限 + 用户手势，Electron
 * 下不稳），返回是否真的粘了——剪贴板为空时什么都不做。
 */
export async function pasteToSession(sessionId: string): Promise<boolean> {
  const text = await window.api.clipboard.readText()
  if (!text) return false
  const state = composerState(sessionId)
  if (state.mode === 'prompt' && state.effectiveInput === 'composer') {
    insertIntoComposer(sessionId, text)
    return true
  }
  const term = getTerminal(sessionId)
  if (!term) return false
  // 多行直通粘贴护栏：落点是 shell 行（prompt/none）且内容含换行时
  // 先确认一次——bracketed paste 不能假设远端开启（老 bash、网络设备、restricted
  // shell 恰是会用直通的那批），没开时每个换行都是立即执行的回车。running/tui
  // 不拦：粘进 REPL / 编辑器是常态。fixed prompt 粘进草稿可见可改，本就不经这里。
  // v0.13.12：不再假设，改为看远端——`modes.bracketedPasteMode` 是远端自己发的
  // `CSI ?2004h`，开着时整块进行缓冲、回车才执行，不必问；设置里也可整体关掉。
  if (
    settings.value?.terminalConfirmMultilinePaste !== false &&
    !term.modes.bracketedPasteMode &&
    (state.mode === 'prompt' || state.mode === 'none') &&
    /[\r\n]/.test(text)
  ) {
    const lines = text.split(/\r\n|[\r\n]/)
    const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    const ok = await confirmDialog({
      title: '确认多行粘贴',
      message: `剪贴板内容有 ${count} 行，将直接送入终端——远端未启用 bracketed paste 时逐行立即执行。`,
      detail: pastePreview(lines.slice(0, count)),
      confirmText: '粘贴'
    })
    if (!ok) return false
    // v0.13.13 确认框是异步的：等待期间会话可能已关闭，重新取终端，不往已销毁的实例里写
    const current = getTerminal(sessionId)
    if (!current) return false
    current.paste(text)
    focusHome()
    return true
  }
  term.paste(text)
  focusHome()
  return true
}

const PREVIEW_LINES = 5
const PREVIEW_LINE_CHARS = 200

/** 确认框里的内容预览：前几行原样给看，超出的只报行数 */
function pastePreview(lines: string[]): string {
  const head = lines.slice(0, PREVIEW_LINES).map((line) => line.slice(0, PREVIEW_LINE_CHARS))
  const rest = lines.length - head.length
  return rest > 0 ? `${head.join('\n')}\n…… 另有 ${rest} 行` : head.join('\n')
}

/** 页面上是否有真实的文本选区（textarea/input 的内部选区不进 document selection） */
export function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0
}
