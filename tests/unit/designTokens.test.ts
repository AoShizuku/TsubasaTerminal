import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

import { TEXT_ROLES, cn } from '../../src/renderer/src/lib/utils'

/**
 * 设计令牌守卫（与姊妹项目 TsubasaRedisManager 设计语言对齐）。
 * 对齐不是一次性清扫：新代码随手写个 text-xs / text-[10px]，档位就又散了。
 * 规则与理由见 doc/tsubasa-alignment.md §2–§3 与 assets/main.css 的 @theme 注释。
 */

const ROOT = join(__dirname, '../..')
const RENDERER = join(ROOT, 'src/renderer/src')

function sourceFiles(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path, ext)
    return ext.test(entry.name) ? [path] : []
  })
}

function offenders(ext: RegExp, pattern: RegExp): string[] {
  return sourceFiles(RENDERER, ext).flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((line, i) =>
        pattern.test(line) ? [`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`] : []
      )
  )
}

describe('type scale', () => {
  it('components use role classes (text-badge/meta/list/body/title/code), never pixel sizes', () => {
    expect(
      offenders(/\.(vue|ts)$/, /\btext-(?:xs|sm|base|lg|[2-9]?xl|\[\d+(?:\.\d+)?(?:px|rem|em)\])(?![\w-])/)
    ).toEqual([])
  })

  it('cn() keeps a role size next to a text color instead of treating it as a color', () => {
    // v0.14.2 首轮验收的真实缺陷：审批卡「执行」按钮与风险徽标的字号被合并吞掉
    expect(cn('rounded px-2 text-meta', 'text-ok')).toBe('rounded px-2 text-meta text-ok')
    expect(cn('text-badge', 'bg-warn/15 text-warn')).toBe('text-badge bg-warn/15 text-warn')
    expect(cn('text-code-body', 'text-muted-foreground')).toBe('text-code-body text-muted-foreground')
    // 同组内后者覆盖前者照旧
    expect(cn('text-list', 'text-meta')).toBe('text-meta')
  })

  it('cn() knows exactly the roles main.css defines', () => {
    const css = readFileSync(join(RENDERER, 'assets/main.css'), 'utf-8')
    const defined = [...css.matchAll(/^\s*--text-([\w-]+?):/gm)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith('--line-height'))
    expect([...defined].sort()).toEqual([...TEXT_ROLES].sort())
  })

  it('hand-written CSS font sizes go through the --fs-* tokens', () => {
    expect(offenders(/\.(vue|css)$/, /font-size:(?!\s*var\(--fs-)/)).toEqual([])
  })
})

describe('colors', () => {
  /*
   * v0.14.3 亮色主题的前置：组件里写死的 Tailwind 色号只为暗底调过——emerald-500、
   * yellow-600、sky-500、orange-500 压在亮底上做文字都只有 2–3:1。颜色一律走
   * main.css 的令牌（ok / warn / danger / info / env-prod / env-exp 与外壳派生色），
   * 由令牌按明暗给值。见 doc/appearance-design.md。
   */
  const PALETTE =
    'white|black|zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
  const UTILITY = 'bg|text|border|ring|stroke|fill|from|via|to|outline|decoration|shadow|divide|placeholder|caret|accent'

  it('components use color tokens, never Tailwind palette colors', () => {
    expect(
      offenders(/\.(vue|ts)$/, new RegExp(`\\b(?:${UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:/[\\w.[\\]]+)?(?![\\w-])`))
        // 注释里讲历史写法（如 Dlg.vue 头注释的 bg-black/60）不算在用
        .filter((hit) => !/^\S+ {2}(?:\*|\/\/)/.test(hit))
    ).toEqual([])
  })
})

describe('icons', () => {
  /** 标签属性里可能有 `index > 1` 这类带 > 的引号值，按引号成对跳过 */
  const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`

  it('every lucide icon is sized by .i-12 / .i-16 / .i-20 (checkbox ticks may pass :size="12")', () => {
    const bad: string[] = []
    for (const file of sourceFiles(RENDERER, /\.vue$/)) {
      const src = readFileSync(file, 'utf-8')
      const names = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-vue-next'/g)].flatMap((m) =>
        m[1]
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/).pop()!)
          .filter(Boolean)
      )
      if (names.length === 0) continue
      const tags = [
        ...names.flatMap((name) => [...src.matchAll(new RegExp(`<${name}\\b${ATTRS}>`, 'g'))]),
        ...[...src.matchAll(new RegExp(`<component\\b${ATTRS}>`, 'g'))].filter((m) =>
          names.some((name) => new RegExp(`\\b${name}\\b`).test(m[1]))
        )
      ]
      for (const tag of tags) {
        const attrs = tag[1]
        const sized = /\bclass="[^"]*\bi-(?:12|16|20)\b/.test(attrs) || /:size="12"/.test(attrs)
        if (!sized || /\b(?:size-|[wh]-)[\d.]+\b|:size="(?!12")/.test(attrs)) {
          const line = src.slice(0, tag.index).split('\n').length
          bad.push(`${relative(ROOT, file)}:${line}  ${tag[0].replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
