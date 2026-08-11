// The roster is a cache with exactly one fill point (#221). `finishHandshake()`
// asks for `{List: null}` once per connection and everything after that is
// incremental `Set: {user}` push — so a frame lost to a mid-reconnect gap, a
// peer that died without a clean disconnect, and a peer the server moved into
// our room without re-broadcasting their file all leave the member list wrong
// until the user disconnects and reconnects. This file covers the 15 s poll that
// closes that, plus the two properties that make a repeated full-roster
// replacement safe: the readiness ratchet and the emit-on-change gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

const sockets: FakeSocket[] = []
const tlsSockets: FakeSocket[] = []

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    const s = new FakeSocket()
    tlsSockets.push(s)
    return s
  })
}))

import { SyncplayClient, type SyncplayRoomUser } from '../../src/main/syncplay'

// Mirrors LIST_POLL_MS in the client.
const LIST_POLL_MS = 15000
// Comfortably past the first reconnect backoff (RECONNECT_BASE_MS = 1000).
const RECONNECT_MS = 1500

type Frame = Record<string, unknown>
type RoomEvent = { level: string; text: string }
type JsonMap = Record<string, unknown>

const frames = (sock: FakeSocket | undefined): Frame[] =>
  (sock?.write.mock.calls ?? []).map(([f]) => JSON.parse(String(f)) as Frame)

// Filter by key, never by index: LIST_POLL_MS is an exact multiple of the 1 s
// heartbeat, so every poll fires in the same fake-timer batch as ~15 `State`
// frames (sendStateMessage always writes once ready — it carries a `ping` even
// when there is no playstate to assert).
const listFrames = (sock: FakeSocket | undefined): Frame[] =>
  frames(sock).filter((f) => 'List' in f)

