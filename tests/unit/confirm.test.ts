import { afterEach, describe, expect, it } from 'vitest'

import { confirmDialog, confirmRequest, settleConfirm } from '../../src/renderer/src/lib/confirm'

/**
 * 确认框请求：同一时刻只问一件事，第二个请求直接回 false 而不是排队——
 * 原生 confirm 冻住线程天然做到了这点，换成异步后要自己守。
 */

afterEach(() => settleConfirm(false))

describe('confirmDialog', () => {
  it('publishes the request and resolves with the settled answer', async () => {
    const answer = confirmDialog({ title: '删除主机', message: '删除？', danger: true })
    expect(confirmRequest.value).toMatchObject({ title: '删除主机', message: '删除？', danger: true })

    settleConfirm(true)
    await expect(answer).resolves.toBe(true)
    expect(confirmRequest.value).toBeNull()
  })

  it('answers false to a second request while one is pending, leaving the first untouched', async () => {
    const first = confirmDialog({ title: 'A', message: 'a' })
    await expect(confirmDialog({ title: 'B', message: 'b' })).resolves.toBe(false)
    expect(confirmRequest.value?.title).toBe('A')

    settleConfirm(true)
    await expect(first).resolves.toBe(true)
  })

  it('accepts a new request once the previous one is settled', async () => {
    const first = confirmDialog({ title: 'A', message: 'a' })
    settleConfirm(false)
    await expect(first).resolves.toBe(false)

    const second = confirmDialog({ title: 'B', message: 'b' })
    expect(confirmRequest.value?.title).toBe('B')
    settleConfirm(true)
    await expect(second).resolves.toBe(true)
  })

  it('treats settling with nothing pending as a no-op', () => {
    expect(() => settleConfirm(true)).not.toThrow()
    expect(confirmRequest.value).toBeNull()
  })
})
