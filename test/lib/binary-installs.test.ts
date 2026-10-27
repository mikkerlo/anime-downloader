import { describe, it, expect, vi } from 'vitest'
import { createBinaryInstalls, singleFlight } from '../../src/main/lib/binary-installs'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('shares one in-flight call and starts a fresh one after it settles', async () => {
    let gate = deferred<string>()
    const fn = vi.fn(() => gate.promise)
    const run = singleFlight(fn)
    const a = run()
    const b = run()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    gate.resolve('x')
    await expect(a).resolves.toBe('x')
    gate = deferred<string>()
    const c = run()
    expect(fn).toHaveBeenCalledTimes(2)
    gate.resolve('y')
    await expect(c).resolves.toBe('y')
  })

  it('clears after a rejection too', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    const run = singleFlight(fn)
    await expect(run()).rejects.toThrow('boom')
    await expect(run()).rejects.toThrow('boom')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

// #567: the boot install and the online kick-off's retry must not run two
// installs extracting into the same directory at once.
describe('createBinaryInstalls', () => {
  it('a retry while the boot install is in flight joins it instead of starting another', async () => {
    const ffmpegGate = deferred<string>()
    const ensureFfmpeg = vi.fn(() => ffmpegGate.promise)
    const ensureFpcalc = vi.fn(async () => '/fpcalc')
    const installs = createBinaryInstalls({ ensureFfmpeg, ensureFpcalc })

    const boot = installs.ffmpeg()
    const retryA = installs.retry()
    const retryB = installs.retry()
    expect(ensureFfmpeg).toHaveBeenCalledTimes(1)

    ffmpegGate.resolve('/ffmpeg')
    await Promise.all([boot, retryA, retryB])
    expect(ensureFfmpeg).toHaveBeenCalledTimes(1)
    expect(ensureFpcalc).toHaveBeenCalledTimes(1)
  })

  it('retry runs ffmpeg before fpcalc', async () => {
    const order: string[] = []
    const installs = createBinaryInstalls({
      ensureFfmpeg: async () => (order.push('ffmpeg'), '/ffmpeg'),
      ensureFpcalc: async () => (order.push('fpcalc'), '/fpcalc')
    })
    await installs.retry()
    expect(order).toEqual(['ffmpeg', 'fpcalc'])
  })
})
