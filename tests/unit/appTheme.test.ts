import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  deriveShell,
  hexToOklch,
  oklchToHex,
  schemeOf
} from '../../src/shared/shellPalette'
import { TERMINAL_THEMES, minimumContrastFor, themeById } from '../../src/shared/terminalThemes'

describe('terminal-derived application theme', () => {
  it.each(['#000000', '#ffffff', '#16181f', '#268bd2'])('round-trips %s through OKLCH', (hex) => {
    expect(oklchToHex(hexToOklch(hex))).toBe(hex)
  })

  it('keeps the established Tsubasa Terminal shell palette byte-for-byte', () => {
    expect(deriveShell(themeById('tsubasaterminal').theme)).toMatchObject({
      background: '#1c1e25',
      card: '#22242b',
      subtle: '#25272f',
      muted: '#292b33',
      active: '#2f3139',
      border: '#353840',
      borderStrong: '#454750',
      foreground: '#b9bec9',
      foreground2: '#a3a8b2',
      mutedForeground: '#8d929d',
      quietForeground: '#70747e',
      ring: '#7aa2f7'
    })
  })

  it('caps a colorful foreground without muting the terminal cursor accent', () => {
    const palette = deriveShell(themeById('tokyo-night').theme)

    expect(palette.foreground).toBe('#c8ccda')
    expect(palette.mutedForeground).toBe('#9498a5')
    expect(palette.ring).toBe(themeById('tokyo-night').theme.cursor)
  })

  // v0.14.0 删掉 Solarized 后内置方案底色最高 C≈0.030，彩度上限不再被触发；
  // 用它原来的高彩度底色（C=0.0486）内联喂进去，护栏照样有测试守着
  it('caps a high-chroma background while preserving its hue', () => {
    const p = deriveShell({ background: '#002b36', foreground: '#839496', cursor: '#839496' })
    expect(p).toMatchObject({ background: '#06313d', border: '#264d59' })
    // v0.14.3 起它的光标（4.2:1）还会被强调色对比闸往亮提——这也是 Solarized
    // "发闷"的同一笔账；内置暗色方案全都不触发这道闸（见下方逐方案用例）
    expect(hexToOklch(p.ring).L).toBeGreaterThan(hexToOklch('#839496').L)
    expect(contrastRatio(p.background, p.ring)).toBeGreaterThanOrEqual(4.5)
  })

  it('falls back to the default scheme for the retired Solarized Dark id', () => {
    expect(themeById('solarized-dark').id).toBe('tsubasaterminal')
  })

  it('raises a pure-black shell above the quantization floor while keeping neutral grays', () => {
    expect(deriveShell(themeById('pitch-black').theme)).toEqual({
      scheme: 'dark',
      background: '#0c0c0c',
      card: '#121212',
      subtle: '#151515',
      muted: '#181818',
      active: '#1e1e1e',
      border: '#242424',
      borderStrong: '#333333',
      control: '#181818',
      controlActive: '#1e1e1e',
      knob: '#ffffff',
      foreground: '#ffffff',
      foreground2: '#c7c7c7',
      mutedForeground: '#929292',
      quietForeground: '#666666',
      ring: '#ffffff',
      primaryForeground: '#0c0c0c'
    })
  })

  /*
   * v0.14.3：亮色派生加进来后，暗色这一侧必须逐字节不变——新增的几个字段在暗色下
   * 只是既有值的别名（控件面 = muted、分段选中 = active、圆钮 = 正文、主按钮字 = background），
   * 强调色的对比闸对内置暗色方案一律不触发。
   */
  it.each(TERMINAL_THEMES.filter((t) => schemeOf(t.theme.background!) === 'dark').map((t) => t.id))(
    'dark scheme %s keeps its pre-light-theme mapping',
    (id) => {
      const theme = themeById(id).theme
      const p = deriveShell(theme)
      expect(p.scheme).toBe('dark')
      expect(p.control).toBe(p.muted)
      expect(p.controlActive).toBe(p.active)
      expect(p.knob).toBe(p.foreground)
      expect(p.primaryForeground).toBe(p.background)
      expect(p.ring).toBe(theme.cursor)
    }
  )
})

