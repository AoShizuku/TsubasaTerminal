import type { TerminalWriteStatus } from '../../shared/types'

/**
 * 终端可写状态单点（composer-design「不变量：prompt 不再等于 pty 输入行为空」）。
 *
 * 渲染进程上报结构化状态（clean/dirty/running/tui/none-unverified），所有要往用户
 * pty 写整行命令的路径（信任免问、单机批准、多机批准、CLI pty 路口）都消费这里的
 * 同一份事实——忙因文案也只在这里生成一份，别再各写各的。
 *
 * **fail-closed**：从未收到上报（会话刚建、渲染层状态丢失、tmux 保活重连回 TUI
 * 现场收不到任何 133）一律视为未知=不可写。此前"未上报默认空闲"是固定栏时代的
 * 宽松假设，原生输入下会把 Agent 命令喂进半行 readline / rc 脚本 / 前台程序。
 *
 * 独立成文件而不并在 approvals.ts：ssh.ts 的 `ssh:input` 路口要在转发人的字节前
 * 标记会话（关掉上报与写入之间的竞态），而 approvals.ts import 了 ssh.ts——
 * 反向 import 就是新环，循环依赖守卫会红。
 */

const writeStates = new Map<string, TerminalWriteStatus>()

export function noteTerminalWriteState(sessionId: string, status: TerminalWriteStatus): void {
  writeStates.set(sessionId, status)
}

/** 唯一的可写判定：只有明确上报过 clean 才放行（未知即不可写） */
export function isTerminalIdle(sessionId: string): boolean {
  return writeStates.get(sessionId) === 'clean'
}

/** 不可写原因的人读文案（clean 时返回"空闲"，正常路径不该拿它拼错误信息） */
export function terminalBusyText(sessionId: string): string {
  switch (writeStates.get(sessionId)) {
    case 'clean':
      return '空闲'
    case 'dirty':
      return '终端输入行非空（用户敲了半行命令）'
    case 'running':
      return '命令运行中'
    case 'tui':
      return '正在全屏应用（TUI）中'
    case 'none-unverified':
      return '无 shell integration，无法确认输入行为空（需用户在状态条点「已回到空提示符」）'
    default:
      return '终端状态未知（会话尚未就绪）'
  }
}

/**
 * 人的 pty 输入到达（ssh:input 转发前调用）：clean 立即降级为 dirty，关掉
 * "渲染层上报还在路上、写入已经发生"的竞态窗口。running/tui 等状态保持原样
 * ——它们本就不可写，覆盖成 dirty 只会把忙因文案改差。
 */
export function noteHumanPtyInput(sessionId: string): void {
  if (writeStates.get(sessionId) === 'clean') writeStates.set(sessionId, 'dirty')
}

/** Agent/CLI 命令写入 pty 的瞬间标记 running：写入方与检查方同在主进程单线程，
 *  check-and-mark 在同一同步段完成，两个写入方（信任免问 vs 多机批准）不会互踩 */
export function markCommandWritten(sessionId: string): void {
  writeStates.set(sessionId, 'running')
}

export function disposeTerminalState(sessionId: string): void {
  writeStates.delete(sessionId)
}
