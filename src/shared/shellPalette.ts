import type { TerminalThemeDef } from './terminalThemes'

/**
 * 主题贯穿：UI 外壳的配色不再是独立的一套 shadcn 灰阶，
 * 而是从**终端 background 派生**——终端底色是唯一的锚，外壳的表面阶梯沿
 * OKLCH 的 L 轴走（H 保留、C 保留），前景取 theme.foreground、
 * 强调/焦点环取 theme.cursor。
 *
 * v0.9.3 收口：前景**不再原样透传**，彩度过 SHELL_FG_CHROMA_CAP 一闸——
 * 见那里的注释，"贯穿"曾把终端的色偏一路染到左栏标题上。
 *
 * 暗底往**亮**抬而不是往暗压：终端是内容区，应该是整屏最深的那口井，
 * 左右栏比它亮一档，视觉上自然下沉。
 *
 * v0.14.3 亮色：明暗由底色明度判（`schemeOf`），**不是**把方向翻过来就完事。
 * 暗色下"浮起"（弹窗、下拉、控件面）和"强调"（悬停、选中、分隔线）都往亮走，
 * 一条轴就够；亮色下两者分家——浮层更白、靠阴影浮起，强调与侧栏更暗。只翻正负号
 * 会让弹窗比侧栏还灰。所以亮色单独一张阶梯表 LIGHT_RUNGS，按姊妹项目
 * TsubasaRedisManager 的浅色令牌标定，见 doc/appearance-design.md。
 *
 * v0.14.3 起本文件在 `src/shared/`：主进程建窗时要用同一套派生给原生窗口底色与
 * 标题栏按钮区上色（否则亮色用户启动先闪一下暗色），公共语义只留一份实现。
 * DOM 适配（写 CSS 变量）仍在渲染层 `lib/appTheme.ts`。
 *
 * 色彩数学手写不引依赖：CSS 的 `oklch()` 能写但**读不回来**（拿不到派生
 * 所需的 L/C/H 分量），转换必须在 JS 里做；也不能用 `color-mix()` 代替——
 * 明度阶梯要在感知均匀空间里走，sRGB 空间的混合在深色端会塌陷。
 * 详见 doc/appearance-design.md。
 */

export interface Oklch {
  L: number
  C: number
  /** 色相，弧度 */
  h: number
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)

const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  ]
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) }
}

export function oklchToHex({ L, C, h }: Oklch): string {
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l3 = L + 0.3963377774 * a + 0.2158037573 * b
  const m3 = L - 0.1055613458 * a - 0.0638541728 * b
  const s3 = L - 0.0894841775 * a - 1.291485548 * b
  const l = l3 * l3 * l3
  const m = m3 * m3 * m3
  const s = s3 * s3 * s3
  const channel = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)
      .toString(16)
      .padStart(2, '0')
  return (
    '#' +
    channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  )
}

/**
 * 外壳彩度上限——防止派生出比终端还艳的外壳（高 C 底色的护栏）。
 * 当初顶在线上的是 Solarized（底色 C=0.0486）；v0.14.0 删掉它之后，现存方案底色
 * 最高是 Catppuccin 的 0.030，这道闸对内置方案不再触发，留作新增方案的护栏。
 */
const SHELL_CHROMA_CAP = 0.05

/**
 * 外壳**前景**彩度上限（v0.9.3 补装）——上面那道护栏 v0.9.1 只装在了底色那一侧，
 * 前景是原样透传的，于是 Tokyo Night 的 `#c0caf5`（C=0.061）**超过了底色的上限**，
 * 外壳文字比外壳底还艳：左栏「主机列表」在 Gruvbox 下是土黄的、在 Catppuccin 下
 * 是蓝紫的，整屏像蒙了层滤镜。原方案在 iTerm 里只染终端网格，是"贯穿"把它放大了。
 *
 * 0.02 这个值来自实测分界：八套方案里 C ≤ 0.0164 的四套（tsubasaterminal / nord /
 * dracula / one-half）观感中性，C ≥ 0.0426 的三套（tokyo-night / gruvbox /
 * catppuccin）全被指出发色。取 0.02 使前者**逐字节不变**，只压后者。
 *
 * 只压彩度不动明度与色相：Tokyo Night 的外壳文字仍微微偏蓝，保住方案调性，
 * 不是拍平成灰。**终端网格不受影响**——xterm 拿的是 terminalThemes 的原值，
 * 色偏属于内容，这里治的是容器。
 */