describe('light scheme derivation (v0.14.3)', () => {
  it('classifies every built-in scheme far from the 0.6 lightness boundary', () => {
    for (const t of TERMINAL_THEMES) {
      const L = hexToOklch(t.theme.background!).L
      // 中间带没有方案：判据不会因为某套方案恰好落在分界附近而左右摇摆
      expect(L < 0.4 || L > 0.75, `${t.id} L=${L.toFixed(3)}`).toBe(true)
    }
  })

  /*
   * "同门"在亮色下是可测的：纯白锚点下的阶梯明度应落在姊妹项目 TsubasaRedisManager
   * 的浅色令牌上（src/styles/tokens.css）。色值不逐字节比——它带一点冷调（#f8f8fa），
   * 我们的纯白锚点无彩——只比 OKLCH 明度。
   */
  it('reproduces the sister project light tokens from a pure white anchor', () => {
    const p = deriveShell({ background: '#ffffff', foreground: '#17171b', cursor: '#2563eb' })
    const sister = {
      background: '#f8f8fa', // --bg-sidebar
      subtle: '#f6f6f8', // --bg-chrome
      muted: '#f2f2f5', // --bg-inset
      border: '#e6e6ea', // --bd
      borderStrong: '#d8d8de' // --bd-strong
    } as const
    for (const [key, hex] of Object.entries(sister)) {
      expect(
        Math.abs(hexToOklch(p[key as keyof typeof sister]).L - hexToOklch(hex).L),
        key
      ).toBeLessThanOrEqual(0.003)
    }
    expect(p.scheme).toBe('light')
    // 弹窗与控件面截到白，同它的 --bg-app 与控件底 #fff
    expect(p.card).toBe('#ffffff')
    expect(p.control).toBe('#ffffff')
    // 它的强调蓝本就达标，闸不触发
    expect(p.ring).toBe('#2563eb')
  })

  // 内置两套浅色方案 + 纯白锚点（姊妹项目的底），三者覆盖了亮色锚点的明度范围
  type Anchor = { background: string; foreground: string; cursor: string }
  const asAnchor = (id: string): Anchor => themeById(id).theme as Anchor
  const LIGHT_ANCHORS: Record<string, Anchor> = {
    'catppuccin-latte': asAnchor('catppuccin-latte'),
    'one-half-light': asAnchor('one-half-light'),
    white: { background: '#ffffff', foreground: '#17171b', cursor: '#2563eb' }
  }

  it('ships the light schemes as light and only they get a terminal contrast floor', () => {
    expect(themeById('catppuccin-latte').id).toBe('catppuccin-latte')
    expect(themeById('one-half-light').id).toBe('one-half-light')
    for (const t of TERMINAL_THEMES) {
      const light = schemeOf(t.theme.background!) === 'light'
      expect(light, t.id).toBe(t.id === 'catppuccin-latte' || t.id === 'one-half-light')
      expect(minimumContrastFor(t), t.id).toBe(light ? 3 : 1)
    }
  })

  /*
   * v0.14.5：Latte 改用 catppuccin/palette 的 ANSI 映射后，灰字（`\e[90m`，zsh 自动建议）
   * 不靠兜底就看得清，且仍比正文淡；兜底降到 3 后它与青色不再被改写。
   */
  it('Latte dim text reads on its own and the lowered floor leaves it untouched', () => {
    const t = themeById('catppuccin-latte').theme
    const bg = t.background!
    const dim = contrastRatio(t.brightBlack!, bg)
    expect(dim).toBeGreaterThanOrEqual(3)
    expect(dim).toBeLessThan(contrastRatio(t.foreground!, bg))
    expect(contrastRatio(t.cyan!, bg)).toBeGreaterThanOrEqual(3)
    // magenta 用 mauve（作者拍板，同其 WT 配置），不靠兜底就够对比
    expect(t.magenta).toBe('#8839ef')
    expect(contrastRatio(t.magenta!, bg)).toBeGreaterThanOrEqual(4.5)
    // 真隐形的白字仍在兜底范围内
    expect(contrastRatio(t.white!, bg)).toBeLessThan(3)
    expect(contrastRatio(t.brightWhite!, bg)).toBeLessThan(3)
  })

  it.each(Object.entries(LIGHT_ANCHORS))('%s: floats overlays up, sinks chrome down', (_, theme) => {
    const p = deriveShell(theme)
    const L = (hex: string): number => hexToOklch(hex).L
    // 浮层往白、强调与侧栏往暗——只翻正负号的话弹窗会比侧栏还灰
    expect(L(p.card)).toBeGreaterThanOrEqual(L(theme.background))
    expect(L(theme.background)).toBeGreaterThan(L(p.background))
    expect(L(p.background)).toBeGreaterThan(L(p.subtle))
    expect(L(p.subtle)).toBeGreaterThan(L(p.muted))
    expect(L(p.muted)).toBeGreaterThan(L(p.active))
    expect(L(p.active)).toBeGreaterThan(L(p.border))
    expect(L(p.border)).toBeGreaterThan(L(p.borderStrong))
    expect(p.control).toBe(p.card)
    expect(p.controlActive).toBe(p.card)
    expect(p.knob).toBe(p.card)
    expect(p.primaryForeground).toBe(p.card)
  })

  it.each(Object.entries(LIGHT_ANCHORS))('%s: text tiers keep their contrast floors', (_, theme) => {
    const p = deriveShell(theme)
    const L = (hex: string): number => hexToOklch(hex).L
    // v0.14.5：正文压到 L ≤ 0.25（姊妹项目 --fg 的量级），三级按 6:1 而非刚够 4.5
    expect(L(p.foreground)).toBeLessThanOrEqual(0.251)
    expect(contrastRatio(p.foreground, p.background)).toBeGreaterThanOrEqual(12)
    expect(contrastRatio(p.mutedForeground, p.muted)).toBeGreaterThanOrEqual(6)
    expect(contrastRatio(p.quietForeground, p.muted)).toBeGreaterThanOrEqual(3)
    // 层级不倒挂：正文最重，次级、三级、四级依次变淡
    expect(L(p.foreground)).toBeLessThan(L(p.foreground2))
    expect(L(p.foreground2)).toBeLessThan(L(p.mutedForeground))
    expect(L(p.mutedForeground)).toBeLessThan(L(p.quietForeground))
  })

  it.each(Object.entries(LIGHT_ANCHORS))('%s: the accent is gated for text and focus rings', (_, theme) => {
    const p = deriveShell(theme)
    expect(contrastRatio(p.primaryForeground, p.ring)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(p.muted, p.ring)).toBeGreaterThanOrEqual(4.5)
    for (const surface of [p.background, p.card, p.subtle, p.muted, p.active]) {
      expect(contrastRatio(surface, p.ring)).toBeGreaterThanOrEqual(3)
    }
  })

  /*
   * v0.14.5：亮色外壳正文不再沿用终端前景的明度（Latte #4c4f69 在侧栏上只有 6.6:1，
   * 小字号读作发虚）。只压明度，保留方案色相；终端网格仍拿方案原值。
   */
  it('darkens the Latte shell text below the terminal foreground, keeping its hue', () => {
    const theme = themeById('catppuccin-latte').theme
    const p = deriveShell(theme)
    expect(p.foreground).toBe('#1f212b')
    expect(p.mutedForeground).toBe('#4f515d')
    // 彩度 0.02 时 8bit 量化让色相漂 ~3°（改前的 #4f505c 也漂了 2.4°），仍是同一个蓝灰
    expect(Math.abs(hexToOklch(p.foreground).h - hexToOklch(theme.foreground!).h)).toBeLessThan(0.1)
    expect(theme.foreground).toBe('#4c4f69')
  })

  it('darkens a pale light-theme cursor along lightness only, keeping its hue', () => {
    const cursor = LIGHT_ANCHORS['one-half-light'].cursor
    const p = deriveShell(LIGHT_ANCHORS['one-half-light'])
    expect(p.ring).not.toBe(cursor)
    expect(hexToOklch(p.ring).L).toBeLessThan(hexToOklch(cursor).L)
    expect(Math.abs(hexToOklch(p.ring).h - hexToOklch(cursor).h)).toBeLessThan(0.05)
  })
})
