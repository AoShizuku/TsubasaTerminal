import { expect, test, type ElectronApplication } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from './fixtures/launch'
import { DEFAULT_WORK_AREA_RATIO } from '../src/main/windowPlacement'
import { WINDOW_MIN_SIZE } from '../src/shared/layout'

// 都在桌面车道：后台车道把窗口放在 (-10000, -10000)，那里不属于任何屏，
// 尺寸按最近一块屏的缩放换算，混合缩放的机器上会差一两个像素
let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

interface Rect { x: number; y: number; width: number; height: number }

/** 分数缩放下 DIP ↔ 物理像素往返有舍入，容忍 1 个逻辑像素 */
function expectNear(actual: Rect, expected: Partial<Rect>): void {
  for (const [key, value] of Object.entries(expected) as Array<[keyof Rect, number]>) {
    expect(Math.abs(actual[key] - value), `${key}: ${actual[key]} vs ${value}`).toBeLessThanOrEqual(1)
  }
}

function bounds(electronApp: ElectronApplication): Promise<Rect> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
}

function isMaximized(electronApp: ElectronApplication): Promise<boolean> {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
}

function readState(userDataDir: string): Rect & { maximized: boolean } {
  return JSON.parse(readFileSync(join(userDataDir, 'window-state.json'), 'utf-8'))
}

test('首次启动按主屏工作区比例取尺寸并居中', { tag: ['@headed', '@daily'] }, async () => {
  // 传空串关掉 fixture 的固定基线，走真实的首次启动默认
  const launched = await launchApp([], undefined, { env: { TSUBASATERMINAL_E2E_WINDOW_SIZE: '' } })
  app = launched.app
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  test.skip(workArea.width * DEFAULT_WORK_AREA_RATIO < WINDOW_MIN_SIZE.width ||
    workArea.height * DEFAULT_WORK_AREA_RATIO < WINDOW_MIN_SIZE.height, '主屏工作区过小，下限优先')
  const width = Math.round(workArea.width * DEFAULT_WORK_AREA_RATIO)
  const height = Math.round(workArea.height * DEFAULT_WORK_AREA_RATIO)
  expectNear(await bounds(app), {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height
  })
})

test('关闭时记住位置、尺寸与最大化，重启后恢复', { tag: ['@headed', '@daily'] }, async () => {
  const first = await launchApp([])
  app = first.app
  const target = await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    const rect = {
      x: area.x + 40,
      y: area.y + 30,
      width: Math.min(1100, area.width - 40),
      height: Math.min(700, area.height - 30)
    }
    const win = BrowserWindow.getAllWindows()[0]
    win.setBounds(rect)
    win.maximize()
    return rect
  })
  await expect.poll(() => isMaximized(app!)).toBe(true)
  // 不等防抖，直接退出：落盘必须在关窗那一跳完成
  await app.close()
  app = undefined
  const saved = readState(first.userDataDir)
  expect(saved.maximized).toBe(true)
  expectNear(saved, target)

  const second = await launchApp([], first.userDataDir)
  app = second.app
  await expect.poll(() => isMaximized(app!)).toBe(true)
  // 取消最大化回到记住的还原尺寸，而不是建窗默认值
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
  await expect.poll(() => isMaximized(app!)).toBe(false)
  expectNear(await bounds(app), target)
  await second.page.getByTestId('open-settings').click()
  await expect(second.page.getByTestId('settings-theme')).toBeVisible()
})

test('缩放与主屏不同的副屏：恢复尺寸准确，反复重启不漂移', { tag: '@headed' }, async () => {
  const first = await launchApp([])
  app = first.app
  const other = await app.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().find((d) => d.scaleFactor !== primary.scaleFactor)?.workArea ?? null
  })
  test.skip(!other || other.width < WINDOW_MIN_SIZE.width + 60 || other.height < WINDOW_MIN_SIZE.height + 60,
    '需要一块缩放与主屏不同、且放得下最小窗口的副屏')
  await app.close()
  app = undefined
  const rect = {
    x: other!.x + 30,
    y: other!.y + 30,
    width: Math.min(1100, other!.width - 60),
    height: Math.min(700, other!.height - 60)
  }
  const record = { ...rect, maximized: false }
  writeFileSync(join(first.userDataDir, 'window-state.json'), JSON.stringify(record), 'utf-8')

  // 建窗按主屏缩放换算尺寸，不纠正会差一个缩放比；照测量值存盘则每次重启涨一两个像素
  for (let round = 0; round < 3; round += 1) {
    app = (await launchApp([], first.userDataDir)).app
    expectNear(await bounds(app), rect)
    await app.close()
    app = undefined
    expect(readState(first.userDataDir)).toEqual(record)
  }
})
