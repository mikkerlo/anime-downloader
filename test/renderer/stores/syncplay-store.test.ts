import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Listener<T> = (data: T) => void

type Captured = {
  connectionStatus: Listener<SyncplayStatus>[]
  roomUsers: Listener<SyncplayRoomUser[]>[]
  syncplayGetStatus: ReturnType<typeof vi.fn>
  syncplayGetRoomUsers: ReturnType<typeof vi.fn>
}

let captured: Captured

function installApi(seed?: { status?: SyncplayStatus; users?: SyncplayRoomUser[] }): void {
  captured = {
    connectionStatus: [],
    roomUsers: [],
    syncplayGetStatus: vi.fn(async () => seed?.status ?? { state: 'idle' }),
    syncplayGetRoomUsers: vi.fn(async () => seed?.users ?? [])
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onSyncplayConnectionStatus: (cb: Listener<SyncplayStatus>) => {
        captured.connectionStatus.push(cb)
        return () => {}
      },
      onSyncplayRoomUsers: (cb: Listener<SyncplayRoomUser[]>) => {
        captured.roomUsers.push(cb)
        return () => {}
      },
      syncplayGetStatus: captured.syncplayGetStatus,
      syncplayGetRoomUsers: captured.syncplayGetRoomUsers
    }
  }
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  vi.resetModules()
})

async function loadStore(): Promise<
  ReturnType<(typeof import('../../../src/renderer/src/stores/syncplay'))['useSyncplayStore']>
> {
  const { useSyncplayStore } = await import('../../../src/renderer/src/stores/syncplay')
  return useSyncplayStore()
}

describe('useSyncplayStore', () => {
  it('subscribes to both broadcasts at construction and seeds from main', async () => {
    installApi({
      status: { state: 'ready', room: 'r1', username: 'me' },
      users: [{ username: 'friend', file: null }]
    })
    const store = await loadStore()
    expect(captured.connectionStatus.length).toBe(1)
    expect(captured.roomUsers.length).toBe(1)
    await vi.waitFor(() => {
      expect(store.status.state).toBe('ready')
      expect(store.roomUsers).toEqual([{ username: 'friend', file: null }])
    })
  })

  it('updates status and roomUsers when the broadcasts fire', async () => {
    const store = await loadStore()
    expect(store.status.state).toBe('idle')
    captured.connectionStatus[0]({ state: 'connecting', host: 'h' })
    expect(store.status).toEqual({ state: 'connecting', host: 'h' })
    captured.roomUsers[0]([{ username: 'a', file: null, isReady: false }])
    expect(store.roomUsers).toEqual([{ username: 'a', file: null, isReady: false }])
  })

  it('isActive tracks connection lifecycle states', async () => {
    const store = await loadStore()
    expect(store.isActive).toBe(false)
    for (const state of [
      'connecting',
      'tls-probing',
      'tls-handshake',
      'hello-sent',
      'ready',
      'reconnecting'
    ] as const) {
      captured.connectionStatus[0]({ state })
      expect(store.isActive).toBe(true)
    }
    captured.connectionStatus[0]({ state: 'disconnected' })
    expect(store.isActive).toBe(false)
  })

  it('refresh() re-reads live state from main', async () => {
    const store = await loadStore()
    captured.syncplayGetStatus.mockResolvedValue({ state: 'ready', room: 'r2' })
    captured.syncplayGetRoomUsers.mockResolvedValue([{ username: 'b', file: null }])
    await store.refresh()
    expect(store.status).toEqual({ state: 'ready', room: 'r2' })
    expect(store.roomUsers).toEqual([{ username: 'b', file: null }])
  })

  it('reuses the same store singleton — subscriptions are not duplicated', async () => {
    const { useSyncplayStore } = await import('../../../src/renderer/src/stores/syncplay')
    useSyncplayStore()
    useSyncplayStore()
    expect(captured.connectionStatus.length).toBe(1)
  })
})