const SHELL_FG_CHROMA_CAP = 0.02

/**
 * 外壳阶梯的**锚点明度下限**（v0.13.5 补装）——上面两道闸管彩度，这道管明度。
 *
 * 阶梯是"相对终端底色 L 的增量"，而 sRGB 的传输函数在低端极陡：同样 +0.025 的 L，
 * 在 L₀=0.210（现有最暗的 tsubasaterminal）上是 6 个 8bit 级，在 L₀=0 上**不足 0.1 级**。
 * 于是纯黑底直接跑阶梯会全档塌掉——左右栏与终端区逐字节相同（分不出栏）、
 * 分隔线 `#070707` 对底 1.04:1（等于没有）：
 *
 *     background #000000  card #000000  subtle #010101  muted #020202
 *     active     #040404  border #070707  borderStrong #141414
 *
 * 0.13 是两条边界夹出来的。**下限 0.06**：阶梯最窄的一档（subtle→muted，ΔL=0.015）
 * 要在 8bit 上还剩 ≥3 级才算可辨（现有 8 套实测该档是 +4），L₀ 低于 0.06 就不够。
 * **上限 0.21**：那正是 tsubasaterminal 的 L₀，外壳抬到那里就跟普通深色方案一样亮了，
 * 「纯黑」只剩终端区一块，失去意义。取中间的 0.13——外壳底 `#0c0c0c` 肉眼读作黑，
 * 分隔线 `#242424` 对底 1.26:1（现有 8 套是 1.42–1.57，**弱一档但立得住**；
 * 这是"外壳也要黑"换来的取舍，不是疏漏）。
 *
 * **只兜底不设顶**：现有 8 套 L₀ 全在 0.210–0.324，`Math.max` 一律不触发，
 * 派生结果逐字节不变。也**不动终端网格**——xterm 与 `TerminalWorkspace` 的 themeBg
 * 都直接取方案原值，终端区仍是真 `#000000`：占屏最大的那块真熄灯，OLED 的账在那里结，
 * 外壳只负责"还能分得出栏"。
 *
 * 亮色不需要对称的上限：sRGB 高端不陡，纯白锚点往暗走的阶梯照样分得开；
 * 唯一往亮走的 card 在 L=1 处截平，与终端区同为白，靠边框与阴影浮起（同姊妹项目）。
 */
const SHELL_ANCHOR_FLOOR_L = 0.13

export type ColorScheme = 'dark' | 'light'

/**
 * 明暗判据：终端底色 OKLCH 明度过 0.6 即浅色。内置方案两极分明——
 * 暗色 L₀ 0–0.324、亮色 0.958 起——中间带没有方案，单测守着不让新方案落进去。
 * 由底色推出而不是另存一个字段：设置里只有方案 id，明暗跟着方案走，不存在
 * "亮外壳配暗终端"的组合。
 */
const LIGHT_ANCHOR_MIN_L = 0.6

/**
 * 亮色外壳正文的**明度上限**——亮色下外壳文字不再沿用终端前景的明度。
 *
 * v0.14.3 的亮色正文就是方案前景压彩度：Latte `#4c4f69`（L=0.435）→ `#4f505c`，侧栏上
 * 只有 6.6:1；次要文字（主机 IP）取"刚够 4.5"更淡。真人反馈左栏与标签页"又小又细"，
 * 截图取样侧栏主机名最深像素灰度 75，而 Windows Terminal 的标签字是 0。12px 的笔画
 * 只有一像素上下，颜色是中灰就整根发虚；暗色下浅字压深底在视觉上显粗，这个问题被盖住了。
 * 终端前景是给成段等宽字调的、Latte 有意偏柔；外壳是小字号的 UI 文字，要的是姊妹项目
 * `--fg #17171b`（L=0.206）那个量级。
 *
 * 0.25：Latte → `#1f212b`（侧栏 13.3:1）、One Half Light → `#1f2129`（14.5:1），保留方案
 * 色相（彩度仍过 SHELL_FG_CHROMA_CAP），不拍成纯黑。比 0.25 暗的前景原样保留。
 * **终端网格不受影响**——xterm 拿的仍是方案原值。暗色不设此上限。
 */
const LIGHT_SHELL_FG_MAX_L = 0.25

