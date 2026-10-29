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

  describe('giving up a wait (#576 review)', () => {
    const settled = async <T>(p: Promise<T>): Promise<boolean> => {
      let done = false
      void p.then(
        () => (done = true),
        () => (done = true)
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()
      return done
    }

    it('an aborted waiter rejects at once and leaves the queue; the waiters behind keep their order', async () => {
      const m = createMutex()
      const order: string[] = []
      const holder = await m.acquire()
      const ac = new AbortController()
      const a = m.acquire(ac.signal)
      const b = m.acquire().then((r) => {
        order.push('b')
        return r
      })
      const c = m.acquire().then((r) => {
        order.push('c')
        return r
      })
      ac.abort()
      await expect(a).rejects.toMatchObject({ name: 'AbortError' })
      // Still held: the abort neither took nor freed the lock.
      expect(m.isLocked()).toBe(true)
      expect(await settled(b)).toBe(false)
      holder()
      ;(await b)()
      ;(await c)()
      expect(order).toEqual(['b', 'c'])
      expect(m.isLocked()).toBe(false)
    })

    it('no leak: with every waiter aborted, the holder’s release frees the lock', async () => {
      const m = createMutex()
      const holder = await m.acquire()
      const acs = [new AbortController(), new AbortController(), new AbortController()]
      const waits = acs.map((ac) => m.acquire(ac.signal).catch((e: Error) => e.name))
      for (const ac of acs) ac.abort()
      expect(await Promise.all(waits)).toEqual(['AbortError', 'AbortError', 'AbortError'])
      holder()
      expect(m.isLocked()).toBe(false)
      const next = await m.acquire()
      next()
      expect(m.isLocked()).toBe(false)
    })

    it('an abort after the lock was handed over does nothing; the hold releases as usual', async () => {
      const m = createMutex()
      const holder = await m.acquire()
      const ac = new AbortController()
      const w = m.acquire(ac.signal)
      const x = m.acquire()
      holder()
      const wRelease = await w
      ac.abort()
      expect(m.isLocked()).toBe(true)
      expect(await settled(x)).toBe(false)
      wRelease()
      ;(await x)()
      expect(m.isLocked()).toBe(false)

      // Uncontended: acquired at once, and a later abort is a no-op too.
      const ac2 = new AbortController()
      const r = await m.acquire(ac2.signal)
      ac2.abort()
      expect(m.isLocked()).toBe(true)
      r()
      expect(m.isLocked()).toBe(false)
    })

    it('an already-aborted signal rejects without taking or queueing', async () => {
      const m = createMutex()
      const ac = new AbortController()
      ac.abort()
      await expect(m.acquire(ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(m.isLocked()).toBe(false)
      const holder = await m.acquire()
      await expect(m.acquire(ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
      holder()
      expect(m.isLocked()).toBe(false)
    })
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
