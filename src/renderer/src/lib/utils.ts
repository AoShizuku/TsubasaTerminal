import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * main.css `@theme` 里定义的字号角色（text-badge / text-meta …）。
 *
 * tailwind-merge 不认识自定义的 `text-*`，会把它们当成**文字颜色**：
 * `cn('text-meta', 'text-ok')` 合并后只剩颜色，字号静默丢掉，元素退回继承字号
 * （v0.14.2 首轮验收：审批卡「y 执行」比「N 拒绝」大一号，风险徽标同理）。
 * 登记成 font-size 组后两者互不冲突。增删角色时两边一起改，tests/unit/designTokens 比对着。
 */
export const TEXT_ROLES = ['badge', 'meta', 'list', 'code', 'body', 'code-body', 'title'] as const

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: [...TEXT_ROLES] }] } }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