/**
 * 亮色三级文字（`--muted-foreground`）的对比目标：6:1，而不是 AA 底线 4.5。
 * 三级承载主机 IP、标签页元数据这类**仍要读**的小字（11–12px），"最淡的达标值"在亮底上
 * 读作发虚。6 让 Latte 的三级落在 `#4f515d`——恰是改前正文的深度；四级仍按 3:1 往淡走，
 * 四级文字的层次靠正文加深拉开。
 */
const LIGHT_MUTED_FG_CONTRAST = 6

export function schemeOf(background: string): ColorScheme {
  return hexToOklch(background).L > LIGHT_ANCHOR_MIN_L ? 'light' : 'dark'
}

/** 只压彩度，保留 L/H。C 已在阈内时原样返回——避免 OKLCH 往返的 ±1 舍入噪声 */
function capChroma(hex: string, cap: number): string {
  const o = hexToOklch(hex)
  return o.C <= cap ? hex : oklchToHex({ ...o, C: cap })
}

function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 相对对比度 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 暗色明度阶梯（相对终端 background 的 OKLCH L）。
 *
 * v0.13.0 从四级扩到七级——控件层（`assets/controls.css`）需要区分"弹窗底 /
 * 页脚带 / 控件底 / 按下态"，四级不够分。**既有四级的值一个字节都没动**：
 * e2e 的 appearance.spec 逐 hex 断言它们，新阶只往缝里插。
 *
 * 阶梯方向往**亮**抬（见文件头）：终端是那口最深的井，外壳每加一层就亮一档，
 * 于是"控件比它所在的卡片亮"这条关系在暗色下自然成立——与姊妹项目浅色下
 * "输入框 #fff 比 chrome #f6f6f8 亮"是同一条关系，只是色温相反。
 */
const RUNGS = {
  background: 0.025,
  card: 0.05,
  /** 弹窗页脚 / tab 条 / 设置导航栏——比卡片高半档的"带" */
  subtle: 0.065,
  muted: 0.08,
  /** hover / 按下 / 分段控件选中块 */
  active: 0.105,
  border: 0.13,
  /** 弹窗与浮层的外框：要能从卡片底上"割"出来，比普通细线再亮一档 */
  borderStrong: 0.19
} as const

/**
 * 亮色明度阶梯。负数往暗、正数往亮；只有 card（弹窗、下拉、控件面）往亮。
 *
 * 按姊妹项目浅色令牌标定：锚点取纯白 `#ffffff` 时，background / subtle / muted /
 * border / borderStrong 的明度分别落在它的 `--bg-sidebar #f8f8fa` / `--bg-chrome
 * #f6f6f8` / `--bg-inset #f2f2f5` / `--bd #e6e6ea` / `--bd-strong #d8d8de` 上，
 * card 截到白即它的 `--bg-app` 与控件底 `#fff`——"同门"在亮色下是可以测出来的
 * （tests/unit/appTheme）。active 是我们自己的一档（悬停 / 按下），落在它的
 * hover −0.044 与 active −0.074 之间，好与 muted 拉开。
 *
 * 幅度只有暗色的约六成：亮端人眼对明度差更敏感，照搬 0.025 的步长会显得过重。
 * 以 Catppuccin Latte 底 `#eff1f5` 为锚，background −0.02 恰好落在它自己的
 * mantle（−0.025）附近——侧栏比编辑区暗一档，是该配色方案自己的结构。
 */
const LIGHT_RUNGS = {
  background: -0.02,
  card: 0.02,
  subtle: -0.026,
  muted: -0.038,
  active: -0.056,
  border: -0.074,
  borderStrong: -0.116
} as const

/** 派生出的外壳色（供 e2e 与调试直接断言） */
export interface ShellPalette {
  scheme: ColorScheme
  background: string
  card: string
  subtle: string
  muted: string
  active: string
  border: string
  borderStrong: string
  /**
   * 控件面（按钮、输入、复选框，v0.14.3）。暗色 = muted（控件比卡片亮一档，值不变）；
   * 亮色 = card（白，同姊妹项目控件底 #fff）——亮色下控件靠边框与阴影立起来，
   * 用 muted 会是一排灰按钮。
   */
  control: string
  /** 分段控件选中块：暗色 = active（值不变），亮色 = control（白块浮在灰槽里） */
  controlActive: string
  /** 开关关闭态的圆钮：暗色 = 正文色（值不变），亮色 = control（白钮） */
  knob: string
  foreground: string
  /** 次级：表单标签、`.srow` 说明的上一层 */
  foreground2: string
  mutedForeground: string
  /** 四级：占位符、计数、禁用态——装饰性，按 3:1 而非 4.5:1 收 */
  quietForeground: string
  ring: string
  /** 压在 ring 上的文字（主按钮、选中复选框、开启开关的圆钮），见 gateRing */
  primaryForeground: string
}

