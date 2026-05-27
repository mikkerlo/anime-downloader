import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  destroy = vi.fn()
  write = vi.fn()
}

let lastSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => new FakeSocket())
}))

import { SyncplayClient } from '../../src/main/syncplay'

describe('SyncplayClient onSocketClose disconnect reason (#119)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  beforeEach(() => {
    lastSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it('emits "Connection closed" (not "Auto-reconnect disabled") when autoReconnect is off and the socket drops', () => {
    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: false
    })
    expect(lastSocket).not.toBeNull()
    // Simulate the socket dropping without ever connecting.
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Connection closed')
    expect(last.error).not.toBe('Auto-reconnect disabled')
  })

  it('still reports "Max reconnect attempts reached" when retries are exhausted', () => {
    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'u',
      autoReconnect: true
    })
    // Force the client past the max-attempts threshold so onSocketClose hits
    // the "give up" branch on the next close.
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Max reconnect attempts reached')
  })
})
