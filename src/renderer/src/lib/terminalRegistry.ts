import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term)
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId)
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return terminals.get(sessionId)
}

/**
 * 每行中首个内容等于 marker 的单元格所在列（找不到的行不返回）。纯文本读不出宽字符占了
 * 几格，字符宽度的 e2e靠它断言同一标记在各行对齐
 */
export function getMarkerColumns(
  sessionId: string,
  marker: string
): Array<{ text: string; col: number }> | null {
  const term = terminals.get(sessionId)
  if (!term) return null
  const buffer = term.buffer.active
  const out: Array<{ text: string; col: number }> = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    for (let x = 0; x < line.length; x++) {
      if (line.getCell(x)?.getChars() === marker) {
        out.push({ text: line.translateToString(true), col: x })
        break
      }
    }
  }
  return out
}

/** 读取某个会话当前屏幕（含回滚）的纯文本。e2e 断言与未来 Agent 的 read_screen 共用这一能力 */
export function getTerminalText(sessionId: string): string | null {
  const term = terminals.get(sessionId)
  if (!term) return null
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}
