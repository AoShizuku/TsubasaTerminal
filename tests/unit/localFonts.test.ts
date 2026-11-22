import { describe, expect, it } from 'vitest'

import {
  isInstalledByMetrics,
  pickMonospaceFamilies,
  quoteFamily,
  type MeasureWidth
} from '../../src/renderer/src/lib/localFonts'

/**
 * 假度量：按 font-family 串里**第一个装了的族**取字宽表。等宽字体每字 10px；
 * 比例字体按字区分；未装的族跳过，落到串尾通用族——与浏览器的回退行为一致。
 */
const PROPORTIONAL = { i: 4, W: 14, m: 12, '.': 4 } as Record<string, number>
function fakeMeasure(installed: Record<string, 'mono' | 'prop'>): MeasureWidth {
  const generic: Record<string, 'mono' | 'prop'> = { monospace: 'mono', serif: 'prop' }
  return (fontFamily, text) => {
    const families = fontFamily.split(',').map((f) => f.trim().replace(/^"|"$/g, ''))
    const hit = families.find((f) => f in installed) ?? families.find((f) => f in generic)
    // 通用族与具体字体的度量不同（不同字体），用名字长度错开
    const offset = hit && hit in generic ? 0.25 * hit.length : 0
    const kind = hit ? (installed[hit] ?? generic[hit]) : 'prop'
    return [...text].reduce((sum, ch) => sum + (kind === 'mono' ? 10 : (PROPORTIONAL[ch] ?? 8)) + offset, 0)
  }
}

describe('pickMonospaceFamilies', () => {
  it('keeps installed monospace families by their real names, deduped and sorted', () => {
    const measure = fakeMeasure({
      'Maple Mono Normal NL NF CN': 'mono',
      Consolas: 'mono',
      'Segoe UI': 'prop'
    })
    // queryLocalFonts 按字重逐条返回，同一 family 会出现多次
    const families = [
      'Segoe UI',
      'Maple Mono Normal NL NF CN',
      'Maple Mono Normal NL NF CN',
      'Consolas',
      '  Consolas  '
    ]
    expect(pickMonospaceFamilies(families, measure)).toEqual(['Consolas', 'Maple Mono Normal NL NF CN'])
  })

  it('drops symbol fonts even when their glyph widths are uniform', () => {
    const measure = fakeMeasure({ Marlett: 'mono', 'Wingdings 2': 'mono', 'Cascadia Mono': 'mono' })
    expect(pickMonospaceFamilies(['Marlett', 'Wingdings 2', 'Cascadia Mono'], measure)).toEqual([
      'Cascadia Mono'
    ])
  })

  it('rejects a family whose name canvas cannot resolve (falls back to a proportional default)', () => {
    expect(pickMonospaceFamilies(['Ghost Font'], fakeMeasure({}))).toEqual([])
  })
})

describe('isInstalledByMetrics', () => {
  it('tells installed fonts from missing ones', () => {
    const measure = fakeMeasure({ 'Fira Code': 'mono' })
    expect(isInstalledByMetrics('Fira Code', measure)).toBe(true)
    expect(isInstalledByMetrics('Maple Mono NF CN', measure)).toBe(false)
  })

  it('still detects a font that is itself the generic monospace (Consolas on Windows)', () => {
    // monospace 解析到的就是 Consolas：与 monospace 比无差，只能靠 serif 那一组比出来
    const measure: MeasureWidth = (fontFamily) =>
      fontFamily.includes('Consolas') || fontFamily === 'monospace' ? 100 : 80
    expect(isInstalledByMetrics('Consolas', measure)).toBe(true)
  })
})

describe('quoteFamily', () => {
  it('escapes quotes and backslashes inside family names', () => {
    expect(quoteFamily('A "B" \\C')).toBe('"A \\"B\\" \\\\C"')
  })
})
