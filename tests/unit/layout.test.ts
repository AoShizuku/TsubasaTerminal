import { describe, expect, it } from 'vitest'
import {
  MIDDLE_MIN_WIDTH,
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  WINDOW_MIN_SIZE,
  clampPaneWidth,
  maxPaneWidth
} from '../../src/shared/layout'

/**
 * 三栏几何常量与夹值。数字之间的关系是硬约束——最小窗口宽度下
 * 三栏各守下限必须放得下，默认布局不能在最小窗口就触发收缩——改数先在这里红。
 */
describe('pane geometry constants', () => {
  it('three minimums fit the minimum window', () => {
    expect(PANE_MIN_WIDTH.left + PANE_MIN_WIDTH.right + MIDDLE_MIN_WIDTH).toBeLessThanOrEqual(
      WINDOW_MIN_SIZE.width
    )
  })

  it('default layout leaves the middle at least MIDDLE_MIN_WIDTH at the minimum window', () => {
    expect(WINDOW_MIN_SIZE.width - PANE_DEFAULT_WIDTH.left - PANE_DEFAULT_WIDTH.right).toBeGreaterThanOrEqual(
      MIDDLE_MIN_WIDTH
    )
  })

  it('defaults sit inside the absolute bounds', () => {
    for (const side of ['left', 'right'] as const) {
      expect(PANE_DEFAULT_WIDTH[side]).toBeGreaterThanOrEqual(PANE_MIN_WIDTH[side])
      expect(PANE_DEFAULT_WIDTH[side]).toBeLessThanOrEqual(PANE_MAX_WIDTH)
    }
  })
})

describe('clampPaneWidth (persistence boundary)', () => {
  it('rounds and keeps in-range values', () => {
    expect(clampPaneWidth('left', 300.4)).toBe(300)
    expect(clampPaneWidth('right', 300.6)).toBe(301)
  })

  it('clamps to the per-side minimum and the shared maximum', () => {
    expect(clampPaneWidth('left', 10)).toBe(PANE_MIN_WIDTH.left)
    expect(clampPaneWidth('right', 10)).toBe(PANE_MIN_WIDTH.right)
    expect(clampPaneWidth('left', 1e9)).toBe(PANE_MAX_WIDTH)
  })

  it('returns null for anything that is not a finite number so callers keep the old value', () => {
    expect(clampPaneWidth('left', NaN)).toBeNull()
    expect(clampPaneWidth('left', Infinity)).toBeNull()
    expect(clampPaneWidth('left', '240')).toBeNull()
    expect(clampPaneWidth('left', undefined)).toBeNull()
    expect(clampPaneWidth('left', null)).toBeNull()
  })
})

describe('maxPaneWidth (live drag ceiling)', () => {
  it('reserves the other pane and the middle minimum', () => {
    expect(maxPaneWidth('left', 1280, 288)).toBe(1280 - 288 - MIDDLE_MIN_WIDTH)
    // 另一栏折叠着传 0
    expect(maxPaneWidth('right', 1280, 0)).toBe(1280 - MIDDLE_MIN_WIDTH)
  })

  it('never drops below the side minimum even when the window is already too narrow', () => {
    expect(maxPaneWidth('left', 960, 800)).toBe(PANE_MIN_WIDTH.left)
  })

  it('floors fractional container widths', () => {
    expect(maxPaneWidth('left', 1000.7, 0)).toBe(1000 - MIDDLE_MIN_WIDTH)
  })
})
