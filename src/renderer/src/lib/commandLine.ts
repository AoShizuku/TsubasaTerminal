import type { IMarker, Terminal } from '@xterm/xterm'

/**
 * 直打命令的屏幕读取：133;B 记下输入起点，133;C 时读出起点到光标之间
 * 已经渲染好的命令行。
 *
 * 回显流是行编辑器的绘制指令而不是命令文本：zle 首键重绘、accept-line 整行重显、
 * 行中插入重输出光标后半段、autosuggestions 灰字与 syntax-highlighting 每键重着色，
 * 剥掉光标移动后会首尾相接（arch 真机：`ls /tmp` → `lllslslsls ls /tmp///ttmmp`）。
 * xterm 已经把这些全部执行完，C 时刻屏幕上就是 shell 接受的那一行。
 *
 * 与 composer-design「不从屏幕反推输入行」不冲突：那条说的是输入过程中实时推断
 * （prompt、方向键、补全都还在变）；这里只读 C 时刻的终态，起点由 B 精确给出。
 * 两个 OSC 处理器都在 xterm 解析到该序列的同步时刻执行，屏幕状态与字节流严格对齐。
 */

interface LineStart {
  marker: IMarker
  x: number
}

/** 与转录回显上限同量级：再长的"命令"多半是粘贴进来的大段文本 */
const MAX_LINES = 200
const MAX_CHARS = 16 * 1024

const starts = new Map<string, LineStart>()

function dropStart(sessionId: string): void {
  starts.get(sessionId)?.marker.dispose()
  starts.delete(sessionId)
}

/** 133;B：记下输入起点。marker 随 scrollback 裁剪漂移，被裁掉即失效 */
export function markCommandLineStart(sessionId: string, term: Terminal): void {
  dropStart(sessionId)
  const buffer = term.buffer.active
  if (buffer.type !== 'normal') return
  const marker = term.registerMarker(0)
  if (marker) starts.set(sessionId, { marker, x: buffer.cursorX })
}

/**
 * 133;C：读出 B 起点到光标之前的命令行。回车后光标落在下一行行首，读到上一行为止；
 * 软折行（isWrapped）无缝拼接，硬换行（多行命令）保留 `\n`。读不到返回 null，
 * 调用方退回回显近似。
 */
export function readCommandLine(sessionId: string, term: Terminal): string | null {
  const start = starts.get(sessionId)
  starts.delete(sessionId)
  if (!start) return null
  const { marker, x } = start
  try {
    const buffer = term.buffer.active
    if (marker.isDisposed || marker.line < 0 || buffer.type !== 'normal') return null
    const cursorLine = buffer.baseY + buffer.cursorY
    const lastLine = buffer.cursorX === 0 ? cursorLine - 1 : cursorLine
    if (lastLine < marker.line || lastLine - marker.line >= MAX_LINES) return null
    let text = ''
    for (let y = marker.line; y <= lastLine; y++) {
      const line = buffer.getLine(y)
      if (!line) return null
      const startCol = y === marker.line ? x : 0
      const endCol = y === cursorLine ? buffer.cursorX : undefined
      const continued = y < lastLine && buffer.getLine(y + 1)?.isWrapped === true
      if (y > marker.line && !line.isWrapped) text += '\n'
      text += line.translateToString(!continued, startCol, endCol)
      if (text.length > MAX_CHARS) return null
    }
    return text.trim()
  } finally {
    marker.dispose()
  }
}

export function disposeCommandLine(sessionId: string): void {
  dropStart(sessionId)
}
