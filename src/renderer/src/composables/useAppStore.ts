import { computed, ref } from 'vue'
import type { ElevationFailReason, ElevationInfo, HostConfig, HostInput, SessionStatus } from '@shared/types'
import { disposeSessionFiles, prefetchSessionFiles } from './useFileStore'
import {
  disposeComposer,
  peekCloseBusyReason,
  preloadHostHistory,
  setSessionInputOverride
} from './useComposerStore'
import { disposeAgentSession } from './useAgentStore'
import { useSettingsStore } from './useSettingsStore'
import { disposeSuggest } from './useSuggestStore'
import { forgetRightPanelSession } from './useUiStore'
import { confirmDialog } from '@/lib/confirm'
import { disposeRemoteContext, prefetchRemoteContext } from '@/lib/remoteContext'

/** 身份切换的渲染态：pending=握手进行中；active=安静 root；degraded=带原因 */
export interface SessionElevation {
  phase: 'pending' | 'active' | 'degraded'
  reason?: ElevationFailReason
}

export interface TerminalSession {
  id: string
  host: HostConfig
  title: string
  status: SessionStatus
  error?: string
  /** 仅 elevate='sudo' 的主机有；徽章消费 */
  elevation?: SessionElevation
}

const hosts = ref<HostConfig[]>([])
const selectedHostId = ref<string | null>(null)
const sessions = ref<TerminalSession[]>([])
const activeSessionId = ref<string | null>(null)

const selectedHost = computed(
  () => hosts.value.find((h) => h.id === selectedHostId.value) ?? null
)
const activeSession = computed(
  () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null
)

/** 去掉 Vue 响应式代理，得到可安全跨 IPC 传输的纯对象 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 本机输入方式立即生效：主机列表每次换新，都把最新的 inputMode 下发给
 * 已开会话——session.host 是开标签时的快照，不能拿它判断。切换本身由 composer
 * store 的 pending 表兜底（草稿非空、半行未提交都不立即切）。主机已被删的会话
 * 保留原值，标签还开着，没有理由让它的输入方式突然变掉。
 */
function syncSessionInputOverrides(): void {
  for (const session of sessions.value) {
    const live = hosts.value.find((h) => h.id === session.host.id)
    if (live) setSessionInputOverride(session.id, live.inputMode)
  }
}

async function loadHosts(): Promise<void> {
  hosts.value = await window.api.hosts.list()
  syncSessionInputOverrides()
}

async function addHost(input: HostInput): Promise<void> {
  hosts.value = await window.api.hosts.add(plain(input))
}

async function updateHost(input: HostInput): Promise<void> {
  hosts.value = await window.api.hosts.update(plain(input))
  syncSessionInputOverrides()
}

async function removeHost(id: string): Promise<void> {
  hosts.value = await window.api.hosts.remove(id)
  if (selectedHostId.value === id) selectedHostId.value = null
}

function selectHost(id: string): void {
  selectedHostId.value = id
}

function openSession(host: HostConfig): string {
  const session: TerminalSession = {
    id: crypto.randomUUID(),
    host: plain(host),
    title: host.name || `${host.username}@${host.host}`,
    status: 'connecting',
    // 配置了"以 root 运行"的会话从 pending 起步，等 ssh:elevation 收口事件定形
    elevation: host.elevate === 'sudo' ? { phase: 'pending' } : undefined
  }
  // 先于 composer 状态的惰性创建下发：首个 effectiveInput 就按本机设置起步
  setSessionInputOverride(session.id, host.inputMode)
  sessions.value.push(session)
  activeSessionId.value = session.id
  // 返回新会话 id（v0.12.2 CLI 自动开会话要按它盯连接状态回话）
  return session.id
}

/** 身份切换收口：主进程握手 + 探活结束后推送一次 */
function setSessionElevation(id: string, info: ElevationInfo): void {
  const session = sessions.value.find((s) => s.id === id)
  if (!session || !info.requested) return
  session.elevation = info.active ? { phase: 'active' } : { phase: 'degraded', reason: info.reason }
}

function activateSession(id: string): void {
  activeSessionId.value = id
}

function closeSession(id: string): void {
  const index = sessions.value.findIndex((s) => s.id === id)
  if (index === -1) return
  void window.api.ssh.disconnect(id)
  disposeSessionFiles(id)
  disposeComposer(id)
  disposeAgentSession(id)
  disposeRemoteContext(id)
  disposeSuggest(id)
  forgetRightPanelSession(id)
  sessions.value.splice(index, 1)
  if (activeSessionId.value === id) {
    const next = sessions.value[Math.min(index, sessions.value.length - 1)]
    activeSessionId.value = next ? next.id : null
  }
}

/**
 * 用户发起的关闭：终端忙时先确认。界面上的关闭入口都走这里，
 * closeSession 保留为不问的底层动作。只看终端状态——Agent 思考、待审批、
 * 文件传输不算忙；未连上（connecting/closed/error）的会话没有可丢的现场，不问。
 */
async function requestCloseSession(id: string): Promise<void> {
  const session = sessions.value.find((s) => s.id === id)
  if (!session) return
  const reason = session.status === 'connected' ? peekCloseBusyReason(id) : null
  const { settings } = useSettingsStore()
  if (reason && settings.value?.terminalConfirmCloseBusy !== false) {
    const ok = await confirmDialog({
      title: '关闭忙碌的会话？',
      message: `「${session.title}」${reason}。关闭会断开 SSH 连接，远端前台进程通常随之终止。`,
      confirmText: '关闭',
      danger: true
    })
    if (!ok) return
  }
  // 等待期间会话可能已被关掉：closeSession 找不到即空操作
  closeSession(id)
}

function setSessionStatus(id: string, status: SessionStatus, error?: string): void {
  const session = sessions.value.find((s) => s.id === id)
  if (!session) return
  session.status = status
  session.error = error
  // 重连即重新握手：旧的身份切换结果作废，回 pending 等新的收口事件
  if (status === 'connecting' && session.host.elevate === 'sudo') {
    session.elevation = { phase: 'pending' }
  }
  // 三件套之二：连接成功即后台预取文件树；顺带预载主机记忆与 L2 远端命令表
  if (status === 'connected') {
    void prefetchSessionFiles(id)
    void preloadHostHistory(id, session.host.id)
    prefetchRemoteContext(id)
  }
}

export function useAppStore() {
  return {
    hosts,
    selectedHostId,
    selectedHost,
    sessions,
    activeSessionId,
    activeSession,
    loadHosts,
    addHost,
    updateHost,
    removeHost,
    selectHost,
    openSession,
    activateSession,
    closeSession,
    requestCloseSession,
    setSessionStatus,
    setSessionElevation
  }
}
