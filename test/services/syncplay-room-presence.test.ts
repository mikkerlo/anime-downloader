// Joining a room must be a passive act (#220): the joiner has no player yet,
// so it must not assert a playstate (which used to yank everyone back to 0 and
// pause them), and it must actively ask for the roster (the server only
// broadcasts membership *changes*, so people already in the room were
// invisible — "Room is empty — you're the first one here" with two people in).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

let lastSocket: FakeSocket | null = null
let lastTlsSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    lastTlsSocket = new FakeSocket()
    return lastTlsSocket
  })
}))

import { SyncplayClient, type SyncplayRoomUser } from '../../src/main/syncplay'

// Mirrors PLAYBACK_STALE_MS in the client: how long without a renderer push
// before main decides no player is driving playback.
const PLAYBACK_STALE_MS = 5000

type Frame = Record<string, unknown>

const frames = (sock: FakeSocket | null): Frame[] =>
  (sock?.write.mock.calls ?? []).map(([f]) => JSON.parse(String(f)) as Frame)

const statesOf = (
  sock: FakeSocket | null
): Array<{
  playstate?: { position: number; paused?: boolean; doSeek: boolean }
}> =>
  frames(sock)
    .filter((f) => 'State' in f)
    .map((f) => f.State as never)

describe('SyncplayClient room presence on join (#220)', () => {
  let client: SyncplayClient
  let roomUsers: SyncplayRoomUser[][]

  const handshake = (room = 'cinema', autoReconnect = false): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room,
      username: 'me',
      autoReconnect
    })
    driveHandshake(room)
  }

  // The TLS probe → secureConnect → Hello sequence on whatever socket pair is
  // current. Split out of `handshake()` so a reconnect can re-drive it on the
  // fresh pair `onSocketClose()` opened, without going through `connect()`
  // (which calls `tearDown()`, and so is not the reconnect path at all).
  const driveHandshake = (room = 'cinema'): void => {
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from(`{"Hello":{"username":"me","room":{"name":"${room}"},"version":"1.6.9"}}\r\n`)
    )
  }

  // A `List` reply the client can key to our room. `{}` is the alone case: the
  // entry is present and empty, and `handleList` seats us at its tail — the
  // state main must be able to tell apart from "no reply has arrived yet"
  // (#236).
  const listReply = (entries: Record<string, unknown> = {}, room = 'cinema'): void => {
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { [room]: entries } }) + '\r\n'))
  }

  // A plausible time.time() rather than 1: since #231 this key is no longer
  // inert here — it arms a real echo through consumeServerLatencyEcho() — and
  // one second past the epoch would be a ~56-year RTT on the wire.
  const serverState = (position: number, paused: boolean, setBy: string | null = null): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
            playstate: { position, paused, doSeek: false, setBy }
          }
        }) + '\r\n'
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    roomUsers = []
    client.on('room-users', (u) => roomUsers.push(u as SyncplayRoomUser[]))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the roster is requested, not waited for', () => {
    it('asks the server for the user list once the handshake completes', () => {
      handshake()
      expect(frames(lastTlsSocket)).toContainEqual({ List: null })
    })

    // The bug: people already sitting in the room generate no Set broadcasts,
    // so without a List request the joiner sees an empty room.
    it('populates the roster from the List reply for users who were already there', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: {
                mikkerlo: {
                  isReady: true,
                  file: {
                    name: 'Ore dake Level Up na Ken Season 2 - 2',
                    duration: 1440,
                    features: {
                      animeDlAppMeta: {
                        animeId: 42,
                        malId: 7,
                        episodeInt: '2',
                        translationId: 601
                      }
                    }
                  }
                },
                me: { isReady: true, file: {} }
              }
            }
          }) + '\r\n'
        )
      )

      const latest = roomUsers.at(-1)!
      expect(latest.map((u) => u.username).sort()).toEqual(['me', 'mikkerlo'])
      const peer = latest.find((u) => u.username === 'mikkerlo')!
      expect(peer.file?.name).toBe('Ore dake Level Up na Ken Season 2 - 2')
      // Without the metadata the view lists the peer but offers no "Join & watch".
      expect(peer.animeDlAppMeta).toEqual({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601
      })
    })

    // The server writes `file: {}` for a watcher with nothing loaded, which
    // would otherwise parse into a hollow {name:'', duration:0} and render as
    // an empty file line under their name.
    it('reports a watcher with nothing loaded as having no file', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )

      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file).toBeNull()
    })

    // A room named like an Object.prototype member resolves to the prototype's
    // function through a bare index — non-undefined, so the single-room
    // fallback is skipped, and isObject() then rejects it: empty roster.
    it('reads a roster when the room is named like an Object prototype member', () => {
      handshake('toString')
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: { Renamed: { mikkerlo: { isReady: true, file: {} } } }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    it('ignores users sitting in other rooms on the same server', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { mikkerlo: { isReady: true, file: {} } },
              'someone-elses-room': { stranger: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    it('keys the roster by the room name the server seated us in', () => {
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'cinema',
        username: 'me',
        autoReconnect: false
      })
      lastSocket!.emit('connect')
      lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      lastTlsSocket!.emit('secureConnect')
      // Server canonicalizes the room name.
      lastTlsSocket!.emit(
        'data',
        Buffer.from('{"Hello":{"username":"me","room":{"name":"Cinema"},"version":"1.6.9"}}\r\n')
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    // The wipe (#223): with no entry the client can key, `handleList` used to
    // fall through, seat the local user alone and emit — blanking every peer
    // and rendering "Room is empty" in a room that is not. Two foreign rooms,
    // so `pickOwnRoom`'s sole-entry fallback cannot rescue this one.
    it('keeps the seated roster when the List reply has no entry for our room', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      const emissions = roomUsers.length

      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              'someone-elses-room': { stranger: { isReady: true, file: {} } },
              'a-third-room': { passer_by: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        client
          .getRoomUsers()
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
      // Nothing to tell the view: the roster it already has is still correct.
      expect(roomUsers).toHaveLength(emissions)
    })

    // The obvious objection to returning before the roster is assigned: does
    // skipping cost us our own seat? It cannot — `finishHandshake` seats the
    // local user through `updateOwnReadinessInRoom()` before it asks for the
    // list, and the roster is only ever cleared on session teardown.
    it('leaves the local user seated when the very first List reply is unkeyable', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              'someone-elses-room': { stranger: { isReady: true, file: {} } },
              'a-third-room': { passer_by: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(client.getRoomUsers().map((u) => u.username)).toEqual(['me'])
    })

    // #257: `pickOwnRoom`'s sole-entry fallback used to adopt the entry's key
    // into `config.room` *and* `status.room` before `handleList`'s guard could
    // reject the entry — so a payload the guard correctly refuses still
    // rewrote the name every other path keys off. The roster survived the
    // `List` (the guard works), and then `handleSet`'s room filter (#230),
    // now comparing against `ghost-room`, read the next genuine in-room frame
    // as off-room and evicted the peer through rule 2. Under #221's 15 s poll
    // that is terminal: every later `List` keyed `cinema` misses the adopted
    // name too, lands back on the guard's `return`, and nothing repairs it.
    it('keeps the roster usable after a sole-entry List whose entry is not an object', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      expect(
        client
          .getRoomUsers()
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])

      lastTlsSocket!.emit(
        'data',
        Buffer.from(JSON.stringify({ List: { 'ghost-room': null } }) + '\r\n')
      )

      // The guard (#223/#255) already kept the roster here…
      expect(
        client
          .getRoomUsers()
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])

      // …but the name it keeps has to still be ours, or the next genuine
      // in-room broadcast reads as a switch-out and evicts the peer.
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            Set: {
              user: {
                mikkerlo: { room: { name: 'cinema' }, file: { name: 'COTE - 7', duration: 1440 } }
              }
            }
          }) + '\r\n'
        )
      )

      expect(
        client
          .getRoomUsers()
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    // The same bug seen through the third copy of the name: `status.room` is
    // what WatchTogetherView renders, so the adoption also relabelled the room
    // in the UI after a payload we then refused to read.
    it('never renames the room from an entry it cannot read', () => {
      const statuses: Array<{ room?: string }> = []
      client.on('connection-status', (s) => statuses.push(s as { room?: string }))
      handshake()

      lastTlsSocket!.emit(
        'data',
        Buffer.from(JSON.stringify({ List: { 'ghost-room': null } }) + '\r\n')
      )

      expect(statuses.map((s) => s.room)).not.toContain('ghost-room')
      expect(statuses.filter((s) => s.room !== undefined).at(-1)!.room).toBe('cinema')
    })

    // The gate defers the adoption, it does not abandon it: a later payload
    // whose sole entry *is* usable still renames us, so a server that
    // canonicalized our room out from under us is not locked out by one
    // unreadable reply.
    it('still adopts the fallback name once a usable sole entry arrives', () => {
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'cinema',
        username: 'me',
        autoReconnect: false
      })
      lastSocket!.emit('connect')
      lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      lastTlsSocket!.emit('secureConnect')
      // No `room` key in Hello, so only `pickOwnRoom` can learn the real name.
      lastTlsSocket!.emit('data', Buffer.from('{"Hello":{"username":"me","version":"1.6.9"}}\r\n'))

      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { Cinema: null } }) + '\r\n'))
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
      // …and the adopted name is live: an in-room `Set` from it is accepted.
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            Set: { user: { mikkerlo: { room: { name: 'Cinema' }, file: { name: 'COTE - 7' } } } }
          }) + '\r\n'
        )
      )
      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    // Shape 3 of the same bug, and the one that needs no `Set` frame at all:
    // once `config.room` holds `ghost-room`, a later `List` that still carries
    // that key as an *object* resolves through `hasOwnProperty` and seats that
    // room's members as ours — stranger-seating, the failure #230/#242 exist
    // to prevent, and worse than either freeze.
    it('never seats a foreign room roster after an unusable sole-entry List', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(JSON.stringify({ List: { 'ghost-room': null } }) + '\r\n')
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { mikkerlo: { isReady: true, file: {} } },
              'ghost-room': { stranger: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        client
          .getRoomUsers()
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    // `extractAppMeta` is fed `data.file`, never `data`, so a `features` block
    // sitting at the *entry* level is not file metadata. Well-formed on
    // purpose: a placeholder would assert `undefined` even after a refactor
    // that passed `data`, which is exactly the regression this pins.
    it('does not mistake a top-level features block for file metadata', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: {
                mikkerlo: {
                  isReady: true,
                  file: { name: 'Ore dake Level Up na Ken Season 2 - 2', duration: 1440 },
                  features: {
                    animeDlAppMeta: { animeId: 42, malId: 7, episodeInt: '2', translationId: 601 }
                  }
                }
              }
            }
          }) + '\r\n'
        )
      )

      const peer = roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!
      expect(peer.file?.name).toBe('Ore dake Level Up na Ken Season 2 - 2')
      expect(peer.animeDlAppMeta).toBeUndefined()
    })

    // The server pads empty rooms with space-named placeholder watchers. They
    // only ever sit under rooms that are not ours, so the room filter is what
    // keeps them out — but our own room has to be in the payload, or the
    // sole-entry fallback would adopt the foreign one and surface the blank.
    it('never surfaces the server’s blank placeholder rows', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { mikkerlo: { isReady: true, file: {} } },
              'someone-elses-room': { ' ': { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      const latest = roomUsers.at(-1)!
      expect(latest.map((u) => u.username).sort()).toEqual(['me', 'mikkerlo'])
      expect(latest.some((u) => u.username.trim() === '')).toBe(false)
    })

    // A roster replacement must never let a server value that predates our
    // last `set-ready` clobber local readiness — the renderer's ready gate
    // reads its own row back out of this list.
    it('keeps local readiness when the List reply has not caught up to it', () => {
      handshake()
      client.setReady(false)
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: {
                me: { isReady: true, file: {} },
                mikkerlo: { isReady: true, file: {} }
              }
            }
          }) + '\r\n'
        )
      )

      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.isReady).toBe(false)
      expect(client.getRoomUsers().find((u) => u.username === 'me')!.isReady).toBe(false)
    })
  })

  describe('a joiner without a player never moves the room', () => {
    // The bug: snapshot defaults to {position: 0, paused: true} and the 1 s
    // heartbeat asserted it, so joining pulled everyone back to 0 and paused.
    it('sends no playstate at all before the server has reported one', () => {
      handshake()
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(3000)

      const states = statesOf(lastTlsSocket)
      expect(states.length).toBeGreaterThan(0)
      for (const s of states) expect(s.playstate).toBeUndefined()
    })

    it('mirrors the room position instead of asserting 0', () => {
      handshake()
      serverState(742.5, true)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      // Position mirrored; no `paused` field at all — a spectator must never be
      // able to flip the room's pause state.
      expect(state.playstate).toEqual({ position: 742.5, doSeek: false })
    })

    it('advances the mirrored position while the room is playing, so we never read as lagging', () => {
      handshake()
      serverState(100, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(3000)

      const states = statesOf(lastTlsSocket)
      expect(states.at(-1)!.playstate!.position).toBeCloseTo(103, 1)
      expect(states.at(-1)!.playstate!.paused).toBeUndefined()
    })

    // The race: a peer pauses, the room flips server-side, and our next
    // heartbeat is still carrying `paused: false` from the stale lastRoomState
    // — its arrival unpauses the room, setBy us. The server reads a *missing*
    // paused as "no claim", so a mirror that omits it cannot flip anything.
    // Distinct from the case below by actually crossing that boundary.
    it('carries no pause claim across a peer’s pause landing mid-stream', () => {
      handshake()
      serverState(100, false, 'mikkerlo')
      lastTlsSocket!.write.mockClear()
      vi.advanceTimersByTime(2000)
      const beforeCount = statesOf(lastTlsSocket).length

      // The peer's pause reaches us only now; heartbeats straddle it.
      serverState(100, true, 'mikkerlo')
      vi.advanceTimersByTime(2000)

      const states = statesOf(lastTlsSocket)
      expect(beforeCount).toBeGreaterThan(0)
      expect(states.length).toBeGreaterThan(beforeCount)
      for (const s of states) {
        expect(s.playstate).toBeDefined()
        expect('paused' in s.playstate!).toBe(false)
      }
    })

    it('never claims paused while the room is playing', () => {
      handshake()
      serverState(50, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(5000)

      // Stronger than "never claims paused": a mirror makes no pause claim at
      // all, so it cannot race the room's own in-flight pause broadcast.
      for (const s of statesOf(lastTlsSocket)) expect(s.playstate!.paused).toBeUndefined()
    })
  })

  describe('a freshly opened player converges before it asserts', () => {
    // "Join & watch" mounts a <video> that reports {0, paused} for a beat
    // before the first remote State seeks it, and the renderer pushes that
    // snapshot on its 1 s timer — the same room-resetting assertion as the
    // no-player case, just arriving through a live player.
    it('does not assert a fresh player position 0 while the room plays on', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.paused).toBeUndefined()
      expect(state.playstate!.position).toBeGreaterThan(742)
    })

    it('asserts its own state once the player has caught up to the room', () => {
      handshake()
      serverState(742.5, true)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      // The renderer's apply rule seeked us to the room position.
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 742.5, paused: false, doSeek: false })
    })

    // Latches: once converged, ordinary drift must not demote a live player
    // back to mirroring (that would silently stop propagating its position).
    it('keeps asserting after convergence even when drift exceeds the tolerance', () => {
      handshake()
      serverState(100, true)
      client.updateSnapshot({ position: 100, paused: true })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.updateSnapshot({ position: 400, paused: true })
      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate!.position).toBe(400)
    })

    // With peers listed we know we are not the first user, so an empty
    // lastRoomState means we are early (our heartbeat can beat the server's
    // first State), not alone — asserting the fresh {0, paused} there is the
    // same yank the gate exists to prevent.
    it('holds off when peers are present but no room state has arrived yet', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate).toBeUndefined()
    })

    // The other half of the same fact (#236). `tearDown()` empties roomUsers,
    // `finishHandshake()` only *requests* the roster, and
    // updateOwnReadinessInRoom() has already seated *us* — so before the reply
    // lands the peer filter reads zero and "we are alone" was indistinguishable
    // from "we have not been told". An element event landing in that window
    // latched adoption and asserted the fresh {0, paused} at a room full of
    // people.
    it('withholds every playstate until the roster reply arrives', () => {
      handshake()
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 0, paused: false, cause: 'play' })
      vi.advanceTimersByTime(1000)

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate).toBeUndefined()
    })

    // The reversed yank (#236 item 1b). On a reference server the first `State`
    // beats our first heartbeat by ~900 ms regardless of RTT, so nesting the
    // roster-alone test under "no room state" made it unreachable: a user alone
    // at 600 s fell through to a drift of 600, never adopted, and mirrored the
    // room forever — pinning the room near 0 through Room.getPosition()'s min()
    // until the next joiner adopted at 0 and dragged them back.
    it('adopts an alone roster even after the server has sent its first State', () => {
      handshake()
      listReply()
      serverState(0, true)
      client.updateSnapshot({ position: 600, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 600,
        paused: false,
        doSeek: false
      })
    })

    // The flag means "the server told us who is in *our* room", not "a `List`
    // frame arrived". #223 already keeps the roster on an unkeyable payload, so
    // this stays green either way today — it is written to pin the *placement*,
    // inside the keying guard, because as a positive adoption signal set beside
    // `this.roomUsers = users` it would assert our position over a populated
    // room. Two foreign rooms, so pickOwnRoom()'s sole-entry fallback cannot
    // rescue the payload.
    it('does not treat a List with no entry for our room as an adoption signal', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { lobby: { alice: { file: {} } }, foyer: {} } }) + '\r\n'
        )
      )
      client.updateSnapshot({ position: 600, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate).toBeUndefined()
    })

    // `rosterReceived` is per socket, not per session. `roomUsers` deliberately
    // survives a reconnect (it is the member list), but the roster it keeps
    // predates the outage, so a peer who joined while we were down is not in it
    // — and between finishHandshake()'s `{List: null}` and the reply, "roster
    // known and no peers" would be true against a roster that cannot see them.
    it('does not adopt against the pre-outage roster after a reconnect', () => {
      handshake('cinema', true)
      listReply()

      lastTlsSocket!.emit('close')
      vi.advanceTimersByTime(1000)
      driveHandshake()
      lastTlsSocket!.write.mockClear()

      // Before the fresh roster lands: an element event must still be withheld.
      client.sendLocalState({ position: 0, paused: false, cause: 'seek' })
      expect(statesOf(lastTlsSocket).filter((s) => s.playstate)).toHaveLength(0)

      // …and the moment it does, we speak for ourselves again.
      listReply()
      client.sendLocalState({ position: 42, paused: false, cause: 'seek' })
      expect(statesOf(lastTlsSocket).at(-1)!.playstate).toEqual({
        position: 42,
        paused: false,
        doSeek: true
      })
    })

    // Reopening the *same* episode gets a fresh <video> at 0 with an identical
    // canonicalName, so setFile()'s identity check can't see the transition.
    it('re-converges when a new player reopens the same episode', () => {
      handshake()
      serverState(600, false)
      const file = {
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      }
      client.setFile(file)
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)

      // Player closed: pushes stop long enough to go stale, then the same
      // episode is reopened and its fresh element reports 0.
      vi.advanceTimersByTime(PLAYBACK_STALE_MS + 1000)
      client.setFile(file)
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.position).toBeGreaterThan(600)
      expect(state.playstate!.paused).toBeUndefined()
    })

    // Main's readiness outlives the player; the renderer's is per-player and
    // only pushes on a change, so a player closed mid-buffer left main stuck
    // at false — pinning us as "Buffering" in every peer's roster.
    it('clears a stale buffering flag when a new player announces its file', () => {
      handshake()
      client.setReady(false)
      lastTlsSocket!.write.mockClear()

      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })

      expect(frames(lastTlsSocket)).toContainEqual({
        Set: { ready: { isReady: true, manuallyInitiated: false } }
      })
    })

    // …and the other direction (#236 item 3). The readiness reset used to sit
    // outside the identity check, so *every* re-push of the same file flipped
    // us back to ready. Re-pushes of an unchanged canonicalName are routine —
    // the duration-known push, an in-player translation switch (the canonical
    // name has no translation component), the transition-into-ready push on a
    // reconnect — and readiness is false on exactly those loads, so the frame
    // told peers we were buffered when we were not and released their gate.
    it('leaves readiness alone when a live player re-pushes the same file', () => {
      handshake()
      const file = {
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      }
      client.setFile({ ...file, newPlayer: true })
      client.updateSnapshot({ position: 120, paused: false })
      client.setReady(false)
      lastTlsSocket!.write.mockClear()
      roomUsers.length = 0

      // The same player, announcing real duration now that it is known.
      client.setFile({ ...file, duration: 1437 })

      for (const f of frames(lastTlsSocket)) expect(f).not.toHaveProperty('Set.ready')
      expect(client.getRoomUsers().find((u) => u.username === 'me')!.isReady).toBe(false)
    })

    // The adoption latch has the same blind spot the readiness reset had, from
    // the opposite side (#236 item 5). A player closed at 600 s and reopened on
    // the same episode *inside* PLAYBACK_STALE_MS arrives with the previous
    // player's latch intact: setFile()'s identity check sees a byte-identical
    // canonicalName and updateSnapshot()'s staleness gap has not opened yet, so
    // the fresh element's startup events assert {0, doSeek} at the room. The
    // easiest way to reach it is a translation switch made from the detail view
    // — close, pick another translation, reopen — since buildCanonicalName()
    // has no translation component.
    it('de-adopts on a same-episode reopen inside the stale window', () => {
      handshake()
      serverState(600, false)
      const file = {
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      }
      client.setFile(file)
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)

      // Reopened well inside PLAYBACK_STALE_MS, so the snapshot clock still
      // reads "live" and nothing but `newPlayer` can see the transition.
      client.setFile({ ...file, translationId: 777, newPlayer: true })
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.position).toBeGreaterThan(600)
      expect(state.playstate!.paused).toBeUndefined()
    })

    // The field is pinned in both directions, so a future refactor cannot
    // quietly restore the clock: the *same* window without `newPlayer` is a
    // re-push from a still-live player, and it must not de-adopt — that would
    // demote an active viewer to the mirror on every duration re-push.
    it('keeps the latch when a live player re-pushes inside the stale window', () => {
      handshake()
      serverState(0, true)
      const file = {
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      }
      client.setFile({ ...file, newPlayer: true })
      client.updateSnapshot({ position: 0, paused: true })
      vi.advanceTimersByTime(1000)

      // The user seeks well away from where the room sits, so drift can no
      // longer re-adopt us — only the surviving latch can keep us asserting.
      client.updateSnapshot({ position: 600, paused: false })
      client.setFile({ ...file, duration: 1437 })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 600,
        paused: false,
        doSeek: false
      })
    })

    // The echo target is armed only for a state that would actually move the
    // element (#236 item 2), under the same rule the renderer applies with.
    // Armed on every inbound state it sat pointing at the room's resting
    // position — refreshed once a second in a paused room — and swallowed any
    // genuine user seek landing within ECHO_SEEK_EPSILON_S of it. Here the
    // snapshot is pushed *first*, so 301 is one second from where we already
    // are: inside the renderer's 3 s tolerance, with no doSeek, it moves
    // nothing and therefore has no echo to suppress.
    it('does not arm the echo target for a remote state that moves nothing', () => {
      handshake()
      client.updateSnapshot({ position: 300, paused: false })
      serverState(301, false, 'mikkerlo')
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 301, paused: false, cause: 'seek' })

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 301,
        paused: false,
        doSeek: true
      })
    })

    // One applied seek yields one `seeked`, so the echo target must retire —
    // otherwise a later genuine seek onto a peer's old position is dropped.
    //
    // Still armed under #236's narrowed condition, but *incidentally*: the
    // serverState below runs before the updateSnapshot, so main's snapshot is
    // still the initial 0 when the arming condition is evaluated and the diff
    // clears ADOPT_TOLERANCE_S. Tidying the two lines into snapshot-first would
    // silently disarm this case and leave it green for the wrong reason.
    it('retires the echo target so a later seek to the same spot still sends', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })
      lastTlsSocket!.write.mockClear()

      // Much later the user deliberately seeks back to the same spot.
      client.sendLocalState({ position: 309.229, paused: false, cause: 'seek' })

      expect(statesOf(lastTlsSocket)[0].playstate!.doSeek).toBe(true)
    })

    // The "first user sets it" behaviour survives #236, but its evidence moved:
    // it is the *roster* that says we are alone, not the absence of a `State`.
    // Before, an unanswered `{List: null}` read identically to an empty room, so
    // this asserted inside the handshake window against a roster that had not
    // arrived — the latch the withheld-roster case above now pins shut.
    it('asserts immediately once the roster says we are alone — the first user sets it', () => {
      handshake()
      listReply()
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 12.5,
        paused: false,
        doSeek: false
      })
    })

    // The failure the unit tests missed and a live session found: opening the
    // player on "Join & watch" reset the host to 0. A fresh <video> fires
    // play/pause/seeked at ~0 *before* any remote state has been applied, so
    // the renderer's suppression window isn't up and those events reach main
    // (use-syncplay-client.ts onLocalPlay/onLocalPause/onVideoSeeked).
    it('sends nothing when a fresh player fires its startup events at 0', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      lastTlsSocket!.write.mockClear()

      // Exactly what the renderer emits while the element loads.
      client.sendLocalState({ position: 0, paused: false, cause: 'play' })
      client.sendLocalState({ position: 0, paused: true, cause: 'pause' })
      client.sendLocalState({ position: 0, paused: false, cause: 'seek' })

      for (const s of statesOf(lastTlsSocket)) {
        expect(s.playstate?.position ?? Infinity).toBeGreaterThan(700)
      }
    })

    // Each pre-adoption local state used to bump clientIgnoreCounter, and
    // handleState drops every inbound remote state while that ack is pending —
    // so the player never got seeked to the room and the session desynced.
    it('keeps applying remote states while a fresh player is still converging', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      const remote: Array<{ position: number }> = []
      client.on('remote-state', (s) => remote.push(s as { position: number }))

      client.sendLocalState({ position: 0, paused: false, cause: 'play' })
      client.sendLocalState({ position: 0, paused: true, cause: 'pause' })
      serverState(800, false, 'mikkerlo')

      expect(remote.map((r) => Math.round(r.position))).toContain(800)
    })

    // The readiness gate pauses the local element while we buffer; buffering
    // has its own channel (`Set: {ready}`) precisely so a slow client doesn't
    // ping-pong pause/play at the room. Caught live: a joiner whose stream
    // stalled paused everyone, over and over.
    // A user pause has to survive buffering. An earlier attempt withheld every
    // assertion while !ownIsReady, so the next heartbeat mirrored the room's
    // "playing" straight back and undid the pause a second after it was
    // pressed — reported live as "I paused and it didn't pause".
    it('keeps asserting a user pause while we are buffering', () => {
      handshake()
      serverState(742.5, false)
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)

      client.setReady(false)
      client.sendLocalState({ position: 742.5, paused: true, cause: 'pause' })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(2000)

      const states = statesOf(lastTlsSocket)
      expect(states.length).toBeGreaterThan(0)
      for (const s of states) expect(s.playstate!.paused).toBe(true)
    })

    // Caught in a live session: applying a peer's seek makes our element fire
    // `seeked` once it finishes — often past the renderer's 1500 ms window on a
    // network stream — and we handed the peer their own position back with
    // doSeek, dragging the room to a stale point and bumping the ignore
    // counter so inbound states got dropped. "Sync breaks after a few seeks".
    it('does not echo a seek that merely lands on the room position', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate?.doSeek).not.toBe(true)
    })

    it('keeps applying remote states after an echoed seek (no ignore-counter stall)', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      const remote: Array<{ position: number }> = []
      client.on('remote-state', (s) => remote.push(s as { position: number }))

      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })
      serverState(400, false, 'mikkerlo')

      expect(remote.map((r) => Math.round(r.position))).toContain(400)
    })

    it('still propagates a real user seek away from the room', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 90, paused: false, cause: 'seek' })

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 90,
        paused: false,
        doSeek: true
      })
    })

    it('propagates an explicit local pause once converged', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      // The apply rule has seeked us onto the room, so we speak for ourselves.
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 742.5, paused: true, cause: 'pause' })

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 742.5,
        paused: true,
        doSeek: false
      })
    })

    it('re-converges on the next episode instead of asserting its 0', () => {
      handshake()
      serverState(10, false)
      client.updateSnapshot({ position: 10, paused: false })
      vi.advanceTimersByTime(1000)

      // Peer advances; we follow onto a fresh element that starts at 0.
      serverState(30, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '3',
        translationId: 601,
        canonicalName: 'Show - 3',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.position).toBeGreaterThan(30)
      expect(state.playstate!.paused).toBeUndefined()
    })
  })

  describe('a joiner with a player asserts its own state', () => {
    it('asserts the local snapshot once the renderer starts pushing', () => {
      handshake()
      // Converged with the room (see the adoption rule below), so this player
      // speaks for itself rather than mirroring.
      serverState(12, true)
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 12.5, paused: false, doSeek: false })
    })

    it('still propagates a local seek', () => {
      handshake()
      // Adoption is what lets a local state reach the wire, and since #236 the
      // roster is what grants it here — the subject of this case is the seek,
      // not the pre-roster latch it used to ride in on.
      listReply()
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 300, paused: false, cause: 'seek' })

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 300, paused: false, doSeek: true })
    })

    // Closing the player stops the snapshot pushes but leaves the connection
    // up; the stale snapshot must not keep asserting a frozen position.
    it('reverts to mirroring when the player stops pushing snapshots', () => {
      handshake()
      serverState(600, false)
      // Converge first: at a drift of ~590 the client mirrors because it never
      // adopted, so this would pass with the staleness rule deleted. The frozen
      // snapshot has to be one it would otherwise be asserting.
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)
      client.updateSnapshot({ position: 601, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(10_000)

      const last = statesOf(lastTlsSocket).at(-1)!
      expect(last.playstate!.paused).toBeUndefined()
      expect(last.playstate!.position).toBeGreaterThan(600)
    })
  })

  // Every roster test above drives membership through `List`. `handleSet` is
  // the other half — the only path that carries live membership changes — and
  // no test fed it a raw frame, so its branches were reachable only in
  // production.
  describe('handleSet seats membership from live Set broadcasts', () => {
    const serverSet = (user: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { user } }) + '\r\n'))
    }

    const readySet = (ready: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { ready } }) + '\r\n'))
    }

    it('seats a peer on a joined event and drops it on left', () => {
      handshake()

      serverSet({ peer: { event: { joined: true } } })
      expect(roomUsers.at(-1)!.map((u) => u.username)).toContain('peer')

      serverSet({ peer: { event: { left: true } } })
      expect(roomUsers.at(-1)!.map((u) => u.username)).not.toContain('peer')
    })

    it('does not seat the same peer twice on a repeated join', () => {
      handshake()

      serverSet({ peer: { event: { joined: true } } })
      const afterFirst = roomUsers.at(-1)!.filter((u) => u.username === 'peer').length
      serverSet({ peer: { event: { joined: true } } })

      expect(afterFirst).toBe(1)
      expect(roomUsers.at(-1)!.filter((u) => u.username === 'peer')).toHaveLength(1)
    })

    it('absorbs a peer file pushed without any event key', () => {
      handshake()

      serverSet({
        peer: {
          file: {
            name: 'COTE - 7',
            duration: 1440,
            features: { animeDlAppMeta: { animeId: 42, episodeInt: '7', translationId: 1 } }
          }
        }
      })

      const peer = roomUsers.at(-1)!.find((u) => u.username === 'peer')
      expect(peer?.file?.name).toBe('COTE - 7')
    })

    // Replaces #241's `records peer readiness from both the object and boolean
    // shapes`, deleted with the `user[X].isReady` branch it characterized
    // (#229). This is the shape the reference server actually sends on the
    // `user` path — `sendUserSetting` writes `room`/`file`/`event` and nothing
    // else — so readiness must come from the top-level `Set: {ready}` alone.
    it('leaves readiness untouched on the real sendUserSetting shape', () => {
      handshake()

      readySet({ username: 'peer', isReady: false, manuallyInitiated: true })
      serverSet({ peer: { event: { joined: true } } })
      readySet({ username: 'peer', isReady: false, manuallyInitiated: true })
      expect(roomUsers.at(-1)!.find((u) => u.username === 'peer')?.isReady).toBe(false)

      serverSet({
        peer: {
          room: { name: 'cinema' },
          file: { name: 'COTE - 7', duration: 1440 },
          event: { joined: true }
        }
      })

      expect(roomUsers.at(-1)!.find((u) => u.username === 'peer')?.isReady).toBe(false)
    })

    it('ignores a malformed per-user payload without disturbing the roster', () => {
      handshake()
      serverSet({ peer: { event: { joined: true } } })
      const before = roomUsers.length

      serverSet({ peer: 'not-an-object' })

      expect(roomUsers).toHaveLength(before)
      expect(roomUsers.at(-1)!.map((u) => u.username)).toContain('peer')
    })

    // A top-level `Set: {room}` is a client→server command — the reference
    // server consumes it and no server-side `sendSet` emits it. Since the room
    // filter (#230) keys off `this.config.room`, honouring an unsolicited one
    // would rewrite the filter's reference name mid-session and re-expose
    // every stranger, so the branch is gone: the roster stays keyed to the
    // name `handleHello` seated us under.
    it('ignores a top-level Set:{room}, so the filter’s reference name cannot be rewritten', () => {
      handshake('cinema')

      lastTlsSocket!.emit(
        'data',
        Buffer.from(JSON.stringify({ Set: { room: { name: 'Cinema' } } }) + '\r\n')
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } },
              Cinema: { stranger: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'peer'])

      // …and the per-user filter still reads "cinema" as ours, so the renamed
      // room's occupant stays out of the roster.
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            Set: { user: { stranger: { room: { name: 'Cinema' }, file: { name: 'X - 1' } } } }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'peer'])
    })
  })

  // With `isolateRooms` off — the reference server's default — `RoomManager.
  // broadcast` fans `Set: {user}` out to *every* room on the server, and
  // `handleSet` never read `data.room.name`. Strangers were seated, their
  // episode changes logged, and their file frames could navigate our player.
  // The filter has to be ordered rather than flat: a peer switching *out* of
  // our room arrives as a lone entry naming their **destination**
  // (`sendRoomSwitchMessage` broadcasts after `moveWatcher` has already
  // reassigned the room), so "ignore off-room entries" would discard the only
  // frame that tells us they left.
  describe('handleSet scopes Set:{user} to our own room (#230)', () => {
    let roomEvents: string[]
    let episodeChanges: unknown[]

    const serverSet = (user: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { user } }) + '\r\n'))
    }

    const fileFrame = (name: string, withMeta = false): Record<string, unknown> => ({
      name,
      duration: 1440,
      ...(withMeta
        ? { features: { animeDlAppMeta: { animeId: 42, malId: 7, episodeInt: '7' } } }
        : {})
    })

    const usernames = (): string[] => (roomUsers.at(-1) ?? []).map((u) => u.username).sort()

    beforeEach(() => {
      roomEvents = []
      episodeChanges = []
      client.on('room-event', (e) => roomEvents.push((e as { text: string }).text))
      client.on('remote-episode-change', (e) => episodeChanges.push(e))
    })

    // Written first, and it is not a regression guard: it passes on `main`
    // (where no room name is read at all) and fails only on a correct-looking
    // filter that keeps `pickOwnRoom`'s stale name. That hole is the one way
    // this change can make a working server worse — the roster would fill from
    // `List` and then empty itself peer by peer as each pushes a file.
    it('adopts the fallback room name, so later Set frames from that room are not filtered', () => {
      const statuses: Array<{ room?: string }> = []
      client.on('connection-status', (s) => statuses.push(s as { room?: string }))
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'cinema',
        username: 'me',
        autoReconnect: false
      })
      lastSocket!.emit('connect')
      lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      lastTlsSocket!.emit('secureConnect')
      // No `room` key in Hello, so `handleHello` cannot adopt a canonical name.
      lastTlsSocket!.emit('data', Buffer.from('{"Hello":{"username":"me","version":"1.6.9"}}\r\n'))
      // Single room, keyed under a name we never learned → pickOwnRoom's
      // fallback arm resolves the roster but must also adopt "Cinema".
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      expect(usernames()).toEqual(['me', 'mikkerlo'])

      serverSet({ mikkerlo: { room: { name: 'Cinema' }, file: fileFrame('COTE - 7') } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file?.name).toBe('COTE - 7')

      // The name the view renders is a third copy: `finishHandshake` emitted
      // "cinema" before the `List` arrived, and every later status that carries
      // a room reads it back off the config — so the adoption has to push it
      // through, or the displayed room flips on the next reconnect.
      expect(statuses.at(-1)!.room).toBe('Cinema')
    })

    // Case 1: the frame that separates an ordered filter from a flat one. It
    // names the peer's *new* room and carries no `left` event, because plain
    // `RoomManager.moveWatcher` emits none.
    it('drops a seated peer named by an off-room entry — that is the switch-out frame', () => {
      handshake()
      serverSet({ mikkerlo: { event: { joined: true } } })
      roomEvents.length = 0

      serverSet({ mikkerlo: { room: { name: 'elsewhere' } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual(['mikkerlo left the room'])
    })

    // Case 10: `sendFileUpdate` also emits `{room, file}` with no `event`, on
    // the hot path, so "no event means switch-in, announce a join" would put a
    // spurious join line in front of every switched-to line.
    it('seats an unseated in-room peer from a file frame without announcing a join', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' }, file: fileFrame('COTE - 7') } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomEvents).toEqual(['mikkerlo switched to "COTE - 7"'])
    })

    it('seats a peer switching into our room from a room-only frame', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' } } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomEvents).toEqual(['mikkerlo joined the room'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file).toBeNull()
    })

    it('ignores a stranger’s file frame entirely — no seat, no log line, no auto-nav', () => {
      handshake()

      serverSet({
        stranger: { room: { name: 'elsewhere' }, file: fileFrame('Some Other Show - 1', true) }
      })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    it('ignores join and leave events from another room', () => {
      handshake()
      const emitsBefore = roomUsers.length

      serverSet({ stranger: { room: { name: 'elsewhere' }, event: { joined: true } } })
      serverSet({ stranger: { room: { name: 'elsewhere' }, event: { left: true } } })

      expect(roomUsers).toHaveLength(emitsBefore)
      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])
    })

    // Rule 0: self is exempt from the room filter. A flat rule 2 would delete
    // us from our own roster, and we would only reappear on the next readiness
    // toggle or reconnect.
    it('never evicts us on a self entry naming another room, and keeps our room name', () => {
      handshake()

      serverSet({ me: { room: { name: 'elsewhere' } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])

      // The filter still keys off "cinema", so an in-room peer is accepted.
      serverSet({ mikkerlo: { room: { name: 'cinema' } } })
      expect(usernames()).toEqual(['me', 'mikkerlo'])
    })

    // Rule 0 is "exempt from the room filter", not "skip the entry".
    // `sendFileUpdate` broadcasts without excluding the sender, so our own push
    // comes back to us and `absorbRemoteFile` is what keeps our roster row's
    // file current between `List` replies.
    it('still absorbs our own echoed file, silently', () => {
      handshake()

      serverSet({ me: { room: { name: 'cinema' }, file: fileFrame('COTE - 7', true) } })

      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.file?.name).toBe('COTE - 7')
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    // …and the branch where the exemption actually earns its keep: the case
    // above names our own room, so it takes the ordinary in-room path and would
    // pass with rule 0 deleted. Only an off-room *self* entry reaches rule 2's
    // `continue`, which would drop our own file instead of absorbing it.
    // Unreachable against a reference server — belt and braces for rule 0.
    it('absorbs our own echoed file even when the entry names another room', () => {
      handshake()

      serverSet({ me: { room: { name: 'elsewhere' }, file: fileFrame('COTE - 7', true) } })

      expect(usernames()).toEqual(['me'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.file?.name).toBe('COTE - 7')
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    // Rule 1 used to exclude `isReady` so it would not announce a join in front
    // of the per-user readiness branch that seated the user itself. #229
    // deleted that branch — `sendUserSetting` never writes `isReady`, so the
    // key is not something a server puts on the `user` path at all — and with
    // it the exclusion. A `{room, isReady}` entry is therefore a room-only
    // frame now: seated and announced like any other switch-in, with the stray
    // `isReady` ignored rather than read into the roster.
    it('treats a {room, isReady} entry as a plain switch-in, ignoring the stray key', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' }, isReady: false } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBeUndefined()
      expect(roomEvents).toEqual(['mikkerlo joined the room'])
    })

    // Pins the invariant that makes `handleSet` safe to write against a
    // non-null `config`: the two sites that null it (`failHandshake`,
    // `disconnectInternal(true)`) both go through `tearDown` →
    // `resetTransportState`, which sets `rxBuffer = ''` — so the rest of the
    // chunk is discarded mid-drain rather than dispatched without a config.
    // (`tearDown` also strips the socket's listeners, and `upgradeToTls`
    // reassigns `this.socket` to the TLS socket, so no *later* chunk arrives
    // either.) Without this the filter's own-room comparison would need a
    // fail-closed reading of `undefined` to mean anything.
    it('discards the rest of the chunk once an escalating Error tears the session down', () => {
      handshake()
      const emitsBefore = roomUsers.length

      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ Error: { message: 'You are banned from this server' } }) +
            '\r\n' +
            JSON.stringify({
              Set: { user: { stranger: { room: { name: 'elsewhere' } } } }
            }) +
            '\r\n'
        )
      )

      // `tearDown` already emptied the roster without broadcasting, so the
      // proof is that the stranger produced neither a fresh `room-users` emit
      // nor a join line.
      expect(roomUsers).toHaveLength(emitsBefore)
      expect(roomEvents).toEqual(['You are banned from this server'])
    })

    // Characterization, not a regression guard: `sendUserSetting` always writes
    // `room`, so a roomless entry only arrives from a proxy or a non-reference
    // server. Treating it as ours preserves today's behavior exactly.
    it('treats an entry with no room key as ours', () => {
      handshake()

      serverSet({ mikkerlo: { file: fileFrame('COTE - 7') } })

      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file?.name).toBe('COTE - 7')
    })

    // `PublicRoomManager.moveWatcher` (isolateRooms=True) does broadcast a
    // `left`, but with the **old** room and room-scoped — so it names our own
    // room and takes today's exact path.
    it('keeps the isolateRooms leave frame working, since it names our own room', () => {
      handshake()
      serverSet({ mikkerlo: { event: { joined: true } } })
      roomEvents.length = 0

      serverSet({ mikkerlo: { room: { name: 'cinema' }, event: { left: true } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual(['mikkerlo left the room'])
    })

    // …and on that server the switch-in's file frame arrives *before* the
    // switch frame (`moveWatcher` ends with `setFile`, inside `setWatcherRoom`,
    // ahead of `sendRoomSwitchMessage`). So the peer is seated silently by the
    // file frame and the room-only frame that follows must do nothing at all.
    it('seats an isolated switch-in once, and the trailing room-only frame is a no-op', () => {
      handshake()
      serverSet({ mikkerlo: { room: { name: 'cinema' }, file: fileFrame('COTE - 7') } })
      const emitsAfterFile = roomUsers.length

      serverSet({ mikkerlo: { room: { name: 'cinema' } } })

      expect(roomUsers.at(-1)!.filter((u) => u.username === 'mikkerlo')).toHaveLength(1)
      expect(roomEvents).toEqual(['mikkerlo switched to "COTE - 7"'])
      expect(roomUsers).toHaveLength(emitsAfterFile)
    })
  })

  // Live readiness travels as a *top-level* `Set: {ready}` (#229) — the
  // reference `sendSetReady` — broadcast on join, on room switch and on every
  // toggle. Before this the roster's `isReady` was a join-time snapshot from
  // the `List` reply and never moved again, so both roster dots were frozen
  // and `applySyncplayReadyGate()` could never see a peer start or stop
  // buffering.
  describe('handleSet parses the live readiness broadcast (#229)', () => {
    let roomEvents: string[]

    const serverSet = (user: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { user } }) + '\r\n'))
    }

    const readySet = (ready: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { ready } }) + '\r\n'))
    }

    // Every outbound `Set: {ready}`. The handshake always contributes one
    // (`finishHandshake` asserts `ownIsReady` unconditionally), so the
    // wire-silence assertions below are written against a baseline rather than
    // against zero.
    const readyWrites = (): Array<Record<string, unknown>> =>
      frames(lastTlsSocket)
        .filter((f) => 'Set' in f && 'ready' in (f.Set as Record<string, unknown>))
        .map((f) => (f.Set as { ready: Record<string, unknown> }).ready)

    const seatPeer = (username: string): void => {
      serverSet({ [username]: { event: { joined: true } } })
    }

    beforeEach(() => {
      roomEvents = []
      client.on('room-event', (e) => roomEvents.push((e as { text: string }).text))
    })

    // Test 1, and the reason it is written first: it passes trivially against
    // the old `handleSet` (which parsed nothing) and is exactly the case a
    // naive `payload.ready.isReady === true` port breaks. A watcher that has
    // never toggled carries `_ready = None`, so this is the literal join
    // broadcast — coerced to `false` it would give the peer a permanent amber
    // dot and hold the local gate shut for the whole session.
    it('maps a null isReady to undefined, not false, so the join broadcast cannot pin the gate', () => {
      handshake()
      seatPeer('mikkerlo')

      readySet({ username: 'mikkerlo', isReady: null, manuallyInitiated: false })

      const peer = roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!
      expect(peer.isReady).toBeUndefined()
      expect(peer.isReady).not.toBe(false)
    })

    // Test 2. The dot has to move in both directions, and the *emit* is what
    // the renderer's `watch(syncplayRoomUsers)` → `applySyncplayReadyGate()`
    // chain hangs off — so assert the emitted array, not internal state. The
    // one-emit-per-frame count is scoped to this `ready`-only frame: it is not
    // a global per-`Set` invariant, because `absorbRemoteFile` emits outside
    // the `usersDirty` accounting.
    it('flips a seated peer’s dot both ways, one room-users emit per frame', () => {
      handshake()
      seatPeer('mikkerlo')
      const baseline = roomUsers.length

      readySet({ username: 'mikkerlo', isReady: false, manuallyInitiated: false })
      expect(roomUsers).toHaveLength(baseline + 1)
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBe(false)

      readySet({ username: 'mikkerlo', isReady: true, manuallyInitiated: false })
      expect(roomUsers).toHaveLength(baseline + 2)
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBe(true)

      // A repeat of the value already held changes nothing and emits nothing.
      readySet({ username: 'mikkerlo', isReady: true, manuallyInitiated: false })
      expect(roomUsers).toHaveLength(baseline + 2)
    })

    // Test 3. Membership gets one owner: the frame carries no room key at all,
    // so seating from it is a write the #230 room filter structurally cannot
    // gate, and an invented row can carry `isReady:false` and pause us for a
    // member we have no membership evidence for. Nothing is lost — the second
    // half is the case the insert used to exist for, now served by #230's
    // rule 1 from the bare `{user:{X:{room}}}` frame the server broadcasts one
    // line earlier.
    it('seats nobody for an unknown username, and #230’s rule 1 covers the switch-in', () => {
      handshake()
      const baseline = roomUsers.length

      readySet({ username: 'ghost', isReady: false, manuallyInitiated: false })

      expect(roomUsers).toHaveLength(baseline)
      expect((roomUsers.at(-1) ?? []).map((u) => u.username)).not.toContain('ghost')

      // Now in the server's own order: the switch-in frame, then readiness.
      serverSet({ latecomer: { room: { name: 'cinema' } } })
      readySet({ username: 'latecomer', isReady: false, manuallyInitiated: false })

      expect(roomUsers.at(-1)!.filter((u) => u.username === 'latecomer')).toHaveLength(1)
      expect(roomUsers.at(-1)!.find((u) => u.username === 'latecomer')!.isReady).toBe(false)
    })

    // Test 4. `broadcastRoom` has no sender filter, so our own `sendSetReady`
    // echoes straight back with our username stamped on it. That echo compares
    // equal and must do nothing at all — no wire write, no roster write.
    // (The case-only spelling is pinned in the override test below, not here:
    // on the *equal* path an exact compare and a case-insensitive one are
    // indistinguishable, since the peer branch finds nobody seated under the
    // other spelling and also does nothing.)
    it('is silent on its own echo, and a later List reverts nothing', () => {
      handshake()
      const writes = readyWrites().length
      const emits = roomUsers.length

      readySet({ username: 'me', isReady: true, manuallyInitiated: false })
      readySet({ username: 'ME', isReady: true, manuallyInitiated: false })

      expect(readyWrites()).toHaveLength(writes)
      expect(roomUsers).toHaveLength(emits)

      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { me: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.isReady).toBe(true)
    })

    // Test 5. The `setOthersReadiness` shape: any peer can force our readiness
    // in an ordinary room, and the server *stores* the forced value. Skipping
    // the frame would leave the server serving `false` for us until a buffer
    // flap or a reconnect — our only client-side writer is edge-triggered on a
    // local change — holding every peer's ready gate down. So: exactly one
    // re-assert carrying *our* value and no `username` field (which is what
    // makes the server take its plain `else` arm and rebroadcast our value),
    // `ownIsReady` and the roster self row untouched, and the resulting echo
    // silent. Adopting the peer's value instead is the dead end this pins
    // against.
    it('re-asserts our own value once when a peer overrides us, and converges', () => {
      handshake()
      const writes = readyWrites().length

      readySet({ username: 'me', isReady: false, manuallyInitiated: true, setBy: 'mikkerlo' })

      const sent = readyWrites().slice(writes)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toEqual({ isReady: true, manuallyInitiated: false })
      expect(sent[0]).not.toHaveProperty('username')
      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.isReady).toBe(true)
      // Peer-only room log: the server's own "X set Y as ready" chat notice is
      // the user's explanation here, and a second line would double-announce.
      expect(roomEvents).toEqual([])

      // The server stores our value and rebroadcasts *that* — now equal.
      readySet({ username: 'me', isReady: true, manuallyInitiated: false })
      expect(readyWrites()).toHaveLength(writes + 1)

      // Case-insensitively, and this is the path where it is observable: an
      // exact compare would drop the frame into the peer branch, find nobody
      // seated under that spelling, and never re-assert — leaving the server
      // serving `false` for us and every peer's gate down. Safe because the
      // server's `findFreeUsername` lowercases every live watcher name into its
      // taken-name set, so no real peer can hold a case-only variant of ours.
      readySet({ username: 'ME', isReady: false, manuallyInitiated: true, setBy: 'mikkerlo' })

      expect(readyWrites()).toHaveLength(writes + 2)
      expect(readyWrites().at(-1)).toEqual({ isReady: true, manuallyInitiated: false })
      expect(roomEvents).toEqual([])
    })

    // Test 5b, the state guard on that re-assert — the one guard the plan names
    // ("Send under `if (this.status.state === 'ready')`, exactly as `setReady`
    // does"). It is not an edge case but the server's *normal* ordering:
    // `handleHello` runs `addWatcher` (which seats us and fires
    // `sendJoinMessage`'s `broadcastRoom`, protocols.py:558) *before*
    // `sendHello` at :560, so we are already receiving room broadcasts while
    // `status.state` is still pre-`ready`. Nothing is lost by dropping the
    // re-assert in that window: `finishHandshake()` sends `ownIsReady`
    // unconditionally moments later, which is what actually corrects the
    // server's stored value.
    it('writes nothing for an override that lands before the handshake completes', () => {
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'cinema',
        username: 'me',
        autoReconnect: false
      })
      lastSocket!.emit('connect')
      lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      lastTlsSocket!.emit('secureConnect')
      expect(readyWrites()).toHaveLength(0)

      readySet({ username: 'me', isReady: false, manuallyInitiated: true, setBy: 'mikkerlo' })

      // Not one byte of readiness on the wire before `Hello` comes back.
      expect(readyWrites()).toHaveLength(0)
      // Our own value is untouched, so the handshake's assert still says `true`.
      lastTlsSocket!.emit(
        'data',
        Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.6.9"}}\r\n')
      )
      expect(readyWrites()).toEqual([{ isReady: true, manuallyInitiated: false }])
    })

    // Test 6, the anti-spin case. `isReady()` returns `None` for every watcher
    // on a `--disable-ready` server, and `null` can never equal `ownIsReady`,
    // so without the boolean guard the re-assert above would be a wire-speed
    // loop against such a server.
    it('writes nothing for a self frame carrying a null isReady', () => {
      handshake()
      const writes = readyWrites().length

      readySet({ username: 'me', isReady: null, manuallyInitiated: false })
      readySet({ username: 'me', isReady: null, manuallyInitiated: false })

      expect(readyWrites()).toHaveLength(writes)
    })

    // Test 8, the readiness angle on the switch-out frame. #230's rule 2 owns
    // the membership assertion; the *harm* it guards against only exists once
    // readiness is live — a peer that switches away mid-buffer would otherwise
    // leave an `isReady:false` behind and `syncplayAllUsersReady()` would hold
    // our playback paused.
    it('removes a peer that switches out, so a stale false cannot pin our gate', () => {
      handshake()
      seatPeer('mikkerlo')
      readySet({ username: 'mikkerlo', isReady: false, manuallyInitiated: false })
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBe(false)

      serverSet({ mikkerlo: { room: { name: 'other-room' } } })

      expect(roomUsers.at(-1)!.map((u) => u.username)).not.toContain('mikkerlo')
    })

    // The optional room log line, gated on truth rather than presence:
    // `manuallyInitiated` is present in *both* branches of the server's
    // `sendSetReady` and the buffer-driven path is exactly the one that sets it
    // `false`, so a presence check would write a line on every peer's MSE
    // `waiting`/recovery flap into the log the user reads for joins and chat.
    it('logs a deliberate peer transition and stays quiet on a buffer flap', () => {
      handshake()
      seatPeer('mikkerlo')
      roomEvents.length = 0

      readySet({ username: 'mikkerlo', isReady: false, manuallyInitiated: false })
      expect(roomEvents).toEqual([])

      readySet({ username: 'mikkerlo', isReady: true, manuallyInitiated: true })
      expect(roomEvents).toEqual(['mikkerlo is ready'])

      readySet({ username: 'mikkerlo', isReady: false, manuallyInitiated: false, setBy: 'someone' })
      expect(roomEvents).toEqual(['mikkerlo is ready', 'mikkerlo was set not ready by someone'])
    })

    it('ignores a readiness frame with no username', () => {
      handshake()
      seatPeer('mikkerlo')
      const emits = roomUsers.length

      readySet({ isReady: false, manuallyInitiated: true })

      expect(roomUsers).toHaveLength(emits)
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBeUndefined()
    })
  })

  // #224 added `timeupdate`-driven snapshot pushes so a background-throttled
  // timer could not demote an active viewer — but `timeupdate` does not fire
  // while *paused*, so a paused player in a hidden window has only the 1 s
  // interval, which Chromium clamps toward 1/min after minutes hidden. It
  // therefore does cross PLAYBACK_STALE_MS and get demoted to the spectator
  // mirror. Characterization only: no production change, and the recovery
  // branches below are the reason the "harmless" framing is only half true.
  describe('a paused hidden player goes stale and recovers (#227)', () => {
    // Takes a converged, adopted player into the stale gap. Returns with the
    // heartbeat already demoted and the write log cleared.
    const hideWhilePaused = (roomPos: number, roomPaused: boolean, ourPos: number): void => {
      handshake()
      serverState(roomPos, roomPaused)
      // Converge first — at a large drift the client mirrors because it never
      // adopted, and every assertion below would pass with the staleness rule
      // deleted outright.
      client.updateSnapshot({ position: ourPos, paused: false })
      vi.advanceTimersByTime(1000)
      // The user pauses and hides the window. This is the last push there is:
      // paused means no `timeupdate`, hidden means the interval is throttled.
      client.updateSnapshot({ position: ourPos, paused: true })
      lastTlsSocket!.write.mockClear()
      vi.advanceTimersByTime(10_000)
    }

    // The delta over 'reverts to mirroring when the player stops pushing
    // snapshots', which pins the same demotion against a *playing* room: with
    // the room paused, projectedRoomPosition() returns it unchanged, so the
    // mirror is exactly the room's position rather than a forward projection.
    it('mirrors the room position unchanged while the room is paused', () => {
      hideWhilePaused(600, true, 600)

      const last = statesOf(lastTlsSocket).at(-1)!
      // Demoted: our own `paused: true` claim is gone from the wire even though
      // a live player is sitting right here holding it.
      expect(last.playstate!.paused).toBeUndefined()
      expect(last.playstate!.position).toBe(600)
    })

    // The de-adoption is a *second*, later step: it lives only in
    // updateSnapshot(), which by construction cannot run during the gap. So
    // `playbackAdopted` is still latched while we sit demoted, and an event
    // arriving before the first post-unhide push goes out unimpeded. This is
    // what makes the ordering in the two drop cases below load-bearing rather
    // than incidental.
    it('still asserts an event that arrives before the first post-unhide push', () => {
      hideWhilePaused(600, false, 600)
      // Drop the gap's own heartbeat frames — the assertion is about the event.
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 600, paused: false, cause: 'play' })

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 600, paused: false, doSeek: false })
    })

    // Recovery (a): the room is where we left it, so the push that de-adopts us
    // re-adopts on the very next check — drift is 0 — and the user's first
    // action after unhiding reaches the room.
    it('re-adopts on the first post-unhide push when the room has not moved', () => {
      hideWhilePaused(600, true, 600)

      // Unhide: the renderer resumes pushing, and this one clears the adoption
      // latch because it arrives after a stale gap.
      client.updateSnapshot({ position: 600, paused: true })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 600, paused: false, cause: 'play' })

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 600, paused: false, doSeek: false })
    })

    // Recovery (b): the room played on while we sat paused-hidden, so by the
    // time we de-adopt the drift has grown past ADOPT_TOLERANCE_S and the first
    // post-unhide action is dropped until a remote apply seeks us back.
    it('drops the first post-unhide action when the room played on without us', () => {
      hideWhilePaused(600, false, 600)

      client.updateSnapshot({ position: 600, paused: true })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 600, paused: false, cause: 'play' })

      expect(statesOf(lastTlsSocket)).toEqual([])
    })

    // Recovery (c): the same drop, from a *paused* room — which is the case the
    // "harmless today" framing misses. Our position-only mirror carries no
    // `paused`, and the reference server reads a missing paused as not-paused in
    // _updatePositionByAge too, so it advances the position it stores for us on
    // every heartbeat. Alone in the room, Room.getPosition()'s min() is us, so
    // that crept value comes straight back as the room state. Main records it
    // and returns on the setBy-less frame, so nothing corrects the element and
    // the drift is invisible until the user acts.
    it('drops it too when the room merely crept forward under our own mirror', () => {
      hideWhilePaused(600, true, 600)

      // What the server hands back after minutes of forward-compensating a
      // stationary paused player: a room state ahead of where we actually are.
      serverState(640, true)

      client.updateSnapshot({ position: 600, paused: true })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 600, paused: false, cause: 'play' })

      expect(statesOf(lastTlsSocket)).toEqual([])
    })
  })
})
