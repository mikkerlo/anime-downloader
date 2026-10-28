// The listener list behind the three multi-listener hooks (#574).

import { describe, it, expect, vi } from 'vitest'
import { createListenerSet } from '../../src/main/lib/listener-set'

describe('createListenerSet (#574)', () => {
  it('calls every listener in registration order with the arguments', () => {
    const set = createListenerSet<[number, string]>()
    const seen: string[] = []
    set.add((n, s) => seen.push(`a${n}${s}`))
    set.add((n, s) => seen.push(`b${n}${s}`))
    set.emit(1, 'x')
    expect(seen).toEqual(['a1x', 'b1x'])
    expect(set.size()).toBe(2)
  })

  it('iterates a snapshot: a listener that unsubscribes during emit does not skip the next one', () => {
    const set = createListenerSet<[]>()
    const seen: string[] = []
    const offA = set.add(() => {
      seen.push('a')
      offA()
    })
    set.add(() => seen.push('b'))
    set.add(() => seen.push('c'))
    set.emit()
    expect(seen).toEqual(['a', 'b', 'c'])
    set.emit()
    expect(seen).toEqual(['a', 'b', 'c', 'b', 'c'])
  })

  it('a listener removed by an earlier one during emit still runs in that emit, not after', () => {
    const set = createListenerSet<[]>()
    const seen: string[] = []
    let offB: () => void = () => {}
    set.add(() => {
      seen.push('a')
      offB()
    })
    offB = set.add(() => seen.push('b'))
    set.emit()
    set.emit()
    expect(seen).toEqual(['a', 'b', 'a'])
  })

  it('unsubscribe is idempotent and removes only its own registration of the same function', () => {
    const set = createListenerSet<[]>()
    const fn = vi.fn()
    const off1 = set.add(fn)
    set.add(fn)
    const other = vi.fn()
    set.add(other)
    off1()
    off1()
    expect(set.size()).toBe(2)
    set.emit()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener is logged and the rest still run', () => {
    const set = createListenerSet<[]>('test')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    set.add(() => {
      throw new Error('boom')
    })
    set.add(after)
    expect(() => set.emit()).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledWith('[test] a listener threw:', expect.any(Error))
    err.mockRestore()
  })
})
