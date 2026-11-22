import { mkdtempSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const adapterState = vi.hoisted(() => ({
  userDataDir: '',
  enabled: true,
  secrets: [] as string[]
}))

vi.mock('electron', () => ({ app: { getPath: () => adapterState.userDataDir } }))
vi.mock('../../../src/main/settings', () => ({
  getSettingsSync: () => ({ redactionEnabled: adapterState.enabled })
}))
vi.mock('../../../src/main/hosts', () => ({
  getSelfSecrets: async () => adapterState.secrets
}))

let userDataDir: string

beforeEach(() => {
  vi.resetModules()
  userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-redaction-adapter-test-'))
  adapterState.userDataDir = userDataDir
  adapterState.enabled = true
  adapterState.secrets = ['host-password']
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('redaction main-process adapter', () => {
  it('honors the settings switch and supplies self-held credentials', async () => {
    const { redact } = await import('../../../src/main/redaction')
    const input = 'leaked host-password'

    adapterState.enabled = false
    expect(await redact(input)).toEqual({ text: input, hits: [] })

    adapterState.enabled = true
    const result = await redact(input)
    expect(result.text).toContain('«REDACTED:self-credential:')
    expect(result.text).not.toContain('host-password')
  })

  it('persists one HMAC key so repeated credentials keep a stable fingerprint', async () => {
    const { redact } = await import('../../../src/main/redaction')

    const first = await redact('AKIAIOSFODNN7EXAMPLE')
    const second = await redact('AKIAIOSFODNN7EXAMPLE')

    expect(first.text).toBe(second.text)
    expect((await readFile(join(userDataDir, 'redaction-key'), 'utf-8')).trim()).toMatch(
      /^[0-9a-f]{64}$/
    )
  })
})
