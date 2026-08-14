// `syncplay:get-room-position` (#262) — the value that seeds the MKV ffmpeg
// spawn, so the open doesn't pay a second spawn plus its buffer-ahead wait when
// the room is parked away from our local resume target.
//
// The discriminating property is the *gate*: a state we set ourselves — a user
// alone in a room, whose own position the server echoes back once a second —
// must answer `null`, even though `lastRoomState` is populated by it. An
// implementation built on `lastRoomState` (the spectator mirror's source,
// recorded deliberately *above* handleState()'s echo guards) passes every other
// test here and fails that one.

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

import { SyncplayClient } from '../../src/main/syncplay'

describe('SyncplayClient.getRoomPosition (#262)', () => {
  let client: SyncplayClient

  // The file the caller is opening. Every read is scoped to it, so a helper
  // keeps the argument out of the way of what each case is actually about.
  const OPEN = 'Some Anime - 1'

  const file = (canonicalName: string, newPlayer = true): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: canonicalName.slice(-1),
      translationId: 3,
      canonicalName,
      duration: 1440,
      newPlayer
    })
  }

  const position = (canonicalName = OPEN): number | null => client.getRoomPosition(canonicalName)

  const handshake = (room = 'cinema', announce = OPEN): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room,
      username: 'me',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from(`{"Hello":{"username":"me","room":{"name":"${room}"},"version":"1.6.9"}}\r\n`)
    )
    // `useSyncplayClient`'s onMounted push, which is what makes main's
    // `currentFile` the file the reads below name.
    file(announce)
  }

  // A `List` reply keyed to our room — the only thing that makes `rosterReceived`
  // true, and with it the "are we alone?" half of the bound below meaningful.
  const roster = (entries: Record<string, unknown>, room = 'cinema'): void => {
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { [room]: entries } }) + '\r\n'))
  }

  // The reference `sendUserSetting` leave frame: one entry naming the departing
  // user with `event.left`.
  const peerLeaves = (username: string, room = 'cinema'): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          Set: { user: { [username]: { room: { name: room }, event: { left: true } } } }
        }) + '\r\n'
      )
    )
  }

  const serverState = (position: number, paused: boolean, setBy: string | null): void => {
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
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the gate', () => {
    it('reports the room position after a state set by a peer', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      expect(position()).toBeCloseTo(600, 3)
    })

    // The solo-room case, and the whole reason this is a second field rather
    // than a read of `lastRoomState`: the server re-broadcasts our own reported
    // position with `setBy` naming us, so a client alone in a room *does* have a
    // `lastRoomState`. Answering with it would seed every MKV open from the
    // room instead of the saved position — the regression `roomOwnsPlayhead()`
    // exists to prevent, moved one layer earlier.
    it('returns null when the only states seen were set by us', () => {
      handshake()
      serverState(600, true, 'me')
      expect(position()).toBeNull()
    })

    it('returns null for a state carrying no setBy at all', () => {
      handshake()
      serverState(600, true, null)
      expect(position()).toBeNull()
    })

    it('returns null before any state has arrived', () => {
      handshake()
      expect(position()).toBeNull()
    })

    it('returns null with no session at all', () => {
      expect(position()).toBeNull()
    })

    // A peer's state seen while connected must not answer for a session that
    // has since ended: `disconnect()` runs tearDown(), which drops the field
    // beside `lastRoomState`.
    it('returns null after the session is torn down', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      expect(position()).not.toBeNull()
      client.disconnect()
      expect(position()).toBeNull()
    })
  })

  describe('the projection', () => {
    it('advances with wall time while the room is playing', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(604, 1)
    })

    // A paused position does not age, so advancing it is pure error — the same
    // rule `projectedRoomPosition()` applies for the spectator mirror.
    it('does not advance while the room is paused', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(600, 3)
    })

    it('never reports a negative position', () => {
      handshake()
      serverState(-5, true, 'mikkerlo')
      expect(position()).toBe(0)
    })
  })

  // Regression for the review of #272. `lastRemoteRoomState` is refreshed *only*
  // by a state that clears handleState()'s setBy-null / self / unacked guards, so
  // two reachable shapes freeze it while `status.state` stays `ready` — and an
  // unbounded projection then walks the frozen value forward with wall time for
  // as long as the session lives. The number it produces becomes `initialSeek`
  // and reaches ffmpeg's `-ss`, where a target past the end of the file is a run
  // that emits nothing and an MSE session that buffers forever.
  describe('the bound', () => {
    // Shape 1 — the last peer leaves. The roster empties, the server keeps
    // sending periodics `setBy` us (its min() re-election elects the only
    // watcher left), and every one of them dies at the self-guard. Unbounded
    // this answered 2400 for a room that was at 600 half an hour ago.
    it('stops answering once the last peer has left the room', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      expect(position()!).toBeCloseTo(600, 1)

      peerLeaves('mikkerlo')
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The roster half is what makes that instant rather than one age-cap later:
    // two seconds after the leave the projection is only 2 s wrong, and still
    // must not be used — nobody is in the room to sync with.
    it('stops answering immediately on the leave, not one age cap later', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      peerLeaves('mikkerlo')
      vi.advanceTimersByTime(2000)
      expect(position()).toBeNull()
    })

    // Shape 2 — *we* pause the room. Our pause is broadcast back to us `setBy`
    // us and dropped, so the stored `paused: false` never flips and the
    // projection keeps walking a room that is standing still. Unbounded this
    // answered 900 after five minutes of a room parked at 600.
    it('stops answering after our own pause has frozen the stored paused flag', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      // The echo of our own pause: real frame, real pause, dropped at the
      // self-guard — so `lastRemoteRoomState` still reads `paused: false`.
      serverState(600, true, 'me')
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The age cap is a freshness test, not a projection test: a *paused* room
    // whose state has gone silent is equally untrustworthy, even though the
    // projection would return the stored value unchanged.
    it('stops answering when the last peer state has gone stale, paused or not', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, true, 'mikkerlo')
      vi.advanceTimersByTime(20 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The bound must not cost the feature on the path it exists for: a peer is
    // seated and driving at ~1 Hz, so the value is fresh and the room owns the
    // spawn.
    it('keeps answering while a seated peer is still driving the room', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      serverState(604, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(608, 1)
    })

    // The roster test is `isAdopted()`'s idiom *including its `rosterReceived`
    // guard*: "the roster is empty" and "the roster has not arrived" are
    // different answers, and a server whose `List` reply we cannot key to our
    // room (#223) never reports one at all. A fresh non-self state is its own
    // proof that a peer exists — only a peer can set it — so it stays usable,
    // bounded by the age cap alone.
    it('still answers from a fresh peer state when no roster has arrived', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(604, 1)
    })
  })

  describe('file identity', () => {
    // The room's position was reported for the file we were on. Handed to the
    // next episode's spawn it would be worse than the saved position it
    // replaces. Asked for under the *new* name, so the `setFile()` clear is the
    // only thing that can answer null here — the caller-scope guard below would
    // otherwise cover for its removal.
    it('drops the position when our canonical name changes', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      expect(position()).toBeCloseTo(600, 3)

      file('Some Anime - 2')
      expect(position('Some Anime - 2')).toBeNull()
    })

    // Keyed on identity, not on `newPlayer`: a same-episode reopen (close the
    // player, pick another translation) re-pushes a byte-identical name at a
    // fresh <video>, and the room's position is still the right seed for it.
    it('keeps the position across a same-episode reopen', () => {
      handshake()
      serverState(600, true, 'mikkerlo')

      file(OPEN, true)
      expect(position()).toBeCloseTo(600, 3)
    })

    it('re-earns the position from the next state after a switch', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file('Some Anime - 2')
      serverState(12, true, 'mikkerlo')
      expect(position('Some Anime - 2')).toBeCloseTo(12, 3)
    })

    // The caller's scope, not merely the ordering (#272 review). Main still
    // believes we are on episode 1 — the push for episode 2 has not landed — and
    // a read naming episode 2 must not be answered from episode 1's room
    // position, which is the exact seed that would spawn ffmpeg in the wrong
    // place if the two `onMounted` hooks ever reorder.
    it('answers null for a file main has not been told about yet', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      expect(position('Some Anime - 2')).toBeNull()
      // ...and the file it *does* know about is unaffected.
      expect(position()).toBeCloseTo(600, 3)
    })
  })
})
