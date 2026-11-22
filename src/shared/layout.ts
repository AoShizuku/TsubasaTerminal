/**
 * 三栏几何的单一来源：主进程用它夹持久化值，渲染进程用它夹拖拽实时值。
 * 两边各抄一份数字就是"两处重复即两处漂移"。
 *
 * 数字与窗口 `minWidth: 960` 的关系：LEFT_MIN + RIGHT_MIN + MIDDLE_MIN = 840 ≤ 960，
 * 最小窗口下三栏各守住下限仍放得下；默认态 960 − (240 + 288) = 432 ≥ MIDDLE_MIN，
 * 默认布局在最小窗口不触发 flex 收缩。改任何一个数都要重算这两条。
 */

export type PaneSide = 'left' | 'right'

/** 默认宽度 = v0.13.3 之前写死的 `w-60` / `w-72` */
export const PANE_DEFAULT_WIDTH: Record<PaneSide, number> = { left: 240, right: 288 }

/** 侧栏下限：左栏要放得下主机名 + 图标两行；右栏是 Agent header 那排按钮的底 */
export const PANE_MIN_WIDTH: Record<PaneSide, number> = { left: 180, right: 260 }

/** 侧栏绝对上限：只防 settings.json 里塞进离谱值，实时上限由窗口宽度决定 */
export const PANE_MAX_WIDTH = 1200

/** 中栏下限：拖拽夹值用；也写进中栏 min-width，flex 收缩时两侧让、中栏不让 */
export const MIDDLE_MIN_WIDTH = 400

/**
 * 绝对夹值（持久化边界）：非有限数返回 null 让调用方保留旧值，
 * 有限数取整后夹进 [min, PANE_MAX_WIDTH]。
 */
export function clampPaneWidth(side: PaneSide, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH[side], Math.round(value)))
}

/**
 * 拖拽实时上限：容器宽 − 另一栏有效宽 − 中栏下限。另一栏折叠着传 0。
 * 结果不会低于本栏下限——两栏偏好都很宽而窗口很小时，flex 收缩已经在让位，
 * 这里只保证拖拽不能把中栏再往下挤。
 */
export function maxPaneWidth(side: PaneSide, containerWidth: number, otherWidth: number): number {
  return Math.max(PANE_MIN_WIDTH[side], Math.floor(containerWidth - otherWidth - MIDDLE_MIN_WIDTH))
}
