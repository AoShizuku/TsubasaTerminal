import type { SftpEntry } from '@shared/types'

export interface FileNode {
  entry: SftpEntry
  expanded: boolean
  loading: boolean
  /** null 表示尚未加载 */
  children: FileNode[] | null
  error?: string
}

export function toNode(entry: SftpEntry): FileNode {
  return { entry, expanded: false, loading: false, children: null }
}
