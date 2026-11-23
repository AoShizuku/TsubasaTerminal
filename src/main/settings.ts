import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { PANE_DEFAULT_WIDTH, clampPaneWidth } from '../shared/layout'
import {
  KNOWLEDGE_LIMIT,
  UI_DENSITIES,
  UI_FONT_SIZES,
  type AppSettings,
  type UiDensity,
  type UiFontSize
} from '../shared/types'

/** 应用全局设置：userData/settings.json，主进程单一持有，内存缓存同步生效 */

const DEFAULTS: AppSettings = {
  redactionEnabled: true,
  activeLlmProfileId: null,
  completionLlmEnabled: false,
  terminalTheme: 'tsubasaterminal',
  terminalFontFamily: '',
  terminalFontSize: 13,
  terminalCopyOnSelect: true,
  terminalConfirmMultilinePaste: true,
  terminalConfirmCloseBusy: true,
  terminalInputMode: 'composer',
  globalKnowledge: '',
  cliBridgeEnabled: false,
  cliSkillClaude: false,
  cliSkillCodex: false,
  // 三栏默认展开是 e2e 的硬约束（绝大多数 spec 靠左栏 host-item 和右栏 tab 定位）
  leftPaneOpen: true,
  rightPaneOpen: true,
  leftPaneWidth: PANE_DEFAULT_WIDTH.left,
  rightPaneWidth: PANE_DEFAULT_WIDTH.right,
  rightPanelTab: 'agent',
  uiDensity: 'standard',
  uiFontSize: 'standard'
}

function isDensity(value: unknown): value is UiDensity {
  return UI_DENSITIES.includes(value as UiDensity)
}

function isFontSize(value: unknown): value is UiFontSize {
  return UI_FONT_SIZES.includes(value as UiFontSize)
}

/**
 * 已下架的终端配色 id（如已删除的 Solarized Dark，见 doc/appearance-design.md §4）。
 * 渲染层 themeById 对未知 id 本就回落默认方案，但设置页下拉框拿着一个没有对应
 * option 的值会显示成空白——读盘时就改写成默认，界面显示与实际生效保持一致。
 */
const RETIRED_TERMINAL_THEMES = new Set(['solarized-dark'])

let cache: AppSettings | null = null
/** 首次读盘的在途 promise：并发的两次 load 共用一次读，不会各读各的再互相覆盖缓存 */
let loading: Promise<AppSettings> | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): Promise<AppSettings> {
  if (cache) return Promise.resolve(cache)
  loading ??= (async () => {
    let loaded: AppSettings
    try {
      const parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf-8'))
      loaded = { ...DEFAULTS, ...parsed }
      if (RETIRED_TERMINAL_THEMES.has(loaded.terminalTheme)) {
        loaded.terminalTheme = DEFAULTS.terminalTheme
      }
      // 手改坏的密度值同上：分段控件拿着无对应项的值会一个都不亮
      if (!isDensity(loaded.uiDensity)) loaded.uiDensity = DEFAULTS.uiDensity
      if (!isFontSize(loaded.uiFontSize)) loaded.uiFontSize = DEFAULTS.uiFontSize
    } catch {
      loaded = { ...DEFAULTS }
    }
    cache = loaded
    return loaded
  })()
  return loading
}

/**
 * 读-改-写的"读"必须与"写缓存"在同一个同步段里：`const current = await load()`
 * 拿到的是 await 之前那一刻的缓存，两个 set 并发时后醒的那个会用陈旧的 current 算 next，
 * 把先醒那个刚写进缓存的字段盖掉。这里只用 await 保证缓存已热，值在醒来后同步取。
 */
async function warm(): Promise<void> {
  await load()
}

/** 异步读取（保证已落盘的值已就位）：启动早期的消费者必须走这条，别用 getSettingsSync */
export function loadSettings(): Promise<AppSettings> {
  return load()
}

/** 同步读取（脱敏闸门每单元都查）；启动后首次 load 前返回默认值 */
export function getSettingsSync(): AppSettings {
  return cache ?? DEFAULTS
}

