import type { HostEnvLevel } from '@shared/types'

/**
 * 主机环境等级视觉 token（见 appearance-design）。
 * 双通道原则：**环境色是氛围，风险色是事件**——环境标识不复用 lib/risk.ts 的
 * 绿黄红（生产机满屏常红会稀释高危 ring 的信号量），生产用橙、实验用青，
 * 且不做背景染色/水印，只做点、线、徽章级的低强度存在。
 *
 * v0.9.1：常驻落点从四个（tab 徽章/终端四边环/composer 左缘条/底栏徽章）
 * 收到两个（tab 徽章 + 终端区顶缘光条）。四个弱信号叠起来不是强信号是噪声；
 * 且四边环用了 `orange-500/45`，合成后是 #773b13 棕色（对底 2.24:1，
 * 连非文本 3:1 线都不到），三条边还与 tab/左栏/右栏既有分隔线 1px 重影。
 * 顶缘条满不透明（6.33:1），落在 tab 条 border-b 的位置上是**替代**不是并排。
 * 见 doc/appearance-design.md。
 */
export interface EnvStyle {
  label: string
  /** 色点（tab；配"生产"字样色形双编码） */
  dot: string
  /** 前景字色 */
  fg: string
  /** 徽章底+字（审批卡与风险徽章并列处——事件现场的标注，非常驻氛围） */
  badge: string
  /** 终端区顶缘 2px 光条（仅生产使用；满不透明，不叠 alpha） */
  rail: string
}

/**
 * 色值在 main.css 的 `--env-prod` / `--env-exp`（v0.14.3 从 orange-500 / sky-500 收进令牌，
 * 暗色值不变）：亮底上原色号做文字只有 2.5:1 上下，按明暗各给一套。文字走 `-fg` 那级：
 * 亮色下光条要"还是橙"、文字要 4.5:1，一个值兼顾不了（暗色两级同值）。
 */
export const ENV_STYLE: Record<Exclude<HostEnvLevel, 'none'>, EnvStyle> = {
  production: {
    label: '生产',
    dot: 'bg-env-prod',
    fg: 'text-env-prod-fg',
    badge: 'bg-env-prod/15 text-env-prod-fg',
    rail: 'bg-env-prod'
  },
  experiment: {
    label: '实验',
    dot: 'bg-env-exp',
    fg: 'text-env-exp-fg',
    badge: 'bg-env-exp/15 text-env-exp-fg',
    rail: ''
  }
}

export function envStyle(level: HostEnvLevel | undefined): EnvStyle | null {
  if (!level || level === 'none') return null
  return ENV_STYLE[level]
}
