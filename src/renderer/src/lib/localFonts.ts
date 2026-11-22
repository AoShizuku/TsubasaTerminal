import { FONT_CANDIDATES } from '@shared/terminalThemes'

/**
 * 终端字体下拉的本机等宽字体枚举。
 *
 * **不能用 `document.fonts.check`**：它只管 FontFaceSet 里的网页字体，系统字体
 * 不论装没装一律返回 true（实测对 "Definitely Not A Font" 也是 true）。旧实现拿它
 * 过滤写死的候选名，等于把候选全当"已安装"列出——候选里的 "Maple Mono NF CN"
 * 与本机真名 "Maple Mono Normal NL NF CN" 差几个词，选了也只会静默落回退栈。
 *
 * 改用 Chromium 的 Local Font Access（`window.queryLocalFonts`）拿系统字体的真实
 * family 名，再用 canvas 量宽筛等宽。Electron 未设权限处理器时默认放行，打包后的
 * file:// 与 dev 的 localhost 都是安全上下文；取不到时退回对候选清单做度量探测。
 */

/** 以 CSS font-family 串量一段文字的宽度（px） */
export type MeasureWidth = (fontFamily: string, text: string) => number

/** 等宽判据：窄字、宽字、中宽字、标点各十个，宽度应全部相等 */
const MONO_PROBES = ['iiiiiiiiii', 'WWWWWWWWWW', 'mmmmmmmmmm', '..........']

/** 符号字体的 ASCII 码位画的是图标，量宽可能等宽，但不能当终端字体 */
const SYMBOL_FONT = /^(Marlett|Webdings|Wingdings|Symbol|MT Extra|Bookshelf Symbol|Segoe (MDL2|Fluent)|HoloLens MDL2)/i

export function quoteFamily(name: string): string {
  return `"${name.replace(/["\\]/g, '\\$&')}"`
}

/** 去重、剔除符号字体、只留等宽，按名称排序 */
export function pickMonospaceFamilies(families: Iterable<string>, measure: MeasureWidth): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of families) {
    const family = raw.trim()
    if (!family || seen.has(family)) continue
    seen.add(family)
    if (SYMBOL_FONT.test(family)) continue
    const widths = MONO_PROBES.map((text) => measure(quoteFamily(family), text))
    if (widths[0] > 0 && widths.every((w) => Math.abs(w - widths[0]) < 0.5)) out.push(family)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * 度量法判断字体是否安装（Local Font Access 不可用时的退路）：未安装时浏览器落到
 * 串尾的通用族，宽度与单独用通用族逐一相同。比两个通用族，是因为字体可能恰好
 * 就是某个通用族的实际字体（Windows 上 monospace 即 Consolas）。
 */
export function isInstalledByMetrics(family: string, measure: MeasureWidth): boolean {
  const probe = 'mmmmmmmmmmlli1WW@中'
  return ['monospace', 'serif'].some(
    (generic) => measure(`${quoteFamily(family)}, ${generic}`, probe) !== measure(generic, probe)
  )
}

interface LocalFontData {
  family: string
}

type LocalFontWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> }

function canvasMeasure(): MeasureWidth | null {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  return (fontFamily, text) => {
    ctx.font = `16px ${fontFamily}`
    return ctx.measureText(text).width
  }
}

/** 本机已安装的等宽字体 family 名（真实名，可直接写进 xterm 的 fontFamily） */
export async function detectMonospaceFonts(): Promise<string[]> {
  const measure = canvasMeasure()
  if (!measure) return []
  let families: string[] | null = null
  const query = (window as LocalFontWindow).queryLocalFonts
  if (typeof query === 'function') {
    try {
      families = (await query.call(window)).map((font) => font.family)
    } catch {
      families = null
    }
  }
  families ??= FONT_CANDIDATES.filter((family) => isInstalledByMetrics(family, measure))
  return pickMonospaceFamilies(families, measure)
}
