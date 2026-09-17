// @vitest-environment happy-dom
//
// The syncplay IPC bridge, driven end to end in one process (#361 step 2).
//
// Before this, the bridge was the least-tested seam in a heavily-tested
// subsystem: 3 of the 12 `CHANNELS.SYNCPLAY_*` invoke channels appeared in any
// test (all via `test/services/syncplay-password-vault.test.ts`, which proves
// the vault rather than the routing), and **none** of the 6
// `EVENT_CHANNELS.SYNCPLAY_*` broadcasts appeared in any test file at all.
//
// What is real here: `src/main/ipc/syncplay.ipc.ts`, the extracted
// `src/main/ipc/syncplay-broadcasts.ts`, `src/preload/index.ts` and its
// `subscribe()` helper, and the `CHANNELS` / `EVENT_CHANNELS` constants. The
// loop between them is the global electron mock's (`__enableIpcLoop()`), and
// `SyncplayClient` is a double — the question this file asks is *which method
// does the channel reach, with what*, so the client's own behaviour is the one
// thing that must not be in the picture. Driving a real client through the
// bridge is #361 step 3's harness.
//
// Both halves are asserted against a census of the channel constants rather
// than a hand-written list, so a thirteenth channel or a seventh broadcast that
// nobody wires reds this file instead of slipping past it.
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { __reset, __enableIpcLoop, __registeredChannels } from '../setup/electron-mock'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc/index'

vi.mock('../../src/main/syncplay', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeSyncplayClient extends EventEmitter {
    connect = vi.fn()
    disconnect = vi.fn()
    setFile = vi.fn()
    sendLocalState = vi.fn()
    updateSnapshot = vi.fn()
    playerClosed = vi.fn()
    setReady = vi.fn()
    getStatus = vi.fn(() => ({ state: 'connected', room: 'r' }))
    getRoomUsers = vi.fn(() => [{ name: 'alice', isReady: true }])
    getRoomPosition = vi.fn(() => 123.5)
  }
  return { syncplay: new FakeSyncplayClient() }
})

import { syncplay } from '../../src/main/syncplay'
import { register } from '../../src/main/ipc/syncplay.ipc'
import { registerSyncplayBroadcasts } from '../../src/main/ipc/syncplay-broadcasts'
// Side-effect import: under Vitest `process.contextIsolated` is unset, so the
// preload takes its `window.api = api` branch and the real `window.api.*`
// surface lands on the happy-dom global. That is what puts the preload wrapper
// inside the loop rather than a re-spelling of it.
import '../../src/preload/index'

type ClientMethod =
  | 'connect'
  | 'disconnect'
  | 'setFile'
  | 'sendLocalState'
  | 'updateSnapshot'
  | 'playerClosed'
  | 'setReady'
  | 'getStatus'
  | 'getRoomUsers'
  | 'getRoomPosition'

const CLIENT_METHODS: ClientMethod[] = [
  'connect',
  'disconnect',
  'setFile',
  'sendLocalState',
  'updateSnapshot',
  'playerClosed',
  'setReady',
  'getStatus',
  'getRoomUsers',
  'getRoomPosition'
]

const client = syncplay as unknown as Record<ClientMethod, Mock> & {
  emit(event: string, payload: unknown): boolean
  removeAllListeners(): void
}

// The preload's own surface, as the renderer sees it.
const api = (): Record<string, (...args: never[]) => unknown> =>
  (globalThis as unknown as { window: { api: Record<string, (...args: never[]) => unknown> } })
    .window.api

/** Every `SyncplayClient` method except the named one must be untouched. */
const onlyCalled = (method: ClientMethod): void => {
  const stray = CLIENT_METHODS.filter((m) => m !== method && client[m].mock.calls.length > 0)
  expect(stray).toEqual([])
  expect(client[method]).toHaveBeenCalledTimes(1)
}

let store: InMemoryStorage

beforeEach(() => {
  vi.clearAllMocks()
  __reset()
  __enableIpcLoop()
  // The mocked module is a singleton, so its emitter survives between cases.
  // `vi.clearAllMocks()` clears call records, not listener sets — without this
  // every `registerSyncplayBroadcasts()` below stacks another wiring onto the
  // previous test's and each emit fans out N times.
  client.removeAllListeners()
  store = new InMemoryStorage()
  store.set('syncplay', {})
  register({ store } as unknown as AppDeps)
})

