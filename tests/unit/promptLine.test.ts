import { describe, expect, it } from 'vitest'

import { isPromptLikeLine } from '../../src/renderer/src/lib/promptLine'

describe('prompt-like cursor line', () => {
  it.each([
    'test@fake:~$ ',
    'root@fake:/home/test# ',
    'zsh-test-host% ',
    '>>> ',
    '❯ ',
    'λ ',
    '» '
  ])('accepts %j', (line) => {
    expect(isPromptLikeLine(line)).toBe(true)
  })

  // robbyrussell 的 `➜  ~ ` 以目录名结尾：已知不认（v0.13.15 边界）
  it.each(['', '   ', '[sudo] password for user:', 'Proceed? [y/N] ', 'compiling...', '➜  ~ '])(
    'rejects %j',
    (line) => {
      expect(isPromptLikeLine(line)).toBe(false)
    }
  )
})
