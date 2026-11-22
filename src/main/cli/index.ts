import { app, ipcMain } from 'electron'
import type { CliInstallStatus, CliSkillTarget } from '../../shared/types'
import { loadSettings, patchSettings } from '../settings'
import {
  cleanLegacySkill,
  cliScriptExists,
  cliScriptPath,
  disableBridgeInstall,
  enableBridgeInstall,
  installSkill,
  isShimDirOnPath,
  pathManaged,
  removeSkill,
  shimDir,
  shimsInstalled,
  skillStatus,
  writeShims
} from './install'
import { isCliServerRunning, pipeName, startCliServer, stopCliServer } from './server'
import { registerAutoOpenHandlers } from './autoOpen'

/**
 * CLI 通道的装配点：设置开关 ↔ 管道起停 / shim 自愈 / skill 版本戳重渲染。
 *
 * 启动时的两件自愈事（cli-bridge-design 6.2 / 6.3）：
 * - 用当前 `process.execPath` 重写三个 shim（应用更新、用户挪了安装位置都自动指回）；
 * - skill 版本戳变了就重渲染（**这是"两套先验不漂移"唯一的机制**），
 *   但用户手工改过的目标一律跳过。
 */

const TARGETS: CliSkillTarget[] = ['claude', 'codex']

export async function cliStatus(): Promise<CliInstallStatus> {
  const settings = await loadSettings()
  return {
    enabled: settings.cliBridgeEnabled,
    listening: isCliServerRunning(),
    pipeName: pipeName(),
    shimDir: shimDir(),
    shimsInstalled: await shimsInstalled(),
    onPath: await isShimDirOnPath(),
    pathManaged: pathManaged(),
    cliScript: cliScriptPath(),
    cliScriptExists: await cliScriptExists(),
    skills: await Promise.all(TARGETS.map((t) => skillStatus(t))),
    version: app.getVersion()
  }
}

async function setBridge(enabled: boolean): Promise<void> {
  await patchSettings({ cliBridgeEnabled: enabled })
  if (enabled) {
    await enableBridgeInstall()
    await startCliServer()
  } else {
    await stopCliServer()
    await disableBridgeInstall()
  }
}

async function setSkill(target: CliSkillTarget, enabled: boolean): Promise<void> {
  await patchSettings(
    target === 'claude' ? { cliSkillClaude: enabled } : { cliSkillCodex: enabled }
  )
  if (enabled) await installSkill(target)
  else await removeSkill(target)
}

/** 启动装配：只在总开关已开时起管道；skill 按各自开关做版本戳重渲染 */
export async function bootCliBridge(): Promise<void> {
  // 必须 await：`registerSettingsHandlers` 里的预热是异步的，同步读会在启动早期
  // 拿到默认值（总开关 false），表现为"勾了 CLI 通道但重启后管道没起来"
  const settings = await loadSettings()
  if (settings.cliBridgeEnabled) {
    await writeShims().catch(() => {})
    await startCliServer()
  }
  for (const target of TARGETS) {
    const on = target === 'claude' ? settings.cliSkillClaude : settings.cliSkillCodex
    if (!on) continue
    const state = await skillStatus(target)
    // absent（用户删了目录）与 outdated（app 升级了）都重渲染；modified 由 installSkill 自己挡住。
    // 已是最新时也补一次旧落点清理（新落点被人手工放好、版本恰好一致的情况）
    if (state.state !== 'installed') await installSkill(target).catch(() => {})
    else await cleanLegacySkill(target).catch(() => {})
  }
}

export function registerCliHandlers(): void {
  // `use` 自动开会话的应答通道：常驻注册，与总开关无关——
  // 开关只控制管道监听，应答面不监听任何外部输入
  registerAutoOpenHandlers()
  ipcMain.handle('cli:status', () => cliStatus())
  ipcMain.handle('cli:set-bridge', async (_event, enabled: boolean): Promise<CliInstallStatus> => {
    await setBridge(enabled === true)
    return await cliStatus()
  })
  ipcMain.handle(
    'cli:set-skill',
    async (_event, target: CliSkillTarget, enabled: boolean): Promise<CliInstallStatus> => {
      if (target === 'claude' || target === 'codex') await setSkill(target, enabled === true)
      return await cliStatus()
    }
  )
}

export async function disposeCliBridge(): Promise<void> {
  await stopCliServer()
}
