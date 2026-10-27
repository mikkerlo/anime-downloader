// Syncplay's raw socket bypasses `fetchWithTimeout`, so it has its own offline
// gate (#567): a connect is refused with a clear error, entering offline drops
// an open session without scheduling a retry, and back online a session that
// offline dropped reconnects if its config allows.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => this.emit('close'))
}

let sockets: FakeSocket[] = []

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  })
}))

vi.mock('tls', () => ({ connect: vi.fn(() => new FakeSocket()) }))

import * as net from 'net'
import { SyncplayClient, SYNCPLAY_OFFLINE_ERROR } from '../../src/main/syncplay'

const CONFIG = { host: 'example.test', port: 8999, room: 'r', username: 'u' }

describe('SyncplayClient offline gate (#567)', () => {
  let client: SyncplayClient
  let offline: boolean
  let statuses: Array<{ state: string; error?: string }>
  let events: Array<{ level: string; text: string }>

  beforeEach(() => {
    vi.useRealTimers()
    vi.mocked(net.createConnection).mockClear()
    sockets = []
    offline = false
    client = new SyncplayClient()
    client.setOfflineCheck(() => offline)
    statuses = []
    events = []
    client.on('connection-status', (s) => statuses.push(s as { state: string; error?: string }))
    client.on('room-event', (e) => events.push(e as { level: string; text: string }))
  })

  it('refuses a connect while offline: no socket, a clear error', () => {
    offline = true
    client.connect({ ...CONFIG, autoReconnect: true })
    expect(net.createConnection).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toMatchObject({ state: 'disconnected', error: SYNCPLAY_OFFLINE_ERROR })
    expect(events.at(-1)?.text).toBe('Disconnected from Syncplay room: offline')
  })

  it('connects normally online (the control)', () => {
    client.connect({ ...CONFIG, autoReconnect: true })
    expect(net.createConnection).toHaveBeenCalledTimes(1)
  })

  it('entering offline drops an open session and schedules no reconnect', async () => {
    vi.useFakeTimers()
    client.connect({ ...CONFIG, autoReconnect: true })
    const sock = sockets[0]
    offline = true
    client.suspendForOffline()
    expect(sock.destroy).toHaveBeenCalledTimes(1)
    expect(client.getStatus()).toMatchObject({
      state: 'disconnected',
      error: SYNCPLAY_OFFLINE_ERROR
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(net.createConnection).toHaveBeenCalledTimes(1)
  })

  it('a reconnect timer that fires while offline opens no socket', async () => {
    vi.useFakeTimers()
    client.connect({ ...CONFIG, autoReconnect: true })
    sockets[0].emit('close')
    expect(client.getStatus().state).toBe('reconnecting')
    offline = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(net.createConnection).toHaveBeenCalledTimes(1)
    expect(client.getStatus()).toMatchObject({ error: SYNCPLAY_OFFLINE_ERROR })
  })

  it('back online, a session offline dropped reconnects', () => {
    client.connect({ ...CONFIG, autoReconnect: true })
    offline = true
    client.suspendForOffline()
    offline = false
    client.resumeAfterOffline()
    expect(net.createConnection).toHaveBeenCalledTimes(2)
  })

  it('back online, a session without auto-reconnect stays disconnected', () => {
    client.connect({ ...CONFIG, autoReconnect: false })
    offline = true
    client.suspendForOffline()
    offline = false
    client.resumeAfterOffline()
    expect(net.createConnection).toHaveBeenCalledTimes(1)
  })

  it('back online does nothing to a session the user disconnected, or one that is still up', () => {
    client.connect({ ...CONFIG, autoReconnect: true })
    client.resumeAfterOffline()
    expect(net.createConnection).toHaveBeenCalledTimes(1)
    offline = true
    client.suspendForOffline()
    client.disconnect()
    offline = false
    client.resumeAfterOffline()
    expect(net.createConnection).toHaveBeenCalledTimes(1)
  })

  it('suspending an idle client is a no-op', () => {
    offline = true
    client.suspendForOffline()
    expect(statuses).toEqual([])
  })
})