/**
 * 次要文字：彩度收到与正文同一道上限（v0.9.1 给的 0.04 比底色上限还宽，
 * 次要文字反而最艳）；明度从 0.66 起步，对**最亮的那级放文字的底**不足
 * AA 4.5:1 时逐级提亮——固定 0.66 只对深底成立，Nord 这类底色偏亮的方案
 * 实测只有 2.89:1。
 *
 * 上限是正文明度 −0.02：次要文字比正文亮就丢了"次级"的表意。正文自己太暗的
 * 方案（已删的 Solarized，正文 L=0.654）会停在不达标处——那是**它正文的账**，
 * 不该由次要文字倒挂来补。
 *
 * 亮色镜像：从 muted 底的明度起往暗走，取第一个够目标对比的；muted 是
 * 亮色下放文字的最暗一级。目标 v0.14.5 起是 LIGHT_MUTED_FG_CONTRAST（6），不是 4.5，
 * 理由见那里。下限是正文明度 +0.02，同一条"次级不能比正文重"。
 */
function deriveMutedForeground(mutedBg: string, fg: Oklch, scheme: ColorScheme): string {
  const C = Math.min(fg.C, SHELL_FG_CHROMA_CAP)
  const at = (L: number): string => oklchToHex({ L, C, h: fg.h })
  if (scheme === 'light') {
    const minL = fg.L + 0.02
    for (let L = hexToOklch(mutedBg).L; L > minL; L -= 0.01) {
      if (contrastRatio(mutedBg, at(L)) >= LIGHT_MUTED_FG_CONTRAST) return at(L)
    }
    return at(minL)
  }
  const maxL = fg.L - 0.02
  for (let L = Math.min(0.66, maxL); L < maxL; L += 0.01) {
    if (contrastRatio(mutedBg, at(L)) >= 4.5) return at(L)
  }
  return at(maxL)
}

/**
 * 次级文字：表单标签、`.srow` 的说明——比正文轻、比三级重。
 * 取正文与三级明度的中点，走同一道彩度闸。它落在两个已经验过对比度的值之间，
 * 不需要再单独验：三级达标则中点必达标。明暗通用。
 */
function deriveSecondaryForeground(mutedFg: string, fg: Oklch): string {
  const C = Math.min(fg.C, SHELL_FG_CHROMA_CAP)
  return oklchToHex({ L: (fg.L + hexToOklch(mutedFg).L) / 2, C, h: fg.h })
}

/**
 * 四级文字：占位符、计数、禁用标签。比三级再退一档，
 * 但**不退到看不见**——WCAG 对这类装饰性文本不要 4.5:1，UI 组件那条线是 3:1，
 * 取它作下限：从三级的明度往底色方向走，最后一个仍满足 3:1 的位置就是它。
 *
 * 起点用三级**算出来的实际明度**而不是某个固定值：三级本身逐主题浮动
 * （Nord 这种亮底会把它顶得很高），固定起点在亮底主题下会一步跌破 3:1、
 * 退化成与三级同色——那就等于没有第四级。亮色方向相反（往亮走），判据相同。
 */
function deriveQuietForeground(
  mutedBg: string,
  mutedFg: string,
  fg: Oklch,
  scheme: ColorScheme
): string {
  const C = Math.min(fg.C, SHELL_FG_CHROMA_CAP)
  const at = (L: number): string => oklchToHex({ L, C, h: fg.h })
  const startL = hexToOklch(mutedFg).L
  let last = at(startL)
  if (scheme === 'light') {
    for (let L = startL + 0.01; L < 1; L += 0.01) {
      if (contrastRatio(mutedBg, at(L)) < 3) break
      last = at(L)
    }
    return last
  }
  for (let L = startL - 0.01; L > 0.2; L -= 0.01) {
    if (contrastRatio(mutedBg, at(L)) < 3) break
    last = at(L)
  }
  return last
}

