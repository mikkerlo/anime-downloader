import { describe, it, expect, vi, beforeEach } from 'vitest'
import { __emit, __reset } from '../setup/electron-mock'
import { subscribe } from '../../src/preload/subscribe'

beforeEach(() => {
  __reset()
})

describe('preload subscribe<T>', () => {
  it('delivers the payload to the listener', () => {
    const cb = vi.fn()
    subscribe<{ x: number }>('test:channel')(cb)
    __emit('test:channel', { x: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ x: 1 })
  })

  it('returns an Unsubscribe that removes only the caller listener', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = subscribe<number>('test:channel')(cbA)
    subscribe<number>('test:channel')(cbB)

    __emit('test:channel', 1)
    expect(cbA).toHaveBeenCalledTimes(1)
    expect(cbB).toHaveBeenCalledTimes(1)

    unsubA()

    __emit('test:channel', 2)
    expect(cbA).toHaveBeenCalledTimes(1)
    expect(cbB).toHaveBeenCalledTimes(2)
  })

  it('keeps subscriptions isolated per channel', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    subscribe<string>('chan:a')(cbA)
    subscribe<string>('chan:b')(cbB)

    __emit('chan:a', 'hello')
    expect(cbA).toHaveBeenCalledTimes(1)
    expect(cbB).not.toHaveBeenCalled()
  })
})
