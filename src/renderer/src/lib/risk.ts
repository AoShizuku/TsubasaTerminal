import type { AgentRisk } from '@shared/types'

/**
 * 风险分级视觉 token（composer-design v0.8.2）：审批卡风险圈、风险徽章、
 * write_file 查看器延伸共用一套色。低中高不同色是"对抗狼来了"在视觉层的
 * 对应——全红则红色通胀，真正 high 出现时不再刺眼。
 * v0.9 生产机红框复用 high 系，勿在组件内另写死风险色。
 */
export interface RiskStyle {
  label: string
  /** 徽章底+字 */
  badge: string
  /** 前景字色（hint 行徽标等） */
  fg: string
  /** 审批卡/查看器的风险圈（ring-inset，高危加重） */
  ring: string
  /** 审批卡淡底色（与输入行区分的来源边界） */
  bg: string
}

export const RISK_STYLE: Record<AgentRisk, RiskStyle> = {
  // v0.14.3：绿黄两级从 emerald / yellow 色号收进语义令牌 --ok / --warn（随明暗切换）
  low: {
    label: '低风险',
    badge: 'bg-ok/15 text-ok',
    fg: 'text-ok',
    ring: 'ring-1 ring-inset ring-ok/30',
    bg: 'bg-ok/[0.04]'
  },
  mid: {
    label: '中风险',
    badge: 'bg-warn/15 text-warn',
    fg: 'text-warn',
    ring: 'ring-1 ring-inset ring-warn/40',
    bg: 'bg-warn/[0.04]'
  },
  high: {
    label: '高风险',
    badge: 'bg-destructive/15 text-destructive',
    fg: 'text-destructive',
    ring: 'ring-2 ring-inset ring-destructive/50',
    bg: 'bg-destructive/[0.06]'
  }
}

/** continue（轮数熔断）不是风险决策，用中性圈：费用护栏轻摩擦，不占用风险色 */
export const NEUTRAL_CARD = 'ring-1 ring-inset ring-border bg-muted/30'