describe('syncplay IPC bridge — invoke channels', () => {
  it('registers a handler for every SYNCPLAY_* request channel and nothing else', () => {
    const expected = Object.entries(CHANNELS)
      .filter(([key]) => key.startsWith('SYNCPLAY_'))
      .map(([, value]) => value)

    // The pin, not just the set: `syncplay.ipc.ts` is the only router this
    // file registers, so the registry is exactly its channels. A handler
    // deleted from the router, or one added without a test, moves this.
    expect(expected).toHaveLength(12)
    expect([...__registeredChannels()].sort()).toEqual([...expected].sort())
  })

  const cfg = {
    host: 'syncplay.test',
    port: 8999,
    room: 'r',
    username: 'u',
    // Explicit, so this case reads routing and not the vault — password
    // *injection* is `test/services/syncplay-password-vault.test.ts`'s subject.
    password: 'explicit',
    autoReconnect: true
  }

  it('syncplayConnect → connect(), with the vault-resolved password merged in', async () => {
    await api().syncplayConnect(cfg as never)

    onlyCalled('connect')
    // Not a pass-through: the handler rebuilds the config around the resolved
    // password (#216), so the assertion is on the merged object.
    expect(client.connect).toHaveBeenCalledWith({ ...cfg, password: 'explicit' })
  })

  it('syncplayDisconnect → disconnect()', async () => {
    await api().syncplayDisconnect()

    onlyCalled('disconnect')
    expect(client.disconnect).toHaveBeenCalledWith()
  })

  it('syncplaySetFile → setFile(file)', async () => {
    const file = { name: 'ep01.mkv', size: 42, duration: 1440 }
    await api().syncplaySetFile(file as never)

    onlyCalled('setFile')
    expect(client.setFile).toHaveBeenCalledWith(file)
  })

  it('syncplaySendLocalState → sendLocalState(payload)', async () => {
    const payload = { paused: false, position: 12.25, cause: 'seek' as const }
    await api().syncplaySendLocalState(payload as never)

    onlyCalled('sendLocalState')
    expect(client.sendLocalState).toHaveBeenCalledWith(payload)
  })

  it('syncplaySendLocalSnapshot → updateSnapshot(snap)', async () => {
    const snap = { position: 300.5, paused: true }
    await api().syncplaySendLocalSnapshot(snap as never)

    onlyCalled('updateSnapshot')
    expect(client.updateSnapshot).toHaveBeenCalledWith(snap)
  })

  it('syncplayPlayerClosed → playerClosed(playerSessionId)', async () => {
    await api().syncplayPlayerClosed('session-7' as never)

    onlyCalled('playerClosed')
    expect(client.playerClosed).toHaveBeenCalledWith('session-7')
  })

  it('syncplayPlayerClosed carries undefined through rather than substituting', async () => {
    // `undefined` is load-bearing: it is the "older renderer / never announced"
    // case the handler degrades on, so the bridge must not turn it into a
    // string or drop the argument's meaning.
    await api().syncplayPlayerClosed()

    onlyCalled('playerClosed')
    expect(client.playerClosed).toHaveBeenCalledWith(undefined)
  })

  it('syncplaySetReady → setReady(isReady)', async () => {
    await api().syncplaySetReady(true as never)

    onlyCalled('setReady')
    expect(client.setReady).toHaveBeenCalledWith(true)
  })

  it('syncplayGetStatus → getStatus(), and the return value comes back', async () => {
    const status = await api().syncplayGetStatus()

    onlyCalled('getStatus')
    expect(status).toEqual({ state: 'connected', room: 'r' })
  })

  it('syncplayGetRoomUsers → getRoomUsers(), and the return value comes back', async () => {
    const users = await api().syncplayGetRoomUsers()

    onlyCalled('getRoomUsers')
    expect(users).toEqual([{ name: 'alice', isReady: true }])
  })

  it('syncplayGetRoomPosition → getRoomPosition(canonicalName), return value included', async () => {
    const position = await api().syncplayGetRoomPosition('Show - 01.mkv' as never)

    onlyCalled('getRoomPosition')
    expect(client.getRoomPosition).toHaveBeenCalledWith('Show - 01.mkv')
    expect(position).toBe(123.5)
  })

  // The two vault channels reach the store, not the client — the only two of
  // the twelve that do.
  it('syncplaySetPassword / syncplayHasPassword reach the vault, not the client', async () => {
    expect(await api().syncplayHasPassword()).toBe(false)

    await api().syncplaySetPassword('hunter2' as never)

    expect(await api().syncplayHasPassword()).toBe(true)
    expect(CLIENT_METHODS.filter((m) => client[m].mock.calls.length > 0)).toEqual([])
  })

  it('surfaces a handler throw as a rejection rather than a resolved undefined', async () => {
    client.disconnect.mockImplementationOnce(() => {
      throw new Error('socket already gone')
    })

    await expect(api().syncplayDisconnect()).rejects.toThrow('socket already gone')
  })
})

