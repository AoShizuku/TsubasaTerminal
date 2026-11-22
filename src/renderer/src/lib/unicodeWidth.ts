import type { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'

/**
 * 字符宽度按字素簇计算。xterm 默认用 Unicode 6 宽度表，`✅` 这类字符只占 1 格，
 * 而远端 TUI 按现行标准算 2 格，两边差一格，画在固定列上的内容就会错位。
 * 换成 graphemes 后，VS16 序列、keycap、肤色修饰、ZWJ 组合都按整簇计宽；Ambiguous 类仍占 1 格。
 *
 * 注意：同版本插件配 @xterm/headless 6.0.0 时，辅助平面 emoji 会算成 1 格，浏览器版没有这个问题。
 * 验证宽度要用 @xterm/xterm（见 tests/component/unicodeWidth.test.ts），不要拿 headless 下结论。
 * 插件走 proposed API，new Terminal 时须开 `allowProposedApi`，见 TERMINAL_UNICODE_OPTIONS。
 */
export const TERMINAL_UNICODE_OPTIONS = { allowProposedApi: true } as const

export function installUnicodeWidth(term: Terminal): void {
  // 加载即把 activeVersion 切到 '15-graphemes'
  term.loadAddon(new UnicodeGraphemesAddon())
}
