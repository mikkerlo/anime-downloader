// A FIFO async mutex (#576). Release hands the lock straight to the first
// waiter, so a holder that releases and calls `acquire()` again in the same
// tick queues behind everyone already waiting (no barging). A waiter can give
// up: aborting its signal takes it out of the queue at once, and the waiters
// behind it keep their order.

export interface Mutex {
  /**
   * Resolves with this hold's release once the lock is ours; the release is
   * idempotent. Rejects with an `AbortError` when `signal` aborts while still
   * waiting (or already has); an abort after the lock was handed over does
   * nothing, and the hold must be released as usual.
   */
  acquire(signal?: AbortSignal): Promise<() => void>
  isLocked(): boolean
}

function abortError(): Error {
  const err = new Error('The wait for the lock was given up')
  err.name = 'AbortError'
  return err
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
    acquire: (signal) => {
      if (signal?.aborted) return Promise.reject(abortError())
      if (!locked) {
        locked = true
        return Promise.resolve(makeRelease())
      }
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          const i = waiters.indexOf(waiter)
          if (i < 0) return
          waiters.splice(i, 1)
          reject(abortError())
        }
        const waiter = (release: () => void): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        }
        waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    isLocked: () => locked
  }
}
