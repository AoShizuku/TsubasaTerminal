import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 指纹 HMAC key 按安装持久化在 userData 下，这里给一个真实临时目录就够——
 * 不为可测性给 `redactText` 加"注入 key"的参数：那是脱敏模块的公开签名，
 * 而这些用例断言的只是"同一凭据指纹稳定"与占位符形状，与 key 的具体值无关。
 */
const state = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }))
vi.mock('../../src/main/hosts', () => ({ getSelfSecrets: vi.fn() }))
vi.mock('../../src/main/settings', () => ({ getSettingsSync: vi.fn() }))

import { redactText } from '../../src/main/redaction'

beforeAll(() => {
  state.userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-redaction-test-'))
})

afterAll(() => {
  rmSync(state.userDataDir, { recursive: true, force: true })
})

describe('credential redaction rules', () => {
  it('replaces repeated AWS access keys with one stable fingerprint', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const result = redactText(`${secret}\n${secret}`, [])
    const placeholders = result.text.match(/«REDACTED:aws-access-key:[0-9a-f]{4}»/g) ?? []

    expect(placeholders).toHaveLength(2)
    expect(placeholders[0]).toBe(placeholders[1])
    expect(result.text).not.toContain(secret)
    expect(result.hits).toEqual([
      { type: 'aws-access-key', fingerprint: result.hits[0].fingerprint },
      { type: 'aws-access-key', fingerprint: result.hits[0].fingerprint }
    ])
  })

  it('keeps common operational identifiers while redacting a real key-value secret', () => {
    const input = [
      'Author: root <root@LAPTOP-X>',
      'max_tokens=1024',
      'sha256:' + 'a'.repeat(64),
      'db_password=hunter22'
    ].join('\n')
    const result = redactText(input, [])

    expect(result.text).toContain('Author: root <root@LAPTOP-X>')
    expect(result.text).toContain('max_tokens=1024')
    expect(result.text).toContain('sha256:' + 'a'.repeat(64))
    expect(result.text).not.toContain('hunter22')
    expect(result.hits.map((hit) => hit.type)).toEqual(['kv-secret'])
  })

  it('gives an exact self-held credential precedence over overlapping generic rules', () => {
    const secret = 'sup3r-secret-pw'
    const result = redactText(`db_password=${secret}`, [secret])

    expect(result.text).toContain('db_password=«REDACTED:self-credential:')
    expect(result.text).not.toContain(secret)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].type).toBe('self-credential')
  })

  it.each([
    'docker run -p 8080:80 nginx',
    'ssh -p 2222 host',
    'password=1234'
  ])('does not mistake numeric port or configuration value for a password: %s', (text) => {
    expect(redactText(text, [])).toEqual({ text, hits: [] })
  })

  it('returns empty input without touching the fingerprint adapter', () => {
    expect(redactText('', [])).toEqual({ text: '', hits: [] })
  })
})
