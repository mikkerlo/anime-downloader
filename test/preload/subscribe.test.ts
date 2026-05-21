import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => void

const listenersByChannel = new Map<string, Set<Listener>>()

vi.mock('electron', () => ({
  ipcRenderer: {
    on(channel: string, listener: Listener): void {
      let bucket = listenersByChannel.get(channel)
      if (!bucket) {
        bucket = new Set()
        listenersByChannel.set(channel, bucket)
      }
      bucket.add(listener)
    },
    removeListener(channel: string, listener: Listener): void {
      listenersByChannel.get(channel)?.delete(listener)
    },
    removeAllListeners(channel: string): void {
      // The contract forbids using this; the mock still implements it so tests
      // can assert "no caller of subscribe() touches it indirectly."
      listenersByChannel.get(channel)?.clear()
    }
  }
}))

import { subscribe } from '../../src/preload/subscribe'

function emit(channel: string, payload: unknown): void {
  const bucket = listenersByChannel.get(channel)
  if (!bucket) return
  for (const listener of [...bucket]) listener({}, payload)
}

beforeEach(() => {
  listenersByChannel.clear()
})

describe('preload subscribe<T>', () => {
  it('delivers the payload to the listener', () => {
    const cb = vi.fn()
    subscribe<{ x: number }>('test:channel')(cb)
    emit('test:channel', { x: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ x: 1 })
  })

  it('returns an Unsubscribe that removes only the caller listener', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = subscribe<number>('test:channel')(cbA)
    subscribe<number>('test:channel')(cbB)

    emit('test:channel', 1)
    expect(cbA).toHaveBeenCalledTimes(1)
    expect(cbB).toHaveBeenCalledTimes(1)

    unsubA()

    emit('test:channel', 2)
    expect(cbA).toHaveBeenCalledTimes(1) // unchanged — disposer removed it
    expect(cbB).toHaveBeenCalledTimes(2) // still firing
  })

  it('keeps subscriptions isolated per channel', () => {
    const cbA = vi.fn()
    const cbB = vi.fn()
    subscribe<string>('chan:a')(cbA)
    subscribe<string>('chan:b')(cbB)

    emit('chan:a', 'hello')
    expect(cbA).toHaveBeenCalledTimes(1)
    expect(cbB).not.toHaveBeenCalled()
  })
})
