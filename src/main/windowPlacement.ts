import { WINDOW_MIN_SIZE } from '../shared/layout'

/**
 * 主窗口落位的纯计算：首次启动的默认尺寸、已存状态的校验与回落。
 * 不 import electron，显示器工作区由调用方传入，单测直接喂假屏幕。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** 落盘形态：还原态（非最大化时）的位置尺寸 + 是否最大化 */
export interface WindowState extends Rect {
  maximized: boolean
}

/** 首次启动占主屏工作区的比例：运维多在大屏上长时间开着，给足终端面积，又保留窗口感 */
export const DEFAULT_WORK_AREA_RATIO = 0.85

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 读盘校验：字段缺失、非有限数、非正尺寸一律视为没有记录，按首次启动处理 */
export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const { x, y, width, height, maximized } = raw as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: maximized === true
  }
}

/** `1280x800` 形式的尺寸；格式不对返回 undefined */
export function parseSizeSpec(spec: string | undefined): Size | undefined {
  const match = /^(\d+)x(\d+)$/.exec(spec?.trim() ?? '')
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * 尺寸夹进工作区，但不低于窗口下限。工作区本身比下限还小（极小屏或超大缩放）时
 * 以下限为准——minWidth / minHeight 本就不允许更小，窗口超出屏幕是唯一的结果。
 */
function fitSize(width: number, height: number, area: Rect): Size {
  return {
    width: Math.max(WINDOW_MIN_SIZE.width, Math.min(Math.round(width), area.width)),
    height: Math.max(WINDOW_MIN_SIZE.height, Math.min(Math.round(height), area.height))
  }
}

function centerIn(size: Size, area: Rect): Rect {
  return {
    x: area.x + Math.max(0, Math.floor((area.width - size.width) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - size.height) / 2)),
    ...size
  }
}

/** 整个窗口推进工作区内；放不下时贴左上角，保证标题栏可拖 */
function keepInside(rect: Rect, area: Rect): Rect {
  return {
    ...rect,
    x: Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width)),
    y: Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height))
  }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * 启动落位。
 *
 * - 没有记录：主屏工作区的 {@link DEFAULT_WORK_AREA_RATIO} 居中；`defaultSize` 显式给出时
 *   用它（e2e 锁定基线尺寸，不夹进工作区，各机器上保持一致）。
 * - 有记录：归到与之重叠最多的显示器，尺寸夹进该工作区、整窗推回工作区内——
 *   改了分辨率或缩放后窗口不会超出屏幕。跨两块屏摆放的窗口会收进重叠多的那块。
 * - 记录与所有显示器都不相交（拔了副屏、换了排列）：保留尺寸，回主屏居中。
 *
 * 最大化标志原样带回：调用方先按还原态尺寸建窗再最大化，取消最大化时回到这个尺寸。
 */
export function resolveWindowPlacement(
  saved: WindowState | null,
  workAreas: readonly Rect[],
  primary: Rect,
  defaultSize?: Size
): WindowState {
  if (!saved) {
    const size =
      defaultSize ??
      fitSize(primary.width * DEFAULT_WORK_AREA_RATIO, primary.height * DEFAULT_WORK_AREA_RATIO, primary)
    return { ...centerIn(size, primary), maximized: false }
  }
  let home: Rect | null = null
  let best = 0
  for (const area of workAreas) {
    const overlap = overlapArea(saved, area)
    if (overlap > best) {
      best = overlap
      home = area
    }
  }
  const area = home ?? primary
  const size = fitSize(saved.width, saved.height, area)
  const rect = home ? keepInside({ x: saved.x, y: saved.y, ...size }, home) : centerIn(size, primary)
  return { ...rect, maximized: saved.maximized }
}
