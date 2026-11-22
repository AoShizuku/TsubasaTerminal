// @vitest-environment jsdom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { installUnicodeWidth, TERMINAL_UNICODE_OPTIONS } from '../../src/renderer/src/lib/unicodeWidth'

/**
 * 字素簇计宽：真 xterm 走 TerminalView 同一个装配入口，量光标实际前进格数。
 * 不可见码点（VS16 / ZWJ / 组合符）一律显式构造，源码与用例名都不放字面量。
 */

const cp = (...xs: number[]): string => String.fromCodePoint(...xs)
const VS16 = 0xfe0f
const ZWJ = 0x200d

let term: Terminal | null = null

afterEach(() => {
  term?.dispose()
  term = null
})

async function advance(text: string, install = true): Promise<number> {
  term?.dispose()
  term = new Terminal({ cols: 40, rows: 4, ...TERMINAL_UNICODE_OPTIONS })
  if (install) installUnicodeWidth(term)
  const t = term
  await new Promise<void>((resolve) => t.write(text, resolve))
  return t.buffer.active.cursorX
}

describe('installUnicodeWidth', () => {
  it('切到 15-graphemes 宽度表', () => {
    term = new Terminal({ cols: 40, rows: 4, ...TERMINAL_UNICODE_OPTIONS })
    installUnicodeWidth(term)
    expect(term.unicode.activeVersion).toBe('15-graphemes')
  })

  it('不装时 U+2705 只占 1 格（缺陷现场：默认 Unicode 6 表）', async () => {
    expect(await advance(cp(0x2705), false)).toBe(1)
  })

  it.each([
    { name: 'U+2705 EAW=W', text: cp(0x2705), want: 2 },
    { name: 'U+274C', text: cp(0x274c), want: 2 },
    { name: 'U+2B50', text: cp(0x2b50), want: 2 },
    { name: 'U+26A0 无 VS16', text: cp(0x26a0), want: 1 },
    { name: 'U+26A0 + VS16', text: cp(0x26a0, VS16), want: 2 },
    { name: 'U+2764 + VS16', text: cp(0x2764, VS16), want: 2 },
    { name: 'U+2714 + VS16', text: cp(0x2714, VS16), want: 2 },
    { name: 'keycap 1 + VS16 + U+20E3', text: cp(0x31, VS16, 0x20e3), want: 2 },
    { name: 'U+1F44D + 肤色 U+1F3FD', text: cp(0x1f44d, 0x1f3fd), want: 2 },
    { name: '国旗 两个 Regional Indicator', text: cp(0x1f1e8, 0x1f1f3), want: 2 },
    { name: '中', text: '中', want: 2 },
    { name: '全角逗号', text: cp(0xff0c), want: 2 },
    { name: 'U+25CF Ambiguous', text: cp(0x25cf), want: 1 },
    { name: 'U+2502 Ambiguous', text: cp(0x2502), want: 1 },
    { name: 'U+2503 Ambiguous', text: cp(0x2503), want: 1 },
    { name: 'U+2500 Ambiguous', text: cp(0x2500), want: 1 },
    { name: 'e + 组合符 U+0301', text: 'e' + cp(0x301), want: 1 }
  ])('$name 占 $want 格', async ({ text, want }) => {
    expect(await advance(text)).toBe(want)
  })

  it('后续字符紧跟在宽字符之后，不被图形盖住', async () => {
    await advance(cp(0x2705) + ' main')
    const line = term!.buffer.active.getLine(0)!
    expect(line.getCell(0)!.getWidth()).toBe(2)
    expect(line.getCell(2)!.getChars()).toBe(' ')
    expect(line.getCell(3)!.getChars()).toBe('m')
  })

  // 辅助平面 emoji 与 ZWJ 组合：@xterm/headless 6.0.0 + 本插件会算错（1 格 / 按成员累计），
  // 浏览器版 @xterm/xterm 正确。这里用的是应用实际加载的浏览器版
  it.each([
    { name: 'U+1F525', text: cp(0x1f525), want: 2 },
    { name: 'U+1F600', text: cp(0x1f600), want: 2 },
    { name: 'U+1F680', text: cp(0x1f680), want: 2 },
    { name: 'U+1F9EA', text: cp(0x1f9ea), want: 2 },
    { name: '双人 ZWJ 组合', text: cp(0x1f468, ZWJ, 0x1f469), want: 2 },
    { name: '三人 ZWJ 组合', text: cp(0x1f468, ZWJ, 0x1f469, ZWJ, 0x1f467), want: 2 },
    { name: '彩虹旗 VS16 + ZWJ', text: cp(0x1f3f3, VS16, ZWJ, 0x1f308), want: 2 },
    { name: '相邻两个宽 emoji', text: cp(0x1f525, 0x2705), want: 4 }
  ])('$name 占 $want 格', async ({ text, want }) => {
    expect(await advance(text)).toBe(want)
  })
})
