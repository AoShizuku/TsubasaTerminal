import type { ZmodemKind } from '@shared/types'
import { getTranscriptContext } from './transcript'
import { onSessionCommandFinished } from '@/composables/useFileStore'

/**
 * ZMODEM→SFTP 拦截桥的 renderer 驱动（见 doc/transfer-design.md）：
 * 主进程已检测起始帧并 CAN 中止，这里从转录状态取 cwd/命令文本，
 * 解析 sz 参数驱动 SFTP 下载，或把 rz 转成上传对话框。
 * hint 行走 xterm 本地写入（不经 pty、不进转录）。
 */

const C_INFO = '\x1b[36m'
const C_OK = '\x1b[32m'
const C_WARN = '\x1b[33m'
const C_ERR = '\x1b[31m'
const C_END = '\x1b[0m'

/** 引号感知分词（单引号内不转义，双引号/裸词支持 \ 转义） */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  let hasToken = false
  for (const ch of line) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      hasToken = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) tokens.push(cur)
      cur = ''
      hasToken = false
      continue
    }
    cur += ch
    hasToken = true
  }
  if (hasToken) tokens.push(cur)
  return tokens
}

/** 从命令文本解析 sz 的文件参数；解析不出返回 null（区别于空数组） */
function parseSzArgs(command: string): { files: string[]; skippedGlobs: string[] } | null {
  const tokens = tokenize(command)
  if (!tokens.length) return null
  const head = tokens[0]
  const cmdName = head.slice(head.lastIndexOf('/') + 1)
  if (cmdName !== 'sz') return null
  const files: string[] = []
  const skippedGlobs: string[] = []
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) continue
    if (/[*?[]/.test(token)) skippedGlobs.push(token)
    else files.push(token)
  }
  return { files, skippedGlobs }
}

/**
 * 桥入口：主进程在 133;D 后扣押 prompt 输出，等这里收尾（finally 无条件
 * release）再放行——保证视觉顺序：检测提示 → ✓ 结果 → prompt 干净落底。
 */
export async function handleZmodemDetected(
  sessionId: string,
  kind: ZmodemKind,
  writeLine: (text: string) => void
): Promise<void> {
  try {
    await runBridge(sessionId, kind, writeLine)
  } finally {
    window.api.transfer.bridgeRelease(sessionId)
  }
}

async function runBridge(
  sessionId: string,
  kind: ZmodemKind,
  writeLine: (text: string) => void
): Promise<void> {
  const ctx = getTranscriptContext(sessionId)
  if (kind === 'upload') {
    writeLine(`\r\n${C_INFO}[Tsubasa Terminal] 检测到 ZMODEM(rz)，已中止，转 SFTP 上传…${C_END}`)
    const res = await window.api.transfer.bridgeUpload(sessionId, ctx.cwd)
    if (res.canceled) {
      writeLine(`${C_WARN}[Tsubasa Terminal] 上传已取消${C_END}`)
    } else if (res.ok && res.uploaded) {
      writeLine(
        `${C_OK}[Tsubasa Terminal] 已上传 ${res.uploaded.length} 个文件到 ${ctx.cwd ?? '~'}：` +
          `${res.uploaded.join('、')}${C_END}`
      )
      // 传输不经 shell，命令结束信号不会来——手动触发文件栏跟随刷新
      onSessionCommandFinished(sessionId)
    } else {
      // 诊断随主进程 error 携带（v0.11.0 errno 分流）：不存在才提嵌套/trzsz，
      // 权限问题说身份不足——此前两种都吐"嵌套够不着"是误诊
      writeLine(`${C_ERR}[Tsubasa Terminal] 上传失败：${res.error ?? '未知错误'}${C_END}`)
    }
    return
  }

  writeLine(`\r\n${C_INFO}[Tsubasa Terminal] 检测到 ZMODEM(sz)，已中止，转 SFTP 下载…${C_END}`)
  const parsed = ctx.command ? parseSzArgs(ctx.command) : null
  if (!parsed) {
    writeLine(
      `${C_WARN}[Tsubasa Terminal] 无法解析命令参数——` +
        `请在文件栏手动下载，或在远端安装 trzsz 后使用 tsz${C_END}`
    )
    return
  }
  for (const glob of parsed.skippedGlobs) {
    writeLine(`${C_WARN}[Tsubasa Terminal] 通配符参数不支持，已跳过：${glob}（请用文件栏或 tsz）${C_END}`)
  }
  if (!parsed.files.length) {
    writeLine(`${C_WARN}[Tsubasa Terminal] sz 未带可下载的文件参数${C_END}`)
    return
  }
  const res = await window.api.transfer.bridgeDownload(sessionId, parsed.files, ctx.cwd)
  if (res.canceled) {
    writeLine(`${C_WARN}[Tsubasa Terminal] 下载已取消${C_END}`)
    return
  }
  if (!res.ok && res.error) {
    writeLine(`${C_ERR}[Tsubasa Terminal] 下载失败：${res.error}${C_END}`)
    return
  }
  for (const file of res.files ?? []) {
    if (file.ok) {
      writeLine(`${C_OK}[Tsubasa Terminal] ✓ ${file.name} → ${res.savedTo}${C_END}`)
    } else {
      // 逐文件错误已带 errno 分流诊断，不再无条件补"嵌套够不着"
      writeLine(`${C_ERR}[Tsubasa Terminal] ✗ ${file.name}：${file.error ?? '失败'}${C_END}`)
    }
  }
}