describe('syncplay IPC bridge — broadcast channels', () => {
  // `broadcastToAll` in `src/main/index.ts` fans a channel out to every
  // window's `webContents.send`; `__emit` is that fan-out's in-process stand-in,
  // landing on the same `ipcRenderer.on` registry the preload's `subscribe()`
  // writes to.
  let broadcast: Mock

  beforeEach(async () => {
    const { __emit } = await import('../setup/electron-mock')
    broadcast = vi.fn((channel: string, ...args: unknown[]) => {
      __emit(channel, ...args)
    })
    registerSyncplayBroadcasts(client as never, broadcast)
  })

  const CASES: Array<{
    event: string
    channel: string
    subscriber: string
    payload: unknown
  }> = [
    {
      event: 'connection-status',
      channel: EVENT_CHANNELS.SYNCPLAY_CONNECTION_STATUS,
      subscriber: 'onSyncplayConnectionStatus',
      payload: { state: 'connected', room: 'r', username: 'u' }
    },
    {
      event: 'remote-state',
      channel: EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE,
      subscriber: 'onSyncplayRemoteState',
      payload: { position: 42.5, paused: false, setBy: 'alice' }
    },
    {
      event: 'room-users',
      channel: EVENT_CHANNELS.SYNCPLAY_ROOM_USERS,
      subscriber: 'onSyncplayRoomUsers',
      payload: [{ name: 'alice', isReady: true }]
    },
    {
      event: 'room-event',
      channel: EVENT_CHANNELS.SYNCPLAY_ROOM_EVENT,
      subscriber: 'onSyncplayRoomEvent',
      payload: { level: 'info', text: 'alice joined the room' }
    },
    {
      event: 'remote-episode-change',
      channel: EVENT_CHANNELS.SYNCPLAY_REMOTE_EPISODE_CHANGE,
      subscriber: 'onSyncplayRemoteEpisodeChange',
      payload: { animeId: 7, episodeInt: '3' }
    },
    {
      event: 'trace',
      channel: EVENT_CHANNELS.SYNCPLAY_TRACE,
      subscriber: 'onSyncplayTrace',
      payload: { dir: 'in', keys: 'State', msg: { State: {} } }
    }
  ]

  it('covers every SYNCPLAY_* broadcast channel', () => {
    const declared = Object.entries(EVENT_CHANNELS)
      .filter(([key]) => key.startsWith('SYNCPLAY_'))
      .map(([, value]) => value)

    expect(declared).toHaveLength(6)
    expect([...CASES.map((c) => c.channel)].sort()).toEqual([...declared].sort())
  })

  for (const { event, channel, subscriber, payload } of CASES) {
    it(`client '${event}' → ${channel} → api.${subscriber}`, () => {
      const seen = vi.fn()
      api()[subscriber](seen as never)

      client.emit(event, payload)

      expect(broadcast).toHaveBeenCalledWith(channel, payload)
      expect(seen).toHaveBeenCalledTimes(1)
      expect(seen).toHaveBeenCalledWith(payload)
    })
  }

  it('routes each event to its own channel only', () => {
    const seen = new Map(CASES.map(({ subscriber }) => [subscriber, vi.fn()]))
    for (const { subscriber } of CASES) api()[subscriber](seen.get(subscriber)! as never)

    client.emit('room-event', { level: 'warn', text: 'x' })

    expect(
      [...seen.entries()].filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name)
    ).toEqual(['onSyncplayRoomEvent'])
  })

  it('stops delivering after the subscriber disposes (EventSubscriber contract)', () => {
    const seen = vi.fn()
    const unsubscribe = api().onSyncplayRoomEvent(seen as never) as () => void

    client.emit('room-event', { level: 'info', text: 'first' })
    unsubscribe()
    client.emit('room-event', { level: 'info', text: 'second' })

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith({ level: 'info', text: 'first' })
  })
})