/**
 * 强调色的对比闸。光标色天生是方案的强调色，被征用为 ring / primary，
 * 暗色方案的光标都偏亮，压在暗底上从来不缺对比，所以此前不设闸。亮色方案不成立：
 * Catppuccin Latte 的光标 rosewater `#dc8a78` 对底 2.34:1、One Half Light 的
 * `#a5b4e5` 更低——焦点环看不清，主按钮上的字更读不出。
 *
 * 判据取文字的两处，都按 4.5:1：主按钮上的字（primaryForeground 压在 ring 上），
 * 以及 ring 自己当文字色（Agent 消息里的链接、`text-primary` 徽标）压在放文字最深的
 * muted 底上。不够就保持色相彩度、沿明度往正文方向挪（暗色往亮、亮色往暗）到刚达标——
 * 达标时 ring 对外壳各级底也都在焦点环要的 3:1 以上（单测逐方案守着）。
 * 已达标时原样返回：现有暗色方案全部一字节不变。**终端里的光标不受影响**，
 * xterm 拿的仍是方案原值。
 */
function gateRing(cursor: string, surfaces: string[], scheme: ColorScheme): string {
  const passes = (c: string): boolean => surfaces.every((s) => contrastRatio(s, c) >= 4.5)
  if (passes(cursor)) return cursor
  const o = hexToOklch(cursor)
  const step = scheme === 'light' ? -0.01 : 0.01
  for (let L = o.L + step; L > 0 && L < 1; L += step) {
    const candidate = oklchToHex({ ...o, L })
    if (passes(candidate)) return candidate
  }
  return scheme === 'light' ? '#000000' : '#ffffff'
}

export function deriveShell(theme: TerminalThemeDef['theme']): ShellPalette {
  const bg = theme.background ?? '#16181f'
  const fg = theme.foreground ?? '#b9bec9'
  const scheme = schemeOf(bg)
  const base = hexToOklch(bg)
  const termFg = hexToOklch(fg)
  // 亮色正文压到 LIGHT_SHELL_FG_MAX_L 以下；暗色原样，派生逐字节不变。
  // 直接在 OKLCH 上取 min，不经 hex 往返——四级文字都从它推
  const fgOklch =
    scheme === 'light' && termFg.L > LIGHT_SHELL_FG_MAX_L ? { ...termFg, L: LIGHT_SHELL_FG_MAX_L } : termFg
  const C = Math.min(base.C, SHELL_CHROMA_CAP)
  // 锚点过明度下限一闸（见 SHELL_ANCHOR_FLOOR_L）——纯黑底的阶梯否则整档塌进量化区
  const anchorL = scheme === 'dark' ? Math.max(base.L, SHELL_ANCHOR_FLOOR_L) : base.L
  const rungs = scheme === 'dark' ? RUNGS : LIGHT_RUNGS
  const rung = (dL: number): string =>
    oklchToHex({ L: Math.min(1, anchorL + dL), C, h: base.h })

  const background = rung(rungs.background)
  const card = rung(rungs.card)
  const muted = rung(rungs.muted)
  const active = rung(rungs.active)
  const foreground =
    fgOklch === termFg
      ? capChroma(fg, SHELL_FG_CHROMA_CAP)
      : oklchToHex({ ...fgOklch, C: Math.min(fgOklch.C, SHELL_FG_CHROMA_CAP) })
  // 验对比取 muted 这一级——它是放文字的底里离正文明度最近的一级（暗色最亮、亮色最暗），
  // 且确实有 text-muted-foreground 落在上面
  const mutedForeground = deriveMutedForeground(muted, fgOklch, scheme)
  // 压在强调色上的字取离正文最远的那级底：暗色最暗的 background、亮色最白的 card
  const primaryForeground = scheme === 'dark' ? background : card
  const control = scheme === 'dark' ? muted : card
  return {
    scheme,
    background,
    card,
    subtle: rung(rungs.subtle),
    muted,
    active,
    border: rung(rungs.border),
    borderStrong: rung(rungs.borderStrong),
    control,
    controlActive: scheme === 'dark' ? active : control,
    knob: scheme === 'dark' ? foreground : control,
    foreground,
    foreground2: deriveSecondaryForeground(mutedForeground, fgOklch),
    mutedForeground,
    quietForeground: deriveQuietForeground(muted, mutedForeground, fgOklch, scheme),
    ring: gateRing(theme.cursor ?? fg, [primaryForeground, muted], scheme),
    primaryForeground
  }
}
