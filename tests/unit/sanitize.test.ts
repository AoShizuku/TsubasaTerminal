import { describe, expect, it } from 'vitest'

import {
  normalizeUnicode,
  sanitizeForMachine,
  stripAnsi,
  stripPromptSpTail
} from '../../src/main/sanitize'

/** zsh 缺省 PROMPT_EOL_MARK（%B%S%#%s%b）展开后的形态 + 按 80 列补齐的尾巴 */
const COLS = 80
function promptSp(mark = '%', width = 1, prefix = '\u001b[1m\u001b[7m', suffix = '\u001b[27m\u001b[1m\u001b[0m'): string {
  return `${prefix}${mark}${suffix}${' '.repeat(COLS - width)}\r${' '.repeat(width)}\r`
}

describe('terminal output sanitization', () => {
  it('strips CSI, OSC, DCS and ordinary escape sequences while preserving text', () => {
    const raw =
      '\u001b[31mred\u001b[0m ' +
      '\u001b]0;secret title\u0007visible ' +
      '\u001bPignored payload\u001b\\tail\u001bM'

    expect(stripAnsi(raw)).toBe('red visible tail')
  })

  it('removes C0 controls and carriage returns but preserves newlines and tabs', () => {
    expect(stripAnsi('a\u0000b\rc\td\ne\u007f')).toBe('abc\td\ne')
  })

  it.each([0x200b, 0x200f, 0x202e, 0x2060, 0x2069, 0xfeff])(
    'removes invisible or bidi code point U+%s',
    (codePoint) => {
      expect(normalizeUnicode(`left${String.fromCharCode(codePoint)}right`)).toBe('leftright')
    }
  )

  it('normalizes compatibility characters before machine consumption', () => {
    expect(normalizeUnicode('ＡＢＣ ①')).toBe('ABC 1')
  })

  it('combines ANSI stripping and Unicode normalization at the public boundary', () => {
    expect(sanitizeForMachine('\u001b[31mr\u200bed\u001b[0m')).toBe('red')
  })
})

describe('zsh PROMPT_SP tail', () => {
  it('drops the whole tail when the command printed nothing', () => {
    expect(stripPromptSpTail(promptSp())).toBe('')
  })

  it('keeps output that ended with a newline', () => {
    expect(stripPromptSpTail(`hello\r\n${promptSp()}`)).toBe('hello\r\n')
  })

  it('keeps unterminated output and strips only the mark', () => {
    expect(stripPromptSpTail(`foo${promptSp()}`)).toBe('foo')
  })

  it('handles the root mark and a custom wide mark', () => {
    expect(stripPromptSpTail(`x\n${promptSp('#')}`)).toBe('x\n')
    expect(stripPromptSpTail(`x\n${promptSp('<EOL>', 5, '', '')}`)).toBe('x\n')
  })

  it('handles an empty PROMPT_EOL_MARK', () => {
    expect(stripPromptSpTail(`x\n${' '.repeat(COLS)}\r\r`)).toBe('x\n')
  })

  it('keeps escapes emitted by later precmd hooks', () => {
    const title = '\u001b]2;user@host\u0007'
    expect(stripPromptSpTail(`ok\n${promptSp()}${title}`)).toBe(`ok\n${title}`)
  })

  it('leaves other output untouched', () => {
    expect(stripPromptSpTail('progress 50%\r')).toBe('progress 50%\r')
    expect(stripPromptSpTail('a \r \r')).toBe('a \r \r')
    expect(stripPromptSpTail(`${promptSp()}more output\n`)).toBe(`${promptSp()}more output\n`)
  })
})
