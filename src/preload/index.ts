import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Api, HostInput, TerminalSize } from '../shared/types'

function on(channel: string, cb: (...args: never[]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    (cb as (...args: unknown[]) => void)(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  window: {
    platform: process.platform,
    setTitleBarTheme: (theme) => ipcRenderer.invoke('window:title-bar-theme', theme)
  },
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    add: (input: HostInput) => ipcRenderer.invoke('hosts:add', input),
    update: (input: HostInput) => ipcRenderer.invoke('hosts:update', input),
    remove: (id: string) => ipcRenderer.invoke('hosts:remove', id),
    getFingerprint: (host: string, port: number) => ipcRenderer.invoke('hostkeys:get', host, port),
    forgetFingerprint: (host: string, port: number) =>
      ipcRenderer.invoke('hostkeys:forget', host, port)
  },
  ssh: {
    connect: (sessionId: string, hostId: string, size: TerminalSize) =>
      ipcRenderer.invoke('ssh:connect', sessionId, hostId, size),
    input: (sessionId, data) => ipcRenderer.send('ssh:input', sessionId, data),
    exec: (sessionId, command) => ipcRenderer.invoke('ssh:exec', sessionId, command),
    reinjectSi: (sessionId) => ipcRenderer.invoke('ssh:reinject-si', sessionId),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    onData: (cb) => on('ssh:data', cb),
    onDataTransient: (cb) => on('ssh:data:transient', cb),
    onZmodem: (cb) => on('ssh:zmodem', cb),
    onExit: (cb) => on('ssh:exit', cb),
    onError: (cb) => on('ssh:error', cb),
    onElevation: (cb) => on('ssh:elevation', cb)
  },
  sshconfig: {
    load: () => ipcRenderer.invoke('sshconfig:load')
  },
  transfer: {
    bridgeDownload: (sessionId, paths, cwd) =>
      ipcRenderer.invoke('transfer:bridge-download', sessionId, paths, cwd),
    bridgeUpload: (sessionId, remoteDir) =>
      ipcRenderer.invoke('transfer:bridge-upload', sessionId, remoteDir),
    bridgeRelease: (sessionId) => ipcRenderer.send('transfer:bridge-release', sessionId)
  },
  sftp: {
    home: (sessionId) => ipcRenderer.invoke('sftp:home', sessionId),
    list: (sessionId, path) => ipcRenderer.invoke('sftp:list', sessionId, path),
    download: (sessionId, remotePath, fileName) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, fileName),
    upload: (sessionId, remoteDir) => ipcRenderer.invoke('sftp:upload', sessionId, remoteDir)
  },
  transcript: {
    report: (sessionId, hostId, unit) =>
      ipcRenderer.send('transcript:report', sessionId, hostId, unit),
    identity: (sessionId, user) => ipcRenderer.send('transcript:identity', sessionId, user),
    dispose: (sessionId) => ipcRenderer.send('transcript:dispose', sessionId),
    get: (sessionId) => ipcRenderer.invoke('transcript:get', sessionId),
    summaries: (sessionId) => ipcRenderer.invoke('transcript:summaries', sessionId),
    onRedactions: (cb) => on('transcript:redactions', cb),
    redactionSummary: (sessionId) => ipcRenderer.invoke('transcript:redaction-summary', sessionId)
  },
  history: {
    list: (hostId, limit) => ipcRenderer.invoke('history:list', hostId, limit)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    // 唯一的 sendSync：首帧前的一次引导读，主进程只回缓存（建窗前已 await 读热）
    getSync: () => ipcRenderer.sendSync('settings:get-sync'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  llm: {
    profiles: () => ipcRenderer.invoke('llm:profiles'),
    saveProfile: (input) => ipcRenderer.invoke('llm:save-profile', input),
    deleteProfile: (id) => ipcRenderer.invoke('llm:delete-profile', id)
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    events: (convId) => ipcRenderer.invoke('conversations:events', convId),
    rename: (convId, title) => ipcRenderer.invoke('conversations:rename', convId, title),
    remove: (convId) => ipcRenderer.invoke('conversations:remove', convId),
    clear: () => ipcRenderer.invoke('conversations:clear'),
    exportMarkdown: (convId, markdown) =>
      ipcRenderer.invoke('conversations:export-md', convId, markdown)
  },
  agent: {
    send: (sessionId, text, opts) => ipcRenderer.invoke('agent:send', sessionId, text, opts),
    newConversation: (sessionId) => ipcRenderer.invoke('agent:new-conversation', sessionId),
    resumeConversation: (sessionId, convId, opts) =>
      ipcRenderer.invoke('agent:resume-conversation', sessionId, convId, opts),
    stop: (sessionId) => ipcRenderer.send('agent:stop', sessionId),
    dispose: (sessionId) => ipcRenderer.send('agent:dispose', sessionId),
    onEvent: (cb) => on('agent:event', cb),
    onScreenRequest: (cb) => on('agent:screen-request', cb),
    screenResponse: (requestId, payload) =>
      ipcRenderer.send('agent:screen-response', requestId, payload),
    approve: (sessionId, proposalId, confirmText, trust, edits) =>
      ipcRenderer.invoke('agent:approve', sessionId, proposalId, confirmText, trust, edits),
    deny: (sessionId, proposalId, comment) =>
      ipcRenderer.invoke('agent:deny', sessionId, proposalId, comment),
    trustList: (sessionId) => ipcRenderer.invoke('agent:trust-list', sessionId),
    trustClear: (sessionId) => ipcRenderer.invoke('agent:trust-clear', sessionId),
    noteTerminalWriteState: (sessionId, status) =>
      ipcRenderer.send('agent:terminal-write-state', sessionId, status),
    suggest: (sessionId) => ipcRenderer.invoke('agent:suggest', sessionId),
    systemPrompt: (sessionId, opts) => ipcRenderer.invoke('agent:system-prompt', sessionId, opts)
  },
  experience: {
    list: (hostId) => ipcRenderer.invoke('experience:list', hostId),
    body: (id) => ipcRenderer.invoke('experience:body', id),
    save: (input) => ipcRenderer.invoke('experience:save', input),
    update: (input, viewHostId) => ipcRenderer.invoke('experience:update', input, viewHostId),
    setPinned: (id, pinned, hostId) => ipcRenderer.invoke('experience:set-pinned', id, pinned, hostId),
    remove: (id, hostId) => ipcRenderer.invoke('experience:remove', id, hostId),
    draft: (convId) => ipcRenderer.invoke('experience:draft', convId)
  },
  audit: {
    reveal: () => ipcRenderer.send('audit:reveal')
  },
  cli: {
    status: () => ipcRenderer.invoke('cli:status'),
    setBridge: (enabled) => ipcRenderer.invoke('cli:set-bridge', enabled),
    setSkill: (target, enabled) => ipcRenderer.invoke('cli:set-skill', target, enabled),
    onFocusSession: (cb) => on('cli:focus-session', cb),
    onMulti: (cb) => on('cli:multi', cb),
    multiApprove: (proposalId, confirmText) =>
      ipcRenderer.invoke('cli:multi-approve', proposalId, confirmText),
    multiDeny: (proposalId, comment) => ipcRenderer.invoke('cli:multi-deny', proposalId, comment),
    onOpenSession: (cb) => on('cli:open-session', cb),
    openSessionResult: (requestId, sessionId, ok, error) =>
      ipcRenderer.send('cli:open-session-result', requestId, sessionId, ok, error)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read-text')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { api: Api }).api = api
}