export function registerSettingsHandlers(): void {
  // 启动即预热缓存，保证 getSettingsSync 在首个转录单元前就绪
  void load()

  ipcMain.handle('settings:get', () => load())

  // 渲染进程首帧前的同步引导读。index.ts 在 createWindow 前 await 过
  // loadSettings，到这里缓存必然已热——若不然返回的是 DEFAULTS，首帧会按默认布局画，
  // 这是那句 await 不能删的原因
  ipcMain.on('settings:get-sync', (event) => {
    event.returnValue = getSettingsSync()
  })

  ipcMain.handle('settings:set', async (_event, patch: Partial<AppSettings>) => {
    await warm()
    const current = getSettingsSync()
    // 只接受已知字段，防渲染进程塞入任意键
    const next: AppSettings = {
      redactionEnabled:
        typeof patch.redactionEnabled === 'boolean'
          ? patch.redactionEnabled
          : current.redactionEnabled,
      activeLlmProfileId:
        patch.activeLlmProfileId === null || typeof patch.activeLlmProfileId === 'string'
          ? patch.activeLlmProfileId
          : current.activeLlmProfileId,
      completionLlmEnabled:
        typeof patch.completionLlmEnabled === 'boolean'
          ? patch.completionLlmEnabled
          : current.completionLlmEnabled,
      terminalTheme:
        typeof patch.terminalTheme === 'string' && patch.terminalTheme.length <= 64
          ? patch.terminalTheme
          : current.terminalTheme,
      terminalFontFamily:
        typeof patch.terminalFontFamily === 'string' && patch.terminalFontFamily.length <= 128
          ? patch.terminalFontFamily
          : current.terminalFontFamily,
      terminalFontSize:
        typeof patch.terminalFontSize === 'number' &&
        Number.isFinite(patch.terminalFontSize) &&
        patch.terminalFontSize >= 8 &&
        patch.terminalFontSize <= 32
          ? Math.round(patch.terminalFontSize)
          : current.terminalFontSize,
      terminalCopyOnSelect:
        typeof patch.terminalCopyOnSelect === 'boolean'
          ? patch.terminalCopyOnSelect
          : current.terminalCopyOnSelect,
      terminalConfirmMultilinePaste:
        typeof patch.terminalConfirmMultilinePaste === 'boolean'
          ? patch.terminalConfirmMultilinePaste
          : current.terminalConfirmMultilinePaste,
      terminalConfirmCloseBusy:
        typeof patch.terminalConfirmCloseBusy === 'boolean'
          ? patch.terminalConfirmCloseBusy
          : current.terminalConfirmCloseBusy,
      terminalInputMode:
        patch.terminalInputMode === 'composer' || patch.terminalInputMode === 'native'
          ? patch.terminalInputMode
          : current.terminalInputMode,
      // 知识块每轮都进 system prompt：长度上限在主进程硬截，不信渲染进程的 maxlength
      globalKnowledge:
        typeof patch.globalKnowledge === 'string'
          ? patch.globalKnowledge.slice(0, KNOWLEDGE_LIMIT).trim()
          : current.globalKnowledge,
      // CLI 通道三个开关走 cli:* 专用 IPC（要连带起停管道 / 写 shim /
      // 改 PATH / 装 skill），这里只做持久化透传：settings:set 补丁若带上它们照收，
      // 但真正的副作用不在这条路上
      cliBridgeEnabled:
        typeof patch.cliBridgeEnabled === 'boolean'
          ? patch.cliBridgeEnabled
          : current.cliBridgeEnabled,
      cliSkillClaude:
        typeof patch.cliSkillClaude === 'boolean' ? patch.cliSkillClaude : current.cliSkillClaude,
      cliSkillCodex:
        typeof patch.cliSkillCodex === 'boolean' ? patch.cliSkillCodex : current.cliSkillCodex,
      // 布局记忆：宽度按 shared/layout 的绝对边界夹，非数字保留旧值
      leftPaneOpen:
        typeof patch.leftPaneOpen === 'boolean' ? patch.leftPaneOpen : current.leftPaneOpen,
      rightPaneOpen:
        typeof patch.rightPaneOpen === 'boolean' ? patch.rightPaneOpen : current.rightPaneOpen,
      leftPaneWidth: clampPaneWidth('left', patch.leftPaneWidth) ?? current.leftPaneWidth,
      rightPaneWidth: clampPaneWidth('right', patch.rightPaneWidth) ?? current.rightPaneWidth,
      rightPanelTab:
        patch.rightPanelTab === 'agent' ||
        patch.rightPanelTab === 'files' ||
        patch.rightPanelTab === 'cli'
          ? patch.rightPanelTab
          : current.rightPanelTab,
      uiDensity: isDensity(patch.uiDensity) ? patch.uiDensity : current.uiDensity,
      uiFontSize: isFontSize(patch.uiFontSize) ? patch.uiFontSize : current.uiFontSize
    }
    await persist(next)
    return next
  })
}

/** 主进程内部改设置（CLI 通道开关走 cli:* IPC，落盘与缓存同这一条路） */
export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  await warm()
  const next = { ...getSettingsSync(), ...patch }
  await persist(next)
  return next
}

/**
 * 写盘串行化：布局提交点让两次贴近的 settings:set 成为常态（拖完立刻点
 * 折叠）。两个 writeFile 并发到同一路径，先发的可能后落盘，把新值盖回旧值。
 * 缓存仍同步更新——读侧永远看到最新；只有磁盘那一跳排队。前一次失败不阻塞后一次。
 */
let writeChain: Promise<void> = Promise.resolve()

function persist(next: AppSettings): Promise<void> {
  cache = next
  const write = writeChain
    .catch(() => undefined)
    .then(() => fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf-8'))
  writeChain = write
  return write
}
