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

describe('SyncplayClient transport error surfacing (#213)', () => {
  let client: SyncplayClient
  let statuses: Array<{ state: string; error?: string }>

  const connect = (autoReconnect = false): void => {
    client.connect({ host: 'example.test', port: 8999, room: 'r', username: 'u', autoReconnect })
  }

  const socketError = (message: string, code?: string): void => {
    const err = new Error(message) as Error & { code?: string }
    err.code = code
    lastSocket!.emit('error', err)
  }

  beforeEach(() => {
    lastSocket = null
    client = new SyncplayClient()
    statuses = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
  })

  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:8999'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND example.test'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 93.184.216.34:8999']
  ])('surfaces %s in the disconnected error instead of bare "Connection closed"', (code, msg) => {
    connect()
    socketError(msg, code)
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(`Connection closed — ${msg}`)
  })

  it('appends the code when the message does not already contain it', () => {
    connect()
    socketError('read gone wrong', 'ECONNRESET')
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.error).toBe('Connection closed — read gone wrong (ECONNRESET)')
  })

  it('suffixes the maxed-out error with the most recent attempt failure', () => {
    connect(true)
    socketError('connect ETIMEDOUT 93.184.216.34:8999', 'ETIMEDOUT')
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 4
    lastSocket!.emit('close')
    // The retry re-enters via openSocket(); its failure overwrites the stale one.
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe(
      'Max reconnect attempts reached — connect ECONNREFUSED 93.184.216.34:8999'
    )
  })

  it('clears the remembered error once the session reaches ready', () => {
    connect(true)
    // Attempt 1 fails; attempt 2 succeeds (finishHandshake fires).
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    ;(client as unknown as { finishHandshake(): void }).finishHandshake()
    // Much later the server closes cleanly (no fresh error event) during
    // retries that also close cleanly — the surfaced reason must not be the
    // stale pre-ready failure.
    ;(client as unknown as { reconnectAttempts: number }).reconnectAttempts = 5
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBe('Max reconnect attempts reached')
  })

  it('clears the remembered error on a fresh user-initiated connect()', () => {
    connect()
    socketError('connect ECONNREFUSED 93.184.216.34:8999', 'ECONNREFUSED')
    lastSocket!.emit('close')

    connect()
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.error).toBe('Connection closed')
  })

  it('keeps the no-config close silent: disconnected with no error at all', () => {
    connect()
    // Reproduce the !cfg branch: close arrives after config was torn down but
    // while status is not yet idle.
    ;(client as unknown as { config: unknown }).config = null
    lastSocket!.emit('close')

    const last = statuses[statuses.length - 1]
    expect(last.state).toBe('disconnected')
    expect(last.error).toBeUndefined()
  })
})

describe('SyncplayClient.getRoomUsers (#213)', () => {
  it('returns a snapshot of the current room users', () => {
    const client = new SyncplayClient()
    expect(client.getRoomUsers()).toEqual([])

    client.connect({
      host: 'example.test',
      port: 8999,
      room: 'r',
      username: 'me',
      autoReconnect: false
    })
    const internal = client as unknown as {
      handleList(payload: unknown): void
    }
    internal.handleList({
      r: {
        me: { file: null },
        friend: {
          file: { name: 'Frieren - 12', duration: 1420 },
          isReady: true
        }
      }
    })

    const users = client.getRoomUsers()
    expect(users).toHaveLength(2)
    const friend = users.find((u) => u.username === 'friend')
    expect(friend?.file).toEqual({ name: 'Frieren - 12', duration: 1420, size: undefined })
    expect(friend?.isReady).toBe(true)

    // Mutating the snapshot must not leak into client state.
    users[0].username = 'mutated'
    expect(client.getRoomUsers().map((u) => u.username)).toEqual(
      expect.arrayContaining(['me', 'friend'])
    )
  })
})
