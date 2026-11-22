/**
 * SFTP 错误分流（identity-design 存量兜底）：此前传输与文件栏把
 * EACCES 和 ENOENT 都吐同一句"嵌套 ssh/容器够不着"——把权限问题误诊成通道问题，
 * 比不提示更有害。按 SFTP 协议状态码分流：
 *   2 = SSH_FX_NO_SUCH_FILE   → 目标不存在（嵌套/容器的"够不着"属于这类）
 *   3 = SSH_FX_PERMISSION_DENIED → 身份不足（SFTP 是登录用户，终端身份切换不跟随）
 * 状态码缺失时退回报错文本匹配（ssh2 的 message 是固定英文，不随 locale 变）。
 */

export type SftpErrorKind = 'permission' | 'not-found' | 'other'

export function classifySftpError(err: unknown): SftpErrorKind {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 3) return 'permission'
  if (code === 2) return 'not-found'
  const message = err instanceof Error ? err.message : String(err)
  if (/permission denied/i.test(message)) return 'permission'
  if (/no such file/i.test(message)) return 'not-found'
  return 'other'
}

/**
 * 组装带诊断的错误文案。transferHint 供 ZMODEM 桥使用：目标不存在时补
 * trzsz 出路（嵌套场景 SFTP 只够得着第一跳，trzsz 走 pty 字节流不受限）。
 */
export function describeSftpError(err: unknown, opts: { transferHint?: boolean } = {}): string {
  const message = err instanceof Error ? err.message : String(err)
  switch (classifySftpError(err)) {
    case 'permission':
      return (
        `${message}——权限不足：SFTP 以 SSH 登录用户身份访问远端，` +
        `终端里的 sudo/su 切换身份不会作用于文件栏与传输，该路径需要更高权限`
      )
    case 'not-found':
      return (
        `${message}——目标不存在` +
        (opts.transferHint
          ? `；若当前在嵌套 ssh/容器中，SFTP 只够得着第一跳主机，请远端安装 trzsz 使用 trz/tsz`
          : `；若当前在嵌套 ssh/容器中，SFTP 只够得着第一跳主机`)
      )
    default:
      return message
  }
}
