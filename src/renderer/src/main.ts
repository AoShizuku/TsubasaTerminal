import './assets/main.css'
import '@xterm/xterm/css/xterm.css'

import { createApp } from 'vue'
import App from './App.vue'
import { useAppStore } from './composables/useAppStore'
import { getStallScanCount, setStallThresholdMs } from './composables/useComposerStore'
import { getMarkerColumns, getTerminalText } from './lib/terminalRegistry'

createApp(App).mount('#app')

// 只读测试钩子（同时是未来 Agent read_screen 的雏形）
const store = useAppStore()
;(window as unknown as Record<string, unknown>).__tsubasaterminal = {
  getTerminalText,
  getActiveTerminalText: (): string | null =>
    store.activeSessionId.value ? getTerminalText(store.activeSessionId.value) : null,
  getActiveMarkerColumns: (marker: string): Array<{ text: string; col: number }> | null =>
    store.activeSessionId.value ? getMarkerColumns(store.activeSessionId.value, marker) : null,
  getSessions: (): Array<{ id: string; title: string; status: string }> =>
    store.sessions.value.map((s) => ({ id: s.id, title: s.title, status: s.status })),
  // e2e 用：把 SI 断链的静默阈值和巡检周期调短，并确认巡检确实运行过
  setStallThresholdMs,
  getStallScanCount
}
