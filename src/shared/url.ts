/**
 * 外部链接放行判定。
 *
 * `shell.openExternal` 会把任意协议交给系统处理——`ms-settings:`、`smb://`、
 * 自定义协议都能拉起本机程序。Agent 文本可能复述被注入的远端内容，所以外开只放行
 * http / https。主进程 window.open handler 用它做硬闸；渲染进程用同一份判定
 * 决定是问"要不要打开"还是直接告知"打不开"，两边不会对同一个链接给出不同答案。
 */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