describe('SyncplayClient room list polling (#221)', () => {
  let client: SyncplayClient
  let roomUsers: SyncplayRoomUser[][]
  let roomEvents: RoomEvent[]

  const tlsSock = (): FakeSocket => tlsSockets[tlsSockets.length - 1]

  // The handshake's own `{List: null}` is the baseline — assertions count the
  // *polled* ones.
  const polledLists = (sock: FakeSocket | undefined = tlsSock()): number =>
    listFrames(sock).length - 1

  const connect = (autoReconnect = false, room = 'cinema'): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room,
      username: 'me',
      autoReconnect
    })
  }

  const completeHandshake = (room = 'cinema'): void => {
    const sock = sockets[sockets.length - 1]
    sock.emit('connect')
    sock.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    const tlsS = tlsSock()
    tlsS.emit('secureConnect')
    tlsS.emit(
      'data',
      Buffer.from(`{"Hello":{"username":"me","room":{"name":"${room}"},"version":"1.6.9"}}\r\n`)
    )
  }

  const handshake = (autoReconnect = false, room = 'cinema'): void => {
    connect(autoReconnect, room)
    completeHandshake(room)
  }

  const deliver = (obj: unknown): void => {
    tlsSock().emit('data', Buffer.from(JSON.stringify(obj) + '\r\n'))
  }

  const deliverList = (rooms: JsonMap): void => deliver({ List: rooms })

  const userNamed = (name: string): SyncplayRoomUser | undefined =>
    client.getRoomUsers().find((u) => u.username === name)

  const usernames = (): string[] => client.getRoomUsers().map((u) => u.username)

  // The server writes `file: {}` for a watcher with nothing loaded.
  const selfEntry = { isReady: true, file: {} }

  const meta = { animeId: 1, malId: null, episodeInt: '3', translationId: null }
  const fileWithMeta = { name: 'A', duration: 10, features: { animeDlAppMeta: meta } }

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    tlsSockets.length = 0
    client = new SyncplayClient()
    roomUsers = []
    roomEvents = []
    client.on('room-users', (u) => roomUsers.push(u as SyncplayRoomUser[]))
    client.on('room-event', (e) => roomEvents.push(e as RoomEvent))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the poll itself', () => {
    // The regression: main sends `{List: null}` exactly once, at handshake, and
    // never again for the life of the connection.
    it('re-requests the roster every 15 s while the session is ready', () => {
      handshake()
      expect(polledLists()).toBe(0)

      vi.advanceTimersByTime(LIST_POLL_MS)
      expect(polledLists()).toBe(1)

      vi.advanceTimersByTime(LIST_POLL_MS * 2)
      expect(polledLists()).toBe(3)
    })

    // This pins the *wiring* — that no interval exists before `ready` — not
    // sendListRequest()'s own `ready` early-return, which is unreachable through
    // the timer (started after `ready` is set, stopped on every transition out
    // of it). Nobody should go chasing that branch for coverage.
    it('creates no poller while the handshake is still in flight', () => {
      connect()
      vi.advanceTimersByTime(LIST_POLL_MS * 2)

      expect(listFrames(sockets[0])).toHaveLength(0)
      expect(tlsSockets.flatMap((s) => listFrames(s))).toHaveLength(0)
    })

    it('creates no poller between the TLS upgrade and the server Hello', () => {
      connect()
      sockets[0].emit('connect')
      sockets[0].emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      tlsSock().emit('secureConnect')
      expect(client.getStatus().state).toBe('hello-sent')

      vi.advanceTimersByTime(LIST_POLL_MS * 2)

      expect(listFrames(tlsSock())).toHaveLength(0)
    })

    it('stops polling when the session is torn down', () => {
      handshake()
      vi.advanceTimersByTime(LIST_POLL_MS)
      const sock = tlsSock()
      const written = frames(sock).length

      client.disconnect()
      vi.advanceTimersByTime(LIST_POLL_MS * 2)

      expect(frames(sock)).toHaveLength(written)
    })

    // Same per-socket-state class as #216: the reconnect path never goes through
    // tearDown(), so without stopListPolling() in onSocketClose() the retry would
    // leave two intervals running and double the poll rate on every drop.
    it('runs exactly one poller after a reconnect', async () => {
      handshake(true)
      tlsSockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(RECONNECT_MS)
      expect(sockets).toHaveLength(2)
      completeHandshake()
      expect(tlsSockets).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(LIST_POLL_MS)

      expect(polledLists(tlsSockets[1])).toBe(1)
    })
  })

  describe('a repeated roster degrades nothing', () => {
    it('keeps a peer’s animeDlAppMeta across repeated polls', () => {
      handshake()
      const list = { cinema: { zoe: { isReady: true, file: fileWithMeta }, me: selfEntry } }
      deliverList(list)
      deliverList(list)
      deliverList(list)
      deliverList(list)

      // "Join & watch" still has something to act on past the nth poll.
      expect(userNamed('zoe')?.animeDlAppMeta).toEqual(meta)
    })

    // The user-visible bug: someone leaves during a gap that produces no
    // `Set.user.event.left`, and main lists them until the next reconnect.
    it('drops a member the next roster no longer lists', () => {
      handshake()
      deliverList({
        cinema: {
          zoe: { isReady: true, file: {} },
          bob: { isReady: true, file: {} },
          me: selfEntry
        }
      })
      expect(usernames()).toContain('bob')

      deliverList({ cinema: { zoe: { isReady: true, file: {} }, me: selfEntry } })

      expect(usernames()).not.toContain('bob')
      expect(roomUsers[roomUsers.length - 1].map((u) => u.username)).not.toContain('bob')
    })

    // #223's guard re-asserted under repetition: a one-shot flash today, a
    // roster that flaps to empty and back on a timer once this lands.
    it('leaves the roster alone when a polled reply cannot be keyed to our room', () => {
      handshake()
      deliverList({ cinema: { zoe: { isReady: true, file: fileWithMeta }, me: selfEntry } })
      const before = client.getRoomUsers()

      // Two foreign rooms: more than one, so pickOwnRoom()'s single-entry
      // fallback cannot adopt it either.
      deliverList({ lounge: { stranger: { isReady: true, file: {} } }, annex: {} })

      expect(client.getRoomUsers()).toEqual(before)
    })

    // Self-readiness is authoritative locally — a poll must never hand our own
    // ready state back to us from a server that has not caught up to the last
    // `set-ready`.
    it('does not let a poll overwrite our own readiness', () => {
      handshake()
      client.setReady(false)

      deliverList({ cinema: { me: { isReady: true, file: {} } } })

      expect(userNamed('me')?.isReady).toBe(false)
    })

    // Join/leave toasts stay driven exclusively by real `Set.user.event` frames:
    // a poll landing between a `Set` and its emit would double-toast, and a poll
    // after a reconnect would replay every member as "joined".
    it('synthesizes no join or leave events from a poll-driven change', () => {
      handshake()
      deliverList({ cinema: { zoe: { isReady: true, file: {} }, me: selfEntry } })
      roomEvents = []

      deliverList({ cinema: { bob: { isReady: true, file: {} }, me: selfEntry } })

      expect(usernames().sort()).toEqual(['bob', 'me'])
      expect(roomEvents.filter((e) => /joined|left/.test(e.text))).toHaveLength(0)
    })
  })

  // Retire this whole describe block when #229 lands (parsing the top-level
  // `Set: {ready}` broadcast) — see the ratchet's comment in syncplay.ts.
  describe('readiness ratchet', () => {
    it('adopts a peer turning ready on a later roster (release direction)', () => {
      handshake()
      deliverList({ cinema: { zoe: { isReady: false, file: {} }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBe(false)
      const emitted = roomUsers.length

      deliverList({ cinema: { zoe: { isReady: true, file: {} }, me: selfEntry } })

      expect(userNamed('zoe')?.isReady).toBe(true)
      expect(roomUsers).toHaveLength(emitted + 1)
    })

    it('refuses a later roster’s not-ready for a known peer (engage direction)', () => {
      handshake()
      deliverList({ cinema: { zoe: { isReady: true, file: {} }, me: selfEntry } })
      const emitted = roomUsers.length

      deliverList({ cinema: { zoe: { isReady: false, file: {} }, me: selfEntry } })

      expect(userNamed('zoe')?.isReady).toBe(true)
      expect(roomUsers).toHaveLength(emitted)
    })

    // The case a "only for users we already know" rule gets wrong — and a peer
    // discovered *by* a poll is exactly what the poll exists for. `undefined`
    // rather than `false`, because the renderer's gate is a strict `=== false`.
    it('seats an unknown peer’s not-ready as undefined, not false', () => {
      handshake()
      deliverList({ cinema: { me: selfEntry } })
      const emitted = roomUsers.length

      deliverList({ cinema: { me: selfEntry, newbie: { isReady: false, file: {} } } })

      expect(userNamed('newbie')?.isReady).toBeUndefined()
      // Membership genuinely changed, so this one does emit — which is exactly
      // why the readiness value it carries has to be right.
      expect(roomUsers).toHaveLength(emitted + 1)
    })

    it('adopts the first roster of a socket verbatim', () => {
      handshake()

      deliverList({ cinema: { zoe: { isReady: false, file: {} }, me: selfEntry } })

      expect(userNamed('zoe')?.isReady).toBe(false)
    })

    // Per socket, not per session: `roomUsers` deliberately survives a reconnect,
    // so a flag that did not reset would leave the previous socket's stale `true`
    // masking a peer who is genuinely buffering on the new one.
    it('unratchets again on the socket opened by a reconnect', async () => {
      handshake(true)
      deliverList({ cinema: { zoe: { isReady: true, file: fileWithMeta }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBe(true)

      tlsSockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(RECONNECT_MS)
      completeHandshake()

      // Not identical to the surviving roster (the file differs), so this one
      // reaches the assignment branch.
      deliverList({
        cinema: {
          zoe: { isReady: false, file: { name: 'B', duration: 20 } },
          me: selfEntry
        }
      })

      expect(userNamed('zoe')?.isReady).toBe(false)
    })

    // The flag/emit-gate collision. An *equal* roster is still an adopted one —
    // anchor the flag to the assignment and a quiet room's reconnect leaves the
    // socket's unratcheted slot for the next poll, which is then free to seat a
    // false and pause the local player.
    it('consumes the unratcheted slot even when the reconnect’s roster is identical', async () => {
      handshake(true)
      const roster = { cinema: { zoe: { isReady: true, file: fileWithMeta }, me: selfEntry } }
      deliverList(roster)

      tlsSockets[0].emit('close')
      await vi.advanceTimersByTimeAsync(RECONNECT_MS)
      completeHandshake()
      const emitted = roomUsers.length

      // Field-for-field identical to the roster that survived the reconnect.
      deliverList(roster)
      expect(roomUsers).toHaveLength(emitted)

      // ...and the next one is nonetheless ratcheted.
      deliverList({ cinema: { zoe: { isReady: false, file: fileWithMeta }, me: selfEntry } })

      expect(userNamed('zoe')?.isReady).toBe(true)
    })

    // A reply #223's guard rejects must not burn the socket's one unratcheted
    // roster: the flag is set on adoption, not on entry.
    it('does not let a rejected reply consume the unratcheted slot', () => {
      handshake()
      deliverList({ lounge: { stranger: { isReady: true, file: {} } }, annex: {} })

      deliverList({ cinema: { zoe: { isReady: false, file: {} }, me: selfEntry } })

      expect(userNamed('zoe')?.isReady).toBe(false)
    })

    // A `--disable-ready` server reports `isReady: null`. The rule is "adopt only
    // a literal true", not "adopt anything truthy" — and null must not repair a
    // seated false either.
    it('treats a non-boolean readiness as unknown in both directions', () => {
      handshake()
      deliverList({ cinema: { zoe: { isReady: null, file: {} }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBeUndefined()

      deliverList({ cinema: { zoe: { isReady: false, file: {} }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBeUndefined()

      deliverList({ cinema: { zoe: { isReady: true, file: {} }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBe(true)

      deliverList({ cinema: { zoe: { isReady: null, file: {} }, me: selfEntry } })
      expect(userNamed('zoe')?.isReady).toBe(true)
    })
  })

  describe('emit on change', () => {
    // Seats zoe through the *other* assembler and at the tail, where the polled
    // `List` (built in Object.entries order, self appended last) puts her first.
    const seatZoeViaSet = (): void => {
      deliver({
        Set: { user: { zoe: { room: { name: 'cinema' }, file: fileWithMeta } } }
      })
    }

    const equalPoll = { cinema: { zoe: { file: fileWithMeta }, me: selfEntry } }

    it('emits nothing for an unchanged roster, whichever path assembled it', () => {
      handshake()
      seatZoeViaSet()
      // (a) assembled by absorbRemoteFile, (b) at index 1 where the poll builds
      // her at index 0, (c) carrying animeDlAppMeta, which extractAppMeta()
      // rebuilds as a fresh object on every reply.
      expect(usernames()).toEqual(['me', 'zoe'])
      const emitted = roomUsers.length

      deliverList(equalPoll)
      deliverList(equalPoll)
      deliverList(equalPoll)

      expect(roomUsers).toHaveLength(emitted)
    })

    it('emits again as soon as something actually changes', () => {
      handshake()
      seatZoeViaSet()
      deliverList(equalPoll)
      const emitted = roomUsers.length

      deliverList({ cinema: { zoe: { file: { name: 'B', duration: 10 } }, me: selfEntry } })

      expect(roomUsers).toHaveLength(emitted + 1)
      expect(userNamed('zoe')?.file?.name).toBe('B')
    })

    // "Keep the previous array on equality" is observable as *order*, never as
    // identity: getRoomUsers() maps to fresh objects and every emission is a
    // .slice(), so a `toBe` would pin nothing. An implementation that reassigns
    // but suppresses the emit passes every other assertion here while leaving
    // main and the renderer holding different orderings.
    it('keeps the previous array on equality, observable as order', () => {
      handshake()
      seatZoeViaSet()
      expect(usernames()).toEqual(['me', 'zoe'])

      deliverList(equalPoll)

      expect(usernames()).toEqual(['me', 'zoe'])
    })
  })
})
