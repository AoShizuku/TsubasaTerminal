import { reactive } from 'vue'
import type { SftpEntry } from '@shared/types'
import { toNode, type FileNode } from '@/components/panels/file-tree'

export interface SessionFileState {
  home: string
  view: 'flat' | 'tree'
  /** 磁铁：视图路径是否跟随 shell 上报的 cwd */
  follow: boolean
  /** shell 上报的当前目录（OSC 7），null 表示尚未收到 */
  cwd: string | null
  /** 平铺视图当前展示的路径 */
  viewPath: string | null
  entries: SftpEntry[]
  entriesLoading: boolean
  entriesError: string
  tree: FileNode[]
  treeLoaded: boolean
  treeLoading: boolean
  treeError: string
  notice: string
  integrationActive: boolean
}

const states = reactive<Record<string, SessionFileState>>({})
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

function ensure(sessionId: string): SessionFileState {
  if (!states[sessionId]) {
    states[sessionId] = {
      home: '',
      view: 'flat',
      follow: true,
      cwd: null,
      viewPath: null,
      entries: [],
      entriesLoading: false,
      entriesError: '',
      tree: [],
      treeLoaded: false,
      treeLoading: false,
      treeError: '',
      notice: '',
      integrationActive: false
    }
  }
  return states[sessionId]
}

async function loadEntries(sessionId: string, path: string): Promise<void> {
  const state = ensure(sessionId)
  state.entriesLoading = true
  state.entriesError = ''
  const result = await window.api.sftp.list(sessionId, path)
  // 响应返回时视图可能已切换路径，丢弃过期响应
  if (states[sessionId] !== state || state.viewPath !== path) return
  state.entriesLoading = false
  if (result.ok && result.entries) {
    state.entries = result.entries
  } else {
    state.entriesError = result.error ?? '读取目录失败'
  }
}

async function loadTreeRoot(sessionId: string): Promise<void> {
  const state = ensure(sessionId)
  if (!state.home) return
  state.treeLoading = true
  state.treeError = ''
  const result = await window.api.sftp.list(sessionId, state.home)
  state.treeLoading = false
  if (result.ok && result.entries) {
    state.tree = result.entries.map(toNode)
    state.treeLoaded = true
  } else {
    state.treeError = result.error ?? '读取目录失败'
  }
}

/** 三件套之二：连接成功后后台预取 home 路径 + 首层目录 */
export async function prefetchSessionFiles(sessionId: string): Promise<void> {
  const state = ensure(sessionId)
  const home = await window.api.sftp.home(sessionId)
  if (states[sessionId] !== state) return
  if (!home.ok || !home.path) {
    // 预取失败不打扰用户，错误留到文件页可见时展示
    state.entriesError = home.error ?? 'SFTP 不可用'
    return
  }
  state.home = home.path
  if (!state.viewPath) {
    state.viewPath = home.path
    void loadEntries(sessionId, home.path)
  }
  void loadTreeRoot(sessionId)
}

/** 关会话时清理缓存 */
export function disposeSessionFiles(sessionId: string): void {
  const timer = refreshTimers.get(sessionId)
  if (timer) clearTimeout(timer)
  refreshTimers.delete(sessionId)
  delete states[sessionId]
}

/** OSC 7：shell 上报 cwd */
export function setSessionCwd(sessionId: string, path: string): void {
  const state = ensure(sessionId)
  state.integrationActive = true
  state.cwd = path
  if (state.follow && state.viewPath !== path) {
    state.viewPath = path
    void loadEntries(sessionId, path)
  }
}

/** OSC 133;D：命令结束，跟随模式下防抖刷新当前目录 */
export function onSessionCommandFinished(sessionId: string): void {
  const state = states[sessionId]
  if (!state || !state.follow || !state.viewPath) return
  const existing = refreshTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  refreshTimers.set(
    sessionId,
    setTimeout(() => {
      refreshTimers.delete(sessionId)
      const current = states[sessionId]
      if (current?.follow && current.viewPath) void loadEntries(sessionId, current.viewPath)
    }, 400)
  )
}

/**
 * 解析 OSC 7 载荷（file://[user@]host/path），带合理性校验——伪造 cwd 可误导 cd 跟随。
 * userinfo 位是 SI 脚本上报的 pty 身份：形态非法（非 POSIX 用户名样）
 * 一律按无身份处理，路径解析不受影响。
 */
export function parseOsc7WithUser(data: string): { path: string; user: string | null } | null {
  if (!data.startsWith('file://')) return null
  const rest = data.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const authority = rest.slice(0, slash)
  const at = authority.indexOf('@')
  const userRaw = at > 0 ? authority.slice(0, at) : null
  const user = userRaw && /^[\w.-]{1,64}$/.test(userRaw) ? userRaw : null
  const raw = rest.slice(slash)
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    path = raw
  }
  // cwd 必须像 POSIX 绝对路径：长度上限、无控制字符
  if (!path.startsWith('/') || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) return null
  return { path, user }
}

export function parseOsc7(data: string): string | null {
  return parseOsc7WithUser(data)?.path ?? null
}

function navigateTo(sessionId: string, path: string): void {
  const state = ensure(sessionId)
  // 手动浏览自动暂停跟随
  state.follow = false
  state.viewPath = path
  void loadEntries(sessionId, path)
}

function toggleFollow(sessionId: string): void {
  const state = ensure(sessionId)
  state.follow = !state.follow
  if (state.follow) {
    const target = state.cwd ?? state.home
    if (target && state.viewPath !== target) {
      state.viewPath = target
      void loadEntries(sessionId, target)
    }
  }
}

function setView(sessionId: string, view: 'flat' | 'tree'): void {
  const state = ensure(sessionId)
  state.view = view
  if (view === 'tree' && !state.treeLoaded && !state.treeLoading) {
    void loadTreeRoot(sessionId)
  }
}

function refreshFlat(sessionId: string): void {
  const state = ensure(sessionId)
  if (state.viewPath) void loadEntries(sessionId, state.viewPath)
  else void prefetchSessionFiles(sessionId)
}

async function toggleTreeNode(sessionId: string, node: FileNode): Promise<void> {
  if (node.entry.type !== 'dir') return
  node.expanded = !node.expanded
  if (node.expanded && node.children === null) {
    node.loading = true
    const result = await window.api.sftp.list(sessionId, node.entry.path)
    if (result.ok && result.entries) {
      node.children = result.entries.map(toNode)
    } else {
      node.children = []
      node.error = result.error ?? '读取目录失败'
    }
    node.loading = false
  }
}

async function download(sessionId: string, entry: SftpEntry): Promise<void> {
  const state = ensure(sessionId)
  const result = await window.api.sftp.download(sessionId, entry.path, entry.name)
  if (result.ok) state.notice = `已下载到 ${result.savedTo}`
  else if (!result.canceled) state.notice = `下载失败：${result.error}`
}

async function upload(sessionId: string): Promise<void> {
  const state = ensure(sessionId)
  const targetDir = state.view === 'flat' ? state.viewPath : state.home
  if (!targetDir) return
  const result = await window.api.sftp.upload(sessionId, targetDir)
  if (result.ok) {
    state.notice = `已上传 ${result.uploaded?.join('、')}`
    if (state.view === 'flat') refreshFlat(sessionId)
    else void loadTreeRoot(sessionId)
  } else if (!result.canceled) {
    state.notice = `上传失败：${result.error}`
  }
}

export function useFileStore() {
  return {
    states,
    ensure,
    navigateTo,
    toggleFollow,
    setView,
    refreshFlat,
    loadTreeRoot,
    toggleTreeNode,
    download,
    upload
  }
}
