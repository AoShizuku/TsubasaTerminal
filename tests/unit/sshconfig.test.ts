import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { parseSshConfig } from '../../src/main/sshconfig'

describe('OpenSSH config parsing', () => {
  it('parses concrete aliases, both assignment syntaxes and quoted identity files', () => {
    const entries = parseSshConfig(`
      Host prod-a prod-b
        HostName = 10.0.0.8
        User deploy
        Port 2202
        IdentityFile "C:/Users/me/.ssh/id ed25519"
    `)

    expect(entries).toEqual([
      {
        alias: 'prod-a',
        host: '10.0.0.8',
        port: 2202,
        username: 'deploy',
        identityFile: 'C:/Users/me/.ssh/id ed25519'
      },
      {
        alias: 'prod-b',
        host: '10.0.0.8',
        port: 2202,
        username: 'deploy',
        identityFile: 'C:/Users/me/.ssh/id ed25519'
      }
    ])
  })

  it('skips wildcard and negated aliases while retaining concrete aliases in the same block', () => {
    expect(
      parseSshConfig(`
        Host * !bastion exact-host web-?
          HostName example.internal
          User ops
      `)
    ).toEqual([
      expect.objectContaining({ alias: 'exact-host', host: 'example.internal', username: 'ops' })
    ])
  })

  it('uses the first occurrence of a field, matching ssh_config precedence', () => {
    expect(
      parseSshConfig(`
        Host prod
          HostName first.example
          HostName second.example
          Port nonsense
      `)
    ).toEqual([
      expect.objectContaining({ alias: 'prod', host: 'first.example', port: 22 })
    ])
  })

  it('strips comments and defaults HostName to the alias', () => {
    expect(parseSshConfig('Host db # primary\n  User root # operator')).toEqual([
      expect.objectContaining({ alias: 'db', host: 'db', port: 22, username: 'root' })
    ])
  })
})
