import type { ITheme } from '@xterm/xterm'
// shellPalette 反过来只 import type，不成环（check:cycles 只算 value import）
import { schemeOf } from './shellPalette'

/**
 * 终端配色方案（v0.9 外观）：调色板转换自 iTerm2-Color-Schemes 社区仓库的
 * .itermcolors（取 16 色 + bg/fg/cursor/selection，值为社区通行版本）。
 *
 * **每套方案必须给满 ANSI 16 色**——缺省时 xterm.js 会回落到它内置的
 * Tango 板，那套色是给浅底终端调的：压在旧默认底 #0c0d10 上，blue #3465a4
 * 只有 3.28:1（而它正是 `ls` 的目录名色），16 色里 5 色低于 AA 的 4.5:1。
 * 见 doc/appearance-design.md。
 */
export interface TerminalThemeDef {
  id: string
  name: string
  theme: ITheme
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    id: 'tsubasaterminal',
    name: 'Tsubasa Terminal（默认）',
    // v0.9.1 重做：底色脱离纯黑（旧 #0c0d10 配 #d6d8de 是 13.6:1，AAA 才要 7:1，
    // 过高会 halation 眩光）；前景落到 9.5:1 的舒适带；16 色补齐，统一在 5.9–9.1:1。
    // brightBlack 有意留在 3.2:1——它的语义就是"次要信息"，拉到 4.5 会破坏 dim 的表意。
    theme: {
      background: '#16181f',
      foreground: '#b9bec9',
      cursor: '#7aa2f7',
      selectionBackground: '#2c3149',
      black: '#252832',
      red: '#e5707e',
      green: '#87c07a',
      yellow: '#d7b56d',
      blue: '#7aa2f7',
      magenta: '#b48ef0',
      cyan: '#63c7d4',
      white: '#b9bec9',
      brightBlack: '#4a4f5e',
      brightRed: '#f28b96',
      brightGreen: '#a3d494',
      brightYellow: '#e8cb8a',
      brightBlue: '#9bb9fa',
      brightMagenta: '#c9aaf5',
      brightCyan: '#84d9e4',
      brightWhite: '#dfe3ea'
    }
  },
  {
    id: 'pitch-black',
    name: '纯黑 OLED',
    /*
     * v0.13.5：运维要"黑到极致"——底色是真 `#000000`，OLED 上这块像素是熄的，
     * 而终端区正是占屏最大的那块。外壳跟不到这么低（sRGB 低端量化会把阶梯压塌），
     * 由 `shared/shellPalette.ts` 的 SHELL_ANCHOR_FLOOR_L 兜到 `#0c0c0c` 起，那里有账。
     *
     * **前景拉满到纯白，眩光是明示接受的代价**（运维原话："绝对的白亮，晃眼睛
     * 啥的不管了"）。第一版试过守 v0.9.1 那条 8–11:1 舒适带，日用当场被打回来——
     * 字既发灰又不亮。两个症状一个根因：**纯黑底上对比度 ≡ 绝对亮度**
     * （比值 =(亮度+0.05)/0.05，底是 0，没有第二个变量），所以"守舒适带"在这里
     * 只能靠压暗前景来实现，而那正是问题本身。舒适带的前提是"可以抬底降对比"，
     * 底锁死在 0 就没这个手段了——那条线在纯黑上不可守，不是不想守。
     *
     * 于是：白全部拉满 `#ffffff`（21:1，foreground/white/brightWhite 三者同值，
     * bold 与正文不再分级——绝对白之上没有更白的），dim 那档相应从 2.6:1 提到
     * 4.6:1（正文纯白后 brightBlack 太暗会读不出）。
     *
     * **彩色统一明度，而不是各自顶到色域上限。** 顶上限试过：sRGB 里各色相的
     * 明度天花板差一倍（绿能到 18.3:1、蓝只能到 9.1:1），且普通色与 bright 色
     * 会撞在一起（绿 ΔL=0.007）。终端里颜色是并排出现的，**均衡比单色饱和度
     * 更重要**，故取普通六色 L=0.80（10.7–11.7:1，跨度 1.0）、bright 六色
     * L=0.85（12.9–13.7:1，跨度 0.9）。代价是红/蓝在高明度处撞色域边界，
     * 彩度只保住 66–80%（绿/黄/青 ~100%）——那是 sRGB 的账，不是标定的账。
     *
     * 灰阶（black/brightBlack/white/brightWhite/selection）**全部无彩**：
     * tsubasaterminal 的灰带轻微冷调（C≈0.016），压在无彩纯黑上会显出蓝斑。
     * 彩色六槽保留原色相——色相是 ANSI 的功能（`ls` 靠它分目录与文件），不是审美。
     *
     * cursor 同为 `#ffffff`，它被贯穿征用为 --ring/--primary：焦点环与主按钮
     * 因此是纯白，落在纯黑外壳上是这套配色里唯一的高光。
     */
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selectionBackground: '#3a3a3a',
      black: '#2a2a2a',
      red: '#ff9ea7',
      green: '#96d089',
      yellow: '#dbb971',
      blue: '#9dbdff',
      magenta: '#caabff',
      cyan: '#6ccfdc',
      white: '#ffffff',
      brightBlack: '#757575',
      brightRed: '#ffb8be',
      brightGreen: '#adde9e',
      brightYellow: '#e7ca89',
      brightBlue: '#b6ceff',
      brightMagenta: '#d9c0ff',
      brightCyan: '#89dee9',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  // v0.14.0 删除 Solarized Dark：低对比是明度病（前景 L=0.654 全场最低、对底仅 4.75:1），
  // 不改原始色值救不回来，改了又不再是 Solarized。老配置存的 id 由主进程 settings.ts
  // 读盘时改写为默认方案。论证见 doc/appearance-design.md §4
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'one-half-dark',
    name: 'One Half Dark',
    theme: {
      background: '#282c34',
      foreground: '#dcdfe4',
      cursor: '#dcdfe4',
      selectionBackground: '#474e5d',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5d677a',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#dcdfe4'
    }
  },
  /*
   * Catppuccin 两套的 ANSI 16 色取官方色板 `catppuccin/palette` v1.8.0 的
   * `ansiColors`——官方现行的槽位映射，底/前景/光标仍是各自的 base/text/rosewater。
   * 此前 Mocha 取自 iTerm2-Color-Schemes（white/brightWhite 对调、亮色一档照抄普通色），
   * Latte 取自 2022 年后未再更新的 catppuccin/windows-terminal（brightBlack 是 surface2
   * `#acb0be`，压浅底 1.91:1，zsh 自动建议、`\e[90m` 灰字近乎隐形）。
   * 色值都是官方色板里的颜色，旧版只是槽位映射过时，"照社区原值"的规矩不变。
   */
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#a6adc8',
      brightBlack: '#585b70',
      brightRed: '#f37799',
      brightGreen: '#89d88b',
      brightYellow: '#ebd391',
      brightBlue: '#74a8fc',
      brightMagenta: '#f2aede',
      brightCyan: '#6bd7ca',
      brightWhite: '#bac2de'
    }
  },
  /*
   * ── 浅色方案────────────────────────────────────────────────
   * 选浅色方案即切到亮色界面：外壳由 shared/shellPalette 按底色明度判明暗，
   * 没有单独的"界面明暗"开关。
   *
   * 色值与暗色方案同一条规矩：**照社区原值，不改**（v0.14.0 删 Solarized 时定的——
   * 改了就不再是那套方案）。浅色板的老毛病是几种颜色压白底近乎隐形（Latte 的
   * white `#acb0be` 1.91:1、brightWhite 1.61:1；One Half Light 的 brightWhite 就是
   * `#ffffff`），由 xterm 的 `minimumContrastRatio` 在渲染时兜底（见下方
   * minimumContrastFor），方案原值不动。
   */
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    // 16 色取 catppuccin/palette 的 ansiColors（见 Mocha 上方注释），**magenta 一对除外**：
    // 官方映射是 pink `#ea76cb`（压浅底 2.34:1，兜底后发灰发紫红），这里按作者拍板换成同色板的
    // mauve `#8839ef`（4.79:1，不触发兜底），与作者 Windows Terminal 里的 Latte 一致；
    // 官方没有"亮 mauve"，bright 一档同值。选区色官方色板不定义，沿用 windows-terminal 的 surface2
    theme: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      selectionBackground: '#acb0be',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#8839ef',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#de293e',
      brightGreen: '#49af3d',
      brightYellow: '#eea02d',
      brightBlue: '#456eff',
      brightMagenta: '#8839ef',
      brightCyan: '#2d9fa8',
      brightWhite: '#bcc0cc'
    }
  },
  {
    id: 'one-half-light',
    name: 'One Half Light',
    // 与 One Half Dark 成对，同取 iTerm2-Color-Schemes 的 windowsterminal 版本
    theme: {
      background: '#fafafa',
      foreground: '#383a42',
      cursor: '#a5b4e5',
      selectionBackground: '#bfceff',
      black: '#383a42',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#0184bc',
      magenta: '#a626a4',
      cyan: '#0997b3',
      white: '#bababa',
      brightBlack: '#4f525e',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#d8b36e',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  }
]

export function themeById(id: string | undefined): TerminalThemeDef {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]
}

