import { describe, expect, test } from 'vitest'
import { normalizeFlags, parseRequest } from '../../../src/main/cli/protocol'

const EMPTY_FLAGS = {
  session: undefined,
  limit: undefined,
  save: false,
  bg: false,
  intent: undefined,
  timeout: undefined,
  async: false,
  hosts: undefined,
  json: false,
  mode: undefined
}

describe('CLI 管道协议解析', () => {
  test.each(['', '{', 'null', 'false', '42', '"exec"', '[]', '{}', '{"cmd":1}'])(
    '拒绝不是合法请求对象的输入：%j',
    (line) => {
      expect(parseRequest(line)).toBeNull()
    }
  )

  test('缺省字段得到安全默认值，且请求对象只保留协议字段', () => {
    const request = parseRequest(
      JSON.stringify({ cmd: 'hosts', unexpected: 'drop-me', flags: 'not-an-object' })
    )

    expect(request).toStrictEqual({
      v: 0,
      token: '',
      clientId: 'global',
      agent: undefined,
      cmd: 'hosts',
      args: [],
      flags: EMPTY_FLAGS
    })
    expect(request).not.toHaveProperty('unexpected')
  })

  test('过滤非字符串 args 与非严格布尔 flags，并截断请求和 flags 字符串', () => {
    const stringArgs = Array.from({ length: 70 }, (_, index) => `arg-${index}`)
    const request = parseRequest(
      JSON.stringify({
        v: '1',
        token: 123,
        clientId: 'c'.repeat(140),
        agent: 'a'.repeat(80),
        cmd: 'x'.repeat(40),
        args: [...stringArgs, 1, null, false, { value: 'drop' }],
        flags: {
          session: 's'.repeat(80),
          limit: '999.9',
          save: 1,
          bg: 'true',
          intent: 'i'.repeat(340),
          timeout: 9999.9,
          async: true,
          hosts: 'h'.repeat(600),
          json: true,
          mode: 0o755,
          unknown: 'drop-me'
        }
      })
    )

    expect(request).not.toBeNull()
    expect(request?.v).toBe(1)
    expect(request?.token).toBe('')
    expect(request?.clientId).toHaveLength(128)
    expect(request?.agent).toHaveLength(64)
    expect(request?.cmd).toHaveLength(32)
    expect(request?.args).toEqual(stringArgs.slice(0, 64))
    expect(request?.flags).toStrictEqual({
      session: 's'.repeat(64),
      limit: 500,
      save: false,
      bg: false,
      intent: 'i'.repeat(300),
      timeout: 3600,
      async: true,
      hosts: 'h'.repeat(512),
      json: true,
      mode: 0o755
    })
    expect(request?.flags).not.toHaveProperty('unknown')
  })
})

describe('CLI flags 归一化', () => {
  test.each([undefined, null, false, 42, 'flags', []])('非对象输入使用缺省 flags：%j', (raw) => {
    expect(normalizeFlags(raw)).toStrictEqual(EMPTY_FLAGS)
  })

  test('正数向下取整并按协议上限截断', () => {
    expect(normalizeFlags({ limit: '12.9', timeout: 89.8 })).toMatchObject({
      limit: 12,
      timeout: 89
    })
    expect(normalizeFlags({ limit: 501, timeout: 3601 })).toMatchObject({
      limit: 500,
      timeout: 3600
    })
  })

  test.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: -1 }, 'limit'],
    [{ limit: 'nope' }, 'limit'],
    [{ timeout: 0 }, 'timeout'],
    [{ timeout: Number.POSITIVE_INFINITY }, 'timeout'],
    [{ mode: -1 }, 'mode'],
    [{ mode: 0o10000 }, 'mode'],
    [{ mode: 1.5 }, 'mode']
  ] as const)('过滤越界或非有限数值：%j', (raw, key) => {
    expect(normalizeFlags(raw)[key]).toBeUndefined()
  })

  test('mode 接收完整权限位边界', () => {
    expect(normalizeFlags({ mode: 0 }).mode).toBe(0)
    expect(normalizeFlags({ mode: 0o7777 }).mode).toBe(0o7777)
  })
})
