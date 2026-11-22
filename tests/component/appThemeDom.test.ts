// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { applyAppTheme } from '../../src/renderer/src/lib/appTheme'
import { deriveShell } from '../../src/shared/shellPalette'
import { themeById, type TerminalThemeDef } from '../../src/shared/terminalThemes'

beforeEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.className = 'dark'
})

/** 亮色锚点（内联，与内置方案解耦：这里守的是 DOM 适配，不是某套方案的取值） */
const LIGHT: TerminalThemeDef = {
  id: 'light-probe',
  name: 'light-probe',
  theme: { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78' }
}

describe('application theme DOM adapter', () => {
  it.each(['tsubasaterminal', 'catppuccin-mocha', 'pitch-black'])(
    'writes the complete %s palette to root CSS variables',
    (themeId) => {
      const theme = themeById(themeId)
      const palette = deriveShell(theme.theme)

      applyAppTheme(theme)

      const style = document.documentElement.style
      expect(style.getPropertyValue('--background')).toBe(palette.background)
      expect(style.getPropertyValue('--card')).toBe(palette.card)
      expect(style.getPropertyValue('--bg-subtle')).toBe(palette.subtle)
      expect(style.getPropertyValue('--muted')).toBe(palette.muted)
      expect(style.getPropertyValue('--bg-active')).toBe(palette.active)
      expect(style.getPropertyValue('--border')).toBe(palette.border)
      expect(style.getPropertyValue('--bd-strong')).toBe(palette.borderStrong)
      expect(style.getPropertyValue('--foreground')).toBe(palette.foreground)
      expect(style.getPropertyValue('--fg-2')).toBe(palette.foreground2)
      expect(style.getPropertyValue('--muted-foreground')).toBe(palette.mutedForeground)
      expect(style.getPropertyValue('--fg-4')).toBe(palette.quietForeground)
      expect(style.getPropertyValue('--ring')).toBe(palette.ring)
      expect(style.getPropertyValue('--primary-foreground')).toBe(palette.primaryForeground)
      expect(style.getPropertyValue('--bg-ctl')).toBe(palette.control)
      expect(style.getPropertyValue('--bg-ctl-on')).toBe(palette.controlActive)
      expect(style.getPropertyValue('--knob')).toBe(palette.knob)
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    }
  )

  it('toggles the dark class with the scheme so fixed colors and color-scheme follow', () => {
    applyAppTheme(LIGHT)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--bg-ctl')).toBe(deriveShell(LIGHT.theme).card)

    applyAppTheme(themeById('tsubasaterminal'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
