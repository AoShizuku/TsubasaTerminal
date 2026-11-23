import { describe, expect, it } from 'vitest'
import { WINDOW_MIN_SIZE } from '../../src/shared/layout'
import {
  DEFAULT_WORK_AREA_RATIO,
  parseSizeSpec,
  parseWindowState,
  resolveWindowPlacement,
  type Rect,
  type WindowState
} from '../../src/main/windowPlacement'

/** 1080p 主屏扣掉 48px 任务栏；副屏在右侧 1440p */
const primary: Rect = { x: 0, y: 0, width: 1920, height: 1032 }
const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1392 }

function saved(rect: Partial<WindowState>): WindowState {
  return { x: 100, y: 100, width: 1400, height: 900, maximized: false, ...rect }
}

describe('parseWindowState', () => {
  it('accepts a complete record and rounds coordinates', () => {
    expect(parseWindowState({ x: 10.4, y: -20.6, width: 1400.5, height: 900, maximized: true })).toEqual({
      x: 10,
      y: -21,
      width: 1401,
      height: 900,
      maximized: true
    })
  })

  it('treats a missing or non-boolean maximized flag as not maximized', () => {
    expect(parseWindowState({ x: 0, y: 0, width: 1000, height: 700 })?.maximized).toBe(false)
    expect(parseWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: 'yes' })?.maximized).toBe(false)
  })

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['missing field', { x: 0, y: 0, width: 1000 }],
    ['non-finite', { x: 0, y: Infinity, width: 1000, height: 700 }],
    ['numeric string', { x: '0', y: 0, width: 1000, height: 700 }],
    ['zero size', { x: 0, y: 0, width: 0, height: 700 }],
    ['negative size', { x: 0, y: 0, width: 1000, height: -1 }]
  ])('rejects %s', (_label, raw) => {
    expect(parseWindowState(raw)).toBeNull()
  })
})

describe('parseSizeSpec', () => {
  it('parses WIDTHxHEIGHT', () => {
    expect(parseSizeSpec('1280x800')).toEqual({ width: 1280, height: 800 })
    expect(parseSizeSpec(' 1280x800 ')).toEqual({ width: 1280, height: 800 })
  })

  it.each([undefined, '', '1280', '1280x', 'x800', '1280*800', '-1280x800', '0x800', '1280.5x800'])(
    'rejects %s',
    (spec) => {
      expect(parseSizeSpec(spec)).toBeUndefined()
    }
  )
})

describe('resolveWindowPlacement: first launch', () => {
  it('takes the ratio of the primary work area, centered', () => {
    const placement = resolveWindowPlacement(null, [primary, secondary], primary)
    const width = Math.round(primary.width * DEFAULT_WORK_AREA_RATIO)
    const height = Math.round(primary.height * DEFAULT_WORK_AREA_RATIO)
    expect(placement).toEqual({
      x: Math.floor((primary.width - width) / 2),
      y: Math.floor((primary.height - height) / 2),
      width,
      height,
      maximized: false
    })
  })

  it('centers within an offset work area (taskbar on top / left)', () => {
    const area: Rect = { x: 60, y: 40, width: 1860, height: 1040 }
    const placement = resolveWindowPlacement(null, [area], area)
    const leftGap = placement.x - area.x
    const rightGap = area.x + area.width - (placement.x + placement.width)
    const topGap = placement.y - area.y
    const bottomGap = area.y + area.height - (placement.y + placement.height)
    expect(leftGap).toBeGreaterThan(0)
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
    expect(topGap).toBeGreaterThan(0)
    expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1)
  })

  it('never goes below the window minimum on a small screen', () => {
    const small: Rect = { x: 0, y: 0, width: 1024, height: 640 }
    const placement = resolveWindowPlacement(null, [small], small)
    expect(placement.width).toBe(WINDOW_MIN_SIZE.width)
    expect(placement.height).toBe(WINDOW_MIN_SIZE.height)
  })

  it('uses an explicit default size unclamped, so e2e stays identical across machines', () => {
    const tiny: Rect = { x: 0, y: 0, width: 1024, height: 700 }
    const placement = resolveWindowPlacement(null, [tiny], tiny, { width: 1280, height: 800 })
    expect(placement).toEqual({ x: 0, y: 0, width: 1280, height: 800, maximized: false })
  })
})

describe('resolveWindowPlacement: restore', () => {
  it('restores a record that fits its display unchanged', () => {
    const record = saved({ x: 200, y: 50, width: 1500, height: 950, maximized: true })
    expect(resolveWindowPlacement(record, [primary, secondary], primary)).toEqual(record)
  })

  it('restores onto the secondary display', () => {
    const record = saved({ x: 2200, y: 100 })
    expect(resolveWindowPlacement(record, [primary, secondary], primary)).toEqual(record)
  })

  it('ignores the explicit default size when a record exists', () => {
    const record = saved({})
    expect(resolveWindowPlacement(record, [primary], primary, { width: 1280, height: 800 })).toEqual(record)
  })

  it('falls back to the primary display, keeping size, when the display is gone', () => {
    const record = saved({ x: 2200, y: 100, width: 1600, height: 1000, maximized: true })
    expect(resolveWindowPlacement(record, [primary], primary)).toEqual({
      x: 160,
      y: 16,
      width: 1600,
      height: 1000,
      maximized: true
    })
  })

  it('pushes a partly off-screen window fully back inside', () => {
    const record = saved({ x: 1000, y: -300, width: 1400, height: 900 })
    const placement = resolveWindowPlacement(record, [primary], primary)
    expect(placement).toMatchObject({ x: primary.width - 1400, y: 0, width: 1400, height: 900 })
  })

  it('shrinks a window larger than the current work area (resolution lowered)', () => {
    const laptop: Rect = { x: 0, y: 0, width: 1366, height: 728 }
    const record = saved({ x: 0, y: 0, width: 1800, height: 1000 })
    expect(resolveWindowPlacement(record, [laptop], laptop)).toMatchObject({
      x: 0,
      y: 0,
      width: 1366,
      height: 728
    })
  })

  it('raises a record below the window minimum', () => {
    const record = saved({ width: 400, height: 300 })
    expect(resolveWindowPlacement(record, [primary], primary)).toMatchObject({
      width: WINDOW_MIN_SIZE.width,
      height: WINDOW_MIN_SIZE.height
    })
  })

  it('moves a window spanning two displays into the one it overlaps most', () => {
    // 左边 400px 在主屏，右边 1000px 在副屏
    const record = saved({ x: 1520, y: 100, width: 1400, height: 900 })
    const placement = resolveWindowPlacement(record, [primary, secondary], primary)
    expect(placement).toMatchObject({ x: secondary.x, y: 100, width: 1400, height: 900 })
  })
})