/**
 * 终端网格的最低对比度（xterm `minimumContrastRatio`）：浅色方案 3，暗色方案 1（关闭）。
 *
 * 只给浅色开：远端程序大多默认"背景是暗的"，打白字（`\e[37m`/`\e[97m`）或真彩色白字，
 * 压在浅底上近乎隐形（Latte 1.61–1.91:1）。xterm 在渲染时把前景压暗到够对比，
 * 方案原值不动、只影响画出来的颜色。
 *
 * **取 3 而不是 4.5**（v0.14.3 曾取 VS Code 的默认 4.5）：xterm 的做法是 RGB
 * 三通道每轮一起乘 0.9、直到达标，还会冲过目标——4.5 把 Latte 的黄 `#df8e1d` 压成土棕
 * `#915b12`、粉压成 `#994c83`，整套板发浑，和其他终端里的同名方案对不上。当初要 4.5
 * 主要是替旧映射下 1.91:1 的 brightBlack 兜底，换成官方映射（`#6c6f85` 4.37:1）后这笔账
 * 在源头没了；剩下真隐形的只有白字，3 足够救回（`#acb0be` → `#7c7f89`），而黄、绿、粉
 * 只暗一两档、仍是原色调，青与 brightBlack 不再被改动。
 *
 * 暗色方案保持关闭：v0.9.1 起它们的 16 色都逐色标定过（默认方案 brightBlack 有意
 * 留在 3.2:1），开了会改掉既有观感。
 */
