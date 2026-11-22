import { ref } from 'vue'
import type { AppSettings } from '@shared/types'

/**
 * 应用设置渲染态：主进程 settings.json 是唯一事实源，这里是共享缓存——
 * SettingsDialog 改、TerminalView watch 同一个 ref 即时应用外观，不再各自 get。
 */

const settings = ref<AppSettings | null>(null)

/**
 * 同步引导：在 App setup 里、首帧之前调用，settings 一步到位。
 * 此前 loadSettings 是异步的，首帧必然先按默认值画一帧——折叠的侧栏会闪现再收起，
 * 主题也先灰阶再切换。持久化布局把这一帧从"不额外处理"变成必须处理。
 */
export function bootstrapSettings(): AppSettings {
  settings.value = window.api.settings.getSync()
  return settings.value
}

export async function loadSettings(): Promise<AppSettings> {
  settings.value = await window.api.settings.get()
  return settings.value
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  settings.value = await window.api.settings.set(JSON.parse(JSON.stringify(patch)))
  return settings.value
}

export function useSettingsStore() {
  return { settings, loadSettings, updateSettings }
}
