import { deriveShell, type ShellPalette } from '@shared/shellPalette'
import type { TerminalThemeDef } from '@shared/terminalThemes'

/**
 * 主题贯穿的 DOM 适配：派生本身（`deriveShell`）在 `src/shared/shellPalette.ts`，
 * 主进程建窗时也要用；这里只负责把结果写到 documentElement 上。
 *
 * 写的是 documentElement 上的内联 CSS 变量——优先级天然高于 main.css 里
 * `.dark` 的类选择器定义，无需改动任何组件。
 *
 * v0.14.3 起同时切 `<html>` 的 `dark` class：main.css 的 `color-scheme`（原生滚动条、
 * `select::picker`）与按明暗给值的固定色（语义色、环境色、阴影）都挂在它上面。
 * 返回派生结果，供调用方同步遮罩等依赖明暗的状态。
 */
export function applyAppTheme(def: TerminalThemeDef): ShellPalette {
  const p = deriveShell(def.theme)
  const root = document.documentElement
  root.classList.toggle('dark', p.scheme === 'dark')
  const style = root.style
  const set = (name: string, value: string): void => style.setProperty(name, value)

  set('--background', p.background)
  set('--foreground', p.foreground)
  set('--card', p.card)
  set('--card-foreground', p.foreground)
  set('--popover', p.card)
  set('--popover-foreground', p.foreground)
  set('--secondary', p.muted)
  set('--secondary-foreground', p.foreground)
  set('--muted', p.muted)
  set('--muted-foreground', p.mutedForeground)
  set('--accent', p.muted)
  set('--accent-foreground', p.foreground)
  set('--border', p.border)
  set('--input', p.border)
  set('--ring', p.ring)
  set('--primary', p.ring)
  set('--primary-foreground', p.primaryForeground)

  /*
   * v0.13.0 控件层（`assets/controls.css` / `overlay.css`）用的别名。
   * 名字沿用姊妹项目 TsubasaRedisManager 的令牌表——两边的 CSS 因此可以
   * 逐行对读，这是"统一形制"落到源码层的那一半。值仍然全部派生自终端底色。
   *
   * **少一个名字：`--accent`。** 那边用它表示交互强调色（蓝），我们这边这个名字
   * 早被 shadcn 的灰阶占了（`--accent` = muted 那一级，`bg-accent` 到处在用）。
   * 我们的交互强调色是 `--ring`（= 方案的光标色），controls.css 里直接写它。
   */
  set('--bg-subtle', p.subtle)
  set('--bg-active', p.active)
  set('--bd', p.border)
  set('--bd-strong', p.borderStrong)
  set('--fg', p.foreground)
  set('--fg-2', p.foreground2)
  set('--fg-3', p.mutedForeground)
  set('--fg-4', p.quietForeground)
  // v0.14.3：亮色下控件面与浮层同为白，与暗色"控件 = muted"分家，见 ShellPalette 注释
  set('--bg-ctl', p.control)
  set('--bg-ctl-on', p.controlActive)
  set('--knob', p.knob)
  return p
}
