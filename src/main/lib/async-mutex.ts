// A FIFO async mutex (#576). Release hands the lock straight to the first
// waiter, so a holder that releases and calls `acquire()` again in the same
// tick queues behind everyone already waiting (no barging).

export interface Mutex {
  /** Resolves with this hold's release once the lock is ours; the release is idempotent. */
  acquire(): Promise<() => void>
  isLocked(): boolean
}

export function createMutex(): Mutex {
  let locked = false
  const waiters: ((release: () => void) => void)[] = []

  const makeRelease = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next(makeRelease())
      else locked = false
    }
  }

  return {
    acquire: () => {
      if (!locked) {
        locked = true
        return Promise.resolve(makeRelease())
      }
      return new Promise((resolve) => waiters.push(resolve))
    },
    isLocked: () => locked
  }
}
