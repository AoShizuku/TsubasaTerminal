import { describe, expect, it } from 'vitest'

import { classifySftpError, describeSftpError } from '../../src/main/sftpError'

describe('SFTP error classification', () => {
  it.each([
    [{ code: 3, message: 'Failure' }, 'permission'],
    [{ code: 2, message: 'Failure' }, 'not-found'],
    [new Error('Permission denied'), 'permission'],
    [new Error('No such file'), 'not-found'],
    [new Error('Connection lost'), 'other']
  ] as const)('classifies %o as %s', (error, expected) => {
    expect(classifySftpError(error)).toBe(expected)
  })

  it('explains that a permission failure belongs to the login-user identity plane', () => {
    const message = describeSftpError(Object.assign(new Error('Permission denied'), { code: 3 }))

    expect(message).toContain('权限不足')
    expect(message).toContain('SSH 登录用户')
    expect(message).not.toContain('目标不存在')
  })

  it('adds the trzsz escape hatch only for transfer not-found failures', () => {
    const plain = describeSftpError(Object.assign(new Error('No such file'), { code: 2 }))
    const transfer = describeSftpError(Object.assign(new Error('No such file'), { code: 2 }), {
      transferHint: true
    })

    expect(plain).toContain('目标不存在')
    expect(plain).not.toContain('trzsz')
    expect(transfer).toContain('trzsz')
  })
})
