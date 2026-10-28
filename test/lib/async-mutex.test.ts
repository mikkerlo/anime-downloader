// The FIFO mutex behind the download manager's ffmpeg (#576): release hands
// the lock to the first waiter, so nobody jumps the queue.

import { describe, it, expect } from 'vitest'
import { createMutex } from '../../src/main/lib/async-mutex'

describe('createMutex (#576)', () => {
  it('an uncontended acquire settles at once and locks', async () => {
    const m = createMutex()
    expect(m.isLocked()).toBe(false)
    const release = await m.acquire()
    expect(m.isLocked()).toBe(true)
    release()
    expect(m.isLocked()).toBe(false)
  })

  it('waiters get the lock in arrival order', async () => {
    const m = createMutex()
    const order: string[] = []
    const first = await m.acquire()
    const a = m.acquire().then((r) => {
      order.push('a')
      return r
    })
    const b = m.acquire().then((r) => {
      order.push('b')
      return r
    })
    first()
    ;(await a)()
    ;(await b)()
    expect(order).toEqual(['a', 'b'])
    expect(m.isLocked()).toBe(false)
  })

  it('no barging: a holder that releases and re-acquires in the same tick queues behind an earlier waiter', async () => {
    const m = createMutex()
    const order: string[] = []
    const release = await m.acquire()
    const waiter = m.acquire().then((r) => {
      order.push('waiter')
      return r
    })
    release()
    // The same tick: the lock was handed to `waiter`, so this queues.
    const again = m.acquire().then((r) => {
      order.push('holder again')
      return r
    })
    expect(m.isLocked()).toBe(true)
    ;(await waiter)()
    ;(await again)()
    expect(order).toEqual(['waiter', 'holder again'])
  })

  it('a release is idempotent: a second call does not free a lock someone else holds', async () => {
    const m = createMutex()
    const release = await m.acquire()
    const next = m.acquire()
    release()
    const nextRelease = await next
    release()
    expect(m.isLocked()).toBe(true)
    const third = m.acquire()
    let thirdGot = false
    void third.then(() => {
      thirdGot = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdGot).toBe(false)
    nextRelease()
    await third
    expect(thirdGot).toBe(true)
  })
})
