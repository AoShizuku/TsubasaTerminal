import { describe, expect, it } from 'vitest'

import { isWebUrl } from '../../src/shared/url'

/** 外开白名单：只有 http / https 交给 shell.openExternal */
describe('isWebUrl', () => {
  it.each(['https://example.com/docs', 'http://10.0.0.1:8080/a?b=c', 'HTTPS://EXAMPLE.COM'])(
    'allows %s',
    (url) => {
      expect(isWebUrl(url)).toBe(true)
    }
  )

  it.each([
    'ms-settings:display',
    'file:///C:/Windows/System32/calc.exe',
    'smb://evil/share',
    'javascript:alert(1)',
    'mailto:ops@example.com',
    '#anchor',
    '/relative/path',
    ''
  ])('rejects %s', (url) => {
    expect(isWebUrl(url)).toBe(false)
  })
})