export const LIGHT_MIN_CONTRAST = 3

export function minimumContrastFor(def: TerminalThemeDef): number {
  return schemeOf(def.theme.background ?? '#000000') === 'light' ? LIGHT_MIN_CONTRAST : 1
}

/**
 * 默认字体回退栈：西文等宽在前，**CJK 等宽回退殿后**（Sarasa/Noto CJK 的
 * 汉字是严格 2:1 全宽，避免 CJK 落到系统 UI 字体导致网格错位）。
 * 用户在设置中选 Nerd Font（如 CaskaydiaCove NF）可显示 powerline/图标字形。
 */
export const FONT_FALLBACK_STACK =
  '"Cascadia Mono", Consolas, "Sarasa Mono SC", "Sarasa Term SC", "Noto Sans Mono CJK SC", "Source Han Mono SC", "Microsoft YaHei", monospace'

export function buildFontFamily(custom: string): string {
  const name = custom.trim()
  if (!name) return FONT_FALLBACK_STACK
  const quoted = /[\s]/.test(name) && !name.startsWith('"') ? `"${name}"` : name
  return `${quoted}, ${FONT_FALLBACK_STACK}`
}

/**
 * 字体下拉的退路候选：仅当 Local Font Access 取不到系统字体时，由
 * lib/localFonts.ts 逐个度量探测。正常路径直接枚举系统字体，不受本清单限制。
 */
export const FONT_CANDIDATES = [
  'Cascadia Mono',
  'Cascadia Code',
  'CaskaydiaCove Nerd Font',
  'CaskaydiaMono Nerd Font',
  'Consolas',
  'JetBrains Mono',
  'JetBrainsMono Nerd Font',
  'Fira Code',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
  'MesloLGS NF',
  'Maple Mono',
  'Maple Mono NF CN',
  'Sarasa Mono SC',
  'Sarasa Term SC',
  'Noto Sans Mono CJK SC',
  'Source Han Mono SC'
]
